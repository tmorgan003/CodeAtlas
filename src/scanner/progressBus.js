// Feature 16: live scan progress. A tiny in-memory pub/sub keyed by appId —
// the scan trigger publishes each onProgress message here, and any number
// of SSE clients subscribed to that appId receive it in real time. Nothing
// persists across a server restart, which is fine: it's a live status feed,
// not a record (Progress.md and the scan-history snapshots already cover
// the durable record).

const { EventEmitter } = require('events');

const buses = new Map();

function getBus(appId) {
  if (!buses.has(appId)) buses.set(appId, new EventEmitter());
  return buses.get(appId);
}

function publish(appId, event) {
  getBus(appId).emit('progress', event);
  if (event.done) {
    // Give any listener attached this tick a chance to receive the final
    // event before the bus is dropped.
    setImmediate(() => buses.delete(appId));
  }
}

function subscribe(appId, handler) {
  const bus = getBus(appId);
  bus.on('progress', handler);
  return () => bus.off('progress', handler);
}

module.exports = { publish, subscribe };
