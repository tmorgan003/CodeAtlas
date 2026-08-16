// Feature 7: incremental rescans. Per-file extraction results (components,
// data models, routes, issues, env vars) are cached by content hash under
// data/scan-cache/<key>.json. On a rescan, unchanged files skip re-parsing
// entirely and their cached results are reused; only changed/new files are
// reprocessed. The cache is rebuilt fresh each run (only entries for files
// actually seen this pass are kept), so deleted files don't linger forever.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'scan-cache');

function cacheKeyFor(appId, rootPath) {
  return appId || crypto.createHash('sha1').update(path.resolve(rootPath)).digest('hex');
}

function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function loadCache(key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(key, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(cache), 'utf8');
}

module.exports = { cacheKeyFor, hashContent, loadCache, saveCache };
