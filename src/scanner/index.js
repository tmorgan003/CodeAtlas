const fs = require('fs');
const path = require('path');
const { analyzeStructure, findSubPackages } = require('./structure');
const { listTopLevel, collectFiles, readFileSafe } = require('./walk');
const { extractComponentsFromFile } = require('./components');
const { detectDataModels } = require('./dataLayer');
const { detectRoutes } = require('./processFlows');
const { scanFile, checkKnownVulnerableDeps, findDeadCode } = require('./issues');
const { runNpmAudit } = require('./npmAudit');
const { buildEnrichment } = require('./deepMode');
const { CODE_EXTENSIONS, BINARY_EXTENSIONS, SKIP_FILES } = require('./ignore');
const customIgnore = require('./customIgnore');
const customSecretRules = require('./customSecretRules');
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

async function runScan(rootPath, meta, onProgress) {
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${rootPath}`);
  }

  const wikiDir = path.join(rootPath, 'wiki');
  wiki.ensureWikiDirs(wikiDir);

  const structureInfo = analyzeStructure(rootPath);
  const monorepoDepth = meta._monorepoDepth || 0;
  const subPackages = monorepoDepth < 2 ? findSubPackages(rootPath, structureInfo.topLevelDirs) : [];
  const directSubPackageDirs = new Set(subPackages.filter((p) => p.direct).map((p) => p.name));

  const unitNames = structureInfo.topLevelDirs.filter((d) => !directSubPackageDirs.has(d));
  if (structureInfo.topLevelFiles.length) unitNames.push('(root files)');

  const statusMap = {};
  unitNames.forEach((u) => { statusMap[u] = 'Not Started'; });
  wiki.initProgress(wikiDir, unitNames);

  // Feature: per-app custom ignore patterns (glob, edited from the UI). The
  // root app id is threaded through sub-package recursion (below) unchanged,
  // so a pattern set on the parent app also applies inside monorepo
  // sub-package scans, which otherwise run under their own synthetic id.
  const rootAppId = meta._rootAppId || meta.appId;
  const customPatterns = rootAppId ? customIgnore.loadPatterns(rootAppId) : [];
  // Feature: per-app masking rules (custom secret regex patterns, edited
  // from the UI) — same root-app-id cascade as the ignore patterns above,
  // so they also apply inside monorepo sub-package scans.
  const secretRules = rootAppId ? customSecretRules.loadRules(rootAppId) : [];
  const ctx = {
    allFileComponents: [], allModels: [], allRoutes: [], allIssues: [], envVars: new Set(),
    shouldIgnore: customPatterns.length ? (relPath) => customIgnore.matchesAnyPattern(relPath, customPatterns) : null,
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

  if (structureInfo.topLevelFiles.length) {
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

  for (const dirName of structureInfo.topLevelDirs) {
    if (directSubPackageDirs.has(dirName)) continue; // documented separately below, as its own sub-package wiki
    markInProgress(dirName);
    await documentDirectory(rootPath, wikiDir, path.join(rootPath, dirName), dirName, ctx, 0, cacheState, ownershipCtx);
    markDone(dirName);
  }

  saveCache(cacheKey, cacheState.newCache);
  if (onProgress) onProgress(`Incremental cache: ${cacheState.hits} file(s) reused, ${cacheState.misses} (re)processed.`);

  // Feature 9: monorepo support. Each detected sub-package gets its own
  // independent scan + wiki, keyed off its own cache/history so it doesn't
  // collide with the root's or its siblings'.
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

  // Cross-directory aggregation: dead-code check and dependency advisory need
  // the full project picture, so they run once after every unit is done.
  ctx.allIssues.push(...findDeadCode(ctx.allFileComponents, structureInfo.entryPoints));

  // Feature 14: dependency graph, persisted for the frontend's graph view.
  if (meta.appId) graph.saveGraph(meta.appId, graph.buildImportGraph(ctx.allFileComponents));

  const pkgJsonManifest = structureInfo.manifests.find((m) => m.file === 'package.json');
  if (pkgJsonManifest) {
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
  }

  const models = ctx.allModels;
  const routeGroups = wiki.groupRoutes(ctx.allRoutes);

  // Feature 11: issue triage. Loaded before writeIssues/Home so dismissed
  // findings drop out of the active count and CLI severity gating, while the
  // full (untouched) issue list still feeds history diffing below.
  const triageMap = meta.appId ? triage.loadTriage(meta.appId) : {};
  const activeIssues = ctx.allIssues.filter((i) => !triage.isDismissed(triageMap, i));

  let enrichment = null;
  if (meta.scanMode === 'deep') {
    if (onProgress) onProgress('Deep scan: asking Claude to enrich documentation (this can take a minute)...');
    enrichment = await buildEnrichment({ meta, structureInfo, routeGroups, models });
    if (!enrichment && onProgress) onProgress('Deep scan enrichment unavailable — falling back to static-only output.');
  }

  // Feature 12: editable data-dictionary overrides — human-written field
  // descriptions take priority over deep-scan prose and auto-detected
  // placeholders, and survive being regenerated every scan.
  const fieldOverrides = meta.appId ? dictionaryOverrides.loadOverrides(meta.appId) : {};
  for (const m of models) wiki.writeDataDictionaryPage(wikiDir, m, enrichment, fieldOverrides[m.name] || {});
  for (const g of routeGroups.groups) wiki.writeProcessFlowPage(wikiDir, g);

  // Feature 8: scan history + diffing (skipped when no appId, e.g. CLI runs
  // against an ad-hoc path with nothing to key history off of).
  let diff = null;
  if (meta.appId) {
    const scannedAt = new Date().toISOString();
    const snapshot = {
      scannedAt,
      stats: { units: unitNames.length, models: models.length, routes: ctx.allRoutes.length, issues: activeIssues.length },
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
    diff = history.diffSnapshots(previous, snapshot);
    wiki.writeChangeLog(wikiDir, diff, scannedAt);
    history.saveSnapshot(meta.appId, snapshot);
  }

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
    },
  };
}

module.exports = { runScan };
