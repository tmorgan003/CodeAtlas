const fs = require('fs');
const path = require('path');
const { analyzeStructure, findSubPackages } = require('./structure');
const { listTopLevel, collectFiles, readFileSafe } = require('./walk');
const { extractComponentsFromFile } = require('./components');
const { detectDataModels } = require('./dataLayer');
const { detectRoutes } = require('./processFlows');
const { scanFile, checkKnownVulnerableDeps, findDeadCode, attachCweInfo } = require('./issues');
const { runNpmAudit } = require('./npmAudit');
const { runOsvScan } = require('./osvScan');
const { checkLicenses } = require('./licenseCheck');
const { buildEnrichment, proposeFixDiffs } = require('./deepMode');
const { CODE_EXTENSIONS, BINARY_EXTENSIONS, SKIP_FILES } = require('./ignore');
const customIgnore = require('./customIgnore');
const customSecretRules = require('./customSecretRules');
const gitignoreParser = require('./gitignoreParser');
const suppressionRules = require('./suppressionRules');
const { cacheKeyFor, hashContent, loadCache, saveCache } = require('./cache');
const history = require('./history');
const triage = require('./triage');
const dictionaryOverrides = require('./dictionaryOverrides');
const graph = require('./graph');
const { createOwnershipContext } = require('./ownership');
const wiki = require('./wikiWriter');

const MAX_FILES_PER_UNIT = 60;
const MAX_SPLIT_DEPTH = 3;

function detectEnvVars(content) {
  const vars = new Set();
  let m;
  const jsRe = /process\.env\.(\w+)/g;
  while ((m = jsRe.exec(content))) vars.add(m[1]);
  const pyRe = /os\.(?:environ\.get|getenv)\(\s*['"](\w+)['"]/g;
  while ((m = pyRe.exec(content))) vars.add(m[1]);
  return vars;
}

function applyResult(ctx, result) {
  if (result.fc) ctx.allFileComponents.push(result.fc);
  ctx.allModels.push(...result.models);
  ctx.allRoutes.push(...result.routes);
  ctx.allIssues.push(...result.issues);
  for (const v of result.envVars) ctx.envVars.add(v);
}

// Incremental rescans (feature 7): a fast path skips even reading the file
// when size+mtime match the last scan; a slower fallback compares content
// hash for cases where mtime isn't trustworthy (e.g. a fresh git clone reset
// every file's mtime) but the content itself hasn't changed.
function processFile(relPath, absPath, ext, ctx, cacheState) {
  const baseName = path.basename(relPath);
  if (BINARY_EXTENSIONS.has(ext) || SKIP_FILES.has(baseName)) return null;
  if (ctx.shouldIgnore && ctx.shouldIgnore(relPath)) return null;

  const { cache, newCache } = cacheState;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }

  const cached = cache[relPath];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    newCache[relPath] = cached;
    cacheState.hits++;
    applyResult(ctx, cached.result);
    return cached.result.fc;
  }

  const content = readFileSafe(absPath);
  if (content === null) return null;
  const hash = hashContent(content);

  if (cached && cached.hash === hash) {
    newCache[relPath] = { size: stat.size, mtimeMs: stat.mtimeMs, hash, result: cached.result };
    cacheState.hits++;
    applyResult(ctx, cached.result);
    return cached.result.fc;
  }

  cacheState.misses++;
  const fc = CODE_EXTENSIONS.has(ext) ? extractComponentsFromFile(relPath, content, ext) : null;
  const result = {
    fc,
    models: detectDataModels(relPath, content, ext),
    routes: detectRoutes(relPath, content, ext),
    issues: scanFile(relPath, content, ext, ctx.customSecretRules),
    envVars: [...detectEnvVars(content)],
  };
  newCache[relPath] = { size: stat.size, mtimeMs: stat.mtimeMs, hash, result };
  applyResult(ctx, result);
  return fc;
}

async function documentDirectory(rootPath, wikiDir, unitAbsPath, unitLabel, ctx, depth, cacheState, ownershipCtx) {
  const allFiles = collectFiles(rootPath, unitAbsPath);
  if (allFiles.length > MAX_FILES_PER_UNIT && depth < MAX_SPLIT_DEPTH) {
    const { dirs, files } = listTopLevel(unitAbsPath);
    const directFileComponents = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      const abs = path.join(unitAbsPath, f);
      const rel = path.relative(rootPath, abs).split(path.sep).join('/');
      const fc = processFile(rel, abs, ext, ctx, cacheState);
      if (fc) directFileComponents.push(fc);
    }
    await wiki.writeComponentPage(wikiDir, unitLabel, directFileComponents, ownershipCtx);
    for (const d of dirs) {
      await documentDirectory(rootPath, wikiDir, path.join(unitAbsPath, d), `${unitLabel}/${d}`, ctx, depth + 1, cacheState, ownershipCtx);
    }
  } else {
    const fileComponents = [];
    for (const f of allFiles) {
      const fc = processFile(f.relPath, f.absPath, f.ext, ctx, cacheState);
      if (fc) fileComponents.push(fc);
    }
    await wiki.writeComponentPage(wikiDir, unitLabel, fileComponents, ownershipCtx);
  }
}

// Extracted from runScan (was a single ~320-line function with cyclomatic
// complexity 52) purely as a readability split — each helper below owns one
// phase of the scan pipeline and mutates the shared `ctx`/wiki side effects
// exactly as the inline code used to. No behavior changes.

function computeUnitNames(structureInfo, subPackages) {
  const directSubPackageDirs = new Set(subPackages.filter((p) => p.direct).map((p) => p.name));
  const unitNames = structureInfo.topLevelDirs.filter((d) => !directSubPackageDirs.has(d));
  if (structureInfo.topLevelFiles.length) unitNames.push('(root files)');
  return { unitNames, directSubPackageDirs };
}

// Feature: per-app custom ignore patterns + masking rules (edited from the
// UI), cascaded to monorepo sub-package scans via rootAppId; and the
// scanned app's own .gitignore (see gitignoreParser.js).
function loadScanConfig(rootPath, meta) {
  const rootAppId = meta._rootAppId || meta.appId;
  const customPatterns = rootAppId ? customIgnore.loadPatterns(rootAppId) : [];
  const secretRules = rootAppId ? customSecretRules.loadRules(rootAppId) : [];
  const gitignorePatterns = gitignoreParser.loadGitignorePatterns(rootPath);
  const shouldIgnoreCustom = customPatterns.length ? (relPath) => customIgnore.matchesAnyPattern(relPath, customPatterns) : null;
  const shouldIgnoreGit = gitignorePatterns.length ? (relPath) => gitignoreParser.matchesGitignore(relPath, gitignorePatterns) : null;
  const shouldIgnore = (shouldIgnoreCustom || shouldIgnoreGit)
    ? (relPath) => !!((shouldIgnoreCustom && shouldIgnoreCustom(relPath)) || (shouldIgnoreGit && shouldIgnoreGit(relPath)))
    : null;
  return { rootAppId, secretRules, shouldIgnore };
}

async function processRootFiles(rootPath, wikiDir, structureInfo, ctx, cacheState, ownershipCtx, markInProgress, markDone) {
  if (!structureInfo.topLevelFiles.length) return;
  markInProgress('(root files)');
  const fileComponents = [];
  for (const f of structureInfo.topLevelFiles) {
    const abs = path.join(rootPath, f);
    const ext = path.extname(f).toLowerCase();
    const fc = processFile(f, abs, ext, ctx, cacheState);
    if (fc) fileComponents.push(fc);
  }
  await wiki.writeComponentPage(wikiDir, '(root files)', fileComponents, ownershipCtx);
  markDone('(root files)');
}

async function processTopLevelDirs(rootPath, wikiDir, structureInfo, directSubPackageDirs, ctx, cacheState, ownershipCtx, markInProgress, markDone) {
  for (const dirName of structureInfo.topLevelDirs) {
    if (directSubPackageDirs.has(dirName)) continue; // documented separately below, as its own sub-package wiki
    markInProgress(dirName);
    await documentDirectory(rootPath, wikiDir, path.join(rootPath, dirName), dirName, ctx, 0, cacheState, ownershipCtx);
    markDone(dirName);
  }
}

// Feature 9: monorepo support. Each detected sub-package gets its own
// independent scan + wiki, keyed off its own cache/history so it doesn't
// collide with the root's or its siblings'.
async function scanSubPackages(subPackages, meta, monorepoDepth, rootAppId, onProgress) {
  const packages = [];
  for (const pkg of subPackages) {
    if (onProgress) onProgress(`Scanning sub-package ${pkg.name}...`);
    try {
      const subMeta = {
        ...meta,
        name: meta.name ? `${meta.name} / ${pkg.name}` : pkg.name,
        appId: meta.appId ? `${meta.appId}__${pkg.relPath.replace(/\//g, '-')}` : undefined,
        _monorepoDepth: monorepoDepth + 1,
        _rootAppId: rootAppId,
      };
      const subResult = await runScan(pkg.absPath, subMeta, onProgress);
      packages.push({ name: pkg.name, wikiLink: `../${pkg.relPath}/wiki/Home.md`, stats: subResult.stats, error: null });
    } catch (err) {
      packages.push({ name: pkg.name, wikiLink: null, stats: null, error: String((err && err.message) || err) });
    }
  }
  return packages;
}

// Live `npm audit` with a static-advisory-list fallback, plus license
// compliance — both gated on a package.json actually existing. Returns the
// manifest (or undefined) so the OSV check below can tell whether dependency
// coverage was already attempted.
async function runNpmAuditAndLicenses(rootPath, structureInfo, ctx, onProgress) {
  const pkgJsonManifest = structureInfo.manifests.find((m) => m.file === 'package.json');
  if (!pkgJsonManifest) return pkgJsonManifest;

  if (onProgress) onProgress('Checking dependencies for known vulnerabilities...');
  const liveAudit = await runNpmAudit(rootPath);
  if (liveAudit) {
    ctx.allIssues.push(...liveAudit);
  } else {
    const raw = readFileSafe(path.join(rootPath, 'package.json'));
    if (raw) {
      ctx.allIssues.push(...checkKnownVulnerableDeps(rootPath, 'package.json', raw));
      ctx.allIssues.push({
        file: 'package.json',
        line: 1,
        severity: 'Low',
        category: 'Scan Limitation',
        source: 'dependency-audit',
        summary: '`npm audit` could not be run (offline, npm missing, or no network access) — dependency findings above are from a small built-in advisory list, not live data.',
        suggestedFix: 'Run `npm audit` manually on this machine for full, current vulnerability coverage.',
      });
    }
  }

  // Feature 15: license compliance — flags copyleft, missing, or
  // unrecognized dependency licenses. Reads node_modules directly, so it
  // needs dependencies actually installed (no network call either way).
  if (onProgress) onProgress('Checking dependency licenses...');
  const licenseIssues = checkLicenses(rootPath);
  if (licenseIssues) {
    ctx.allIssues.push(...licenseIssues);
  } else {
    ctx.allIssues.push({
      file: 'package.json',
      line: 1,
      severity: 'Low',
      category: 'Scan Limitation',
      source: 'dependency-audit',
      summary: 'License compliance could not be checked — dependencies are not installed (no node_modules found).',
      suggestedFix: 'Run `npm install` on this machine, then rescan for license compliance coverage.',
    });
  }

  return pkgJsonManifest;
}

// Security scanning coverage: OSV.dev as a second, multi-ecosystem
// dependency-vulnerability source (npm, PyPI, Go — see osvScan.js) run
// alongside npm audit above rather than instead of it, since OSV/GHSA
// sometimes carries an advisory before it lands in npm's own database.
// Unlike the npm-audit/license block above, this isn't gated on a
// package.json existing — it's the only dependency-vulnerability coverage
// a Python or Go app gets at all today.
async function runOsvDependencyCheck(rootPath, structureInfo, ctx, pkgJsonManifest, onProgress) {
  if (onProgress) onProgress('Checking dependencies against OSV.dev...');
  const osvIssues = await runOsvScan(rootPath);
  if (osvIssues) {
    ctx.allIssues.push(...osvIssues);
  } else if (!pkgJsonManifest) {
    // Only note the limitation when npm audit above didn't already cover
    // this — otherwise a static.md app gets two near-identical "couldn't
    // check dependencies" issues for the same underlying reason.
    ctx.allIssues.push({
      file: structureInfo.manifests[0]?.file || '(no manifest found)',
      line: 1,
      severity: 'Low',
      category: 'Scan Limitation',
      source: 'dependency-audit',
      summary: 'OSV.dev dependency check could not run — no supported manifest (package.json, requirements.txt, go.mod) was found, or the OSV.dev API was unreachable.',
      suggestedFix: 'OSV.dev coverage is currently limited to npm, PyPI (requirements.txt exact pins), and Go (go.mod) manifests.',
    });
  }
}

async function runDeepModeEnrichment(meta, structureInfo, routeGroups, models, ctx, activeIssues, rootPath, onProgress) {
  if (meta.scanMode !== 'deep') return null;

  if (onProgress) onProgress('Deep scan: asking Claude to enrich documentation (this can take a minute)...');
  const enrichment = await buildEnrichment({ meta, structureInfo, routeGroups, models });
  if (!enrichment && onProgress) onProgress('Deep scan enrichment unavailable — falling back to static-only output.');

  // Junior-developer learning path: propose an actual code diff (not just
  // prose) for the small set of findings a mechanical fix usually covers.
  // Same "never blocks the static output" contract as enrichment above —
  // a failure here just means no proposed diffs this scan.
  if (onProgress) onProgress('Deep scan: proposing fixes for common findings...');
  const proposals = await proposeFixDiffs(activeIssues, (relPath) => readFileSafe(path.join(rootPath, relPath)));
  if (Object.keys(proposals).length) {
    for (const issue of ctx.allIssues) {
      const key = `${issue.category}::${issue.file}::${issue.line}::${issue.summary}`;
      if (proposals[key]) issue.proposedFix = proposals[key];
    }
  }
  return enrichment;
}

// Feature 8: scan history + diffing (skipped when no appId, e.g. CLI runs
// against an ad-hoc path with nothing to key history off of). Returns the
// diff so the caller can include it in the scan result.
function buildAndSaveHistorySnapshot(meta, wikiDir, unitNames, models, ctx, activeIssues, routeGroups, structureInfo, durationMs, filesProcessed) {
  if (!meta.appId) return null;
  const scannedAt = new Date().toISOString();
  const snapshot = {
    scannedAt,
    stats: {
      units: unitNames.length, models: models.length, routes: ctx.allRoutes.length, issues: activeIssues.length,
      durationMs, filesProcessed,
    },
    issues: ctx.allIssues,
    routes: ctx.allRoutes.map((r) => ({ method: r.method, path: r.path, file: r.file })),
    // Feature: real process-flow diagrams. The richer per-route detail
    // (handler, step trace, which Process-Flow group it belongs to) only
    // ever existed transiently during the scan and got flattened straight
    // into Process-Flows/*.md — nothing structured to build a diagram
    // from. Persisted separately (not merged into `routes` above) so
    // existing consumers of the plain {method,path,file} shape are
    // unaffected.
    processFlowGroups: routeGroups.groups.map((g) => ({
      name: g.name,
      slug: g.slug,
      routes: g.routes.map((r) => ({
        method: r.method, path: r.path, file: r.file, line: r.line,
        handlerName: r.handlerName, traced: r.traced, steps: r.steps,
      })),
    })),
    entryPoints: structureInfo.entryPoints,
    models: models.map((m) => ({ name: m.name, source: m.source, file: m.file, fields: m.fields, relationships: m.relationships })),
    // Feature 8: auto-detected frameworks/ecosystems, so a portfolio-wide
    // tech stack view can group apps by what they actually use instead of
    // relying only on the free-text techStack field.
    frameworks: structureInfo.frameworks,
    ecosystems: [...new Set(structureInfo.manifests.map((m) => m.ecosystem))],
    // Feature 13: persisted so the Setup tab's env var list can be shown
    // (and annotated) through the interactive API instead of only as a
    // static Setup.md bullet list.
    envVars: [...ctx.envVars].sort(),
  };
  const previous = history.getLatestSnapshot(meta.appId);
  const diff = history.diffSnapshots(previous, snapshot);
  wiki.writeChangeLog(wikiDir, diff, scannedAt);
  history.saveSnapshot(meta.appId, snapshot);
  return diff;
}

async function runScan(rootPath, meta, onProgress) {
  // Feature 14: scan performance metrics — measured around this whole
  // function so a monorepo root's duration naturally includes the time
  // spent awaiting its sub-package scans (real wall-clock time the user
  // waited), while each sub-package's own recursive runScan call gets its
  // own independent measurement too.
  const scanStartedAt = Date.now();

  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${rootPath}`);
  }

  const wikiDir = path.join(rootPath, 'wiki');
  wiki.ensureWikiDirs(wikiDir);

  const structureInfo = analyzeStructure(rootPath);
  const monorepoDepth = meta._monorepoDepth || 0;
  const subPackages = monorepoDepth < 2 ? findSubPackages(rootPath, structureInfo.topLevelDirs) : [];
  const { unitNames, directSubPackageDirs } = computeUnitNames(structureInfo, subPackages);

  const statusMap = {};
  unitNames.forEach((u) => { statusMap[u] = 'Not Started'; });
  wiki.initProgress(wikiDir, unitNames);

  const { rootAppId, secretRules, shouldIgnore } = loadScanConfig(rootPath, meta);
  const ctx = {
    allFileComponents: [], allModels: [], allRoutes: [], allIssues: [], envVars: new Set(),
    shouldIgnore,
    customSecretRules: secretRules,
  };

  const cacheKey = cacheKeyFor(meta.appId, rootPath);
  const cacheState = { cache: loadCache(cacheKey), newCache: {}, hits: 0, misses: 0 };

  const markInProgress = (u) => {
    statusMap[u] = 'In Progress';
    wiki.updateProgress(wikiDir, unitNames, statusMap);
    if (onProgress) onProgress(`Scanning ${u}...`);
  };
  const markDone = (u) => {
    statusMap[u] = 'Done';
    wiki.updateProgress(wikiDir, unitNames, statusMap);
  };

  // Feature 20: CODEOWNERS/git-blame ownership. CODEOWNERS is loaded once
  // up front (cheap, doesn't depend on scan results); git-blame lookups
  // happen lazily per file inside writeComponentPage, capped globally via
  // ownershipCtx.gitBlameCallsUsed so a huge repo with no CODEOWNERS file
  // doesn't turn every scan into hundreds of `git log` spawns.
  const ownershipCtx = createOwnershipContext(rootPath);

  await processRootFiles(rootPath, wikiDir, structureInfo, ctx, cacheState, ownershipCtx, markInProgress, markDone);
  await processTopLevelDirs(rootPath, wikiDir, structureInfo, directSubPackageDirs, ctx, cacheState, ownershipCtx, markInProgress, markDone);

  saveCache(cacheKey, cacheState.newCache);
  if (onProgress) onProgress(`Incremental cache: ${cacheState.hits} file(s) reused, ${cacheState.misses} (re)processed.`);

  const packages = await scanSubPackages(subPackages, meta, monorepoDepth, rootAppId, onProgress);

  // Cross-directory aggregation: dead-code check and dependency advisory need
  // the full project picture, so they run once after every unit is done.
  ctx.allIssues.push(...findDeadCode(ctx.allFileComponents, structureInfo.entryPoints));

  // Feature 14: dependency graph, persisted for the frontend's graph view.
  if (meta.appId) graph.saveGraph(meta.appId, graph.buildImportGraph(ctx.allFileComponents));

  const pkgJsonManifest = await runNpmAuditAndLicenses(rootPath, structureInfo, ctx, onProgress);
  await runOsvDependencyCheck(rootPath, structureInfo, ctx, pkgJsonManifest, onProgress);

  const models = ctx.allModels;
  const routeGroups = wiki.groupRoutes(ctx.allRoutes);

  // Security scanning coverage: attach a CWE/OWASP citation + a short "why
  // this matters" explanation to every issue whose category maps to a real
  // vulnerability class — one pass over the fully-assembled list rather than
  // threading this through every individual check, so it applies uniformly
  // to static findings, npmAudit.js, and osvScan.js results alike.
  ctx.allIssues = attachCweInfo(ctx.allIssues);

  // Feature 11: issue triage. Loaded before writeIssues/Home so dismissed
  // findings drop out of the active count and CLI severity gating, while the
  // full (untouched) issue list still feeds history diffing below.
  const triageMap = meta.appId ? triage.loadTriage(meta.appId) : {};
  const appSuppressionRules = meta.appId ? suppressionRules.loadRules(meta.appId) : [];
  const activeIssues = ctx.allIssues.filter((i) => !triage.isDismissed(triageMap, i, appSuppressionRules));

  const enrichment = await runDeepModeEnrichment(meta, structureInfo, routeGroups, models, ctx, activeIssues, rootPath, onProgress);

  // Feature 12: editable data-dictionary overrides — human-written field
  // descriptions take priority over deep-scan prose and auto-detected
  // placeholders, and survive being regenerated every scan.
  const fieldOverrides = meta.appId ? dictionaryOverrides.loadOverrides(meta.appId) : {};
  for (const m of models) wiki.writeDataDictionaryPage(wikiDir, m, enrichment, fieldOverrides[m.name] || {});
  for (const g of routeGroups.groups) wiki.writeProcessFlowPage(wikiDir, g);

  const durationMs = Date.now() - scanStartedAt;
  const filesProcessed = cacheState.hits + cacheState.misses;
  const diff = buildAndSaveHistorySnapshot(meta, wikiDir, unitNames, models, ctx, activeIssues, routeGroups, structureInfo, durationMs, filesProcessed);

  wiki.writeDataModel(wikiDir, models, routeGroups);
  wiki.writeIssues(wikiDir, ctx.allIssues, triageMap);
  wiki.writeArchitecture(wikiDir, { structureInfo, routeGroups, modelCount: models.length, enrichment });
  wiki.writeSetup(wikiDir, { structureInfo, envVars: [...ctx.envVars].sort(), meta });
  wiki.writeHome(wikiDir, {
    meta,
    structureInfo,
    unitNames,
    modelCount: models.length,
    routeCount: ctx.allRoutes.length,
    issueCount: activeIssues.length,
    enrichment,
    packages,
    hasChangeLog: !!meta.appId,
  });

  return {
    wikiDir,
    wikiHomeRelPath: 'wiki/Home.md',
    issuesList: activeIssues,
    diff,
    stats: {
      units: unitNames.length,
      models: models.length,
      routes: ctx.allRoutes.length,
      issues: activeIssues.length,
      dismissedIssues: ctx.allIssues.length - activeIssues.length,
      cacheHits: cacheState.hits,
      cacheMisses: cacheState.misses,
      durationMs,
      filesProcessed,
    },
  };
}

module.exports = { runScan };
