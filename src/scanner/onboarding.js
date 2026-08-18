// Junior-developer learning path: the onboarding checklist used to track
// admin housekeeping (owner assigned, tags added, tech stack confirmed,
// first scan reviewed) — useful, but not a walkthrough of the product's
// actual workflow. Reworked to walk through the four things a new user
// genuinely needs to have done at least once to understand how CodeAtlas is
// meant to be used: run a scan, resolve a finding, decide what blocks CI,
// and understand what a suppression rule actually does. Two are fully
// auto-detected from real activity (scanning, fixing); the other two are
// auto-detected when the real signal exists (a non-default CI gate, an
// actual suppression rule/ignore pattern) and fall back to an explicit
// human acknowledgment otherwise — visiting a settings page isn't the same
// as understanding it, but a real configured value or a manual check-off
// are both honest signals, unlike a checkbox with no underlying meaning.

const fs = require('fs');
const path = require('path');
const { loadTriage } = require('./triage');
const suppressionRules = require('./suppressionRules');
const customIgnore = require('./customIgnore');

const ONBOARDING_DIR = path.join(__dirname, '..', '..', 'data', 'onboarding');

function stateFile(appId) {
  return path.join(ONBOARDING_DIR, `${appId}.json`);
}

function loadState(appId) {
  const file = stateFile(appId);
  if (!fs.existsSync(file)) return { ciGateAcknowledged: false, suppressionAcknowledged: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ciGateAcknowledged: !!parsed.ciGateAcknowledged, suppressionAcknowledged: !!parsed.suppressionAcknowledged };
  } catch {
    return { ciGateAcknowledged: false, suppressionAcknowledged: false };
  }
}

function setState(appId, patch) {
  fs.mkdirSync(ONBOARDING_DIR, { recursive: true });
  const current = loadState(appId);
  const next = {
    ciGateAcknowledged: patch.ciGateAcknowledged !== undefined ? !!patch.ciGateAcknowledged : current.ciGateAcknowledged,
    suppressionAcknowledged: patch.suppressionAcknowledged !== undefined ? !!patch.suppressionAcknowledged : current.suppressionAcknowledged,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile(appId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function buildChecklist(app) {
  const manual = loadState(app.id);
  const hasFixedIssue = Object.values(loadTriage(app.id)).some((t) => t.state === 'fixed');
  const gateIsCustomized = !!app.failOnSeverity && app.failOnSeverity !== 'Critical';
  const hasSuppressionActivity = suppressionRules.loadRules(app.id).length > 0 || customIgnore.loadPatterns(app.id).length > 0;

  const items = [
    {
      id: 'firstScan',
      label: 'Run your first scan',
      done: app.status === 'Done' && !!app.scannedAt,
      auto: true,
      why: "A scan is where every other step starts — there's nothing to review, fix, or gate until one finishes.",
      cta: 'Add a path/repo above and submit the form, or click Rescan on an existing app.',
    },
    {
      id: 'firstFix',
      label: 'Fix your first issue',
      done: hasFixedIssue,
      auto: true,
      why: 'Marking a finding "fixed" in Issues is how the tool learns it\'s actually resolved — it stops re-flagging the same thing on future scans once you do.',
      cta: 'Open the Issues tab, pick any finding, and set its Triage dropdown to "fixed" once you\'ve addressed it.',
    },
    {
      id: 'ciGate',
      label: 'Set a CI gate',
      done: gateIsCustomized || manual.ciGateAcknowledged,
      auto: gateIsCustomized,
      why: 'CI Gate Severity (in Scan Settings) decides what actually blocks a build — the default (Critical-only) is a safe starting point, but every team\'s risk tolerance is different.',
      cta: 'Open Scan Settings and either change CI Gate Severity, or check this off once you\'ve confirmed the default is right for this app.',
      manualField: 'ciGateAcknowledged',
    },
    {
      id: 'suppression',
      label: 'Understand suppression',
      done: hasSuppressionActivity || manual.suppressionAcknowledged,
      auto: hasSuppressionActivity,
      why: 'A Suppression Rule silences a whole category of future findings at once, not just one — powerful, and exactly why it requires a reason and an expiration date instead of being permanent.',
      cta: 'Open Suppression Rules and add one (or an Ignore Pattern), or check this off once you understand the difference between suppressing a rule and marking one finding "fixed".',
      manualField: 'suppressionAcknowledged',
    },
  ];
  const doneCount = items.filter((i) => i.done).length;
  return { items, doneCount, total: items.length, complete: doneCount === items.length };
}

module.exports = { loadState, setState, buildChecklist };
