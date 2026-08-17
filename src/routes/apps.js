const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../store/db');
const history = require('../scanner/history');
const triage = require('../scanner/triage');
const dictionaryOverrides = require('../scanner/dictionaryOverrides');
const owners = require('../store/owners');
const envVarOverrides = require('../scanner/envVarOverrides');
const graph = require('../scanner/graph');
const { searchWiki } = require('../scanner/wikiSearch');
const progressBus = require('../scanner/progressBus');
const { triggerAppScan } = require('../scanRunner');
const { buildStaticSite } = require('../scanner/exportSite');
const { buildPortfolioStaticSite } = require('../scanner/exportPortfolio');
const { pushToGithubWiki } = require('../scanner/exportGithubWiki');
const { isRepoLink } = require('../scanner/gitFetch');
const { pushIssueToTracker } = require('../scanner/trackerLink');

const router = express.Router();

// Feature 17: archived apps are hidden from the default list (and from the
// portfolio-wide rollups below) but keep their full scan history — nothing
// is deleted, ?includeArchived=true just opts back into seeing them.
router.get('/', (req, res) => {
  const apps = db.loadAll();
  res.json(req.query.includeArchived === 'true' ? apps : apps.filter((a) => !a.archived));
});

// Portfolio-wide rollup for the dashboard landing view: issue counts by
// severity, apps by status/environment, and which apps haven't been
// scanned recently. Must be registered before /:id or Express would treat
// "dashboard" as an app id.
const STALE_DAYS = 14;

router.get('/dashboard', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
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

// Bulk registration: one app per line, either a bare path/repo (name is
// derived from the last path segment) or a CSV row
// "name,pathOrRepo,environment,owner,tags". Lets a team register a dozen
// apps at once instead of one form submission at a time. Registered apps
// start at "Not Started" — this only creates entries, it doesn't scan them.
function deriveNameFromPath(pathOrRepo) {
  const trimmed = pathOrRepo.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() || trimmed;
  return base.replace(/\.git$/i, '');
}

router.post('/bulk', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required — one app per line, either a path/repo or name,pathOrRepo,environment,owner,tags' });
  }
  const lines = text.split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l && !l.startsWith('#'));

  const created = [];
  const errors = [];
  for (const [i, line] of lines.entries()) {
    try {
      const parts = line.split(',').map((p) => p.trim());
      let name, pathOrRepo, environment, owner, tags;
      if (parts.length === 1) {
        [pathOrRepo] = parts;
      } else {
        // Trailing parts (5+) are all tags rejoined, so a tags list with
        // its own commas ("bulk,demo") isn't truncated to just the first one.
        [name, pathOrRepo, environment, owner] = parts;
        tags = parts.slice(4).join(',');
      }
      if (!pathOrRepo) throw new Error('missing path/repo');
      if (!name) name = deriveNameFromPath(pathOrRepo);
      if (owner && !owners.isValid(owner)) throw new Error(`unknown owner "${owner}" — add it via Manage Owners first`);
      created.push(db.create({ name, pathOrRepo, environment, owner, tags }));
    } catch (err) {
      errors.push({ line: i + 1, text: line, error: String((err && err.message) || err) });
    }
  }
  res.status(created.length ? 201 : 400).json({ created, errors });
});

// Feature 7: every issue across every app in one list, so a user doesn't
// have to drill into each app individually to see what's open portfolio-wide.
// Registered before /:id for the same reason as /dashboard and /bulk above.
router.get('/issues', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
  const all = [];
  for (const app of apps) {
    const latest = history.getLatestSnapshot(app.id);
    if (!latest) continue;
    const triageMap = triage.loadTriage(app.id);
    for (const issue of latest.issues) {
      const fingerprint = triage.fingerprintIssue(issue);
      all.push({
        ...issue,
        appId: app.id,
        appName: app.name,
        fingerprint,
        triage: triageMap[fingerprint] || { state: 'open', note: '', assignee: '' },
      });
    }
  }
  res.json(all);
});

// Feature 8: portfolio-wide tech stack view — which apps share a framework
// or dependency, combining the free-text techStack field with whatever the
// scanner auto-detected (frameworks/ecosystems) on each app's latest scan.
// Registered before /:id for the same reason as the other list-level routes.
router.get('/tech-stack', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
  const perApp = [];
  const techMap = new Map();
  for (const app of apps) {
    const manual = (app.techStack || '').split(',').map((t) => t.trim()).filter(Boolean);
    const latest = history.getLatestSnapshot(app.id);
    const detected = latest ? [...(latest.frameworks || []), ...(latest.ecosystems || [])] : [];
    const combined = [...new Set([...manual, ...detected])];
    perApp.push({ id: app.id, name: app.name, tech: combined });
    for (const t of combined) {
      if (!techMap.has(t)) techMap.set(t, []);
      techMap.get(t).push({ id: app.id, name: app.name });
    }
  }
  const shared = [...techMap.entries()]
    .map(([tech, techApps]) => ({ tech, apps: techApps }))
    .sort((a, b) => b.apps.length - a.apps.length || a.tech.localeCompare(b.tech));
  res.json({ perApp, shared });
});

// Feature 18: compare two apps side by side — useful for spotting drift
// between similar services (two Node/Express APIs, say) on tech stack and
// issue counts. Registered before /:id for the same reason as the other
// list-level routes.
router.get('/compare', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'a and b (app ids) are required' });
  const appA = db.getById(a);
  const appB = db.getById(b);
  if (!appA || !appB) return res.status(404).json({ error: 'One or both apps not found' });

  function summarize(app) {
    const latest = history.getLatestSnapshot(app.id);
    const triageMap = triage.loadTriage(app.id);
    const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    if (latest) {
      for (const issue of latest.issues) {
        if (triage.isDismissed(triageMap, issue)) continue;
        bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
      }
    }
    const manualTech = (app.techStack || '').split(',').map((t) => t.trim()).filter(Boolean);
    const detectedTech = latest ? [...(latest.frameworks || []), ...(latest.ecosystems || [])] : [];
    return {
      id: app.id,
      name: app.name,
      environment: app.environment,
      owner: app.owner,
      status: app.status,
      scannedAt: app.scannedAt,
      stats: app.stats,
      bySeverity,
      tech: [...new Set([...manualTech, ...detectedTech])],
    };
  }

  res.json({ a: summarize(appA), b: summarize(appB) });
});

router.get('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(app);
});

router.post('/', (req, res) => {
  const { name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl, failOnSeverity, digestEnabled } = req.body || {};
  if (!name || !pathOrRepo) {
    return res.status(400).json({ error: 'name and pathOrRepo are required' });
  }
  if (owner && !owners.isValid(owner)) {
    return res.status(400).json({ error: `Unknown owner "${owner}" — add it via Manage Owners first, or leave this blank.` });
  }
  const entry = db.create({ name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl, failOnSeverity, digestEnabled });
  res.status(201).json(entry);
});

router.patch('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const {
    purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl,
    failOnSeverity, digestEnabled, trackerType, trackerBaseUrl, trackerProjectOrRepo, trackerEmail, trackerToken,
    archived,
  } = req.body || {};
  const patch = {};
  if (purpose !== undefined) patch.purpose = purpose;
  if (owner !== undefined) {
    if (owner && !owners.isValid(owner)) {
      return res.status(400).json({ error: `Unknown owner "${owner}" — add it via Manage Owners first, or leave this blank.` });
    }
    patch.owner = owner;
  }
  if (environment !== undefined) patch.environment = environment;
  if (techStack !== undefined) patch.techStack = techStack;
  if (notes !== undefined) patch.notes = notes;
  if (scanMode !== undefined) patch.scanMode = scanMode === 'deep' ? 'deep' : 'static';
  if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags : String(tags).split(',').map((t) => t.trim()).filter(Boolean);
  if (scheduleMinutes !== undefined) patch.scheduleMinutes = Number(scheduleMinutes) > 0 ? Number(scheduleMinutes) : 0;
  if (notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = notifyWebhookUrl;
  if (failOnSeverity !== undefined) {
    if (!db.GATE_SEVERITIES.has(failOnSeverity)) return res.status(400).json({ error: `failOnSeverity must be one of: ${[...db.GATE_SEVERITIES].join(', ')}` });
    patch.failOnSeverity = failOnSeverity;
  }
  if (digestEnabled !== undefined) patch.digestEnabled = !!digestEnabled;
  if (trackerType !== undefined) {
    if (!['none', 'github', 'jira'].includes(trackerType)) return res.status(400).json({ error: 'trackerType must be one of: none, github, jira' });
    patch.trackerType = trackerType;
  }
  if (trackerBaseUrl !== undefined) patch.trackerBaseUrl = trackerBaseUrl;
  if (trackerProjectOrRepo !== undefined) patch.trackerProjectOrRepo = trackerProjectOrRepo;
  if (trackerEmail !== undefined) patch.trackerEmail = trackerEmail;
  if (trackerToken !== undefined) patch.trackerToken = trackerToken;
  if (archived !== undefined) patch.archived = !!archived;
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

// Feature 10: diff any two historical scans, not just the latest against
// the one before it — history.diffSnapshots() was already generic, this
// just lets the caller pick which two snapshots (by scannedAt) to feed it.
router.get('/:id/history/diff', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params (scannedAt timestamps) are required' });
  const snapshots = history.loadSnapshots(app.id);
  const fromSnap = snapshots.find((s) => s.scannedAt === from);
  const toSnap = snapshots.find((s) => s.scannedAt === to);
  if (!fromSnap || !toSnap) return res.status(404).json({ error: 'One or both scans not found in history' });
  res.json({ from: fromSnap.scannedAt, to: toSnap.scannedAt, diff: history.diffSnapshots(fromSnap, toSnap) });
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
    triage: triageMap[triage.fingerprintIssue(i)] || { state: 'open', note: '', assignee: '' },
  }));
  res.json(withTriage);
});

// Feature 15: push a single issue to the app's configured external tracker
// (GitHub Issues or Jira) and remember the resulting link so it isn't
// pushed twice from the UI.
router.post('/:id/issues/push-to-tracker', async (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { fingerprint } = req.body || {};
  if (!fingerprint) return res.status(400).json({ error: 'fingerprint is required' });
  const latest = history.getLatestSnapshot(app.id);
  const issue = latest && latest.issues.find((i) => triage.fingerprintIssue(i) === fingerprint);
  if (!issue) return res.status(404).json({ error: 'Issue not found in the latest scan' });
  try {
    const ref = await pushIssueToTracker(app, issue);
    const entry = triage.setExternalRef(app.id, fingerprint, { type: app.trackerType, ...ref });
    res.json(entry);
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
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

// Feature 5: assign a person/team to a finding, independent of triage state.
router.post('/:id/issues/assign', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { fingerprint, assignee } = req.body || {};
  if (!fingerprint) return res.status(400).json({ error: 'fingerprint is required' });
  const entry = triage.setAssignee(app.id, fingerprint, assignee || '');
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

// Feature 13: env vars referenced in code, merged with any human-written
// descriptions, for the editable Setup tab UI.
router.get('/:id/env-vars', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const latest = history.getLatestSnapshot(app.id);
  if (!latest) return res.json([]);
  const overrides = envVarOverrides.loadOverrides(app.id);
  res.json((latest.envVars || []).map((name) => ({ name, description: overrides[name] || '' })));
});

router.post('/:id/env-vars/override', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const saved = envVarOverrides.setOverride(app.id, name, description || '');
  res.json({ name, description: saved });
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

// Feature 11: combined static-site export across the whole portfolio, not
// just one app at a time. Written under data/portfolio-export/ (this
// project's own data dir — apps can live anywhere on disk, so there's no
// single natural "portfolio root" to write under otherwise).
router.post('/export/portfolio-static-site', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
  if (!apps.length) return res.status(400).json({ error: 'No applications to export.' });
  try {
    const outDir = path.join(__dirname, '..', '..', 'data', 'portfolio-export');
    const result = buildPortfolioStaticSite(apps, outDir);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

module.exports = router;
