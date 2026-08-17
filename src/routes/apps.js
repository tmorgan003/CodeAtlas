const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../store/db');
const history = require('../scanner/history');
const triage = require('../scanner/triage');
const dictionaryOverrides = require('../scanner/dictionaryOverrides');
const graph = require('../scanner/graph');
const { searchWiki } = require('../scanner/wikiSearch');
const progressBus = require('../scanner/progressBus');
const { triggerAppScan } = require('../scanRunner');
const { buildStaticSite } = require('../scanner/exportSite');
const { pushToGithubWiki } = require('../scanner/exportGithubWiki');
const { isRepoLink } = require('../scanner/gitFetch');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.loadAll());
});

// Portfolio-wide rollup for the dashboard landing view: issue counts by
// severity, apps by status/environment, and which apps haven't been
// scanned recently. Must be registered before /:id or Express would treat
// "dashboard" as an app id.
const STALE_DAYS = 14;

router.get('/dashboard', (req, res) => {
  const apps = db.loadAll();
  const now = Date.now();
  const byStatus = {};
  const byEnvironment = {};
  const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  let totalActiveIssues = 0;
  const staleApps = [];

  for (const app of apps) {
    byStatus[app.status] = (byStatus[app.status] || 0) + 1;
    const envKey = app.environment || 'Unset';
    byEnvironment[envKey] = (byEnvironment[envKey] || 0) + 1;

    const daysSinceScan = app.scannedAt ? (now - new Date(app.scannedAt).getTime()) / 86400000 : null;
    if (daysSinceScan === null || daysSinceScan > STALE_DAYS) {
      staleApps.push({
        id: app.id,
        name: app.name,
        scannedAt: app.scannedAt,
        daysSinceScan: daysSinceScan === null ? null : Math.floor(daysSinceScan),
      });
    }

    const latest = history.getLatestSnapshot(app.id);
    if (!latest) continue;
    const triageMap = triage.loadTriage(app.id);
    for (const issue of latest.issues) {
      if (triage.isDismissed(triageMap, issue)) continue;
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
      totalActiveIssues += 1;
    }
  }

  staleApps.sort((a, b) => (b.daysSinceScan === null ? Infinity : b.daysSinceScan) - (a.daysSinceScan === null ? Infinity : a.daysSinceScan));

  res.json({ totalApps: apps.length, byStatus, byEnvironment, bySeverity, totalActiveIssues, staleApps, staleDaysThreshold: STALE_DAYS });
});

router.get('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(app);
});

router.post('/', (req, res) => {
  const { name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl } = req.body || {};
  if (!name || !pathOrRepo) {
    return res.status(400).json({ error: 'name and pathOrRepo are required' });
  }
  const entry = db.create({ name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl });
  res.status(201).json(entry);
});

router.patch('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl } = req.body || {};
  const patch = {};
  if (purpose !== undefined) patch.purpose = purpose;
  if (owner !== undefined) patch.owner = owner;
  if (environment !== undefined) patch.environment = environment;
  if (techStack !== undefined) patch.techStack = techStack;
  if (notes !== undefined) patch.notes = notes;
  if (scanMode !== undefined) patch.scanMode = scanMode === 'deep' ? 'deep' : 'static';
  if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags : String(tags).split(',').map((t) => t.trim()).filter(Boolean);
  if (scheduleMinutes !== undefined) patch.scheduleMinutes = Number(scheduleMinutes) > 0 ? Number(scheduleMinutes) : 0;
  if (notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = notifyWebhookUrl;
  const updated = db.update(app.id, patch);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = db.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'App not found' });
  res.status(204).end();
});

router.post('/:id/scan', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });

  const updated = db.update(app.id, { status: 'Scanning', error: null });
  res.json(updated);

  triggerAppScan(app).catch(() => { /* already recorded on the app entry + progress bus */ });
});

// Feature 16: live scan progress via Server-Sent Events. If the app isn't
// currently scanning, sends one synthetic "not scanning" event and closes —
// this is a live feed, not a log, so there's nothing to replay for a scan
// that already finished (see Progress.md / scan history for the record).
router.get('/:id/scan-stream', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');

  if (app.status !== 'Scanning') {
    res.write(`data: ${JSON.stringify({ message: `Not currently scanning (status: ${app.status}).`, done: true, status: app.status })}\n\n`);
    res.end();
    return;
  }

  const unsubscribe = progressBus.subscribe(app.id, (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (evt.done) res.end();
  });
  req.on('close', unsubscribe);
});

// Serves a single file out of a scanned app's /wiki directory so the
// frontend can display it without the browser needing filesystem access.
router.get('/:id/wiki-file', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app || !app.localPath) return res.status(404).json({ error: 'Wiki not available for this app yet' });

  const wikiDir = path.join(app.localPath, 'wiki');
  const requested = req.query.path || 'Home.md';
  const resolved = path.resolve(wikiDir, requested);
  if (!resolved.startsWith(path.resolve(wikiDir))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
  const content = fs.readFileSync(resolved, 'utf8');
  res.json({ path: requested, content });
});

// Compact scan-over-time view: stats per past scan, newest first.
router.get('/:id/history', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const snapshots = history.loadSnapshots(app.id)
    .map((s) => ({ scannedAt: s.scannedAt, stats: s.stats }))
    .reverse();
  res.json(snapshots);
});

// Structured (non-markdown) view of the latest scan's issues, merged with
// triage state, for the interactive Issues UI.
router.get('/:id/issues', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const latest = history.getLatestSnapshot(app.id);
  if (!latest) return res.json([]);
  const triageMap = triage.loadTriage(app.id);
  const withTriage = latest.issues.map((i) => ({
    ...i,
    fingerprint: triage.fingerprintIssue(i),
    triage: triageMap[triage.fingerprintIssue(i)] || { state: 'open' },
  }));
  res.json(withTriage);
});

router.post('/:id/issues/triage', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { fingerprint, state, note } = req.body || {};
  if (!fingerprint || !state) return res.status(400).json({ error: 'fingerprint and state are required' });
  if (!triage.VALID_STATES.has(state)) return res.status(400).json({ error: `state must be one of: ${[...triage.VALID_STATES].join(', ')}` });
  const entry = triage.setTriageState(app.id, fingerprint, state, note);
  res.json(entry);
});

// Structured (non-markdown) view of the latest scan's data models, merged
// with any human-edited field description overrides, for the editable
// Data Dictionary UI.
router.get('/:id/models', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const latest = history.getLatestSnapshot(app.id);
  if (!latest) return res.json([]);
  const overrides = dictionaryOverrides.loadOverrides(app.id);
  const withOverrides = latest.models.map((m) => ({
    ...m,
    fields: m.fields.map((f) => ({ ...f, override: (overrides[m.name] && overrides[m.name][f.name]) || null })),
  }));
  res.json(withOverrides);
});

router.post('/:id/models/override', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { modelName, fieldName, description } = req.body || {};
  if (!modelName || !fieldName) return res.status(400).json({ error: 'modelName and fieldName are required' });
  const saved = dictionaryOverrides.setOverride(app.id, modelName, fieldName, description || '');
  res.json({ modelName, fieldName, description: saved });
});

// Resolved import graph for the latest scan, for the frontend's graph view.
router.get('/:id/graph', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const g = graph.loadGraph(app.id);
  res.json(g || { nodes: [], edges: [] });
});

// Live full-text search across the latest scan's generated wiki .md files.
router.get('/:id/wiki-search', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app || !app.localPath) return res.status(404).json({ error: 'Wiki not available for this app yet' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(searchWiki(path.join(app.localPath, 'wiki'), q));
});

// Feature 18: bundle the generated wiki into a portable static HTML site,
// written to <appRoot>/wiki-static-site/.
router.post('/:id/export/static-site', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app || !app.localPath) return res.status(404).json({ error: 'Wiki not available for this app yet' });
  try {
    const result = buildStaticSite(path.join(app.localPath, 'wiki'), path.join(app.localPath, 'wiki-static-site'), app.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// Feature 18: push the generated wiki to the repo's companion Wiki repo
// (GitHub/GitLab <repo>.wiki.git convention). Only makes sense for apps
// submitted as a repo URL, and only runs on this explicit request — never
// automatically. Uses the machine's own git credentials.
router.post('/:id/export/github-wiki', async (req, res) => {
  const app = db.getById(req.params.id);
  if (!app || !app.localPath) return res.status(404).json({ error: 'Wiki not available for this app yet' });
  if (!isRepoLink(app.pathOrRepo)) {
    return res.status(400).json({ error: 'This app was submitted as a local path, not a repo URL — there is no companion wiki repo to push to.' });
  }
  try {
    const result = await pushToGithubWiki(path.join(app.localPath, 'wiki'), app.pathOrRepo, app.id, { dryRun: !!req.body?.dryRun });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

module.exports = router;
