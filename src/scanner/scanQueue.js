// Feature 20: scans were previously fired off with unlimited concurrency —
// triggering rescans on several apps at once (or an auto-rescan wave from
// the scheduler) meant every one of them ran simultaneously, all shelling
// out to the local Claude CLI at once for deep scans. Adds a small
// in-process concurrency-limited queue: scans beyond MAX_CONCURRENT sit as
// "Queued" (a status distinct from "Scanning") until a slot frees up.

const db = require('../store/db');
const { triggerAppScan } = require('../scanRunner');

const MAX_CONCURRENT = 2;

let active = 0;
const queue = []; // app objects waiting for a slot, in trigger order

function processQueue() {
  while (active < MAX_CONCURRENT && queue.length) {
    const app = queue.shift();
    active += 1;
    triggerAppScan(app)
      .catch(() => { /* already recorded on the app entry + progress bus */ })
      .finally(() => {
        active -= 1;
        processQueue();
      });
  }
}

function enqueueScan(app) {
  if (queue.some((a) => a.id === app.id)) return; // already waiting, don't double-queue
  if (active >= MAX_CONCURRENT) {
    db.update(app.id, { status: 'Queued', error: null });
  }
  queue.push(app);
  processQueue();
}

function queueStats() {
  return {
    active,
    maxConcurrent: MAX_CONCURRENT,
    queued: queue.map((a, i) => ({ id: a.id, name: a.name, position: i + 1 })),
  };
}

module.exports = { enqueueScan, queueStats, MAX_CONCURRENT };
