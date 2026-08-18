// Shared lexical scanner for JS/TS/Python source: walks the file once and
// classifies every span as a comment, a string/template/regex literal, or
// plain code — used by (1) maskStringsAndComments, which blanks out
// non-code spans so a pattern-matcher can't be fooled by a finding's own
// description text sitting in a comment or string, and (2) extractStrings,
// which returns the genuine top-level string-literal values (for entropy-
// based secret detection) without also matching quote characters that
// happen to appear nested inside a template literal or inside a regex
// character class like /['"]/.
//
// Not a real lexer, but tracking real token boundaries (rather than each
// caller re-implementing its own quote-matching regex) is what fixed two
// real false-positive bugs: a regex literal like /['"]/  desyncing a naive
// quote-scanner's open/close parity, and a double-quoted HTML attribute
// nested inside a backtick template being mistaken for a standalone string.

const REGEX_PRECEDING_PUNCT = new Set(['(', '[', '{', ',', ';', ':', '!', '&', '|', '?', '=', '+', '-', '*', '%', '^', '~', '<', '>']);
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function precedingWord(content, i) {
  let j = i;
  while (j > 0 && /[A-Za-z0-9_$]/.test(content[j - 1])) j--;
  return content.slice(j, i);
}

function looksLikeRegexStart(content, i, lastSignificant) {
  if (lastSignificant === null) return true;
  if (REGEX_PRECEDING_PUNCT.has(lastSignificant)) return true;
  if (/[A-Za-z0-9_$]/.test(lastSignificant)) {
    return REGEX_PRECEDING_KEYWORDS.has(precedingWord(content, i));
  }
  return false;
}

function consumeRegexLiteral(content, start) {
  const n = content.length;
  let i = start + 1;
  let inClass = false;
  while (i < n) {
    const c = content[i];
    if (c === '\n') return null;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) { i++; break; }
    i++;
  }
  if (content[i - 1] !== '/') return null;
  while (i < n && /[a-z]/i.test(content[i])) i++;
  return i;
}

// Each tryX below attempts to consume one span type starting at `i` and
// returns { type, end, lastSignificant? } on a match, or null to let
// tokenize() try the next span type. Splitting these out (mirroring the
// pre-existing consumeRegexLiteral) is what took tokenize() from a single
// 29-branch loop down to a short dispatch loop — the branch count didn't
// disappear, it just moved into these small, independently-readable
// functions instead of one long if-chain.

function tryLineComment(content, i, flags) {
  if (!flags.isJsLike || content.slice(i, i + 2) !== '//') return null;
  const n = content.length;
  let j = i;
  while (j < n && content[j] !== '\n') j++;
  return { type: 'comment', end: j };
}

function tryBlockComment(content, i, flags) {
  if (!flags.isJsLike || content.slice(i, i + 2) !== '/*') return null;
  let j = content.indexOf('*/', i + 2);
  j = j === -1 ? content.length : j + 2;
  return { type: 'comment', end: j };
}

function tryPythonComment(content, i, flags) {
  if (!flags.isPython || content[i] !== '#') return null;
  const n = content.length;
  let j = i;
  while (j < n && content[j] !== '\n') j++;
  return { type: 'comment', end: j };
}

function tryPythonTripleQuote(content, i, flags) {
  if (!flags.isPython) return null;
  const three = content.slice(i, i + 3);
  if (three !== '"""' && three !== "'''") return null;
  let j = content.indexOf(three, i + 3);
  j = j === -1 ? content.length : j + 3;
  return { type: 'comment', end: j };
}

function tryRegexLiteral(content, i, flags) {
  if (!flags.isJsLike || content[i] !== '/' || !looksLikeRegexStart(content, i, flags.lastSignificant)) return null;
  const end = consumeRegexLiteral(content, i);
  if (end === null) return null;
  return { type: 'regex', end, lastSignificant: '/' };
}

function tryStringOrTemplate(content, i) {
  const ch = content[i];
  if (ch !== '"' && ch !== "'" && ch !== '`') return null;
  const n = content.length;
  let j = i + 1;
  while (j < n && content[j] !== ch) {
    if (content[j] === '\\') j++;
    j++;
  }
  j = Math.min(j + 1, n);
  return { type: ch === '`' ? 'template' : 'string', end: j, lastSignificant: ch };
}

const SPAN_MATCHERS = [tryLineComment, tryBlockComment, tryPythonComment, tryPythonTripleQuote, tryRegexLiteral, tryStringOrTemplate];

// Yields { type: 'comment'|'string'|'template'|'regex'|'code', start, end }
// spans covering the entire content. 'string' is single/double-quoted only
// (what a secret-detector cares about); backtick templates are their own
// 'template' type since interpolation makes their raw text unreliable.
function tokenize(content, ext) {
  const flags = { isPython: ext === '.py', isJsLike: ext !== '.py', lastSignificant: null };
  const tokens = [];
  let i = 0;
  const n = content.length;
  let codeStart = 0;

  const flushCode = (end) => {
    if (end > codeStart) tokens.push({ type: 'code', start: codeStart, end });
  };

  while (i < n) {
    let matched = null;
    for (const tryMatch of SPAN_MATCHERS) {
      matched = tryMatch(content, i, flags);
      if (matched) break;
    }
    if (matched) {
      flushCode(i);
      tokens.push({ type: matched.type, start: i, end: matched.end });
      i = matched.end;
      codeStart = i;
      if (matched.lastSignificant !== undefined) flags.lastSignificant = matched.lastSignificant;
      continue;
    }
    if (!/\s/.test(content[i])) flags.lastSignificant = content[i];
    i++;
  }
  flushCode(n);
  return tokens;
}

function maskStringsAndComments(content, ext) {
  const tokens = tokenize(content, ext);
  let out = '';
  for (const t of tokens) {
    const raw = content.slice(t.start, t.end);
    out += t.type === 'code' ? raw : raw.replace(/[^\n]/g, ' ');
  }
  return out;
}

// Returns [{ value, index }] for genuine top-level single/double-quoted
// string literals — excludes backtick template contents, regex literals,
// and comments, and returns the *inner* text (quotes stripped) with escapes
// left as-is (callers care about entropy/shape, not decoded value).
function extractStrings(content, ext) {
  const tokens = tokenize(content, ext);
  const results = [];
  for (const t of tokens) {
    if (t.type !== 'string') continue;
    results.push({ value: content.slice(t.start + 1, t.end - 1), index: t.start });
  }
  return results;
}

module.exports = { maskStringsAndComments, extractStrings, tokenize };
