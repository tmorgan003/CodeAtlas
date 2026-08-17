// Feature 13: new-app onboarding checklist. Distinct from Progress.md (which
// tracks directory-by-directory scan progress within a single run) — this
// tracks whether a *newly registered app* has actually been set up
// properly: owner assigned, tags added, tech stack confirmed, first scan
// reviewed. The first two are derived live from the app record itself (no
// storage needed — they're already true/false from app.owner/app.tags);
// the last two require a human to actually look and say so, so they're the
// only state persisted here.

const fs = require('fs');
const path = require('path');

const ONBOARDING_DIR = path.join(__dirname, '..', '..', 'data', 'onboarding');

function stateFile(appId) {
  return path.join(ONBOARDING_DIR, `${appId}.json`);
}

function loadState(appId) {
  const file = stateFile(appId);
  if (!fs.existsSync(file)) return { techStackConfirmed: false, firstScanReviewed: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { techStackConfirmed: !!parsed.techStackConfirmed, firstScanReviewed: !!parsed.firstScanReviewed };
  } catch {
    return { techStackConfirmed: false, firstScanReviewed: false };
  }
}

function setState(appId, patch) {
  fs.mkdirSync(ONBOARDING_DIR, { recursive: true });
  const current = loadState(appId);
  const next = {
    techStackConfirmed: patch.techStackConfirmed !== undefined ? !!patch.techStackConfirmed : current.techStackConfirmed,
    firstScanReviewed: patch.firstScanReviewed !== undefined ? !!patch.firstScanReviewed : current.firstScanReviewed,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile(appId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Builds the full checklist for an app: two items derived live from the app
// record (no manual action needed once the underlying field is filled in),
// two that require an explicit human check-off even if the data looks
// complete (a tech stack string existing doesn't mean anyone confirmed it's
// right; a finished scan doesn't mean anyone reviewed the findings).
function buildChecklist(app) {
  const manual = loadState(app.id);
  const items = [
    { id: 'ownerAssigned', label: 'Owner / Team assigned', done: !!(app.owner && app.owner.trim()), auto: true },
    { id: 'tagsAdded', label: 'Tags added', done: !!(app.tags && app.tags.length), auto: true },
    { id: 'techStackConfirmed', label: 'Tech stack confirmed', done: manual.techStackConfirmed, auto: false },
    { id: 'firstScanReviewed', label: 'First scan reviewed', done: manual.firstScanReviewed, auto: false },
  ];
  const doneCount = items.filter((i) => i.done).length;
  return { items, doneCount, total: items.length, complete: doneCount === items.length };
}

module.exports = { loadState, setState, buildChecklist };
