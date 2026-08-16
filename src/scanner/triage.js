// Feature 11: issue triage state. A user can mark a finding as
// "acknowledged" (stays visible, flagged), "false_positive", or "fixed"
// (both removed from the active list/severity gating on future scans) so a
// rescan doesn't keep re-flagging something already reviewed. Keyed by a
// content-based fingerprint (category+file+line+summary), not a database id,
// so it survives the issue list being fully rebuilt every scan.

const fs = require('fs');
const path = require('path');

const TRIAGE_DIR = path.join(__dirname, '..', '..', 'data', 'triage');
const VALID_STATES = new Set(['open', 'acknowledged', 'false_positive', 'fixed']);

function fingerprintIssue(i) {
  return `${i.category}::${i.file}::${i.line}::${i.summary}`;
}

function triageFile(appId) {
  return path.join(TRIAGE_DIR, `${appId}.json`);
}

function loadTriage(appId) {
  const file = triageFile(appId);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveTriage(appId, map) {
  fs.mkdirSync(TRIAGE_DIR, { recursive: true });
  fs.writeFileSync(triageFile(appId), JSON.stringify(map, null, 2), 'utf8');
}

function setTriageState(appId, fingerprint, state, note) {
  if (!VALID_STATES.has(state)) throw new Error(`Invalid triage state: ${state}`);
  const map = loadTriage(appId);
  if (state === 'open') {
    delete map[fingerprint];
  } else {
    map[fingerprint] = { state, note: note || '', updatedAt: new Date().toISOString() };
  }
  saveTriage(appId, map);
  return map[fingerprint] || { state: 'open' };
}

// An issue is excluded from the "active" list/severity gating once it's
// been marked false_positive or fixed; "acknowledged" stays active but
// carries a visible note that it's been reviewed.
function isDismissed(triageMap, issue) {
  const t = triageMap[fingerprintIssue(issue)];
  return !!t && (t.state === 'false_positive' || t.state === 'fixed');
}

module.exports = { fingerprintIssue, loadTriage, saveTriage, setTriageState, isDismissed, VALID_STATES };
