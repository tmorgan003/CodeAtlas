// Process-flow diagrams: statically traces each detected entry point's
// (route/handler) direct calls, then one or two hops into local or
// project-imported functions, stopping at anything that looks like it
// leaves the app (database/HTTP/filesystem/queue) or once the node budget
// is spent. Fully static — nothing from the scanned app is ever executed.
//
// Reuses components.js's AST pass rather than adding a second parser: every
// named function's `calls` list (see components.js) was already collected
// during the normal per-file scan and flows through the same incremental
// cache, so this stage is just graph traversal over already-computed data —
// cheap even on a large repo.
//
// The one thing components.js's named-function extraction can't see is an
// *inline* handler passed directly as a route-registration argument (the
// common `app.get('/x', (req, res) => {...})` shape) — those aren't a
// function/variable/class-member declaration, so they're invisible to that
// pass. This module re-parses just the entry point's own file to locate
// that specific inline handler when needed (findRouteHandlerNode below);
// every further hop is a named function and uses the already-collected data.

const ts = require('typescript');
const { resolveRelativeImport, RESOLVE_SUFFIXES } = require('./graph');

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS,
};
const JS_EXT = new Set(Object.keys(SCRIPT_KIND));

const MAX_NODES = 25;
const MAX_DEPTH = 2; // hops beyond the entry point's own direct calls

// ---- External-call classification ----
// Narrow, high-confidence patterns only (same philosophy as the rest of the
// scanner's checks) — an unresolved call to some other third-party helper
// is skipped rather than guessed at (see classifyCall).
const EXTERNAL_PATTERNS = [
  { re: /\.(findMany|findFirst|findUnique|findById|findOne|findAll|query|execute|aggregate)$/i, label: 'Database call' },
  { re: /^(axios|fetch|got|superagent)(\.|$)/i, label: 'Outbound HTTP call' },
  { re: /^https?\.request$/i, label: 'Outbound HTTP call' },
  { re: /^fs(Promises)?\./, label: 'File I/O' },
  { re: /\.(readFile|writeFile|readFileSync|writeFileSync|unlink|mkdir)$/i, label: 'File I/O' },
  { re: /\.(publish|sendMessage|produce)$/i, label: 'Queue/event publish' },
];

function classifyExternal(callee) {
  for (const p of EXTERNAL_PATTERNS) {
    if (p.re.test(callee)) return p.label;
  }
  return null;
}

function baseIdentifier(callee) {
  const m = callee.match(/^[A-Za-z_$][\w$]*/);
  return m ? m[0] : callee;
}

function memberName(callee) {
  const parts = callee.split('.');
  return parts.length > 1 ? parts[1] : null;
}

function findFunctionByName(fc, name) {
  if (!fc || !name) return null;
  return fc.functions.find((f) => f.name === name || f.name.endsWith('.' + name)) || null;
}

function findFileComponents(allFileComponents, relPath) {
  return allFileComponents.find((fc) => fc.relPath === relPath) || null;
}

// Resolves an imported local binding name back to the project file it was
// imported from — null for an npm package, a file this scan didn't index,
// or a name that isn't actually an import binding in this file.
function resolveImportedFile(fc, calleeBase, allFileComponents) {
  const binding = (fc.importBindings || []).find((b) => b.local === calleeBase);
  if (!binding) return null;
  const resolvedBase = resolveRelativeImport(fc.relPath, binding.source);
  if (resolvedBase === null) return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    const targetFc = findFileComponents(allFileComponents, resolvedBase + suffix);
    if (targetFc) return targetFc;
  }
  return null;
}

// Classifies one call made from within `fc` — external (leaves the app),
// local (same file), imported (resolves to a project file/function), an
// opaque project reference (resolves to a project file but not to a
// specific function this scan indexed, e.g. a namespace method it can't
// pin down), or null (an unresolved third-party call — not modeled, so the
// diagram stays high-confidence instead of guessing).
function classifyCall(callee, fc, allFileComponents) {
  const external = classifyExternal(callee);
  if (external) return { kind: 'external', label: external };

  const base = baseIdentifier(callee);
  const localFn = findFunctionByName(fc, callee) || findFunctionByName(fc, base);
  if (localFn) return { kind: 'local', fc, fn: localFn };

  const targetFc = resolveImportedFile(fc, base, allFileComponents);
  if (targetFc) {
    const member = memberName(callee);
    const fn = findFunctionByName(targetFc, member) || findFunctionByName(targetFc, base);
    if (fn) return { kind: 'imported', fc: targetFc, fn };
    return { kind: 'opaque-project', label: targetFc.relPath };
  }
  return null;
}

// ---- Locating an entry point's own handler body ----

function isFunctionLikeNode(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

function collectDirectCalls(bodyNode, sourceFile) {
  const calls = [];
  function walk(n, isRoot) {
    if (!isRoot && isFunctionLikeNode(n)) return;
    if (ts.isCallExpression(n)) {
      calls.push({ callee: n.expression.getText(sourceFile), line: sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(n, (child) => walk(child, false));
  }
  walk(bodyNode, true);
  return calls;
}

const ROUTE_CALL_VERB_RE = /\.(get|post|put|patch|delete|all)$/i;

// Finds the inline handler argument of the exact route-registration call at
// `line` (e.g. `app.get('/x', (req, res) => {...})`) — the case
// components.js's declaration-only extraction can't see. Returns null (not
// this style of handler) rather than guessing at a nearby function.
function findRouteHandlerNode(sourceFile, line) {
  let found = null;
  function visit(node) {
    if (!found && ts.isCallExpression(node)) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (startLine === line && ts.isPropertyAccessExpression(node.expression) && ROUTE_CALL_VERB_RE.test(node.expression.getText(sourceFile))) {
        const lastArg = node.arguments[node.arguments.length - 1];
        if (lastArg && isFunctionLikeNode(lastArg)) found = lastArg;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

// Returns { calls } for the entry point's own handler, trying the inline
// AST lookup first and falling back to a named function already indexed by
// components.js (the `app.get('/x', myHandler)` style).
function locateEntryCalls(route, allFileComponents, readFile) {
  const ext = '.' + route.file.split('.').pop();
  if (JS_EXT.has(ext) && readFile) {
    const content = readFile(route.file);
    if (content) {
      try {
        const sourceFile = ts.createSourceFile(route.file, content, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext]);
        const node = findRouteHandlerNode(sourceFile, route.line);
        if (node && node.body) return { calls: collectDirectCalls(node.body, sourceFile) };
      } catch {
        // fall through to the named-function lookup below
      }
    }
  }
  const fc = findFileComponents(allFileComponents, route.file);
  const fn = findFunctionByName(fc, route.handlerName);
  return fn ? { calls: fn.calls || [] } : null;
}

// ---- Trace assembly ----

function traceRoute(route, allFileComponents, readFile) {
  const nodes = [];
  const edges = [];
  let truncated = false;

  function addNode(kind, label, file, line) {
    if (nodes.length >= MAX_NODES) { truncated = true; return null; }
    const id = 'N' + nodes.length;
    nodes.push({ id, kind, label, file, line });
    return id;
  }

  const entryId = addNode('entry', `${route.method} ${route.path}`, route.file, route.line);
  const entry = locateEntryCalls(route, allFileComponents, readFile);
  if (!entry) return { entryId, nodes, edges, truncated: false };

  const entryFc = findFileComponents(allFileComponents, route.file) || { relPath: route.file, imports: [], importBindings: [], functions: [] };
  const visited = new Set();
  const queue = [{ calls: entry.calls, fc: entryFc, parentId: entryId, depth: 0 }];

  while (queue.length) {
    const { calls, fc, parentId, depth } = queue.shift();
    for (const call of calls) {
      if (nodes.length >= MAX_NODES) { truncated = true; break; }
      const classified = classifyCall(call.callee, fc, allFileComponents);
      if (!classified) continue; // unresolved third-party call — not modeled

      if (classified.kind === 'external') {
        const id = addNode('external', classified.label, fc.relPath, call.line);
        if (id) edges.push({ from: parentId, to: id });
        continue;
      }
      if (classified.kind === 'opaque-project') {
        const id = addNode('internal', `${call.callee}()`, classified.label, null);
        if (id) edges.push({ from: parentId, to: id });
        continue;
      }

      const key = classified.fc.relPath + '::' + classified.fn.name;
      const id = addNode('internal', classified.fn.name, classified.fc.relPath, classified.fn.line);
      if (!id) break;
      edges.push({ from: parentId, to: id });
      if (depth < MAX_DEPTH && !visited.has(key)) {
        visited.add(key);
        queue.push({ calls: classified.fn.calls || [], fc: classified.fc, parentId: id, depth: depth + 1 });
      }
    }
  }

  return { entryId, nodes, edges, truncated };
}

// Mutates each route in `routes`, attaching `.flowTrace`. Mutating in place
// (rather than returning a parallel structure) means wikiWriter.js's
// existing writeProcessFlowPage(wikiDir, group) signature doesn't need to
// change at all — it just reads r.flowTrace off each route it already has.
function traceEntryPoints(routes, allFileComponents, readFile) {
  for (const route of routes) {
    route.flowTrace = traceRoute(route, allFileComponents, readFile);
  }
}

module.exports = { traceEntryPoints, traceRoute, classifyCall, classifyExternal };
