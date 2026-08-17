// Feature 13: editable descriptions for the env vars the scanner finds
// referenced in code (Setup tab). Mirrors dictionaryOverrides.js — stored
// per app, keyed by var name, independent of and surviving rescans.

const fs = require('fs');
const path = require('path');

const OVERRIDES_DIR = path.join(__dirname, '..', '..', 'data', 'env-var-overrides');

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
