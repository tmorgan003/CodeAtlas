// Shared, append-only audit trail for every finding-silencing mechanism in
// the app — suppression rules (suppressionRules.js) and custom ignore
// patterns (customIgnore.js). Both hide findings broadly and permanently
// until removed, which is exactly the kind of action that needs a record of
// who did it, when, and why — one shared log (tagged by `kind`) instead of
// two separate ones, so reviewing "what's been silenced across this whole
// app" is one read instead of two.

const path = require('path');
const jsonFileStore = require('../jsonFileStore');

const AUDIT_LOG_PATH = path.join(__dirname, '..', '..', 'data', 'suppression-audit-log.json');

function loadAuditLog() {
  const log = jsonFileStore.load(AUDIT_LOG_PATH, []);
  return Array.isArray(log) ? log : [];
}

function appendAuditLog(entry) {
  const log = loadAuditLog();
  log.push(entry);
  jsonFileStore.save(AUDIT_LOG_PATH, log);
}

module.exports = { loadAuditLog, appendAuditLog };
