// Feature 12: Notify Webhook (see notify.js) already posts on scan
// completion when new Critical/High issues appear. This adds an opt-in
// scheduled summary — a periodic rollup ("N new issues, M resolved in the
// last 7 days") sent to the same webhook URL, independent of whether a
// scan happened to run in that window. Driven by the same in-process
// poller as auto-rescan (src/scheduler.js), so it needs no external cron.

const db = require('../store/db');
const history = require('./history');
const { postJson } = require('./notify');

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_WINDOW_MS = DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// snapshots is ascending (oldest first, per history.loadSnapshots) — find
// the latest snapshot at or before the window start, falling back to the
// oldest snapshot available if the whole history is newer than the window.
function findBaselineSnapshot(snapshots, windowStart) {
  let baseline = snapshots[0];
  for (const s of snapshots) {
    if (new Date(s.scannedAt).getTime() <= windowStart) baseline = s;
    else break;
  }
  return baseline;
}

async function sendDigestIfDue(app, now = Date.now()) {
  if (!app.digestEnabled || !app.notifyWebhookUrl) return null;
  const last = app.lastDigestAt ? new Date(app.lastDigestAt).getTime() : 0;
  if (now < last + DIGEST_WINDOW_MS) return null;

  const snapshots = history.loadSnapshots(app.id);
  if (!snapshots.length) {
    db.update(app.id, { lastDigestAt: new Date(now).toISOString() });
    return null;
  }

  const latest = snapshots[snapshots.length - 1];
  const baseline = findBaselineSnapshot(snapshots, now - DIGEST_WINDOW_MS);
  const diff = baseline === latest ? null : history.diffSnapshots(baseline, latest);
  const newCount = diff ? diff.newIssues.length : 0;
  const resolvedCount = diff ? diff.resolvedIssues.length : 0;

  const text = `*CodeAtlas weekly digest: "${app.name}"*\n`
    + `${newCount} new issue(s), ${resolvedCount} resolved issue(s) in the last ${DIGEST_WINDOW_DAYS} day(s).\n`
    + `Active issues: ${latest.stats.issues}\n`
    + `Wiki: ${app.wikiLink || '(unavailable)'}`;

  const result = await postJson(app.notifyWebhookUrl, { text });
  db.update(app.id, { lastDigestAt: new Date(now).toISOString() });
  return result;
}

module.exports = { sendDigestIfDue, findBaselineSnapshot, DIGEST_WINDOW_DAYS };
