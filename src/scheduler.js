// Feature 19 (scheduling half): a simple in-process poller — no external
// cron needed. Every CHECK_INTERVAL_MS it looks for apps with
// scheduleMinutes > 0 whose last scan is old enough, and reruns them
// through the same triggerAppScan() the API and CLI use. Off by default per
// app (scheduleMinutes: 0) — this never scans anything the user didn't
// explicitly opt in via the "Auto-rescan" field.

const db = require('./store/db');
const { triggerAppScan } = require('./scanRunner');

const CHECK_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 5000;

function isDue(app, now) {
  if (!app.scheduleMinutes || app.scheduleMinutes <= 0) return false;
  if (app.status === 'Scanning') return false;
  if (!app.scannedAt) return true;
  const last = new Date(app.scannedAt).getTime();
  return now - last >= app.scheduleMinutes * 60 * 1000;
}

function tick() {
  const now = Date.now();
  for (const app of db.loadAll()) {
    if (isDue(app, now)) {
      triggerAppScan(app).catch(() => { /* recorded on the app entry + progress bus */ });
    }
  }
}

function startScheduler() {
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  const initial = setTimeout(tick, INITIAL_DELAY_MS);
  return () => { clearInterval(timer); clearTimeout(initial); };
}

module.exports = { startScheduler, isDue, tick };
