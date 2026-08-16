// Feature 8: scan history + diffing. After each scan, a compact snapshot
// (stats, issue fingerprints, route list, model list) is saved under
// data/history/<appId>/. Each new scan is diffed against the previous
// snapshot to surface what changed — new/resolved issues, new/removed
// routes, added/removed models — written to the wiki as Change-Log.md.

const fs = require('fs');
const path = require('path');
const { fingerprintIssue } = require('./triage');

const HISTORY_DIR = path.join(__dirname, '..', '..', 'data', 'history');

function dirFor(appId) {
  return path.join(HISTORY_DIR, appId);
}

function loadSnapshots(appId) {
  const dir = dirFor(appId);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function getLatestSnapshot(appId) {
  const snapshots = loadSnapshots(appId);
  return snapshots.length ? snapshots[snapshots.length - 1] : null;
}

function saveSnapshot(appId, snapshot) {
  const dir = dirFor(appId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${snapshot.scannedAt.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(snapshot), 'utf8');
}

const fingerprintRoute = (r) => `${r.method} ${r.path}`;

function diffSnapshots(prev, curr) {
  if (!prev) return null;

  const prevIssueKeys = new Set(prev.issues.map(fingerprintIssue));
  const currIssueKeys = new Set(curr.issues.map(fingerprintIssue));
  const newIssues = curr.issues.filter((i) => !prevIssueKeys.has(fingerprintIssue(i)));
  const resolvedIssues = prev.issues.filter((i) => !currIssueKeys.has(fingerprintIssue(i)));

  const prevRouteKeys = new Set(prev.routes.map(fingerprintRoute));
  const currRouteKeys = new Set(curr.routes.map(fingerprintRoute));
  const newRoutes = curr.routes.filter((r) => !prevRouteKeys.has(fingerprintRoute(r)));
  const removedRoutes = prev.routes.filter((r) => !currRouteKeys.has(fingerprintRoute(r)));

  const prevModelNames = new Set(prev.models.map((m) => m.name));
  const currModelNames = new Set(curr.models.map((m) => m.name));
  const addedModels = curr.models.filter((m) => !prevModelNames.has(m.name));
  const removedModels = prev.models.filter((m) => !currModelNames.has(m.name));

  return { previousScanAt: prev.scannedAt, newIssues, resolvedIssues, newRoutes, removedRoutes, addedModels, removedModels };
}

module.exports = { loadSnapshots, getLatestSnapshot, saveSnapshot, diffSnapshots };
