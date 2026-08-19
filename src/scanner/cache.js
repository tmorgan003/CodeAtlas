// Feature 7: incremental rescans. Per-file extraction results (components,
// data models, routes, issues, env vars) are cached by content hash under
// data/scan-cache/<key>.json. On a rescan, unchanged files skip re-parsing
// entirely and their cached results are reused; only changed/new files are
// reprocessed. The cache is rebuilt fresh each run (only entries for files
// actually seen this pass are kept), so deleted files don't linger forever.
//
// Entries are also invalidated whenever CodeAtlas's OWN detection logic
// changes, not just when a scanned file's content changes — otherwise a
// scanner bug fix (e.g. the dead-code detector learning to resolve a new
// import style) would silently keep serving pre-fix cached results for
// every file whose own content happens not to have changed since the last
// scan, so a plain rescan would never actually pick up the fix. Guarded by
// hashing the source of every module whose output ends up in a cached
// per-file result; any edit there changes the fingerprint and invalidates
// the whole cache for one pass (old cache files with no fingerprint at all
// are treated the same way — safe, just a one-time full reprocess).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'scan-cache');
const SCANNER_DIR = __dirname;
const SCANNER_SOURCE_FILES = ['components.js', 'dataLayer.js', 'processFlows.js', 'issues.js', 'graph.js', 'entryPointTrace.js', 'mask.js'];

function computeScannerVersion() {
  const hash = crypto.createHash('sha1');
  for (const file of SCANNER_SOURCE_FILES) hash.update(fs.readFileSync(path.join(SCANNER_DIR, file)));
  return hash.digest('hex');
}

const SCANNER_VERSION = computeScannerVersion();

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
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.scannerVersion !== SCANNER_VERSION) return {};
    return parsed.entries || {};
  } catch {
    return {};
  }
}

function saveCache(key, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ scannerVersion: SCANNER_VERSION, entries: cache }), 'utf8');
}

module.exports = { cacheKeyFor, hashContent, loadCache, saveCache };
