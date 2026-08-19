// Step 7: pattern-based issue flagging. Every finding is a heuristic signal,
// not a certainty — severities are conservative and suggested fixes are
// generic starting points for a human reviewer.

const { maskStringsAndComments, extractStrings } = require('./mask');
const { applyCustomRules } = require('./customSecretRules');
const { resolveImport, RESOLVE_SUFFIXES } = require('./graph');
const { scanComplexityIssues } = require('./complexity');
const { scanMaintainabilityIssues } = require('./maintainability');

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

const PLACEHOLDER_VALUES = new Set([
  'changeme', 'xxxxxxxx', 'your_api_key', 'placeholder', 'example',
  'test', 'dummy', 'todo', 'secret', 'password', 'yourpassword', '',
]);

function scanSecrets(relPath, content) {
  const issues = [];
  const kvRe = /['"](?:aws_?(?:access|secret)_?key|api[_-]?key|secret|secret[_-]?key|password|passwd|token|auth[_-]?token|private[_-]?key)['"]\s*[:=]\s*['"]([^'"]{8,})['"]/gi;
  let m;
  while ((m = kvRe.exec(content))) {
    const value = m[1];
    if (PLACEHOLDER_VALUES.has(value.toLowerCase()) || value.includes('process.env') || value.includes('${')) continue;
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A credential-like value appears to be hardcoded as a string literal.',
      suggestedFix: 'Move this value to an environment variable or secrets manager and load it at runtime instead of committing it to source.',
    });
  }
  const awsKeyRe = /AKIA[0-9A-Z]{16}/g;
  while ((m = awsKeyRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A string matching the AWS Access Key ID format was found in source.',
      suggestedFix: 'Revoke this key immediately if it is real, then move credentials to environment variables or a secrets manager.',
    });
  }
  const privKeyRe = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;
  while ((m = privKeyRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A private key block is embedded directly in source.',
      suggestedFix: 'Remove the key from source control, rotate it, and load it from a secrets manager or mounted secret file instead.',
    });
  }
  // Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-, or the newer xoxe.xox*
  // rotation format) — a fixed, high-confidence prefix, same reasoning as
  // the AWS key check above: format alone is enough signal, no need for
  // entropy scoring or a nearby variable name.
  const slackTokenRe = /\bxox[baprs]-[0-9A-Za-z-]{10,}/g;
  while ((m = slackTokenRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A string matching the Slack API token format was found in source.',
      suggestedFix: 'Revoke this token in the Slack app config immediately if it is real, then move it to an environment variable or secrets manager.',
    });
  }
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh) — GitHub's own fixed-prefix
  // format since 2021, replacing the old unprefixed 40-char hex tokens.
  const githubTokenRe = /\bgh[oprsu]_[0-9A-Za-z]{36,}/g;
  while ((m = githubTokenRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A string matching the GitHub personal access token format was found in source.',
      suggestedFix: 'Revoke this token from GitHub Settings > Developer settings immediately if it is real, then move it to an environment variable or secrets manager.',
    });
  }
  // Database connection strings with credentials embedded directly in the
  // URL (user:pass@host) — a different shape from the keyword check above
  // (that one looks for `"password": "..."`; this looks for the credential
  // riding inside a URL scheme most ORMs/drivers accept as a config value).
  const dbConnStringRe = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\/\s'"]+:[^@\/\s'"]+@[^\/\s'"]+/gi;
  while ((m = dbConnStringRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Hardcoded Secret',
      summary: 'A database/service connection string with an embedded username and password was found in source.',
      suggestedFix: 'Move the connection string (or at least the credential portion) to an environment variable, and rotate the password if this was ever committed.',
    });
  }
  return issues;
}

// Feature 13: entropy-based secret detection. The keyword check above only
// catches credentials assigned to an obviously-named variable (apiKey,
// password, ...). A random-looking token assigned to an innocuous name
// (or embedded as a bare argument) slips past it — this catches those by
// looking at the randomness of the string content itself, independent of
// what it's called. Lower confidence than the keyword match, so it's Medium
// severity and skips anything already flagged by scanSecrets on the same line.
function shannonEntropy(str) {
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const key in freq) {
    const p = freq[key] / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const URL_OR_PATH_RE = /^(?:https?:\/\/|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/;
const ENTROPY_THRESHOLD = 4.0;
const MIN_LEN = 20;
const MAX_LEN = 200;

// Legitimate high-entropy-looking IDs that entropy scoring alone can't tell
// apart from a real secret: Prisma/cuid2, UUID (any version, with dashes),
// MongoDB ObjectId, and Nano ID. Excluding known generator shapes up front
// is cheaper and more precise than trying to push the entropy threshold
// higher — a real random secret and a cuid have comparable entropy, so no
// threshold value avoids this false positive; only recognizing the shape
// does. (A generated ID observed in practice: a Prisma cuid was flagged as
// a Medium-severity possible secret before this exclusion existed.)
const GENERATED_ID_RES = [
  /^c[0-9a-z]{24}$/i, // cuid / cuid2
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{24}$/i, // Mongo ObjectId
  /^[A-Za-z0-9_-]{21}$/, // Nano ID (default 21-char alphabet)
];

function scanEntropySecrets(relPath, content, ext, alreadyFlaggedLines) {
  const issues = [];
  // Uses the shared tokenizer (mask.js) rather than a standalone quote
  // regex — a naive regex would also match a double-quoted HTML/CSS
  // attribute nested inside a backtick template as if it were its own
  // string literal, which is exactly the false positive this caused before.
  for (const { value, index } of extractStrings(content, ext)) {
    if (value.length < MIN_LEN || value.length > MAX_LEN) continue;
    if (/\s/.test(value)) continue;
    if (URL_OR_PATH_RE.test(value)) continue;
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
    if (GENERATED_ID_RES.some((re) => re.test(value))) continue;
    const line = lineOf(content, index);
    if (alreadyFlaggedLines.has(line)) continue;
    const entropy = shannonEntropy(value);
    if (entropy < ENTROPY_THRESHOLD) continue;
    issues.push({
      file: relPath,
      line,
      severity: 'Medium',
      category: 'Possible High-Entropy Secret',
      summary: `A ${value.length}-character string with high entropy (${entropy.toFixed(2)} bits/char) was found — could be an API key, token, or credential not caught by keyword matching.`,
      suggestedFix: 'If this is a real credential, move it to an environment variable or secrets manager. If it is a hash, generated ID, or other legitimate random-looking value, this can be disregarded.',
    });
  }
  return issues;
}

// Runs on the RAW content deliberately — the whole point is to inspect what's
// inside the string/template literal passed to query()/execute().
function scanSqlInjection(relPath, content) {
  const issues = [];
  const sqlCallRe = /\.(query|execute)\(\s*(`[^`]*\$\{[^`]*\}[^`]*`|['"][^'"]*['"]\s*\+)/g;
  let m;
  while ((m = sqlCallRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'SQL Injection Risk',
      summary: 'A query is built via string concatenation or template interpolation instead of parameterized input.',
      suggestedFix: 'Use parameterized queries / prepared statements (e.g. `?` placeholders or a query builder) instead of interpolating values into the SQL string.',
    });
  }
  return issues;
}

// Runs on content with string-literal and comment bodies masked out, so a
// finding's own description text (e.g. "eval() executes...") or a commented-
// out call doesn't get flagged the same as a real, live call.
function scanCodeExecutionRisk(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const issues = [];
  let m;
  const evalRe = /\beval\s*\(/g;
  while ((m = evalRe.exec(masked))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'Code Injection Risk',
      summary: 'eval() executes arbitrary strings as code.',
      suggestedFix: 'Replace eval() with an explicit parser, JSON.parse, or a direct function call — avoid executing dynamic strings.',
    });
  }
  const newFnRe = /new\s+Function\s*\(/g;
  while ((m = newFnRe.exec(masked))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Medium',
      category: 'Code Injection Risk',
      summary: 'new Function() constructs and executes code from a string at runtime.',
      suggestedFix: 'Avoid dynamic code construction; use a fixed function or a safe interpreter/config format instead.',
    });
  }
  return issues;
}

// A `${...}` interpolation is not automatically dangerous — an escaped
// value or a plain count can't carry markup. Two conventions common enough
// across real codebases (not specific to this one) to treat as evidence of
// safety: a call to a function whose name says it escapes/sanitizes/encodes
// (escapeHtml, sanitizeHtml, DOMPurify.sanitize, ...), and a bare numeric
// property (`.length`/`.count`/`.size`, or a literal number) — neither can
// smuggle in an HTML tag.
const SAFE_ESCAPE_FN_RE = /^[\w.]*\b(escape|sanitize|purify|encode)\w*\s*\(/i;
const SAFE_NUMERIC_EXPR_RE = /^[\w.]+\.(length|count|size|line|lineNo|lineNumber|column|col|index|idx|row)$/;

function isSafeInterpolation(expr) {
  const trimmed = expr.trim();
  return SAFE_ESCAPE_FN_RE.test(trimmed) || SAFE_NUMERIC_EXPR_RE.test(trimmed) || /^\d+$/.test(trimmed);
}

// Depth-aware — a naive regex on "${...}" breaks the moment an expression
// contains its own braces (an object literal, a destructure), which a flat
// non-greedy match would truncate at the first inner "}".
function extractInterpolations(template) {
  const exprs = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === '$' && template[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < template.length && depth > 0) {
        if (template[j] === '{') depth++;
        else if (template[j] === '}') depth--;
        if (depth > 0) j++;
      }
      exprs.push(template.slice(start, j));
      i = j + 1;
    } else {
      i++;
    }
  }
  return exprs;
}

// Runs on RAW content deliberately, same reasoning as scanSqlInjection —
// masking blanks out template-literal interpolation, which is exactly what
// makes an innerHTML assignment dangerous vs. a static one.
function scanXss(relPath, content) {
  const issues = [];
  let m;
  const innerHtmlRe = /\.innerHTML\s*=\s*(`[^`]*\$\{[^`]*\}[^`]*`|['"][^'"]*['"]\s*\+)/g;
  while ((m = innerHtmlRe.exec(content))) {
    const rhs = m[1];
    if (rhs.startsWith('`')) {
      const interpolations = extractInterpolations(rhs);
      if (interpolations.length && interpolations.every(isSafeInterpolation)) continue;
    }
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'Cross-Site Scripting (XSS) Risk',
      summary: 'innerHTML is assigned a dynamically-built string (template interpolation or concatenation) instead of a static value.',
      suggestedFix: 'Use textContent for plain text, or sanitize the HTML (e.g. DOMPurify) before assigning innerHTML. Avoid building HTML by concatenating untrusted input.',
    });
  }
  const dangerousHtmlRe = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+)\}\}/g;
  while ((m = dangerousHtmlRe.exec(content))) {
    const value = m[1].trim();
    // A whole-expression literal string (single/double-quoted, nothing else)
    // is low-risk; anything else — a variable, a function call, a template
    // with interpolation — is unsanitized markup passing straight through.
    if (/^(['"]).*\1$/.test(value)) continue;
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'High',
      category: 'Cross-Site Scripting (XSS) Risk',
      summary: "dangerouslySetInnerHTML receives a non-literal value — its __html content isn't visibly sanitized here.",
      suggestedFix: "Sanitize the HTML (e.g. DOMPurify.sanitize(...)) before passing it to dangerouslySetInnerHTML, or use plain JSX text if the content doesn't need to contain markup.",
    });
  }
  return issues;
}

// Same shape as scanSqlInjection's concatenation/template check, applied to
// exec()/execSync() instead of a query call — both run their string argument
// through an interpreter (a shell here, SQL there) that untrusted input can
// escape out of. execFile()/spawn() with an argument array are deliberately
// out of scope: they never invoke a shell, so there's nothing to inject into.
function scanCommandInjection(relPath, content) {
  const issues = [];
  let m;
  const execRe = /\b(?:child_process\.)?(?:exec|execSync)\(\s*(`[^`]*\$\{[^`]*\}[^`]*`|['"][^'"]*['"]\s*\+)/g;
  while ((m = execRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Critical',
      category: 'Command Injection Risk',
      summary: 'A shell command is built via string concatenation or template interpolation and passed to exec()/execSync(), which runs it through a shell.',
      suggestedFix: "Use execFile()/execFileSync() or spawn() with an argument array instead of exec() — that bypasses the shell entirely, so shell metacharacters in the input can't be interpreted.",
    });
  }
  return issues;
}

const WEAK_RANDOM_CONTEXT_RE = /token|session|password|secret|csrf|nonce|otp|api[_-]?key|auth/i;

// Math.random() itself is fine for non-security randomness (a color, a
// shuffle, a UI animation) — flagging every call would be mostly noise, so
// this only fires when the same line reads like it's generating something
// security-sensitive. Runs on masked content so a comment or string that
// happens to mention "Math.random()" isn't mistaken for a live call.
function scanWeakRandomness(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const lines = content.split('\n');
  const issues = [];
  let m;
  const mathRandomRe = /Math\.random\(\)/g;
  while ((m = mathRandomRe.exec(masked))) {
    const line = lineOf(content, m.index);
    // The security-context keyword is often the enclosing function name or
    // an assignment target a few lines up (`function generateSessionToken()
    // { ... return Math.random()... }`), not necessarily the exact line
    // Math.random() is called on — so this checks a small window around the
    // call instead of just that one line.
    const context = lines.slice(Math.max(0, line - 6), line).join('\n');
    if (!WEAK_RANDOM_CONTEXT_RE.test(context)) continue;
    issues.push({
      file: relPath,
      line,
      severity: 'High',
      category: 'Weak Random Number Generation',
      summary: 'Math.random() is not cryptographically secure and appears to be generating a token, session ID, or other security-sensitive value.',
      suggestedFix: 'Use crypto.randomUUID() or crypto.randomBytes() (Node) / crypto.getRandomValues() (browser) instead of Math.random() for anything security-sensitive.',
    });
  }
  return issues;
}

const PASSWORD_CONTEXT_RE = /password|passwd|credential/i;

// Runs on raw content — the algorithm name ('md5'/'sha1') lives inside the
// string literal argument, which masking would blank out along with
// everything else needed to tell which algorithm was used. But that same
// property means the raw regex alone can't tell a live call from this exact
// text sitting inside someone else's string or template literal — e.g. a
// docs/example snippet, or (caught scanning this very file) the
// CATEGORY_CODE_EXAMPLE "before" text below, which is a template literal
// containing the vulnerable pattern as illustrative text, not a real call.
// Cross-checking the "createHash(" prefix (everything up to the opening
// quote — never itself inside a string for a genuine call) against the
// masked version confirms it's real code before flagging it.
function scanWeakHashing(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const issues = [];
  let m;
  const weakHashRe = /createHash\(\s*(['"])(md5|sha1)\1/gi;
  while ((m = weakHashRe.exec(content))) {
    const quoteIndex = m.index + m[0].indexOf(m[1]);
    if (masked.slice(m.index, quoteIndex) !== content.slice(m.index, quoteIndex)) continue;
    const line = lineOf(content, m.index);
    const lineText = content.split('\n')[line - 1] || '';
    const algo = m[2].toUpperCase();
    const isPasswordContext = PASSWORD_CONTEXT_RE.test(lineText);
    issues.push({
      file: relPath,
      line,
      severity: isPasswordContext ? 'Critical' : 'Medium',
      category: 'Weak Password Hashing',
      summary: `${algo} is used${isPasswordContext ? ' in what looks like a password/credential context' : ''} — ${algo} is broken for security purposes (collision-prone, fast to brute-force).`,
      suggestedFix: isPasswordContext
        ? 'Use a purpose-built password hash (bcrypt, scrypt, or Argon2) instead — never a general-purpose hash like MD5/SHA1/SHA256 for passwords, even salted.'
        : "If this is used for anything security-sensitive (integrity checks, signatures, password storage), switch to SHA-256 or better. If it's a non-security checksum (cache key, ETag), this can be disregarded.",
    });
  }
  return issues;
}

function scanCodeSmell(relPath, content, ext) {
  const masked = maskStringsAndComments(content, ext);
  const issues = [];
  let m;
  const consoleRe = /console\.(log|debug)\(/g;
  let consoleCount = 0;
  let firstConsoleIndex = -1;
  while ((m = consoleRe.exec(masked))) {
    consoleCount++;
    if (firstConsoleIndex < 0) firstConsoleIndex = m.index;
  }
  if (consoleCount > 0) {
    issues.push({
      file: relPath,
      line: lineOf(content, firstConsoleIndex),
      severity: 'Low',
      category: 'Leftover Debug Logging',
      summary: `${consoleCount} console.log/debug call(s) found — likely leftover debugging output.`,
      suggestedFix: 'Remove or replace with a structured logger that respects log levels/environment.',
    });
  }
  // TODO detection intentionally reads the RAW content — it looks for text
  // that follows a real `//` comment marker, so masking comments would erase
  // the very thing it's searching for.
  const todoRe = /\/\/\s*(TODO|FIXME|HACK|XXX)\b(.*)/g;
  while ((m = todoRe.exec(content))) {
    issues.push({
      file: relPath,
      line: lineOf(content, m.index),
      severity: 'Low',
      category: 'Unresolved TODO',
      summary: `${m[1]} comment left in code:${m[2].slice(0, 80)}`,
      suggestedFix: 'Resolve or file a tracked issue for this, then remove the comment.',
    });
  }
  return issues;
}

// A small, non-exhaustive list of known-problematic version ranges, used only
// to demonstrate the check — this is not a live vulnerability feed.
const KNOWN_VULNERABLE = [
  { name: 'lodash', badBelow: '4.17.21', reason: 'prototype pollution (CVE-2020-8203 and related) fixed in 4.17.21' },
  { name: 'minimist', badBelow: '1.2.6', reason: 'prototype pollution (CVE-2021-44906) fixed in 1.2.6' },
  { name: 'express', badBelow: '4.17.3', reason: 'open redirect / ReDoS issues fixed in later 4.x releases' },
  { name: 'axios', badBelow: '0.21.2', reason: 'SSRF (CVE-2021-3749) fixed in 0.21.2' },
  { name: 'node-fetch', badBelow: '2.6.7', reason: 'exposure of sensitive data (CVE-2022-0235) fixed in 2.6.7' },
];

function versionLess(a, b) {
  const pa = a.replace(/[^\d.]/g, '').split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function checkKnownVulnerableDeps(rootPath, relPath, pkgJsonContent) {
  const issues = [];
  try {
    const pkg = JSON.parse(pkgJsonContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const known of KNOWN_VULNERABLE) {
      const declared = allDeps[known.name];
      if (!declared) continue;
      if (versionLess(declared, known.badBelow)) {
        issues.push({
          file: relPath,
          line: 1,
          severity: 'High',
          category: 'Outdated/Vulnerable Dependency',
          source: 'dependency-audit',
          summary: `${known.name}@${declared} is below the known-fixed version ${known.badBelow} (${known.reason}).`,
          suggestedFix: `Upgrade ${known.name} to ${known.badBelow} or later. (Checked against a small built-in advisory list, not a live vulnerability database — also run \`npm audit\` for full coverage.)`,
        });
      }
    }
  } catch { /* invalid JSON, skip */ }
  return issues;
}

function scanFile(relPath, content, ext, customSecretRules) {
  const secrets = scanSecrets(relPath, content);
  const alreadyFlaggedLines = new Set(secrets.filter((i) => i.category === 'Hardcoded Secret').map((i) => i.line));
  // Feature: per-app masking rules — user-defined regex patterns applied
  // alongside the built-in secret checks above, same raw-content approach
  // (the value we're matching legitimately lives inside a string literal).
  const custom = customSecretRules && customSecretRules.length
    ? applyCustomRules(relPath, content, customSecretRules, lineOf)
    : [];
  return [
    ...secrets,
    ...scanEntropySecrets(relPath, content, ext, alreadyFlaggedLines),
    ...scanSqlInjection(relPath, content),
    ...scanCodeExecutionRisk(relPath, content, ext),
    ...scanXss(relPath, content),
    ...scanCommandInjection(relPath, content),
    ...scanWeakRandomness(relPath, content, ext),
    ...scanWeakHashing(relPath, content, ext),
    ...scanCodeSmell(relPath, content, ext),
    ...scanComplexityIssues(relPath, content, ext),
    ...scanMaintainabilityIssues(relPath, content, ext),
    ...custom,
  ];
}

// CWE/OWASP mapping, applied once over the fully-assembled issue list (see
// attachCweInfo below) rather than threaded through every check above — one
// lookup table by category instead of duplicating this at every push site,
// and it applies uniformly to issues from npmAudit.js/osvScan.js too since
// they share the same category strings. Categories with no real CWE (dead
// code, TODOs, license compliance, debug logging) are deliberately absent —
// forcing a CWE onto a non-vulnerability-class finding would be inaccurate,
// not helpful.
const CATEGORY_CWE = {
  'Hardcoded Secret': {
    cwe: 'CWE-798', title: 'Use of Hard-Coded Credentials', owasp: 'OWASP A07:2021 – Identification and Authentication Failures',
    why: 'A credential committed to source stays readable forever in git history/blame, even after the line is later removed or the repo goes private.',
  },
  'Possible High-Entropy Secret': {
    cwe: 'CWE-798', title: 'Use of Hard-Coded Credentials', owasp: 'OWASP A07:2021 – Identification and Authentication Failures',
    why: 'Same risk as a keyword-matched hardcoded secret — this one was caught by randomness alone, so confirm by hand before rotating anything.',
  },
  'SQL Injection Risk': {
    cwe: 'CWE-89', title: 'SQL Injection', owasp: 'OWASP A03:2021 – Injection',
    why: "Concatenating input into a query lets an attacker change the query's structure — e.g. appending a value like ' OR '1'='1 to bypass a WHERE clause, or a UNION SELECT to read another table.",
  },
  'Code Injection Risk': {
    cwe: 'CWE-94', title: 'Code Injection', owasp: 'OWASP A03:2021 – Injection',
    why: 'eval()/new Function() execute a string as code with the full privileges of the running process — any untrusted input that reaches it runs as if it were part of the program.',
  },
  'Cross-Site Scripting (XSS) Risk': {
    cwe: 'CWE-79', title: "Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')", owasp: 'OWASP A03:2021 – Injection',
    why: "Unsanitized HTML rendered into the page lets an attacker run arbitrary JavaScript in another user's browser session — e.g. steal their session cookie or perform actions as them.",
  },
  'Command Injection Risk': {
    cwe: 'CWE-78', title: "Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection')", owasp: 'OWASP A03:2021 – Injection',
    why: 'exec()/execSync() run the string through a shell, so shell metacharacters in the input (;, |, &&, $(...)) let an attacker chain in an arbitrary second command.',
  },
  'Weak Random Number Generation': {
    cwe: 'CWE-338', title: 'Use of Cryptographically Weak Pseudo-Random Number Generator (PRNG)', owasp: 'OWASP A02:2021 – Cryptographic Failures',
    why: "Math.random() is seeded and predictable — it's designed for speed, not unpredictability, so a token or session ID generated with it can potentially be guessed or reproduced by an attacker.",
  },
  'Weak Password Hashing': {
    cwe: 'CWE-916', title: 'Use of Password Hash With Insufficient Computational Effort', owasp: 'OWASP A02:2021 – Cryptographic Failures',
    why: 'MD5 and SHA-1 are fast general-purpose hashes designed for speed, which is exactly the wrong property for password storage — it makes brute-forcing a stolen hash database cheap. Purpose-built password hashes (bcrypt/scrypt/Argon2) are deliberately slow.',
  },
  'Outdated/Vulnerable Dependency': {
    cwe: 'CWE-1104', title: 'Use of Unmaintained Third-Party Components', owasp: 'OWASP A06:2021 – Vulnerable and Outdated Components',
    why: 'A dependency with a known, published vulnerability is a documented attack path — the fix is usually just a version bump, which is why this category is worth clearing before anything else.',
  },
};

// Junior-developer learning path: a suggestedFix is a sentence; a
// before/after snippet is something you can actually compare side by side.
// Deliberately generic per category (not tailored to the exact line
// flagged) — the point is teaching the shape of the fix, not auto-fixing
// this specific occurrence (Deep Scan's proposeFixDiff, below, does that
// for the small set of mechanical fixes that are safe to generate
// automatically). Categories without an established one-shot fix pattern
// (dead code, TODOs, license compliance) are left without an example —
// those are judgment calls, not a rewrite shape.
const CATEGORY_CODE_EXAMPLE = {
  'Hardcoded Secret': {
    before: `const apiKey = "sk_live_51H8x...";`,
    after: `const apiKey = process.env.STRIPE_API_KEY;`,
  },
  'Possible High-Entropy Secret': {
    before: `const apiKey = "sk_live_51H8x...";`,
    after: `const apiKey = process.env.STRIPE_API_KEY;`,
  },
  'SQL Injection Risk': {
    before: `db.query("SELECT * FROM users WHERE id = " + userId);`,
    after: `db.query("SELECT * FROM users WHERE id = ?", [userId]);`,
  },
  'Code Injection Risk': {
    before: `eval(userSuppliedExpression);`,
    after: `// Parse to a known-safe shape instead of executing arbitrary code\nJSON.parse(userSuppliedExpression);`,
  },
  'Cross-Site Scripting (XSS) Risk': {
    before: `el.innerHTML = \`<p>\${userBio}</p>\`;`,
    after: `el.textContent = userBio;\n// or, if userBio must contain markup:\nel.innerHTML = DOMPurify.sanitize(\`<p>\${userBio}</p>\`);`,
  },
  'Command Injection Risk': {
    before: `execSync(\`tar -czf backup.tar.gz \${userPath}\`);`,
    after: `execFileSync('tar', ['-czf', 'backup.tar.gz', userPath]);`,
  },
  'Weak Random Number Generation': {
    before: `const sessionToken = Math.random().toString(36).slice(2);`,
    after: `const sessionToken = crypto.randomUUID();`,
  },
  'Weak Password Hashing': {
    before: `const hash = crypto.createHash('md5').update(password).digest('hex');`,
    after: `const hash = await bcrypt.hash(password, 12);`,
  },
  'N+1 Query Pattern': {
    before: `for (const id of userIds) {\n  const posts = await db.post.findMany({ where: { userId: id } });\n}`,
    after: `const posts = await db.post.findMany({ where: { userId: { in: userIds } } });\nconst byUser = groupBy(posts, 'userId');`,
  },
  'Unbounded Loop Over Unpaginated Data': {
    before: `for (const item of await db.item.findMany()) { process(item); }`,
    after: `let page = 0;\nlet batch;\ndo {\n  batch = await db.item.findMany({ take: 100, skip: page++ * 100 });\n  for (const item of batch) process(item);\n} while (batch.length === 100);`,
  },
  'Missing Effect Cleanup': {
    before: `useEffect(() => {\n  const id = setInterval(tick, 1000);\n}, []);`,
    after: `useEffect(() => {\n  const id = setInterval(tick, 1000);\n  return () => clearInterval(id);\n}, []);`,
  },
};

function attachCweInfo(issues) {
  return issues.map((issue) => {
    const cweInfo = CATEGORY_CWE[issue.category];
    const example = CATEGORY_CODE_EXAMPLE[issue.category];
    if ((!cweInfo || issue.cwe) && (!example || issue.codeExample)) return issue;
    const patch = {};
    if (cweInfo && !issue.cwe) patch.cwe = `${cweInfo.cwe} — ${cweInfo.title} (${cweInfo.owasp}). ${cweInfo.why}`;
    if (example && !issue.codeExample) patch.codeExample = example;
    return { ...issue, ...patch };
  });
}

// Aggregation-time check across the whole project: files that define exports
// but no other scanned file's relative import resolves to them, excluding
// entry points/tests/config. Resolution mirrors Node's index.js fallback and
// Python's package __init__.py, which a naive substring match got wrong.
function findDeadCode(allFileComponents, entryPoints) {
  const existing = new Set(allFileComponents.map((fc) => fc.relPath));
  const referenced = new Set();

  for (const fc of allFileComponents) {
    for (const imp of fc.imports || []) {
      const resolvedBase = resolveImport(fc, imp);
      if (resolvedBase === null) continue;
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = resolvedBase + suffix;
        if (existing.has(candidate)) referenced.add(candidate);
      }
    }
  }

  const issues = [];
  for (const fc of allFileComponents) {
    const fileName = fc.relPath.split('/').pop();
    const baseName = fc.relPath.replace(/\.[^./]+$/, '');
    const isEntry = entryPoints.some((e) => e.includes(fileName) || e.startsWith(baseName.split('/').pop()));
    const isTestOrConfig = /\.(test|spec)\./.test(fc.relPath) || /^(test|tests|__tests__|config)\//.test(fc.relPath) || /\.config\./.test(fc.relPath);
    if (isEntry || isTestOrConfig) continue;
    if ((fc.functions.length + fc.classes.length) === 0) continue;
    if (!referenced.has(fc.relPath)) {
      issues.push({
        file: fc.relPath,
        line: 1,
        severity: 'Low',
        category: 'Possible Dead Code',
        summary: 'No other scanned file resolves a relative import to this file (real path resolution, including index.js/__init__.py fallback — dynamic imports or consumers outside this repo would not be detected).',
        suggestedFix: 'Confirm whether this file is still used (check dynamic imports, build tooling, or external consumers) and remove it if not.',
      });
    }
  }
  return issues;
}

module.exports = { scanFile, checkKnownVulnerableDeps, findDeadCode, attachCweInfo };
