// Feature 15: license compliance. Flags direct dependencies with a
// restrictive (copyleft) license, a missing license field, or a license
// string this tool doesn't recognize. Reads each dependency's own
// package.json under node_modules (already installed by the user) rather
// than shelling out per-package to the registry — same offline-first spirit
// as npmAudit.js falling back gracefully when it can't reach the network,
// except license data isn't in `npm audit`'s output at all, so this needs
// its own source: whatever's actually on disk.

const fs = require('fs');
const path = require('path');

const PERMISSIVE = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear', 'Apache-2.0',
  '0BSD', 'Unlicense', 'CC0-1.0', 'WTFPL', 'Zlib', 'Python-2.0', 'BlueOak-1.0.0',
]);

// Copyleft licenses, severity reflecting how much obligation they place on a
// project that merely *depends* on the package — AGPL's network-use clause
// is the one most likely to actually matter; LGPL/MPL are file-level
// copyleft and rarely a problem for normal (unmodified) dependency use.
const RESTRICTIVE = new Map([
  ['AGPL-3.0', 'High'], ['AGPL-3.0-only', 'High'], ['AGPL-3.0-or-later', 'High'],
  ['GPL-2.0', 'High'], ['GPL-2.0-only', 'High'], ['GPL-2.0-or-later', 'High'],
  ['GPL-3.0', 'High'], ['GPL-3.0-only', 'High'], ['GPL-3.0-or-later', 'High'],
  ['LGPL-2.1', 'Medium'], ['LGPL-2.1-only', 'Medium'], ['LGPL-2.1-or-later', 'Medium'],
  ['LGPL-3.0', 'Medium'], ['LGPL-3.0-only', 'Medium'], ['LGPL-3.0-or-later', 'Medium'],
  ['MPL-2.0', 'Medium'], ['MPL-1.1', 'Medium'], ['EPL-1.0', 'Medium'], ['EPL-2.0', 'Medium'],
  ['CDDL-1.0', 'Medium'], ['CDDL-1.1', 'Medium'],
]);

const MAX_ISSUES = 30;

function normalizeLicenseField(pkgJson) {
  if (typeof pkgJson.license === 'string') return pkgJson.license;
  if (pkgJson.license && typeof pkgJson.license === 'object' && pkgJson.license.type) return pkgJson.license.type;
  // Legacy pre-SPDX form: "licenses": [{ "type": "MIT", ... }]
  if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length && pkgJson.licenses[0].type) {
    return pkgJson.licenses.map((l) => l.type).join(' OR ');
  }
  return null;
}

// SPDX expressions can combine licenses with OR/AND (e.g. "MIT OR Apache-2.0")
// — checked token by token rather than as one opaque string.
function classify(licenseStr) {
  if (!licenseStr) return { status: 'missing' };
  const tokens = licenseStr.split(/\s+(?:OR|AND)\s+/i).map((t) => t.trim().replace(/^\(|\)$/g, ''));
  for (const token of tokens) {
    if (RESTRICTIVE.has(token)) return { status: 'restrictive', license: token, severity: RESTRICTIVE.get(token) };
  }
  if (tokens.every((t) => PERMISSIVE.has(t))) return { status: 'permissive', license: licenseStr };
  return { status: 'unrecognized', license: licenseStr };
}

// Reads+parses a package.json, returning null for either a missing file or
// a parse error — callers treat both the same way (skip/bail).
function loadPackageJson(pkgJsonPath) {
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function buildLicenseIssue(name, version, result) {
  if (result.status === 'missing') {
    return {
      file: 'package.json', line: 1, severity: 'Medium', category: 'License Compliance', source: 'dependency-audit',
      summary: `${name}@${version} has no license field — can't confirm it's safe to use.`,
      suggestedFix: "Check the package's repository or npm page for its actual license, or replace it with an alternative that declares one.",
    };
  }
  if (result.status === 'restrictive') {
    return {
      file: 'package.json', line: 1, severity: result.severity, category: 'License Compliance', source: 'dependency-audit',
      summary: `${name}@${version} is licensed under ${result.license}, a copyleft license that may impose obligations on this project.`,
      suggestedFix: `Confirm ${result.license} is acceptable for this project's distribution model, or replace ${name} with a permissively-licensed alternative.`,
    };
  }
  return {
    file: 'package.json', line: 1, severity: 'Low', category: 'License Compliance', source: 'dependency-audit',
    summary: `${name}@${version} has an unrecognized license string ("${result.license}") — could not classify it as permissive or restrictive.`,
    suggestedFix: 'Manually verify the license terms for this dependency.',
  };
}

function collectDependencyLicenseIssues(rootPath, deps) {
  const nodeModules = path.join(rootPath, 'node_modules');
  const issues = [];
  for (const name of Object.keys(deps)) {
    if (issues.length >= MAX_ISSUES) break;
    // Missing package.json here means hoisted elsewhere, or an uninstalled
    // optional dep — loadPackageJson returning null covers that and a
    // parse error identically (both mean "nothing to classify, skip it").
    const depPkg = loadPackageJson(path.join(nodeModules, name, 'package.json'));
    if (!depPkg) continue;
    const result = classify(normalizeLicenseField(depPkg));
    if (result.status === 'permissive') continue;
    issues.push(buildLicenseIssue(name, depPkg.version || deps[name], result));
  }
  return issues;
}

// Returns an issues array, or null if licenses can't be checked at all
// (no package.json, or dependencies aren't installed — nothing under
// node_modules to read license data from without a network call).
function checkLicenses(rootPath) {
  const pkgJson = loadPackageJson(path.join(rootPath, 'package.json'));
  if (!pkgJson) return null;
  const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
  if (!Object.keys(deps).length) return [];

  const nodeModules = path.join(rootPath, 'node_modules');
  if (!fs.existsSync(nodeModules)) return null;

  return collectDependencyLicenseIssues(rootPath, deps);
}

module.exports = { checkLicenses, classify, PERMISSIVE, RESTRICTIVE };
