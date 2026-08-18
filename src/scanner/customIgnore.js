// Feature: per-app custom ignore patterns. ignore.js's IGNORED_DIRS is a
// fixed, global list (node_modules, dist, .git, ...) — this lets a user add
// their own glob-style patterns per app (e.g. "tests/**", "**/*.generated.js")
// from the UI instead of editing scanner source. Patterns are matched against
// each file's posix-style path relative to the scan root; a match means the
// file is skipped entirely (no components/models/routes/issues extracted).
//
// Suppression safety: an ignore pattern hides a file from every check at
// once (secrets, dead code, everything) — broader than a single suppression
// rule, so it gets the same guardrails: a required reason, a required
// expiration date, and an entry in the shared audit log (auditLog.js) on
// every add/remove. No permanent, unexplained ignores.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auditLog = require('./auditLog');

const PATTERNS_DIR = path.join(__dirname, '..', '..', 'data', 'ignore-patterns');
const MAX_EXPIRY_DAYS = 365;

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

function isExpired(entry) {
  return !!entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now();
}

function addPattern(appId, { pattern, reason, expiresAt }, actor) {
  const trimmed = (pattern || '').trim();
  if (!trimmed) throw new Error('Pattern is required');
  const trimmedReason = (reason || '').trim();
  if (!trimmedReason) throw new Error('A reason is required — explain why this path is being ignored.');

  if (!expiresAt) throw new Error('An expiration date is required — ignore patterns cannot be permanent.');
  const expiryDate = new Date(expiresAt);
  if (Number.isNaN(expiryDate.getTime())) throw new Error('Invalid expiration date.');
  const now = Date.now();
  if (expiryDate.getTime() <= now) throw new Error('Expiration date must be in the future.');
  if (expiryDate.getTime() > now + MAX_EXPIRY_DAYS * 86400000) throw new Error(`Expiration date can be at most ${MAX_EXPIRY_DAYS} days out — request a new ignore pattern if it's still needed after that.`);

  const patterns = loadPatterns(appId);
  if (patterns.some((p) => p.pattern === trimmed)) return patterns;
  const entry = {
    id: crypto.randomUUID(),
    pattern: trimmed,
    reason: trimmedReason,
    expiresAt: expiryDate.toISOString(),
    createdBy: actor || 'unknown',
    createdAt: new Date().toISOString(),
  };
  patterns.push(entry);
  savePatterns(appId, patterns);
  auditLog.appendAuditLog({ kind: 'ignore-pattern', action: 'created', appId, ruleId: entry.id, filePattern: entry.pattern, reason: entry.reason, expiresAt: entry.expiresAt, by: entry.createdBy, at: entry.createdAt });
  return patterns;
}

function removePattern(appId, id, actor) {
  const patterns = loadPatterns(appId);
  const removed = patterns.find((p) => p.id === id);
  const remaining = patterns.filter((p) => p.id !== id);
  savePatterns(appId, remaining);
  if (removed) {
    auditLog.appendAuditLog({ kind: 'ignore-pattern', action: 'removed', appId, ruleId: removed.id, filePattern: removed.pattern, reason: removed.reason, by: actor || 'unknown', at: new Date().toISOString() });
  }
  return remaining;
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
    if (isExpired(p)) return false;
    try {
      return globToRegExp(p.pattern).test(relPath);
    } catch {
      return false;
    }
  });
}

module.exports = { loadPatterns, savePatterns, addPattern, removePattern, matchesAnyPattern, globToRegExp, isExpired };
