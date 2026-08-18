// Feature 16: inline wiki editing beyond the Data Dictionary. That feature's
// pattern (dictionaryOverrides.js) works because field descriptions are a
// simple key->value map merged in at render time. A whole generated page
// like Architecture.md is free-form prose, not a map — so the equivalent
// here is a full-page override: when present, it's served instead of the
// freshly generated file, taking priority the same way a dictionary
// override takes priority over the auto-detected placeholder, and
// surviving rescans the same way for the same reason (the scanner writes
// the generated .md file to disk on every scan; this map is never touched
// by that write, only ever read by the route that serves it).

const path = require('path');
const jsonFileStore = require('../jsonFileStore');

const OVERRIDES_DIR = path.join(__dirname, '..', '..', 'data', 'wiki-overrides');

function overridesFile(appId) {
  return path.join(OVERRIDES_DIR, `${appId}.json`);
}

function loadOverrides(appId) {
  return jsonFileStore.load(overridesFile(appId), {});
}

function saveOverrides(appId, map) {
  jsonFileStore.save(overridesFile(appId), map);
}

function setOverride(appId, pagePath, content) {
  const map = loadOverrides(appId);
  map[pagePath] = { content, updatedAt: new Date().toISOString() };
  saveOverrides(appId, map);
  return map[pagePath];
}

function clearOverride(appId, pagePath) {
  const map = loadOverrides(appId);
  delete map[pagePath];
  saveOverrides(appId, map);
}

module.exports = { loadOverrides, setOverride, clearOverride };
