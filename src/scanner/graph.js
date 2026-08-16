// Feature 14: import/dependency graph. Resolves each file's relative
// imports into real project-relative paths (shared with the dead-code
// detector in issues.js — same resolution logic, single source of truth)
// and builds a { nodes, edges } graph, persisted per app so the frontend
// can fetch and render it without re-scanning.

const fs = require('fs');
const path = require('path');

const GRAPH_DIR = path.join(__dirname, '..', '..', 'data', 'graphs');

// Resolves a relative import string (e.g. "../scanner", "./ignore") against
// the importing file's own path into a project-relative path, the same way
// Node/bundler module resolution would (minus package.json "exports" maps).
// Returns null for non-relative imports (npm packages).
function resolveRelativeImport(fromRelPath, importPath) {
  if (!importPath.startsWith('.')) return null;
  const fromDir = fromRelPath.includes('/') ? fromRelPath.slice(0, fromRelPath.lastIndexOf('/')) : '';
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of importPath.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const RESOLVE_SUFFIXES = ['', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '/index.js', '/index.ts', '/__init__.py'];

function buildImportGraph(allFileComponents) {
  const existing = new Set(allFileComponents.map((fc) => fc.relPath));
  const nodes = allFileComponents.map((fc) => ({
    id: fc.relPath,
    functions: fc.functions.length,
    classes: fc.classes.length,
  }));
  const edgeSet = new Set();
  const edges = [];
  for (const fc of allFileComponents) {
    for (const imp of fc.imports || []) {
      const resolvedBase = resolveRelativeImport(fc.relPath, imp);
      if (resolvedBase === null) continue;
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = resolvedBase + suffix;
        if (existing.has(candidate) && candidate !== fc.relPath) {
          const key = `${fc.relPath}=>${candidate}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from: fc.relPath, to: candidate });
          }
          break;
        }
      }
    }
  }
  return { nodes, edges };
}

function saveGraph(appId, graph) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  fs.writeFileSync(path.join(GRAPH_DIR, `${appId}.json`), JSON.stringify(graph), 'utf8');
}

function loadGraph(appId) {
  const file = path.join(GRAPH_DIR, `${appId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { resolveRelativeImport, RESOLVE_SUFFIXES, buildImportGraph, saveGraph, loadGraph };
