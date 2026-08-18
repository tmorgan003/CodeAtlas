const path = require('path');
const crypto = require('crypto');
const jsonFileStore = require('../jsonFileStore');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'apps.json');

// Mirrors cli.js's SEVERITY_ORDER keys — the CLI's --fail-on gating
// threshold, now also settable per app from the UI instead of CLI-only.
const GATE_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);

function loadAll() {
  return jsonFileStore.load(DB_PATH, []);
}

function saveAll(apps) {
  jsonFileStore.save(DB_PATH, apps);
}

function getById(id) {
  return loadAll().find((a) => a.id === id) || null;
}

// ---- create() field defaulting helpers ----
// Split out of create() (was one function with cyclomatic complexity 18 —
// a dozen `|| ''` fallbacks and a handful of ternaries, all counted as
// branches of that one function even though it's really just field-by-field
// data defaulting, not control flow).

function orEmpty(v) {
  return v || '';
}

function parseTags(tags) {
  return (tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function normalizeScanMode(scanMode) {
  return scanMode === 'deep' ? 'deep' : 'static';
}

function normalizeScheduleMinutes(scheduleMinutes) {
  return Number(scheduleMinutes) > 0 ? Number(scheduleMinutes) : 0;
}

function normalizeGateSeverity(value, fallback) {
  return GATE_SEVERITIES.has(value) ? value : fallback;
}

function normalizeTrackerType(trackerType) {
  return ['github', 'jira'].includes(trackerType) ? trackerType : 'none';
}

function create(fields) {
  const apps = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: fields.name,
    pathOrRepo: fields.pathOrRepo,
    purpose: orEmpty(fields.purpose),
    owner: orEmpty(fields.owner),
    environment: orEmpty(fields.environment),
    techStack: orEmpty(fields.techStack),
    notes: orEmpty(fields.notes),
    tags: parseTags(fields.tags),
    scanMode: normalizeScanMode(fields.scanMode),
    scheduleMinutes: normalizeScheduleMinutes(fields.scheduleMinutes),
    notifyWebhookUrl: orEmpty(fields.notifyWebhookUrl),
    // Feature: how urgent a new issue has to be before the on-completion
    // webhook fires — was hardcoded to "High" (i.e. Critical+High), now
    // configurable per app the same way failOnSeverity is, so a team that
    // only cares about Critical (or one that wants Medium+) isn't stuck
    // with everyone else's default.
    notifySeverity: normalizeGateSeverity(fields.notifySeverity, 'High'),
    failOnSeverity: normalizeGateSeverity(fields.failOnSeverity, 'Critical'),
    digestEnabled: !!fields.digestEnabled,
    lastDigestAt: null,
    trackerType: normalizeTrackerType(fields.trackerType),
    trackerBaseUrl: orEmpty(fields.trackerBaseUrl),
    trackerProjectOrRepo: orEmpty(fields.trackerProjectOrRepo),
    trackerEmail: orEmpty(fields.trackerEmail),
    trackerToken: orEmpty(fields.trackerToken),
    gitRef: orEmpty(fields.gitRef),
    lastScannedRef: null,
    shareToken: null,
    archived: false,
    status: 'Not Started',
    wikiLink: null,
    localPath: null,
    stats: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    scannedAt: null,
  };
  apps.push(entry);
  saveAll(apps);
  return entry;
}

function update(id, patch) {
  const apps = loadAll();
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  apps[idx] = { ...apps[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(apps);
  return apps[idx];
}

function remove(id) {
  const apps = loadAll();
  const next = apps.filter((a) => a.id !== id);
  saveAll(next);
  return next.length !== apps.length;
}

module.exports = { loadAll, getById, create, update, remove, GATE_SEVERITIES };
