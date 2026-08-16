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

// Yields { type: 'comment'|'string'|'template'|'regex'|'code', start, end }
// spans covering the entire content. 'string' is single/double-quoted only
// (what a secret-detector cares about); backtick templates are their own
// 'template' type since interpolation makes their raw text unreliable.
function tokenize(content, ext) {
  const isPython = ext === '.py';
  const isJsLike = !isPython;
  const tokens = [];
  let i = 0;
  const n = content.length;
  let lastSignificant = null;
  let codeStart = 0;

  const flushCode = (end) => {
    if (end > codeStart) tokens.push({ type: 'code', start: codeStart, end });
  };

  while (i < n) {
    const ch = content[i];
    const two = content.slice(i, i + 2);

    if (isJsLike && two === '//') {
      flushCode(i);
      let j = i;
      while (j < n && content[j] !== '\n') j++;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j;
      codeStart = i;
      continue;
    }
    if (isJsLike && two === '/*') {
      flushCode(i);
      let j = content.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j;
      codeStart = i;
      continue;
    }
    if (isPython && ch === '#') {
      flushCode(i);
      let j = i;
      while (j < n && content[j] !== '\n') j++;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j;
      codeStart = i;
      continue;
    }
    const three = content.slice(i, i + 3);
    if (isPython && (three === '"""' || three === "'''")) {
      flushCode(i);
      let j = content.indexOf(three, i + 3);
      j = j === -1 ? n : j + 3;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j;
      codeStart = i;
      continue;
    }
    if (isJsLike && ch === '/' && looksLikeRegexStart(content, i, lastSignificant)) {
      const end = consumeRegexLiteral(content, i);
      if (end !== null) {
        flushCode(i);
        tokens.push({ type: 'regex', start: i, end });
        i = end;
        codeStart = i;
        lastSignificant = '/';
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      flushCode(i);
      let j = i + 1;
      while (j < n && content[j] !== quote) {
        if (content[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      tokens.push({ type: quote === '`' ? 'template' : 'string', start: i, end: j });
      i = j;
      codeStart = i;
      lastSignificant = quote;
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
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
