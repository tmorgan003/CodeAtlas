// Security scanning coverage: OSV.dev (Open Source Vulnerabilities — run by
// Google/OpenSSF, the same database GitHub Advisory Database and PyPI's own
// advisories feed into) as a second, multi-ecosystem dependency-vulnerability
// source alongside npmAudit.js. npm audit only ever covers npm; this covers
// whatever ecosystems this app's manifests declare, which matters because
// CodeAtlas itself scans Python/Go/Ruby/Java/PHP repos with zero dependency-
// vulnerability coverage for any of them today.
//
// v1 ecosystem coverage is deliberately partial, same spirit as the rest of
// this codebase's honestly-scoped checks: npm (package.json + installed
// node_modules version, same technique licenseCheck.js already uses), PyPI
// (requirements.txt, simple `name==version` pins only — not
// poetry.lock/Pipfile.lock's richer formats), and Go (go.mod require block).
// Ruby/Java/PHP manifests aren't parsed yet.
//
// Same graceful-degradation contract as npmAudit.js: returns null (never
// throws) on any network/parse failure so the caller can fall back cleanly,
// and never blocks the scan on OSV being slow or unreachable.

const fs = require('fs');
const path = require('path');
const https = require('https');

const MAX_ISSUES = 30;
const MAX_QUERIES_PER_BATCH = 500; // OSV's own batch endpoint caps at 1000; stay well under it
const REQUEST_TIMEOUT_MS = 15000;

function requestJson(method, reqPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
    const req = https.request(
      { hostname: 'api.osv.dev', path: reqPath, method, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`OSV HTTP ${res.statusCode}`)); return; }
          try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OSV request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// npm: read the actually-installed version from node_modules rather than the
// declared range in package.json — a range like "^4.17.20" isn't a version
// OSV can check, and licenseCheck.js already established this is how to get
// the real installed version without a network call.
function collectNpmDeps(rootPath) {
  const pkgJsonPath = path.join(rootPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return [];
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return [];
  }
  const names = Object.keys({ ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) });
  const nodeModules = path.join(rootPath, 'node_modules');
  if (!fs.existsSync(nodeModules)) return [];
  const deps = [];
  for (const name of names) {
    const depPkgPath = path.join(nodeModules, name, 'package.json');
    if (!fs.existsSync(depPkgPath)) continue;
    try {
      const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
      if (depPkg.version) deps.push({ name, version: depPkg.version, ecosystem: 'npm', manifest: 'package.json' });
    } catch { /* skip unreadable/invalid dependency manifest */ }
  }
  return deps;
}

// requirements.txt only — exact pins (`name==1.2.3`) only, since that's the
// only form that gives OSV a specific version to check. Lines with a range
// (`>=`, `~=`, unpinned) are skipped rather than guessed at.
function collectPipDeps(rootPath) {
  const reqPath = path.join(rootPath, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(reqPath, 'utf8');
  } catch {
    return [];
  }
  const deps = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const m = trimmed.match(/^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9.]+)/);
    if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'PyPI', manifest: 'requirements.txt' });
  }
  return deps;
}

// go.mod's `require` block: either a single `require module v1.2.3` line or
// a `require (\n  module v1.2.3\n  ...\n)` block — both share the same
// `module version` shape once the surrounding `require`/parens are stripped.
function collectGoDeps(rootPath) {
  const goModPath = path.join(rootPath, 'go.mod');
  if (!fs.existsSync(goModPath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(goModPath, 'utf8');
  } catch {
    return [];
  }
  const deps = [];
  const lineRe = /^\s*([\w.\-/]+\.[\w.\-]+\/[\w.\-/]+)\s+(v[\d][\w.\-+]*)/gm;
  let m;
  while ((m = lineRe.exec(raw))) {
    deps.push({ name: m[1], version: m[2], ecosystem: 'Go', manifest: 'go.mod' });
  }
  return deps;
}

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MEDIUM: 2, LOW: 3 };

// OSV's per-vuln `severity` field (when present) is a raw CVSS vector
// string, not a plain word or number — parsing a vector into a score is
// more machinery than this needs, so severity comes from the
// database_specific.severity label GHSA/OSV sources attach directly instead.
function classifySeverity(vuln) {
  const dbSpecific = (vuln.database_specific && vuln.database_specific.severity) || '';
  const rank = SEVERITY_RANK[String(dbSpecific).toUpperCase()];
  if (rank === 0) return 'Critical';
  if (rank === 1) return 'High';
  if (rank === 2) return 'Medium';
  if (rank === 3) return 'Low';
  return 'Medium'; // unknown/unlabeled — conservative middle default, same as npmAudit.js's fallback
}

async function fetchOsvBatchResults(deps) {
  const queries = deps.slice(0, MAX_QUERIES_PER_BATCH).map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version }));
  let batchResult;
  try {
    batchResult = await requestJson('POST', '/v1/querybatch', { queries });
  } catch {
    return null;
  }
  return batchResult && Array.isArray(batchResult.results) ? batchResult.results : null;
}

// The batch endpoint returns vuln IDs only (no summary/severity) — collect
// only the packages that actually had a hit, so the per-vuln detail fetch
// below stays cheap for the common case (most dependencies have zero vulns).
function collectOsvHits(deps, results) {
  const hits = [];
  for (let i = 0; i < results.length && hits.length < MAX_ISSUES; i++) {
    const vulnIds = (results[i].vulns || []).map((v) => v.id);
    if (vulnIds.length) hits.push({ dep: deps[i], vulnIds: vulnIds.slice(0, 3) });
  }
  return hits;
}

async function fetchOsvVulnDetail(id) {
  try {
    return await requestJson('GET', `/v1/vulns/${encodeURIComponent(id)}`);
  } catch {
    return null; // detail fetch failed for this one ID — skip it, not the whole scan
  }
}

function buildOsvIssue(dep, id, vuln) {
  const summary = vuln.summary || vuln.details?.slice(0, 200) || 'No summary provided by the advisory.';
  return {
    file: dep.manifest,
    line: 1,
    severity: classifySeverity(vuln),
    category: 'Outdated/Vulnerable Dependency',
    source: 'dependency-audit',
    summary: `${dep.name}@${dep.version} (${dep.ecosystem}) — ${id}: ${summary}`,
    suggestedFix: `Upgrade ${dep.name} past the affected range. (Live data from OSV.dev — see https://osv.dev/vulnerability/${encodeURIComponent(id)} for the full advisory.)`,
  };
}

async function buildOsvIssuesFromHits(hits) {
  const issues = [];
  for (const { dep, vulnIds } of hits) {
    for (const id of vulnIds) {
      if (issues.length >= MAX_ISSUES) break;
      const vuln = await fetchOsvVulnDetail(id);
      if (!vuln) continue;
      issues.push(buildOsvIssue(dep, id, vuln));
    }
  }
  return issues;
}

async function runOsvScan(rootPath) {
  const deps = [...collectNpmDeps(rootPath), ...collectPipDeps(rootPath), ...collectGoDeps(rootPath)];
  if (!deps.length) return null;

  const results = await fetchOsvBatchResults(deps);
  if (!results) return null;

  const hits = collectOsvHits(deps, results);
  if (!hits.length) return [];

  return buildOsvIssuesFromHits(hits);
}

module.exports = { runOsvScan };
