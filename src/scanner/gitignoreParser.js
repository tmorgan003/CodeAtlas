// Respects the *scanned app's own* .gitignore, in addition to CodeAtlas's
// small hardcoded IGNORED_DIRS list (node_modules, dist, .git, ...) and the
// per-app custom ignore patterns configured from the UI (customIgnore.js).
//
// Why this exists: processFile() runs scanFile() — including the
// high-entropy-string heuristic (scanEntropySecrets) — on every non-binary
// file it reaches, regardless of extension. A file the app's own team
// already gitignored (a local .env, a data/ dump, a generated report, a
// vendored blob) still gets walked and scanned unless it happens to fall
// under the static IGNORED_DIRS list, so its content — often genuinely
// high-entropy (hashes, tokens, seed data) but not a real *source* secret —
// gets flagged as a false positive. Reading the repo's own .gitignore is
// the direct fix: if the team already decided this file isn't tracked
// source, CodeAtlas shouldn't treat it as source to audit either.
//
// Pragmatic subset of gitignore syntax (same spirit as customIgnore.js's
// glob engine — not a full spec implementation):
//   - comments (#...) and blank lines are skipped
//   - "!pattern" negates a later match (last-match-wins, same as real git)
//   - a trailing "/" marks a directory pattern (matches the dir and
//     everything under it)
//   - a pattern containing "/" (other than a trailing one) is anchored to
//     the .gitignore's own directory; a bare pattern ("*.log", ".env")
//     matches at any depth, same as git's basename-anywhere behavior
//   - only the .gitignore at the scan root is read — nested .gitignore
//     files in subdirectories aren't merged in

const fs = require('fs');
const path = require('path');
const { globToRegExp } = require('./customIgnore');

function compilePattern(rawLine) {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  // Escaped leading '#' or '!' (git allows "\#foo" / "\!foo" as literals) —
  // uncommon enough that dropping the backslash and treating the rest
  // literally (via globToRegExp's own escaping) is a fine approximation.
  if (line.startsWith('\\')) line = line.slice(1);

  const isDirOnly = line.endsWith('/');
  if (isDirOnly) line = line.slice(0, -1);
  if (!line) return null;

  const isAnchored = line.startsWith('/');
  if (isAnchored) line = line.slice(1);

  // Bare filename/glob (no remaining '/') matches at any depth, like git's
  // "*.log" or ".env"; an anchored or otherwise-slashed pattern is relative
  // to the scan root.
  const hasInnerSlash = line.includes('/');
  const globPattern = isAnchored || hasInnerSlash ? line : `**/${line}`;

  let regex;
  try {
    regex = globToRegExp(globPattern);
  } catch {
    return null;
  }

  // A directory pattern also matches everything underneath it — the same
  // glob with "/**" appended, tested as a second regex.
  const dirRegex = isDirOnly
    ? (() => {
        try {
          return globToRegExp(`${globPattern}/**`);
        } catch {
          return null;
        }
      })()
    : null;

  return { regex, dirRegex, negate };
}

function loadGitignorePatterns(rootPath) {
  const file = path.join(rootPath, '.gitignore');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map(compilePattern)
    .filter(Boolean);
}

// Last-match-wins, same as real git: later patterns (including negations)
// override earlier ones for the same path.
function matchesGitignore(relPath, patterns) {
  let ignored = false;
  for (const p of patterns) {
    if (p.regex.test(relPath) || (p.dirRegex && p.dirRegex.test(relPath))) {
      ignored = !p.negate;
    }
  }
  return ignored;
}

module.exports = { loadGitignorePatterns, matchesGitignore };
