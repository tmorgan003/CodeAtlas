// Feature 13: editable descriptions for the env vars the scanner finds
// referenced in code (Setup tab). Mirrors dictionaryOverrides.js — stored
// per app, keyed by var name, independent of and surviving rescans.

const path = require('path');
const jsonFileStore = require('../jsonFileStore');

const OVERRIDES_DIR = path.join(__dirname, '..', '..', 'data', 'env-var-overrides');

function overridesFile(appId) {
  return path.join(OVERRIDES_DIR, `${appId}.json`);
}

function loadOverrides(appId) {
  return jsonFileStore.load(overridesFile(appId), {});
}

function saveOverrides(appId, map) {
  jsonFileStore.save(overridesFile(appId), map);
}

function setOverride(appId, varName, description) {
  const map = loadOverrides(appId);
  if (!description || !description.trim()) {
    delete map[varName];
  } else {
    map[varName] = description.trim();
  }
  saveOverrides(appId, map);
  return map[varName] || null;
}

module.exports = { loadOverrides, saveOverrides, setOverride };
