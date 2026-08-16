// Feature 12: editable data-dictionary overrides. A human-written field
// description should survive a rescan instead of being silently overwritten
// by the "(auto-detected — add description)" placeholder every time. Stored
// per app, keyed by model name + field name — independent of deep-scan
// enrichment, and takes priority over it when both exist for the same field.

const fs = require('fs');
const path = require('path');

const OVERRIDES_DIR = path.join(__dirname, '..', '..', 'data', 'dictionary-overrides');

function overridesFile(appId) {
  return path.join(OVERRIDES_DIR, `${appId}.json`);
}

function loadOverrides(appId) {
  const file = overridesFile(appId);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveOverrides(appId, map) {
  fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
  fs.writeFileSync(overridesFile(appId), JSON.stringify(map, null, 2), 'utf8');
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
