// Step 3: per-file component extraction (functions, classes, imports, exports).
// JS/TS/JSX/TSX use the real TypeScript compiler API (a proper parser, not
// regex) for accurate results even on unusual formatting. Other languages
// fall back to regex heuristics — there's no JS-native parser for them here,
// and this environment has no Python/Go/etc. toolchain installed to shell
// out to for a real one.

const ts = require('typescript');

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function hasExportModifier(node) {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!(mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

// Node-kind predicates used by visit()'s dispatch below — split out so each
// compound condition contributes to its own (small) function's complexity
// instead of visit()'s, which is what drove visit() to 34 when this was all
// inlined as one long if/else-if chain.
function isNamedFunctionDeclaration(node) {
  return ts.isFunctionDeclaration(node) && !!node.name;
}
function isFunctionVariableDeclaration(node) {
  return ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer && isFunctionLike(node.initializer);
}
function isModuleExportsAssignment(node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  if (!ts.isPropertyAccessExpression(node.left) || !isFunctionLike(node.right)) return false;
  return /^(module\.exports|exports)\./.test(node.left.getText(node.getSourceFile()));
}
function isNamedClassDeclaration(node) {
  return ts.isClassDeclaration(node) && !!node.name;
}
function isModuleSpecifierImport(node) {
  return ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier);
}
function isRequireCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments[0] && ts.isStringLiteral(node.arguments[0]);
}

// ---- Process-flow diagrams: direct-call collection + import bindings ----
// Both purely additive to the returned shape — existing consumers (the
// Components wiki page, the dependency graph, dead-code detection) only
// ever read name/params/line/imports/exports and are unaffected.

function isFunctionLikeNode(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

// Calls made directly in a function's own body — stops at a nested
// function/arrow/method boundary so a callback's calls aren't attributed to
// the outer function (same exclusion rule maintainability.js's N+1 check
// already uses for the same reason).
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

// import Foo, { a, b as c } from './x'  ->  [{local:'Foo',...},{local:'a',...},{local:'c',...}]
// import * as ns from './x'             ->  [{local:'ns', source:'./x'}]
function collectImportBindings(node) {
  const source = node.moduleSpecifier.text;
  const bindings = [];
  const clause = node.importClause;
  if (!clause) return bindings;
  if (clause.name) bindings.push({ local: clause.name.text, source });
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({ local: clause.namedBindings.name.text, source });
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) bindings.push({ local: el.name.text, source });
    }
  }
  return bindings;
}

// const x = require('./y')           ->  [{local:'x', source:'./y'}]
// const { a, b: c } = require('./y') ->  [{local:'a',...},{local:'c',...}]
function collectRequireBindings(node) {
  const source = node.arguments[0].text;
  const bindings = [];
  const decl = node.parent && ts.isVariableDeclaration(node.parent) ? node.parent : null;
  if (!decl) return bindings;
  if (ts.isIdentifier(decl.name)) {
    bindings.push({ local: decl.name.text, source });
  } else if (ts.isObjectBindingPattern(decl.name)) {
    for (const el of decl.name.elements) {
      if (ts.isIdentifier(el.name)) bindings.push({ local: el.name.text, source });
    }
  }
  return bindings;
}

function extractJsLikeAst(relPath, content, ext) {
  const sourceFile = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] || ts.ScriptKind.JS);
  const functions = [];
  const classes = [];
  const imports = new Set();
  const importBindings = [];
  const exportsList = [];

  const lineOfPos = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const paramsText = (params) => params.map((p) => p.getText(sourceFile)).join(', ');

  function visitFunctionDeclaration(node) {
    functions.push({
      name: node.name.text,
      params: paramsText(node.parameters),
      line: lineOfPos(node.getStart(sourceFile)),
      calls: node.body ? collectDirectCalls(node.body, sourceFile) : [],
    });
    if (hasExportModifier(node)) exportsList.push(node.name.text);
  }

  function visitFunctionVariableDeclaration(node) {
    functions.push({
      name: node.name.text,
      params: paramsText(node.initializer.parameters),
      line: lineOfPos(node.getStart(sourceFile)),
      calls: collectDirectCalls(node.initializer.body, sourceFile),
    });
    const varStmt = node.parent && node.parent.parent;
    if (varStmt && ts.isVariableStatement(varStmt) && hasExportModifier(varStmt)) exportsList.push(node.name.text);
  }

  function visitModuleExportsAssignment(node) {
    const name = node.left.name.text;
    functions.push({
      name,
      params: paramsText(node.right.parameters),
      line: lineOfPos(node.getStart(sourceFile)),
      calls: collectDirectCalls(node.right.body, sourceFile),
    });
    exportsList.push(name);
  }

  function visitClassMember(className, member) {
    if (!ts.isMethodDeclaration(member) || !member.name) return;
    functions.push({
      name: `${className}.${member.name.getText(sourceFile)}`,
      params: paramsText(member.parameters),
      line: lineOfPos(member.getStart(sourceFile)),
      calls: member.body ? collectDirectCalls(member.body, sourceFile) : [],
    });
  }

  function visitClassDeclaration(node) {
    const heritage = node.heritageClauses && node.heritageClauses.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    const extendsName = heritage ? heritage.types[0].expression.getText(sourceFile) : null;
    classes.push({ name: node.name.text, extends: extendsName, line: lineOfPos(node.getStart(sourceFile)) });
    if (hasExportModifier(node)) exportsList.push(node.name.text);
    for (const member of node.members) visitClassMember(node.name.text, member);
  }

  function visit(node) {
    if (isNamedFunctionDeclaration(node)) visitFunctionDeclaration(node);
    else if (isFunctionVariableDeclaration(node)) visitFunctionVariableDeclaration(node);
    else if (isModuleExportsAssignment(node)) visitModuleExportsAssignment(node);
    else if (isNamedClassDeclaration(node)) visitClassDeclaration(node);
    else if (isModuleSpecifierImport(node)) {
      imports.add(node.moduleSpecifier.text);
      importBindings.push(...collectImportBindings(node));
    } else if (isRequireCall(node)) {
      imports.add(node.arguments[0].text);
      importBindings.push(...collectRequireBindings(node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { functions, classes, imports: [...imports], importBindings, exports: exportsList };
}

// Regex fallback, used only if the AST walk throws on something unexpected.
function extractJsLikeRegex(relPath, content) {
  const functions = [];
  const classes = [];
  const imports = new Set();
  let m;
  const fnDeclRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = fnDeclRe.exec(content))) functions.push({ name: m[1], params: m[2].trim(), line: lineOf(content, m.index) });
  const arrowRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  while ((m = arrowRe.exec(content))) functions.push({ name: m[1], params: m[2].trim(), line: lineOf(content, m.index) });
  const classRe = /(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
  while ((m = classRe.exec(content))) classes.push({ name: m[1], extends: m[2] || null, line: lineOf(content, m.index) });
  const importRe = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(content))) imports.add(m[1]);
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(content))) imports.add(m[1]);
  return { functions, classes, imports: [...imports], exports: [] };
}

function extractPython(relPath, content) {
  const functions = [];
  const classes = [];
  const imports = new Set();

  let m;
  const defRe = /^\s*def\s+(\w+)\s*\(([^)]*)\)/gm;
  while ((m = defRe.exec(content))) {
    functions.push({ name: m[1], params: m[2].trim(), line: lineOf(content, m.index) });
  }
  const classRe = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?:/gm;
  while ((m = classRe.exec(content))) {
    classes.push({ name: m[1], extends: m[2] ? m[2].trim() : null, line: lineOf(content, m.index) });
  }
  const importRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  while ((m = importRe.exec(content))) imports.add(m[1] || m[2]);

  return { functions, classes, imports: [...imports], exports: [] };
}

function extractGeneric(relPath, content) {
  // Best-effort for languages without a dedicated extractor: look for common
  // function/class keywords so the file isn't documented as a total blank.
  const functions = [];
  const classes = [];
  let m;
  const fnRe = /\b(?:func|fn|void|public|private|protected|static)\s+[\w<>\[\]]*\s*(\w+)\s*\(([^)]*)\)\s*\{/g;
  while ((m = fnRe.exec(content))) {
    functions.push({ name: m[1], params: m[2].trim(), line: lineOf(content, m.index) });
  }
  const classRe = /\b(?:class|struct|interface)\s+(\w+)/g;
  while ((m = classRe.exec(content))) {
    classes.push({ name: m[1], extends: null, line: lineOf(content, m.index) });
  }
  return { functions, classes, imports: [], exports: [] };
}

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function extractComponentsFromFile(relPath, content, ext) {
  const lines = content.split('\n').length;
  let extracted;
  if (JS_EXT.has(ext)) {
    try {
      extracted = extractJsLikeAst(relPath, content, ext);
    } catch {
      extracted = extractJsLikeRegex(relPath, content);
    }
  } else if (ext === '.py') {
    extracted = extractPython(relPath, content);
  } else {
    extracted = extractGeneric(relPath, content);
  }

  return { relPath, ext, lines, ...extracted };
}

module.exports = { extractComponentsFromFile };
