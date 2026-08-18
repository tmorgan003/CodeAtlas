const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../store/db');
const history = require('../scanner/history');
const triage = require('../scanner/triage');
const dictionaryOverrides = require('../scanner/dictionaryOverrides');
const owners = require('../store/owners');
const envVarOverrides = require('../scanner/envVarOverrides');
const customIgnore = require('../scanner/customIgnore');
const customSecretRules = require('../scanner/customSecretRules');
const customWikiSections = require('../scanner/customWikiSections');
const suppressionRules = require('../scanner/suppressionRules');
const auditLog = require('../scanner/auditLog');
const onboarding = require('../scanner/onboarding');
const wikiOverrides = require('../scanner/wikiOverrides');
const { resolveWikiFile } = require('../scanner/wikiFileResolver');
const graph = require('../scanner/graph');
const { searchWiki } = require('../scanner/wikiSearch');
const progressBus = require('../scanner/progressBus');
const scanQueue = require('../scanner/scanQueue');
const { buildStaticSite } = require('../scanner/exportSite');
const { buildPortfolioStaticSite } = require('../scanner/exportPortfolio');
const { pushToGithubWiki } = require('../scanner/exportGithubWiki');
const { isRepoLink } = require('../scanner/gitFetch');
const { pushIssueToTracker } = require('../scanner/trackerLink');
const { requireRole } = require('../middleware/auth');

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
    const appRules = suppressionRules.loadRules(app.id);
    for (const issue of latest.issues) {
      if (triage.isDismissed(triageMap, issue, appRules)) continue;
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
      totalActiveIssues += 1;
    }
  }

  // Feature 14: flag apps whose most recent scan took meaningfully longer
  // than the portfolio average — relative, not an arbitrary fixed number of
  // seconds, so it stays meaningful whether the portfolio is mostly tiny
  // static scans or mostly large deep scans. SLOW_MIN_MS is a floor so two
  // apps that both scan in under a second don't get flagged over noise.
  const SLOW_MIN_MS = 5000;
  const SLOW_MULTIPLIER = 2;
  const timedApps = apps.filter((a) => a.stats && typeof a.stats.durationMs === 'number');
  const avgDurationMs = timedApps.length
    ? timedApps.reduce((sum, a) => sum + a.stats.durationMs, 0) / timedApps.length
    : 0;
  const slowThresholdMs = Math.max(SLOW_MIN_MS, avgDurationMs * SLOW_MULTIPLIER);
  const slowApps = timedApps
    .filter((a) => a.stats.durationMs > slowThresholdMs)
    .map((a) => ({ id: a.id, name: a.name, durationMs: a.stats.durationMs, filesProcessed: a.stats.filesProcessed }))
    .sort((a, b) => b.durationMs - a.durationMs);

  staleApps.sort((a, b) => (b.daysSinceScan === null ? Infinity : b.daysSinceScan) - (a.daysSinceScan === null ? Infinity : a.daysSinceScan));

  res.json({
    totalApps: apps.length, byStatus, byEnvironment, bySeverity, totalActiveIssues, staleApps, staleDaysThreshold: STALE_DAYS,
    slowApps, avgDurationMs,
  });
});

// Trend visibility: the dashboard above is a snapshot only — this answers
// "is the portfolio improving or drifting" by replaying each app's scan
// history (history.js already saves one snapshot per scan) against TODAY's
// triage/suppression state, so a since-dismissed finding doesn't inflate a
// past day's count. Bucketed by calendar day (apps scan independently, on
// their own schedules, so there's no single shared "scan N" to plot
// against) rather than by raw scan event. Registered before /:id like the
// other list-level routes above.
router.get('/dashboard/trend', (req, res) => {
  const DAYS = 14;
  const apps = db.loadAll().filter((a) => !a.archived);

  const perApp = apps.map((app) => {
    const snapshots = history.loadSnapshots(app.id);
    const triageMap = triage.loadTriage(app.id);
    const rules = suppressionRules.loadRules(app.id);
    return { app, snapshots, triageMap, rules };
  });

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const points = [];
  for (let d = DAYS - 1; d >= 0; d--) {
    const dayEnd = new Date(today.getTime() - d * 86400000);
    const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const { snapshots, triageMap, rules } of perApp) {
      let latest = null;
      for (const snap of snapshots) {
        if (new Date(snap.scannedAt).getTime() <= dayEnd.getTime()) latest = snap;
        else break; // filenames (and therefore array order from loadSnapshots) sort ascending by scannedAt
      }
      if (!latest) continue;
      for (const issue of latest.issues) {
        if (triage.isDismissed(triageMap, issue, rules)) continue;
        bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
      }
    }
    const total = bySeverity.Critical + bySeverity.High + bySeverity.Medium + bySeverity.Low;
    points.push({ date: dayEnd.toISOString().slice(0, 10), bySeverity, total });
  }

  const weekAgo = Date.now() - 7 * 86400000;
  let resolvedThisWeek = 0;
  for (const { snapshots } of perApp) {
    for (let i = 1; i < snapshots.length; i++) {
      if (new Date(snapshots[i].scannedAt).getTime() < weekAgo) continue;
      const diff = history.diffSnapshots(snapshots[i - 1], snapshots[i]);
      if (diff) resolvedThisWeek += diff.resolvedIssues.length;
    }
  }

  res.json({ points, resolvedThisWeek });
});

// Portfolio scan calendar: when is every app next due for an auto-rescan.
// Apps opt into scheduling via scheduleMinutes (see scheduler.js); an app
// with no schedule set has no next-due date and is surfaced separately so
// it doesn't get lost among ones actually on a cadence. Registered before
// /:id for the same reason as the other list-level routes.
router.get('/calendar', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
  const now = Date.now();
  const scheduled = [];
  const unscheduled = [];

  for (const app of apps) {
    if (!app.scheduleMinutes || app.scheduleMinutes <= 0) {
      unscheduled.push({ id: app.id, name: app.name, environment: app.environment, scannedAt: app.scannedAt });
      continue;
    }
    const lastScan = app.scannedAt ? new Date(app.scannedAt).getTime() : null;
    const nextDueAt = lastScan === null ? now : lastScan + app.scheduleMinutes * 60 * 1000;
    scheduled.push({
      id: app.id,
      name: app.name,
      environment: app.environment,
      scheduleMinutes: app.scheduleMinutes,
      scannedAt: app.scannedAt,
      nextDueAt: new Date(nextDueAt).toISOString(),
      overdue: nextDueAt <= now && app.status !== 'Scanning' && app.status !== 'Queued',
    });
  }

  scheduled.sort((a, b) => new Date(a.nextDueAt).getTime() - new Date(b.nextDueAt).getTime());
  res.json({ scheduled, unscheduled });
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
    const appRules = suppressionRules.loadRules(app.id);
    for (const issue of latest.issues) {
      const fingerprint = triage.fingerprintIssue(issue);
      all.push({
        ...issue,
        appId: app.id,
        appName: app.name,
        fingerprint,
        triage: triageMap[fingerprint] || { state: 'open', note: '', assignee: '' },
        suppressedByRule: suppressionRules.matchesAnyRule(issue, appRules),
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

// Feature 20: portfolio-wide scan queue visibility — how many scans are
// actively running vs waiting for a slot, and each queued app's position.
// Registered before /:id for the same reason as the other list-level routes.
router.get('/scan-queue', (req, res) => {
  res.json(scanQueue.queueStats());
});

// Feature 19: tag management — tags are free text on each app (no separate
// store, unlike owners.js), so this aggregates them live from db.loadAll()
// rather than maintaining a parallel list that could drift. Registered
// before /:id for the same reason as the other list-level routes.
router.get('/tags', (req, res) => {
  const apps = db.loadAll().filter((a) => !a.archived);
  const tagMap = new Map();
  for (const app of apps) {
    for (const tag of app.tags || []) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push({ id: app.id, name: app.name });
    }
  }
  const tags = [...tagMap.entries()]
    .map(([tag, taggedApps]) => ({ tag, apps: taggedApps, count: taggedApps.length }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  res.json(tags);
});

// Global audit trail — who suppressed what, when, and why, across every
// app. Read-only; nothing writes to this except addRule/removeRule
// themselves, so it can't be edited or backfilled after the fact. A
// single-segment list-level route, registered before /:id for the same
// reason as /tags, /calendar, /issues above.
router.get('/suppression-audit-log', (req, res) => {
  const log = auditLog.loadAuditLog().slice().reverse();
  res.json(log);
});

router.patch('/tags/:tag', (req, res) => {
  const oldTag = req.params.tag;
  const newTag = (req.body && req.body.newTag || '').trim();
  if (!newTag) return res.status(400).json({ error: 'newTag is required' });
  let updatedCount = 0;
  for (const app of db.loadAll()) {
    if (!app.tags || !app.tags.includes(oldTag)) continue;
    db.update(app.id, { tags: [...new Set(app.tags.map((t) => (t === oldTag ? newTag : t)))] });
    updatedCount += 1;
  }
  res.json({ tag: newTag, updatedCount });
});

router.post('/tags/merge', (req, res) => {
  const { sourceTags, targetTag } = req.body || {};
  const target = (targetTag || '').trim();
  if (!target || !Array.isArray(sourceTags) || !sourceTags.length) {
    return res.status(400).json({ error: 'sourceTags (array) and targetTag are required' });
  }
  const sourceSet = new Set(sourceTags);
  let updatedCount = 0;
  for (const app of db.loadAll()) {
    if (!app.tags || !app.tags.some((t) => sourceSet.has(t))) continue;
    db.update(app.id, { tags: [...new Set(app.tags.map((t) => (sourceSet.has(t) ? target : t)))] });
    updatedCount += 1;
  }
  res.json({ tag: target, updatedCount });
});

router.delete('/tags/:tag', (req, res) => {
  const tag = req.params.tag;
  let updatedCount = 0;
  for (const app of db.loadAll()) {
    if (!app.tags || !app.tags.includes(tag)) continue;
    db.update(app.id, { tags: app.tags.filter((t) => t !== tag) });
    updatedCount += 1;
  }
  res.json({ updatedCount });
});

router.get('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(app);
});

router.post('/', (req, res) => {
  const { name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl, notifySeverity, failOnSeverity, digestEnabled, gitRef } = req.body || {};
  if (!name || !pathOrRepo) {
    return res.status(400).json({ error: 'name and pathOrRepo are required' });
  }
  if (owner && !owners.isValid(owner)) {
    return res.status(400).json({ error: `Unknown owner "${owner}" — add it via Manage Owners first, or leave this blank.` });
  }
  if (notifySeverity !== undefined && !db.GATE_SEVERITIES.has(notifySeverity)) {
    return res.status(400).json({ error: `notifySeverity must be one of: ${[...db.GATE_SEVERITIES].join(', ')}` });
  }
  // RBAC: Deep scan uses real Claude usage on every run, and a lenient CI
  // gate quietly lets issues through — both are admin-only, even at
  // creation time, not just when changed later via PATCH.
  const role = req.user ? req.user.role : 'viewer';
  if (scanMode === 'deep' && role !== 'admin') {
    return res.status(403).json({ error: 'Deep scan requires the "admin" role — log in as an admin, or leave Scan Mode as Static.' });
  }
  if (failOnSeverity !== undefined && failOnSeverity !== 'Critical' && role !== 'admin') {
    return res.status(403).json({ error: 'Changing the CI Gate Severity requires the "admin" role.' });
  }
  const entry = db.create({ name, pathOrRepo, purpose, owner, environment, techStack, notes, scanMode, tags, scheduleMinutes, notifyWebhookUrl, notifySeverity, failOnSeverity, digestEnabled, gitRef });
  res.status(201).json(entry);
});

// PATCH /:id field handling split into small, independent helpers — one
// route handler validating and assigning ~20 orthogonal fields inline had
// climbed to a cyclomatic complexity of 41. Each helper below owns one
// concern group and mutates `patch` directly; the route handler just wires
// them together in order.

// RBAC: Deep scan and CI Gate Severity changes are admin-only, same as at
// creation time.
function checkPatchRbac(body, app, role) {
  if (body.scanMode === 'deep' && app.scanMode !== 'deep' && role !== 'admin') {
    return 'Deep scan requires the "admin" role — log in as an admin, or leave Scan Mode as Static.';
  }
  if (body.failOnSeverity !== undefined && body.failOnSeverity !== app.failOnSeverity && role !== 'admin') {
    return 'Changing the CI Gate Severity requires the "admin" role.';
  }
  return null;
}

function buildIdentityPatch(body, patch) {
  if (body.name !== undefined) {
    if (!body.name.trim()) return 'name cannot be blank';
    patch.name = body.name;
  }
  if (body.pathOrRepo !== undefined) {
    if (!body.pathOrRepo.trim()) return 'pathOrRepo cannot be blank';
    patch.pathOrRepo = body.pathOrRepo;
  }
  return null;
}

function buildOwnerPatch(body, patch) {
  if (body.owner === undefined) return null;
  if (body.owner && !owners.isValid(body.owner)) {
    return `Unknown owner "${body.owner}" — add it via Manage Owners first, or leave this blank.`;
  }
  patch.owner = body.owner;
  return null;
}

function buildGateAndTrackerTypePatch(body, patch) {
  if (body.notifySeverity !== undefined) {
    if (!db.GATE_SEVERITIES.has(body.notifySeverity)) return `notifySeverity must be one of: ${[...db.GATE_SEVERITIES].join(', ')}`;
    patch.notifySeverity = body.notifySeverity;
  }
  if (body.failOnSeverity !== undefined) {
    if (!db.GATE_SEVERITIES.has(body.failOnSeverity)) return `failOnSeverity must be one of: ${[...db.GATE_SEVERITIES].join(', ')}`;
    patch.failOnSeverity = body.failOnSeverity;
  }
  if (body.trackerType !== undefined) {
    if (!['none', 'github', 'jira'].includes(body.trackerType)) return 'trackerType must be one of: none, github, jira';
    patch.trackerType = body.trackerType;
  }
  return null;
}

// Plain pass-through fields — no validation, just "if present, copy it over".
function buildPassthroughFieldsPatch(body, patch) {
  if (body.purpose !== undefined) patch.purpose = body.purpose;
  if (body.environment !== undefined) patch.environment = body.environment;
  if (body.techStack !== undefined) patch.techStack = body.techStack;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = body.notifyWebhookUrl;
  if (body.digestEnabled !== undefined) patch.digestEnabled = !!body.digestEnabled;
  if (body.trackerBaseUrl !== undefined) patch.trackerBaseUrl = body.trackerBaseUrl;
  if (body.trackerProjectOrRepo !== undefined) patch.trackerProjectOrRepo = body.trackerProjectOrRepo;
  if (body.trackerEmail !== undefined) patch.trackerEmail = body.trackerEmail;
  if (body.trackerToken !== undefined) patch.trackerToken = body.trackerToken;
  if (body.gitRef !== undefined) patch.gitRef = body.gitRef;
  if (body.archived !== undefined) patch.archived = !!body.archived;
}

// Fields that need a small transform on the way in, not just validation.
function buildTransformedFieldsPatch(body, patch) {
  if (body.scanMode !== undefined) patch.scanMode = body.scanMode === 'deep' ? 'deep' : 'static';
  if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(',').map((t) => t.trim()).filter(Boolean);
  if (body.scheduleMinutes !== undefined) patch.scheduleMinutes = Number(body.scheduleMinutes) > 0 ? Number(body.scheduleMinutes) : 0;
}

router.patch('/:id', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const body = req.body || {};
  const role = req.user ? req.user.role : 'viewer';

  const rbacError = checkPatchRbac(body, app, role);
  if (rbacError) return res.status(403).json({ error: rbacError });

  const patch = {};
  const validationError = [
    buildIdentityPatch(body, patch),
    buildOwnerPatch(body, patch),
    buildGateAndTrackerTypePatch(body, patch),
  ].find((e) => e);
  if (validationError) return res.status(400).json({ error: validationError });

  buildPassthroughFieldsPatch(body, patch);
  buildTransformedFieldsPatch(body, patch);

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
  // RBAC: gate the trigger itself, not just the mode switch — an app whose
  // scanMode was already set to "deep" by an admin still burns real Claude
  // usage on every rescan, so a non-admin shouldn't be able to fire it.
  const role = req.user ? req.user.role : 'viewer';
  if (app.scanMode === 'deep' && role !== 'admin') {
    return res.status(403).json({ error: 'Triggering a Deep scan requires the "admin" role.' });
  }

  scanQueue.enqueueScan(app);
  res.json(db.getById(app.id)); // reflects whatever enqueueScan just set (Queued) or left as-is (about to run)
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
  const result = resolveWikiFile(app, req.query.path);
  if (!result) return res.status(404).json({ error: 'File not found' });
  res.json(result);
});

// Feature 16: save/clear a full-page override for a generated wiki page
// (see wiki-file above for how it's served, and wikiOverrides.js for why
// this is a whole-page override rather than a field-level one).
router.post('/:id/wiki-file/override', requireRole('editor'), (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { path: pagePath, content } = req.body || {};
  if (!pagePath) return res.status(400).json({ error: 'path is required' });
  const saved = wikiOverrides.setOverride(app.id, pagePath, content || '');
  res.json({ path: pagePath, content: saved.content, overridden: true, updatedAt: saved.updatedAt });
});

router.delete('/:id/wiki-file/override', requireRole('editor'), (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const pagePath = req.query.path;
  if (!pagePath) return res.status(400).json({ error: 'path is required' });
  wikiOverrides.clearOverride(app.id, pagePath);
  res.status(204).end();
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
  const appRules = suppressionRules.loadRules(app.id);
  const withTriage = latest.issues.map((i) => ({
    ...i,
    fingerprint: triage.fingerprintIssue(i),
    triage: triageMap[triage.fingerprintIssue(i)] || { state: 'open', note: '', assignee: '' },
    suppressedByRule: suppressionRules.matchesAnyRule(i, appRules),
  }));
  res.json(withTriage);
});

// Feature 12: pattern-based issue suppression rules (see suppressionRules.js
// for how they're applied) — auto-suppresses every current and future
// finding matching a category + file-glob pattern, distinct from
// triage.js's per-finding false-positive marking above.
router.get('/:id/suppression-rules', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(suppressionRules.loadRules(app.id));
});

router.post('/:id/suppression-rules', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { category, filePattern, reason, expiresAt } = req.body || {};
  try {
    res.status(201).json(suppressionRules.addRule(app.id, { category, filePattern, reason, expiresAt }, req.user ? req.user.username : null));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/:id/suppression-rules/:ruleId', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(suppressionRules.removeRule(app.id, req.params.ruleId, req.user ? req.user.username : null));
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

// Signal vs. noise: a collapsed duplicate-finding group (see app.js's
// groupIssuesForDisplay) can be dozens of occurrences of the same rule —
// this sets every one of them in a single request instead of requiring the
// per-finding dropdown N times.
router.post('/:id/issues/triage-bulk', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { fingerprints, state } = req.body || {};
  if (!Array.isArray(fingerprints) || !fingerprints.length) return res.status(400).json({ error: 'fingerprints (non-empty array) is required' });
  if (!triage.VALID_STATES.has(state)) return res.status(400).json({ error: `state must be one of: ${[...triage.VALID_STATES].join(', ')}` });
  const entries = fingerprints.map((fp) => triage.setTriageState(app.id, fp, state));
  res.json({ updated: entries.length });
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

router.post('/:id/models/override', requireRole('editor'), (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { modelName, fieldName, description } = req.body || {};
  if (!modelName || !fieldName) return res.status(400).json({ error: 'modelName and fieldName are required' });
  const saved = dictionaryOverrides.setOverride(app.id, modelName, fieldName, description || '');
  res.json({ modelName, fieldName, description: saved });
});

// Feature 13: new-app onboarding checklist (see onboarding.js) — distinct
// from Progress.md's directory-scan progress tracker.
// Feature 17: public read-only share link. Generating/revoking a link is
// admin-gated — it's a decision to expose this app's wiki to anyone with
// the URL, no login required, same weight as the other admin-only actions
// (Deep scan, CI Gate Severity). Viewing an existing link needs no auth at
// all — see src/routes/share.js, a separate router mounted outside
// attachUser's normal app surface, deliberately scoped to read-only wiki
// pages only (no issues, no triage, no settings).
router.get('/:id/share', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json({ enabled: !!app.shareToken, token: app.shareToken || null });
});

router.post('/:id/share', requireRole('admin'), (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const token = crypto.randomBytes(16).toString('hex');
  db.update(app.id, { shareToken: token });
  res.json({ enabled: true, token });
});

router.delete('/:id/share', requireRole('admin'), (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  db.update(app.id, { shareToken: null });
  res.status(204).end();
});

router.get('/:id/onboarding', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(onboarding.buildChecklist(app));
});

router.patch('/:id/onboarding', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { ciGateAcknowledged, suppressionAcknowledged } = req.body || {};
  onboarding.setState(app.id, { ciGateAcknowledged, suppressionAcknowledged });
  res.json(onboarding.buildChecklist(app));
});

// Custom wiki sections: team-added markdown pages (e.g. "Runbook") that
// live outside the generated wiki/ dir so a rescan never touches them.
router.get('/:id/wiki-sections', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(customWikiSections.loadSections(app.id));
});

router.post('/:id/wiki-sections', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { title, content } = req.body || {};
  try {
    res.status(201).json(customWikiSections.addSection(app.id, title, content));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.patch('/:id/wiki-sections/:slug', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { title, content } = req.body || {};
  try {
    res.json(customWikiSections.updateSection(app.id, req.params.slug, { title, content }));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/:id/wiki-sections/:slug', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  customWikiSections.removeSection(app.id, req.params.slug);
  res.status(204).end();
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

// Feature: per-app custom ignore patterns (glob-style), editable from the
// UI instead of requiring a scanner source-code change. Applied on the next
// scan — see src/scanner/customIgnore.js and its use in scanner/index.js.
router.get('/:id/ignore-patterns', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(customIgnore.loadPatterns(app.id));
});

router.post('/:id/ignore-patterns', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { pattern, reason, expiresAt } = req.body || {};
  try {
    res.status(201).json(customIgnore.addPattern(app.id, { pattern, reason, expiresAt }, req.user ? req.user.username : null));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/:id/ignore-patterns/:patternId', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(customIgnore.removePattern(app.id, req.params.patternId, req.user ? req.user.username : null));
});

// Feature: masking rules UI — per-app custom secret-detection regex
// patterns, applied alongside the built-in checks on the next scan. See
// src/scanner/customSecretRules.js and its use in issues.js's scanFile().
router.get('/:id/mask-rules', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(customSecretRules.loadRules(app.id));
});

router.post('/:id/mask-rules', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { name, pattern, severity } = req.body || {};
  try {
    res.status(201).json(customSecretRules.addRule(app.id, { name, pattern, severity }));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.patch('/:id/mask-rules/:ruleId', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const { name, pattern, severity } = req.body || {};
  try {
    res.json(customSecretRules.updateRule(app.id, req.params.ruleId, { name, pattern, severity }));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/:id/mask-rules/:ruleId', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(customSecretRules.removeRule(app.id, req.params.ruleId));
});

// Resolved import graph for the latest scan, for the frontend's graph view.
router.get('/:id/graph', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const g = graph.loadGraph(app.id);
  res.json(g || { nodes: [], edges: [] });
});

// Feature: real process-flow diagrams — structured entry-point/route/handler
// detail for the frontend to render as an actual diagram, instead of the
// plain-text "N route(s)" list Architecture.md shows.
router.get('/:id/process-flows', (req, res) => {
  const app = db.getById(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  const latest = history.getLatestSnapshot(app.id);
  if (!latest) return res.json({ entryPoints: [], groups: [] });
  res.json({ entryPoints: latest.entryPoints || [], groups: latest.processFlowGroups || [] });
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
