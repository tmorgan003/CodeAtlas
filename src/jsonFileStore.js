// Shared JSON-file persistence. Every data/*.json store used to hand-roll
// its own mkdir/existsSync/JSON.parse-with-fallback/writeFileSync boilerplate;
// this factors that out. Callers keep their own path and business logic
// (validation, merging, slugifying, etc.).

const fs = require('fs');
const path = require('path');

function load(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { load, save };
