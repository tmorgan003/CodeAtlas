// Step 6: detect route/handler definitions and produce a heuristic step trace
// for each one. This is pattern-based, not real control-flow tracing — it
// reads error-handling idioms, status codes, conditionals and outbound calls
// out of the handler's source text to build a plausible numbered trace.
// Traces are labeled "auto-generated" wherever precision can't be guaranteed.

function findMatchingDelim(content, openIndex, openCh, closeCh) {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === openCh) depth++;
    else if (content[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((s) => s.trim());
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ---- Generic brace-delimited body trace, reused by every brace-language ----
// (JS/TS, Go, Java, PHP). `opts` supplies the language-specific idiom regexes.

function traceBody(body, opts) {
  const errorHandled = opts.errorRe.test(body);
  const statusCodes = [...new Set([...body.matchAll(opts.statusRe)].map((m) => m.slice(1).find((g) => g !== undefined)).filter(Boolean))];
  const ifCount = (body.match(/\bif\s*\(/g) || []).length;
  const sideEffectCalls = [...new Set([...body.matchAll(opts.sideEffectRe)].map((m) => m[0]))];
  const sendsResponse = opts.responseRe.test(body);
  return { errorHandled, statusCodes, ifCount, sideEffectCalls, sendsResponse };
}

function buildSteps(method, urlPath, handlerName, trace, errorLabel) {
  const steps = [];
  steps.push(`Trigger: client sends ${method} ${urlPath}.`);
  steps.push(`Handler "${handlerName}" begins execution.`);
  if (trace.ifCount > 0) steps.push(`Contains ${trace.ifCount} conditional branch(es) — auto-detected, exact branch logic not traced.`);
  if (trace.sideEffectCalls.length) steps.push(`Calls out to: ${trace.sideEffectCalls.join(', ')} (data/network side effect).`);
  if (trace.errorHandled) {
    steps.push(`${errorLabel.handled} — failures are handled within the handler.`);
  } else {
    steps.push(`${errorLabel.unhandled} — an unhandled failure would propagate to the framework's default error path.`);
  }
  if (trace.statusCodes.length) steps.push(`Error/response paths reference status: ${trace.statusCodes.join(', ')}.`);
  if (trace.sendsResponse) steps.push('End state: a response is sent back to the client.');
  else steps.push('End state: no explicit response call detected in this handler body (may delegate further, or this trace is incomplete).');
  return steps;
}

const shallowSteps = (method, urlPath, handlerName, note) => [
  `Trigger: client sends ${method} ${urlPath}.`,
  `Handler "${handlerName}" begins execution.`,
  `Auto-generated trace: ${note}`,
];

// ---- JS/TS: Express ----

const JS_TRACE_OPTS = {
  errorRe: /\btry\s*\{/,
  statusRe: /\.status\(\s*([45]\d\d)\s*\)/g,
  sideEffectRe: /\b(db|prisma|knex|pool|connection|axios|fetch|redis|mongoose|sequelize)\.\w+/g,
  responseRe: /\.(?:json|send|render|redirect|end)\s*\(/,
};
const JS_ERROR_LABEL = { handled: 'Wrapped in try/catch', unhandled: 'No try/catch detected in this handler' };

function findHandlerBody(content, argsText, rangeStart) {
  const inlineRe = /(?:async\s*)?function\s*\(([^)]*)\)\s*\{|(?:async\s*)?\(([^)]*)\)\s*=>\s*\{|(?:async\s*)?(\w+)\s*=>\s*\{/g;
  let m;
  let last = null;
  while ((m = inlineRe.exec(argsText))) last = m;
  if (last) {
    const braceOpenAbs = rangeStart + last.index + last[0].length - 1;
    const braceCloseAbs = findMatchingDelim(content, braceOpenAbs, '{', '}');
    if (braceCloseAbs > braceOpenAbs) {
      return { handlerName: '(inline)', body: content.slice(braceOpenAbs + 1, braceCloseAbs) };
    }
  }
  const tokens = splitTopLevelCommas(argsText);
  const last2 = tokens[tokens.length - 1];
  if (last2 && /^\w+$/.test(last2)) {
    const name = last2;
    const defPatterns = [
      new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`),
      new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`),
      new RegExp(`async\\s+function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`),
    ];
    for (const re of defPatterns) {
      const dm = re.exec(content);
      if (dm) {
        const braceOpenAbs = dm.index + dm[0].length - 1;
        const braceCloseAbs = findMatchingDelim(content, braceOpenAbs, '{', '}');
        if (braceCloseAbs > braceOpenAbs) {
          return { handlerName: name, body: content.slice(braceOpenAbs + 1, braceCloseAbs) };
        }
      }
    }
    return { handlerName: name, body: null };
  }
  return { handlerName: '(unresolved)', body: null };
}

function detectExpressRoutes(relPath, content) {
  const routes = [];
  const callRe = /\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(/g;
  let m;
  while ((m = callRe.exec(content))) {
    const method = m[1].toUpperCase();
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingDelim(content, openParen, '(', ')');
    if (closeParen < 0) continue;
    const argsText = content.slice(openParen + 1, closeParen);
    const pathMatch = argsText.match(/^\s*['"`]([^'"`]+)['"`]/);
    if (!pathMatch) continue;
    const urlPath = pathMatch[1];
    const restStart = openParen + 1 + pathMatch[0].length;
    const restArgsText = content.slice(restStart, closeParen).replace(/^\s*,/, '');
    const { handlerName, body } = findHandlerBody(content, restArgsText, restStart);
    const trace = body ? traceBody(body, JS_TRACE_OPTS) : { errorHandled: false, statusCodes: [], ifCount: 0, sideEffectCalls: [], sendsResponse: false };
    routes.push({
      method,
      path: urlPath,
      handlerName,
      file: relPath,
      line: lineOf(content, m.index),
      steps: buildSteps(method, urlPath, handlerName, trace, JS_ERROR_LABEL),
      traced: !!body,
    });
  }
  return routes;
}

// ---- Python: Flask / FastAPI (shallow — see README limitations) ----

function detectFlaskRoutes(relPath, content) {
  const routes = [];
  const routeRe = /@(?:app|bp|blueprint)\.route\(\s*['"]([^'"]+)['"]([^)]*)\)\s*\n\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = routeRe.exec(content))) {
    const [, urlPath, optsRaw, handlerName] = m;
    const methodsMatch = optsRaw.match(/methods\s*=\s*\[([^\]]*)\]/);
    const methods = methodsMatch ? methodsMatch[1].replace(/['"]/g, '').split(',').map((s) => s.trim().toUpperCase()) : ['GET'];
    for (const method of methods) {
      routes.push({
        method, path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
        steps: shallowSteps(method, urlPath, handlerName, 'static scan does not follow the function body for Python handlers beyond this point — inspect the function directly for branch/error-path detail.'),
        traced: false,
      });
    }
  }
  return routes;
}

function detectFastApiRoutes(relPath, content) {
  const routes = [];
  const routeRe = /@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"][^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
  let m;
  while ((m = routeRe.exec(content))) {
    const [, method, urlPath, handlerName] = m;
    routes.push({
      method: method.toUpperCase(), path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: shallowSteps(method.toUpperCase(), urlPath, handlerName, 'static scan does not follow the function body for Python handlers beyond this point — inspect the function directly for branch/error-path detail.'),
      traced: false,
    });
  }
  return routes;
}

// ---- Go: Gin / Echo (router.METHOD style) and net/http HandleFunc ----

const GO_TRACE_OPTS = {
  errorRe: /\bif\s+err\s*!=\s*nil\b/,
  statusRe: /\.(?:JSON|String|Status|XML)\(\s*(\d{3})/g,
  sideEffectRe: /\b(db|conn|pool|client|repo|repository|store|redis|sql)\.\w+/g,
  responseRe: /\.(?:JSON|String|Status|Write|XML)\(/,
};
const GO_ERROR_LABEL = { handled: 'Checks `if err != nil`', unhandled: 'No `if err != nil` check detected after the primary operation' };

function detectGoRoutes(relPath, content) {
  const routes = [];
  // router.METHOD("/path", handler) — named handler or inline func literal.
  const callRe = /\b\w+\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*,\s*/g;
  let m;
  while ((m = callRe.exec(content))) {
    const method = m[1];
    const urlPath = m[2];
    const afterArgsStart = m.index + m[0].length;
    const inlineMatch = content.slice(afterArgsStart).match(/^func\s*\(([^)]*)\)\s*\{/);
    let handlerName = '(inline)';
    let body = null;
    if (inlineMatch) {
      const braceOpenAbs = afterArgsStart + inlineMatch[0].length - 1;
      const braceCloseAbs = findMatchingDelim(content, braceOpenAbs, '{', '}');
      if (braceCloseAbs > braceOpenAbs) body = content.slice(braceOpenAbs + 1, braceCloseAbs);
    } else {
      const nameMatch = content.slice(afterArgsStart).match(/^(\w+)/);
      if (nameMatch) {
        handlerName = nameMatch[1];
        const defRe = new RegExp(`func\\s+${handlerName}\\s*\\(([^)]*)\\)[^\\{]*\\{`);
        const dm = defRe.exec(content);
        if (dm) {
          const braceOpenAbs = dm.index + dm[0].length - 1;
          const braceCloseAbs = findMatchingDelim(content, braceOpenAbs, '{', '}');
          if (braceCloseAbs > braceOpenAbs) body = content.slice(braceOpenAbs + 1, braceCloseAbs);
        }
      }
    }
    const trace = body ? traceBody(body, GO_TRACE_OPTS) : { errorHandled: false, statusCodes: [], ifCount: 0, sideEffectCalls: [], sendsResponse: false };
    routes.push({
      method, path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: buildSteps(method, urlPath, handlerName, trace, GO_ERROR_LABEL),
      traced: !!body,
    });
  }
  // http.HandleFunc("/path", ...) — method isn't part of the call, so it's left unresolved.
  const handleFuncRe = /http\.HandleFunc\(\s*"([^"]+)"\s*,\s*(\w+)?/g;
  while ((m = handleFuncRe.exec(content))) {
    const urlPath = m[1];
    const handlerName = m[2] || '(inline)';
    routes.push({
      method: 'ANY', path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: shallowSteps('ANY', urlPath, handlerName, 'net/http.HandleFunc does not declare an HTTP method at the registration site — check inside the handler for `r.Method` branching.'),
      traced: false,
    });
  }
  return routes;
}

// ---- Ruby: Rails config/routes.rb ----

const RESOURCE_ACTIONS = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'show', method: 'GET', suffix: '/:id' },
  { action: 'edit', method: 'GET', suffix: '/:id/edit' },
  { action: 'update', method: 'PATCH', suffix: '/:id' },
  { action: 'destroy', method: 'DELETE', suffix: '/:id' },
];

function detectRailsRoutes(relPath, content) {
  const routes = [];
  const explicitRe = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*['"]([^'"]+)['"]|=>\s*['"]([^'"]+)['"])?/g;
  let m;
  while ((m = explicitRe.exec(content))) {
    const method = m[1].toUpperCase();
    const urlPath = m[2];
    const handlerName = m[3] || m[4] || '(unresolved)';
    routes.push({
      method, path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: shallowSteps(method, urlPath, handlerName, 'the handler lives in a separate controller file this scan does not cross-reference — see app/controllers for the actual logic.'),
      traced: false,
    });
  }
  const resourcesRe = /\bresources\s+:(\w+)/g;
  while ((m = resourcesRe.exec(content))) {
    const resource = m[1];
    const line = lineOf(content, m.index);
    for (const r of RESOURCE_ACTIONS) {
      const urlPath = `/${resource}${r.suffix}`;
      const handlerName = `${resource}#${r.action}`;
      routes.push({
        method: r.method, path: urlPath, handlerName, file: relPath, line,
        steps: shallowSteps(r.method, urlPath, handlerName, `expanded from \`resources :${resource}\` — the handler lives in the ${resource} controller, which this scan does not cross-reference.`),
        traced: false,
      });
    }
  }
  return routes;
}

// ---- Java: Spring MVC annotations ----

const JAVA_TRACE_OPTS = {
  errorRe: /\btry\s*\{/,
  statusRe: /(?:HttpStatus\.\w*(\d{3})\w*|\.status\(\s*(\d{3})\s*\)|status\s*=\s*(\d{3}))/g,
  sideEffectRe: /\b(repository|repo|service|dao|jdbcTemplate|entityManager)\.\w+/gi,
  responseRe: /\breturn\s+(?:ResponseEntity|new\s+ResponseEntity)/,
};
const JAVA_ERROR_LABEL = { handled: 'Wrapped in try/catch', unhandled: 'No try/catch detected in this handler' };

function detectSpringRoutes(relPath, content) {
  const routes = [];
  const annoRe = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\(([^)]*)\)\s*\n\s*(?:public|private|protected)?\s*[\w<>\[\],\s]+\s+(\w+)\s*\(/g;
  let m;
  while ((m = annoRe.exec(content))) {
    const [, anno, argsRaw, handlerName] = m;
    const pathMatch = argsRaw.match(/(?:value\s*=\s*)?["']([^"']+)["']/);
    const urlPath = pathMatch ? pathMatch[1] : '/';
    let method = anno.replace('Mapping', '').toUpperCase();
    if (anno === 'RequestMapping') {
      const methodMatch = argsRaw.match(/RequestMethod\.(\w+)/);
      method = methodMatch ? methodMatch[1] : 'ANY';
    }
    const braceStart = content.indexOf('{', m.index + m[0].length - 1);
    let body = null;
    if (braceStart > 0) {
      const braceClose = findMatchingDelim(content, braceStart, '{', '}');
      if (braceClose > braceStart) body = content.slice(braceStart + 1, braceClose);
    }
    const trace = body ? traceBody(body, JAVA_TRACE_OPTS) : { errorHandled: false, statusCodes: [], ifCount: 0, sideEffectCalls: [], sendsResponse: false };
    routes.push({
      method, path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: buildSteps(method, urlPath, handlerName, trace, JAVA_ERROR_LABEL),
      traced: !!body,
    });
  }
  return routes;
}

// ---- PHP: Laravel Route:: facade ----

const PHP_TRACE_OPTS = {
  errorRe: /\btry\s*\{/,
  statusRe: /,\s*(\d{3})\s*\)/g,
  sideEffectRe: /\b(DB|Model|\w+Model|\w+Repository)::\w+/g,
  responseRe: /\b(?:return\s+response\(|response\(\)->|return\s+\$\w+)/,
};
const PHP_ERROR_LABEL = { handled: 'Wrapped in try/catch', unhandled: 'No try/catch detected in this handler' };

function detectLaravelRoutes(relPath, content) {
  const routes = [];
  const callRe = /Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*/g;
  let m;
  while ((m = callRe.exec(content))) {
    const method = m[1].toUpperCase();
    const urlPath = m[2];
    const afterStart = m.index + m[0].length;
    const inlineMatch = content.slice(afterStart).match(/^function\s*\(([^)]*)\)\s*\{/);
    let handlerName = '(inline)';
    let body = null;
    if (inlineMatch) {
      const braceOpenAbs = afterStart + inlineMatch[0].length - 1;
      const braceCloseAbs = findMatchingDelim(content, braceOpenAbs, '{', '}');
      if (braceCloseAbs > braceOpenAbs) body = content.slice(braceOpenAbs + 1, braceCloseAbs);
    } else {
      const arrayMatch = content.slice(afterStart, afterStart + 120).match(/^\[\s*(\w+)::class\s*,\s*['"](\w+)['"]\s*\]/);
      const stringMatch = content.slice(afterStart, afterStart + 120).match(/^['"](\w+)@(\w+)['"]/);
      if (arrayMatch) handlerName = `${arrayMatch[1]}@${arrayMatch[2]}`;
      else if (stringMatch) handlerName = `${stringMatch[1]}@${stringMatch[2]}`;
    }
    const trace = body ? traceBody(body, PHP_TRACE_OPTS) : { errorHandled: false, statusCodes: [], ifCount: 0, sideEffectCalls: [], sendsResponse: false };
    routes.push({
      method, path: urlPath, handlerName, file: relPath, line: lineOf(content, m.index),
      steps: body
        ? buildSteps(method, urlPath, handlerName, trace, PHP_ERROR_LABEL)
        : shallowSteps(method, urlPath, handlerName, 'the handler is a controller method this scan does not cross-reference — see the referenced controller class.'),
      traced: !!body,
    });
  }
  return routes;
}

function detectRoutes(relPath, content, ext) {
  const routes = [];
  if (ext === '.js' || ext === '.ts' || ext === '.mjs' || ext === '.cjs') {
    routes.push(...detectExpressRoutes(relPath, content));
  }
  if (ext === '.py') {
    routes.push(...detectFlaskRoutes(relPath, content));
    routes.push(...detectFastApiRoutes(relPath, content));
  }
  if (ext === '.go') {
    routes.push(...detectGoRoutes(relPath, content));
  }
  if (ext === '.rb') {
    routes.push(...detectRailsRoutes(relPath, content));
  }
  if (ext === '.java') {
    routes.push(...detectSpringRoutes(relPath, content));
  }
  if (ext === '.php') {
    routes.push(...detectLaravelRoutes(relPath, content));
  }
  return routes;
}

module.exports = { detectRoutes };
