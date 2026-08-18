// Feature 12: editable data-dictionary overrides. A human-written field
// description should survive a rescan instead of being silently overwritten
// by the "(auto-detected — add description)" placeholder every time. Stored
// per app, keyed by model name + field name — independent of deep-scan
// enrichment, and takes priority over it when both exist for the same field.

const path = require('path');
const jsonFileStore = require('../jsonFileStore');

const OVERRIDES_DIR = path.join(__dirname, '..', '..', 'data', 'dictionary-overrides');

function overridesFile(appId) {
  return path.join(OVERRIDES_DIR, `${appId}.json`);
}

function loadOverrides(appId) {
  return jsonFileStore.load(overridesFile(appId), {});
}

function saveOverrides(appId, map) {
  jsonFileStore.save(overridesFile(appId), map);
}

function setOverride(appId, modelName, fieldName, description) {
  const map = loadOverrides(appId);
  if (!description || !description.trim()) {
    if (map[modelName]) {
      delete map[modelName][fieldName];
      if (!Object.keys(map[modelName]).length) delete map[modelName];
    }
  } else {
    map[modelName] = map[modelName] || {};
    map[modelName][fieldName] = description.trim();
  }
  saveOverrides(appId, map);
  return map[modelName] && map[modelName][fieldName] ? map[modelName][fieldName] : null;
}

module.exports = { loadOverrides, saveOverrides, setOverride };
