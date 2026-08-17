// Feature 11: issue triage state. A user can mark a finding as
// "acknowledged" (stays visible, flagged), "false_positive", or "fixed"
// (both removed from the active list/severity gating on future scans) so a
// rescan doesn't keep re-flagging something already reviewed. Keyed by a
// content-based fingerprint (category+file+line+summary), not a database id,
// so it survives the issue list being fully rebuilt every scan.

const fs = require('fs');
const path = require('path');
const { matchesAnyRule } = require('./suppressionRules');

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
  const existing = map[fingerprint] || {};
  if (state === 'open' && !existing.assignee) {
    delete map[fingerprint];
  } else {
    map[fingerprint] = {
      state,
      note: note !== undefined ? note : (existing.note || ''),
      assignee: existing.assignee || '',
      updatedAt: new Date().toISOString(),
    };
  }
  saveTriage(appId, map);
  return map[fingerprint] || { state: 'open', note: '', assignee: '' };
}

// Feature 5: assign a person/team to a finding, independent of its triage
// state — an "open" issue can still carry an assignee, so a bare state===
// 'open' entry can no longer be dropped from the map purely on state.
function setAssignee(appId, fingerprint, assignee) {
  const map = loadTriage(appId);
  const existing = map[fingerprint] || { state: 'open', note: '' };
  if (!assignee && (!existing.state || existing.state === 'open')) {
    delete map[fingerprint];
  } else {
    map[fingerprint] = {
      state: existing.state || 'open',
      note: existing.note || '',
      assignee: assignee || '',
      updatedAt: new Date().toISOString(),
    };
  }
  saveTriage(appId, map);
  return map[fingerprint] || { state: 'open', note: '', assignee: '' };
}

// An issue is excluded from the "active" list/severity gating once it's
// been marked false_positive or fixed; "acknowledged" stays active but
// carries a visible note that it's been reviewed. A matching pattern-based
// suppression rule (see suppressionRules.js) dismisses it the same way,
// independent of whether it also has a per-finding triage record.
function isDismissed(triageMap, issue, suppressionRules) {
  const t = triageMap[fingerprintIssue(issue)];
  if (t && (t.state === 'false_positive' || t.state === 'fixed')) return true;
  return !!(suppressionRules && suppressionRules.length && matchesAnyRule(issue, suppressionRules));
}

// Feature 15: records where an issue was pushed to (GitHub Issues / Jira),
// so the UI can show "already linked" instead of letting it be pushed twice.
function setExternalRef(appId, fingerprint, ref) {
  const map = loadTriage(appId);
  const existing = map[fingerprint] || { state: 'open', note: '', assignee: '' };
  map[fingerprint] = { ...existing, externalRef: ref, updatedAt: new Date().toISOString() };
  saveTriage(appId, map);
  return map[fingerprint];
}

module.exports = { fingerprintIssue, loadTriage, saveTriage, setTriageState, setAssignee, setExternalRef, isDismissed, VALID_STATES };
