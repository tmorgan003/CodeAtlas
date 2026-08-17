// Feature: per-app custom ignore patterns. ignore.js's IGNORED_DIRS is a
// fixed, global list (node_modules, dist, .git, ...) — this lets a user add
// their own glob-style patterns per app (e.g. "tests/**", "**/*.generated.js")
// from the UI instead of editing scanner source. Patterns are matched against
// each file's posix-style path relative to the scan root; a match means the
// file is skipped entirely (no components/models/routes/issues extracted).

const fs = require('fs');
const path = require('path');

const PATTERNS_DIR = path.join(__dirname, '..', '..', 'data', 'ignore-patterns');

function patternsFile(appId) {
  return path.join(PATTERNS_DIR, `${appId}.json`);
}

function loadPatterns(appId) {
  const file = patternsFile(appId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePatterns(appId, patterns) {
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  fs.writeFileSync(patternsFile(appId), JSON.stringify(patterns, null, 2), 'utf8');
}

function addPattern(appId, pattern) {
  const trimmed = (pattern || '').trim();
  if (!trimmed) throw new Error('Pattern is required');
  const patterns = loadPatterns(appId);
  if (!patterns.includes(trimmed)) {
    patterns.push(trimmed);
    savePatterns(appId, patterns);
  }
  return patterns;
}

function renamePattern(appId, oldPattern, newPattern) {
  const trimmed = (newPattern || '').trim();
  if (!trimmed) throw new Error('New pattern is required');
  const patterns = loadPatterns(appId);
  const idx = patterns.indexOf(oldPattern);
  if (idx === -1) throw new Error(`Pattern "${oldPattern}" not found`);
  patterns[idx] = trimmed;
  savePatterns(appId, patterns);
  return patterns;
}

function removePattern(appId, pattern) {
  const patterns = loadPatterns(appId).filter((p) => p !== pattern);
  savePatterns(appId, patterns);
  return patterns;
}

const GLOBSTAR_SLASH_TOKEN = String.fromCharCode(1);
const GLOBSTAR_TOKEN = String.fromCharCode(2);

// Minimal glob -> RegExp. Pragmatic approximation (same spirit as the
// CODEOWNERS matcher in ownership.js), not a full glob spec implementation:
//   "**/"  -> zero or more path segments (so "**/*.spec.js" matches both
//             a root-level "foo.spec.js" and "deep/nested/foo.spec.js")
//   "**"   -> anything, including "/" (e.g. trailing "tests/**")
//   "*"    -> anything except "/"
//   "?"    -> exactly one char, except "/"
// Two control-char placeholders stand in for the multi-char globstar tokens
// while single "*"/"?" are expanded, so "**" is never mangled into "[^/]*[^/]*".
function globToRegExp(glob) {
  let s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  s = s.split('**/').join(GLOBSTAR_SLASH_TOKEN);
  s = s.split('**').join(GLOBSTAR_TOKEN);
  s = s.split('*').join('[^/]*');
  s = s.split('?').join('[^/]');
  s = s.split(GLOBSTAR_SLASH_TOKEN).join('(?:.*/)?');
  s = s.split(GLOBSTAR_TOKEN).join('.*');
  return new RegExp('^' + s + '$');
}

function matchesAnyPattern(relPath, patterns) {
  return patterns.some((p) => {
    try {
      return globToRegExp(p).test(relPath);
    } catch {
      return false;
    }
  });
}

module.exports = { loadPatterns, savePatterns, addPattern, renamePattern, removePattern, matchesAnyPattern, globToRegExp };
