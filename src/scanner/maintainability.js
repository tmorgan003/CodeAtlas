// Code efficiency and maintainability, continued: N+1 query patterns,
// unbounded loops over unpaginated data, and event listeners/timers left
// running after a component unmounts. Same AST infrastructure and JS/TS-only
// scope as complexity.js (see that file's header for why this isn't
// generalized to every language) — kept in its own module since these three
// checks are about call patterns and control flow, not a function's own
// size/branching.

const ts = require('typescript');

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS,
};
const JS_EXT = new Set(Object.keys(SCRIPT_KIND));

// High-confidence ORM/DB read methods — narrow on purpose. A method name
// like "find" or "get" alone is too generic (plain array/object methods use
// the same names constantly); these are distinctive enough across
// Prisma/Mongoose/Sequelize/TypeORM/raw drivers that a false positive is
// unlikely.
const QUERY_METHOD_RE = /\.(findMany|findFirst|findUnique|findById|findOne|findAll|query|execute|aggregate)\s*\(/;
const PAGINATION_HINT_RE = /\b(take|limit|first|pageSize|LIMIT)\b/i;

function parse(relPath, content, ext) {
  if (!JS_EXT.has(ext)) return null;
  try {
    return ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] || ts.ScriptKind.JS);
  } catch {
    return null;
  }
}

function lineAt(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isLoopStatement(node) {
  return ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

// .forEach(fn) / .map(fn) count as a loop for this purpose — a query call
// inside that callback runs once per array element exactly the same as a
// query call inside a for-of body does.
function isArrayIterationCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === 'forEach' || node.expression.name.text === 'map')
    && node.arguments.length && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]));
}

function loopBody(node) {
  if (isArrayIterationCall(node)) return node.arguments[0].body;
  return node.statement || node.body;
}

// N+1: a query call reachable inside a loop body, not counting a query
// inside a further-nested function (that function might only run once, e.g.
// a one-off setup callback) or inside a NESTED loop (already flagged when
// that inner loop is visited on its own).
function scanN1Queries(relPath, content, ext) {
  const sourceFile = parse(relPath, content, ext);
  if (!sourceFile) return [];
  const issues = [];

  function findQueryInBody(body) {
    let found = null;
    function walk(n) {
      if (found) return;
      if (n !== body && (isLoopStatement(n) || isArrayIterationCall(n))) return; // belongs to a nested loop, flagged separately
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || (ts.isArrowFunction(n) && n !== body)) return; // a callback defined here isn't necessarily invoked per-iteration
      if (ts.isCallExpression(n) && n.getText(sourceFile).match(QUERY_METHOD_RE)) {
        found = n;
        return;
      }
      ts.forEachChild(n, walk);
    }
    walk(body);
    return found;
  }

  function visit(node) {
    if (isLoopStatement(node) || isArrayIterationCall(node)) {
      const body = loopBody(node);
      if (body) {
        const match = findQueryInBody(body);
        if (match) {
          issues.push({
            file: relPath,
            line: lineAt(sourceFile, match),
            severity: 'Medium',
            category: 'N+1 Query Pattern',
            summary: 'A database query runs inside a loop body — once per iteration instead of once total, so N items means N (or N+1) round trips to the database.',
            suggestedFix: "Move the query outside the loop and fetch everything needed in one call (e.g. a single findMany with an `in`/`where` filter across all the loop's keys, or a join/include), then look up each item's data from the already-fetched result inside the loop.",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issues;
}

// Unbounded loop over unpaginated data: a for-of iterating directly over the
// result of a query call whose own argument list shows no pagination
// keyword. Textual (not full argument-shape analysis) — matches this
// codebase's other pragmatic, narrow-on-purpose regex checks rather than
// modeling every ORM's pagination API.
function scanUnboundedLoops(relPath, content) {
  const issues = [];
  const forOfRe = /for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+(?:await\s+)?([\s\S]*?)\)\s*\{/g;
  let m;
  while ((m = forOfRe.exec(content))) {
    const source = m[1];
    if (!QUERY_METHOD_RE.test('.' + source.split('.').slice(1).join('.')) && !QUERY_METHOD_RE.test(source)) continue;
    if (PAGINATION_HINT_RE.test(source)) continue;
    const line = content.slice(0, m.index).split('\n').length;
    issues.push({
      file: relPath,
      line,
      severity: 'Low',
      category: 'Unbounded Loop Over Unpaginated Data',
      summary: 'A loop iterates directly over a query result with no visible pagination (take/limit) — fine at today\'s data size, but this reads the entire table into memory on every call as the table grows.',
      suggestedFix: 'Add a page size to the query (e.g. take/limit) and process in batches, or push the per-item logic into the database query itself (a WHERE/aggregate) instead of looping in application code.',
    });
  }
  return issues;
}

const TIMER_ADD_RE = /\b(setInterval|setTimeout)\s*\(/;
const LISTENER_ADD_RE = /\.addEventListener\s*\(/;
const TIMER_CLEAR_RE = /\b(clearInterval|clearTimeout)\s*\(/;
const LISTENER_REMOVE_RE = /\.removeEventListener\s*\(/;

// React-specific: a useEffect callback that starts a timer/listener but
// whose cleanup function (the value it returns) never stops it leaks that
// timer/listener into every subsequent render and past unmount — a classic
// early-career mistake that works fine in dev and only shows up as memory
// growth or duplicate handlers under real, sustained traffic.
function isUseEffectCallWithHandler(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
    && node.arguments.length && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]));
}

function findEffectCleanupText(effectFn, sourceFile) {
  let cleanupText = '';
  function findReturn(n) {
    if (cleanupText) return;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      if (n !== effectFn) return; // don't reach into a nested callback's own return
    }
    if (ts.isReturnStatement(n) && n.expression && (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))) {
      cleanupText = n.expression.getText(sourceFile);
      return;
    }
    if (ts.isArrowFunction(effectFn) && effectFn.body === n && !ts.isBlock(n)) {
      // concise-body arrow (`useEffect(() => addEventListener(...))`) — no cleanup is even possible here
      cleanupText = '__NO_BLOCK_BODY__';
      return;
    }
    ts.forEachChild(n, findReturn);
  }
  findReturn(effectFn.body);
  return cleanupText;
}

function describeMissingCleanup(addsTimer, hasTimerCleanup, addsListener, hasListenerCleanup) {
  return [
    addsTimer && !hasTimerCleanup ? 'a timer' : null,
    addsListener && !hasListenerCleanup ? 'an event listener' : null,
  ].filter(Boolean).join(' and ');
}

// Returns an issue for this useEffect call, or null if it doesn't start a
// timer/listener at all, or does but already cleans it up correctly.
function checkEffectCleanup(node, sourceFile, relPath) {
  const effectFn = node.arguments[0];
  const effectText = effectFn.getText(sourceFile);
  const addsTimer = TIMER_ADD_RE.test(effectText);
  const addsListener = LISTENER_ADD_RE.test(effectText);
  if (!addsTimer && !addsListener) return null;

  const cleanupText = findEffectCleanupText(effectFn, sourceFile);
  const hasTimerCleanup = TIMER_CLEAR_RE.test(cleanupText);
  const hasListenerCleanup = LISTENER_REMOVE_RE.test(cleanupText);
  if (!((addsTimer && !hasTimerCleanup) || (addsListener && !hasListenerCleanup))) return null;

  const what = describeMissingCleanup(addsTimer, hasTimerCleanup, addsListener, hasListenerCleanup);
  return {
    file: relPath,
    line: lineAt(sourceFile, node),
    severity: 'Medium',
    category: 'Missing Effect Cleanup',
    summary: `This useEffect starts ${what} but doesn't return a cleanup function that stops it — it keeps running after the component unmounts (or accumulates a new one on every re-run if the dependency array changes).`,
    suggestedFix: 'Return a function from the effect that calls clearInterval/clearTimeout or removeEventListener with the same reference the effect created, so it stops when the component unmounts or the effect re-runs.',
  };
}

function scanEffectCleanupIssues(relPath, content, ext) {
  const sourceFile = parse(relPath, content, ext);
  if (!sourceFile) return [];
  const issues = [];

  function visit(node) {
    if (isUseEffectCallWithHandler(node)) {
      const issue = checkEffectCleanup(node, sourceFile, relPath);
      if (issue) issues.push(issue);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issues;
}

function scanMaintainabilityIssues(relPath, content, ext) {
  return [
    ...scanN1Queries(relPath, content, ext),
    ...scanUnboundedLoops(relPath, content),
    ...scanEffectCleanupIssues(relPath, content, ext),
  ];
}

module.exports = { scanMaintainabilityIssues, scanN1Queries, scanUnboundedLoops, scanEffectCleanupIssues };
