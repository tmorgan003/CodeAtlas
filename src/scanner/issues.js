// Step 7: pattern-based issue flagging. Every finding is a heuristic signal,
// not a certainty — severities are conservative and suggested fixes are
// generic starting points for a human reviewer.

const { maskStringsAndComments, extractStrings } = require('./mask');
const { resolveRelativeImport, RESOLVE_SUFFIXES } = require('./graph');

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

const PLACEHOLDER_VALUES = new Set([
  'changeme', 'xxxxxxxx', 'your_api_key', 'placeholder', 'example',
  'test', 'dummy', 'todo', 'secret', 'password', 'yourpassword', '',
]);

function scanSecrets(relPath, content) {
  const issues = [];
  const kvRe = /['"](?:aws_?(?:access|secret)_?key|api[_-]?key|secret|secret[_-]?key|password|passwd|token|auth[_-]?token|private[_-]?key)['"]\s*[:=]\s*['"]([^'"]{8,})['"]/gi;
  let m;
  while ((m = kvRe.exec(content))) {
    const value = m[1];
    if (PLACEHOLDER_VALUES.has(value.toLowerCase()) || value.includes('process.env') || value.includes('${')) continue;
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A credential-like value appears to be hardcoded as a string literal.',
      suggestedFix: 'Move this value to an environment variable or secrets manager and load it at runtime instead of committing it to source.',
    });
  }
  const awsKeyRe = /AKIA[0-9A-Z]{16}/g;
  while ((m = awsKeyRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A string matching the AWS Access Key ID format was found in source.',
      suggestedFix: 'Revoke this key immediately if it is real, then move credentials to environment variables or a secrets manager.',
    });
  }
  const privKeyRe = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;
  while ((m = privKeyRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A private key block is embedded directly in source.',
      suggestedFix: 'Remove the key from source control, rotate it, and load it from a secrets manager or mounted secret file instead.',
    });
  }
  return issues;
}

// Feature 13: entropy-based secret detection. The keyword check above only
// catches credentials assigned to an obviously-named variable (apiKey,
// password, ...). A random-looking token assigned to an innocuous name
// (or embedded as a bare argument) slips past it — this catches those by
// looking at the randomness of the string content itself, independent of
// what it's called. Lower confidence than the keyword match, so it's Medium
// severity and skips anything already flagged by scanSecrets on the same line.
function shannonEntropy(str) {
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const key in freq) {
    const p = freq[key] / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const URL_OR_PATH_RE = /^(?:https?:\/\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/;
const ENTROPY_THRESHOLD = 4.0;
const MIN_LEN = 20;
const MAX_LEN = 200;

function scanEntropySecrets(relPath, content, ext, alreadyFlaggedLines) {
  const issues = [];
  // Uses the shared tokenizer (mask.js) rather than a standalone quote
  // regex — a naive regex would also match a double-quoted HTML/CSS
  // attribute nested inside a backtick template as if it were its own
  // string literal, which is exactly the false positive this caused before.
  for (const { value, index } of extractStrings(content, ext)) {
    if (value.length < MIN_LEN || value.length > MAX_LEN) continue;
    if (/\s/.test(value)) continue;
    if (URL_OR_PATH_RE.test(value)) continue;
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
    const line = lineOf(content, index);
    if (alreadyFlaggedLines.has(line)) continue;
    const entropy = shannonEntropy(value);
    if (entropy < ENTROPY_THRESHOLD) continue;
    issues.push({
      file: relPath,
      line,
      severity: 'Medium',
      category: 'Possible High-Entropy Secret',
      summary: `A ${value.length}-character string with high entropy (${entropy.toFixed(2)} bits/char) was found — could be an API key, token, or credential not caught by keyword matching.`,
      suggestedFix: 'If this is a real credential, move it to an environment variable or secrets manager. If it is a hash, generated ID, or other legitimate random-looking value, this can be disregarded.',
    });
  }
  return issues;
}

// Runs on the RAW content deliberately — the whole point is to inspect what's
// inside the string/template literal passed to query()/execute().
function scanSqlInjection(relPath, content) {
  const issues = [];
  const sqlCallRe = /\.(query|execute)\(\s*(`[^`]*\$\{[^`]*\}[^`]*`|['"][^'"]*['"]\s*\+)/g;
  let m;
  while ((m = sqlCallRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'SQL Injection Risk',
      summary: 'A query is built via string concatenation or template interpolation instead of parameterized input.',
      suggestedFix: 'Use parameterized queries / prepared statements (e.g. `?` placeholders or a query builder) instead of interpolating values into the SQL string.',
    });
  }
  return issues;
}

// Runs on content with string-literal and comment bodies masked out, so a
// finding's own description text (e.g. "eval() executes...") or a commented-
// out call doesn't get flagged the same as a real, live call.
function scanCodeExecutionRisk(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const issues = [];
  let m;
  const evalRe = /\beval\s*\(/g;
  while ((m = evalRe.exec(masked))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'Code Injection Risk',
      summary: 'eval() executes arbitrary strings as code.',
      suggestedFix: 'Replace eval() with an explicit parser, JSON.parse, or a direct function call — avoid executing dynamic strings.',
    });
  }
  const newFnRe = /new\s+Function\s*\(/g;
  while ((m = newFnRe.exec(masked))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Medium',
      category: 'Code Injection Risk',
      summary: 'new Function() constructs and executes code from a string at runtime.',
      suggestedFix: 'Avoid dynamic code construction; use a fixed function or a safe interpreter/config format instead.',
    });
  }
  return issues;
}

function scanCodeSmell(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const issues = [];
  let m;
  const consoleRe = /console\.(log|debug)\(/g;
  let consoleCount = 0;
  let firstConsoleIndex = -1;
  while ((m = consoleRe.exec(masked))) {
    consoleCount++;
    if (firstConsoleIndex < 0) firstConsoleIndex = m.index;
  }
  if (consoleCount > 0) {
    issues.push({
      file: relPath,
      line: lineOf(content, firstConsoleIndex),
      severity: 'Low',
      category: 'Leftover Debug Logging',
      summary: `${consoleCount} console.log/debug call(s) found — likely leftover debugging output.`,
      suggestedFix: 'Remove or replace with a structured logger that respects log levels/environment.',
    });
  }
  // TODO detection intentionally reads the RAW content — it looks for text
  // that follows a real `//` comment marker, so masking comments would erase
  // the very thing it's searching for.
  const todoRe = /\/\/\s*(TODO|FIXME|HACK|XXX)\b(.*)/g;
  while ((m = todoRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Low',
      category: 'Unresolved TODO',
      summary: `${m[1]} comment left in code:${m[2].slice(0, 80)}`,
      suggestedFix: 'Resolve or file a tracked issue for this, then remove the comment.',
    });
  }
  return issues;
}

// A small, non-exhaustive list of known-problematic version ranges, used only
// to demonstrate the check — this is not a live vulnerability feed.
const KNOWN_VULNERABLE = [
  { name: 'lodash', badBelow: '4.17.21', reason: 'prototype pollution (CVE-2020-8203 and related) fixed in 4.17.21' },
  { name: 'minimist', badBelow: '1.2.6', reason: 'prototype pollution (CVE-2021-44906) fixed in 1.2.6' },
  { name: 'express', badBelow: '4.17.3', reason: 'open redirect / ReDoS issues fixed in later 4.x releases' },
  { name: 'axios', badBelow: '0.21.2', reason: 'SSRF (CVE-2021-3749) fixed in 0.21.2' },
  { name: 'node-fetch', badBelow: '2.6.7', reason: 'exposure of sensitive data (CVE-2022-0235) fixed in 2.6.7' },
];

function versionLess(a, b) {
  const pa = a.replace(/[^\d.]/g, '').split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function checkKnownVulnerableDeps(rootPath, relPath, pkgJsonContent) {
  const issues = [];
  try {
    const pkg = JSON.parse(pkgJsonContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const known of KNOWN_VULNERABLE) {
      const declared = allDeps[known.name];
      if (!declared) continue;
      if (versionLess(declared, known.badBelow)) {
        issues.push({
          file: relPath,
          line: 1,
          severity: 'High',
          category: 'Outdated/Vulnerable Dependency',
          summary: `${known.name}@${declared} is below the known-fixed version ${known.badBelow} (${known.reason}).`,
          suggestedFix: `Upgrade ${known.name} to ${known.badBelow} or later. (Checked against a small built-in advisory list, not a live vulnerability database — also run \`npm audit\` for full coverage.)`,
        });
      }
    }
  } catch { /* invalid JSON, skip */ }
  return issues;
}

function scanFile(relPath, content, ext) {
  const secrets = scanSecrets(relPath, content);
  const alreadyFlaggedLines = new Set(secrets.filter((i) => i.category === 'Hardcoded Secret').map((i) => i.line));
  return [
    ...secrets,
    ...scanEntropySecrets(relPath, content, ext, alreadyFlaggedLines),
    ...scanSqlInjection(relPath, content),
    ...scanCodeExecutionRisk(relPath, content, ext),
    ...scanCodeSmell(relPath, content, ext),
  ];
}

// Aggregation-time check across the whole project: files that define exports
// but no other scanned file's relative import resolves to them, excluding
// entry points/tests/config. Resolution mirrors Node's index.js fallback and
// Python's package __init__.py, which a naive substring match got wrong.
function findDeadCode(allFileComponents, entryPoints) {
  const existing = new Set(allFileComponents.map((fc) => fc.relPath));
  const referenced = new Set();

  for (const fc of allFileComponents) {
    for (const imp of fc.imports || []) {
      const resolvedBase = resolveRelativeImport(fc.relPath, imp);
      if (resolvedBase === null) continue;
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = resolvedBase + suffix;
        if (existing.has(candidate)) referenced.add(candidate);
      }
    }
  }

  const issues = [];
  for (const fc of allFileComponents) {
    const fileName = fc.relPath.split('/').pop();
    const baseName = fc.relPath.replace(/\.[^./]+$/, '');
    const isEntry = entryPoints.some((e) => e.includes(fileName) || e.startsWith(baseName.split('/').pop()));
    const isTestOrConfig = /\.(test|spec)\./.test(fc.relPath) || /^(test|tests|__tests__|config)\//.test(fc.relPath) || /\.config\./.test(fc.relPath);
    if (isEntry || isTestOrConfig) continue;
    if ((fc.functions.length + fc.classes.length) === 0) continue;
    if (!referenced.has(fc.relPath)) {
      issues.push({
        file: fc.relPath,
        line: 1,
        severity: 'Low',
        category: 'Possible Dead Code',
        summary: 'No other scanned file resolves a relative import to this file (real path resolution, including index.js/__init__.py fallback — dynamic imports or consumers outside this repo would not be detected).',
        suggestedFix: 'Confirm whether this file is still used (check dynamic imports, build tooling, or external consumers) and remove it if not.',
      });
    }
  }
  return issues;
}

module.exports = { scanFile, checkKnownVulnerableDeps, findDeadCode };
