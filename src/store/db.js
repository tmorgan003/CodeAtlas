const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'apps.json');

// Mirrors cli.js's SEVERITY_ORDER keys — the CLI's --fail-on gating
// threshold, now also settable per app from the UI instead of CLI-only.
const GATE_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]', 'utf8');
}

function loadAll() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveAll(apps) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(apps, null, 2), 'utf8');
}

function getById(id) {
  return loadAll().find((a) => a.id === id) || null;
}

function create(fields) {
  const apps = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: fields.name,
    pathOrRepo: fields.pathOrRepo,
    purpose: fields.purpose || '',
    owner: fields.owner || '',
    environment: fields.environment || '',
    techStack: fields.techStack || '',
    notes: fields.notes || '',
    tags: (fields.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    scanMode: fields.scanMode === 'deep' ? 'deep' : 'static',
    scheduleMinutes: Number(fields.scheduleMinutes) > 0 ? Number(fields.scheduleMinutes) : 0,
    notifyWebhookUrl: fields.notifyWebhookUrl || '',
    failOnSeverity: GATE_SEVERITIES.has(fields.failOnSeverity) ? fields.failOnSeverity : 'Critical',
    digestEnabled: !!fields.digestEnabled,
    lastDigestAt: null,
    trackerType: ['github', 'jira'].includes(fields.trackerType) ? fields.trackerType : 'none',
    trackerBaseUrl: fields.trackerBaseUrl || '',
    trackerProjectOrRepo: fields.trackerProjectOrRepo || '',
    trackerEmail: fields.trackerEmail || '',
    trackerToken: fields.trackerToken || '',
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
