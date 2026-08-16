// Composes the scanner engine with the app data store and the live-progress
// bus — the one place that knows how to "run a scan for this stored app
// entry." Used by the API's scan-trigger route and by the scheduler
// (feature 19), so both go through identical logic instead of drifting.

const path = require('path');
const db = require('./store/db');
const { runScan } = require('./scanner');
const { isRepoLink, cloneRepo } = require('./scanner/gitFetch');
const progressBus = require('./scanner/progressBus');
const { notifyIfNeeded } = require('./scanner/notify');

async function triggerAppScan(app) {
  db.update(app.id, { status: 'Scanning', error: null });
  const onProgress = (message) => progressBus.publish(app.id, { message, done: false });

  try {
    let localPath = app.pathOrRepo;
    if (isRepoLink(app.pathOrRepo)) {
      onProgress(`Cloning ${app.pathOrRepo}...`);
      localPath = await cloneRepo(app.id, app.pathOrRepo);
    } else if (!path.isAbsolute(localPath)) {
      localPath = path.resolve(localPath);
    }

    const result = await runScan(localPath, {
      appId: app.id,
      name: app.name,
      purpose: app.purpose,
      owner: app.owner,
      environment: app.environment,
      techStack: app.techStack,
      notes: app.notes,
      scanMode: app.scanMode,
    }, onProgress);

    const updated = db.update(app.id, {
      status: 'Done',
      localPath,
      wikiLink: path.join(localPath, 'wiki', 'Home.md'),
      stats: result.stats,
      error: null,
      scannedAt: new Date().toISOString(),
    });

    await notifyIfNeeded(updated, result.diff);

    progressBus.publish(app.id, { message: 'Scan complete.', done: true, status: 'Done' });
    return { app: updated, result };
  } catch (err) {
    const message = String((err && err.message) || err);
    db.update(app.id, { status: 'Failed', error: message });
    progressBus.publish(app.id, { message: `Scan failed: ${message}`, done: true, status: 'Failed' });
    throw err;
  }
}

module.exports = { triggerAppScan };
