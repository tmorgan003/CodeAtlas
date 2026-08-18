// Code efficiency and maintainability: no category before this covered
// anything about a function being hard to work with, only whether it was
// dead or insecure. This adds two per-function signals for JS/TS (the one
// ecosystem with a real parser available — see components.js's own reasoning
// for why other languages don't get AST-based checks here): oversized
// functions (raw line count) and cyclomatic complexity (decision-point
// count + 1), the two cheapest, most-established proxies for "this function
// is a maintenance risk," without needing a runtime or a linter dependency.
//
// Deliberately its own module rather than folded into components.js's
// walker — that one is tuned for structural extraction (names/params/lines
// for the dependency graph and dead-code check); this one re-walks the same
// source for a different purpose (each function's own line range and
// decision points), so keeping them separate means neither has to carry
// concerns the other doesn't need.

const ts = require('typescript');

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

const JS_EXT = new Set(Object.keys(SCRIPT_KIND));

const OVERSIZED_LINES = 80;
const HIGH_COMPLEXITY = 15;
const MODERATE_COMPLEXITY = 10;
const MAX_NESTING_DEPTH = 5;

function isFunctionNode(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

// A block-scoping node bumps nesting depth when it's a control-flow body
// (if/for/while/switch/try/function), not every curly brace — an object
// literal or a class body isn't "nesting" in the sense that makes code hard
// to follow.
function isNestingNode(node) {
  return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)
    || ts.isCatchClause(node);
}

function functionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  if (ts.isVariableDeclaration(node.parent) && node.parent.name) return node.parent.name.getText(sourceFile);
  return '(anonymous)';
}

// A node kind that's always +1 to complexity on its own (an if/loop/case/
// catch/ternary — each one is a branch point regardless of what it contains).
function isSimpleDecisionPoint(kind) {
  switch (kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.CatchClause:
    case ts.SyntaxKind.ConditionalExpression:
      return true;
    default:
      return false;
  }
}

// &&/||/?? short-circuit — each one is its own branch point, same as an if.
function isShortCircuitBinary(n) {
  return n.kind === ts.SyntaxKind.BinaryExpression && (
    n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    || n.operatorToken.kind === ts.SyntaxKind.BarBarToken
    || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function nodeAddsComplexity(n) {
  return isSimpleDecisionPoint(n.kind) || isShortCircuitBinary(n);
}

function analyzeFunction(node, sourceFile) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  // Cyclomatic complexity: 1 (base path) + 1 per decision point. Matches the
  // standard McCabe definition closely enough to be a useful proxy without
  // needing full control-flow-graph construction.
  let complexity = 1;
  let maxDepth = 0;

  function walk(n, depth) {
    if (n !== node && isFunctionNode(n)) return; // don't count a nested function's branches against the outer one
    if (nodeAddsComplexity(n)) complexity++;
    const nextDepth = isNestingNode(n) ? depth + 1 : depth;
    if (nextDepth > maxDepth) maxDepth = nextDepth;
    ts.forEachChild(n, (child) => walk(child, nextDepth));
  }
  walk(node, 0);

  return { name: functionName(node, sourceFile), startLine: start, lines: end - start + 1, complexity, maxNestingDepth: maxDepth };
}

// Returns one entry per function; caller decides what's worth flagging.
function analyzeComplexity(relPath, content, ext) {
  if (!JS_EXT.has(ext)) return [];
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] || ts.ScriptKind.JS);
  } catch {
    return [];
  }
  const results = [];
  function visit(node) {
    if (isFunctionNode(node) && node.body) {
      try {
        results.push(analyzeFunction(node, sourceFile));
      } catch {
        // a pathological/unusual node shape — skip it rather than fail the whole file
      }
    }
    ts.forEachChild(node, visit);
  }
  try {
    visit(sourceFile);
  } catch {
    return [];
  }
  return results;
}

function scanComplexityIssues(relPath, content, ext) {
  const issues = [];
  for (const fn of analyzeComplexity(relPath, content, ext)) {
    if (fn.lines > OVERSIZED_LINES) {
      issues.push({
        file: relPath,
        line: fn.startLine,
        severity: fn.lines > OVERSIZED_LINES * 2 ? 'Medium' : 'Low',
        category: 'Oversized Function',
        summary: `${fn.name}() is ${fn.lines} lines long (over the ${OVERSIZED_LINES}-line guideline) — hard to hold in your head at once and a likely sign it's doing more than one job.`,
        suggestedFix: 'Split into smaller, named helper functions along its natural sub-steps — each one testable and readable on its own.',
      });
    }
    if (fn.complexity >= MODERATE_COMPLEXITY) {
      issues.push({
        file: relPath,
        line: fn.startLine,
        severity: fn.complexity >= HIGH_COMPLEXITY ? 'Medium' : 'Low',
        category: 'High Cyclomatic Complexity',
        summary: `${fn.name}() has a cyclomatic complexity of ${fn.complexity} (${fn.complexity >= HIGH_COMPLEXITY ? 'well over' : 'over'} the ${MODERATE_COMPLEXITY} guideline) — that many independent branches means that many distinct paths a test suite has to cover to actually exercise the function.`,
        suggestedFix: 'Extract branches into smaller functions, replace a long if/else-if chain with a lookup table or early returns, or split by responsibility.',
      });
    }
    if (fn.maxNestingDepth > MAX_NESTING_DEPTH) {
      issues.push({
        file: relPath,
        line: fn.startLine,
        severity: 'Low',
        category: 'Deep Nesting',
        summary: `${fn.name}() nests ${fn.maxNestingDepth} levels deep (if/for/while/switch/try inside each other) — each level is another condition a reader has to hold in mind to know if a given line even runs.`,
        suggestedFix: 'Use early returns/guard clauses to flatten the common case, or extract the innermost block into its own function.',
      });
    }
  }
  return issues;
}

module.exports = { analyzeComplexity, scanComplexityIssues };
