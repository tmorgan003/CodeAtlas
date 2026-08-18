// Server-side markdown -> HTML string renderer, used only for static-site
// export (feature 18). Deliberately the same minimal feature set as the
// frontend's client-side renderer in public/app.js (headers, bold, inline
// code, tables, lists, links) — this is a generated wiki of a known shape,
// not arbitrary markdown, so a full CommonMark implementation isn't needed.

const path = require('path');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveRelative(baseDir, relPath) {
  if (relPath.startsWith('/')) return relPath.slice(1);
  return path.posix.join(baseDir || '', relPath);
}

// linkResolver(resolvedMdRelPath) -> href to emit for an internal .md link,
// or null to leave it as plain text (e.g. target doesn't exist in the set).
function inlineFormat(text, baseDir, linkResolver) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, target) => {
    if (/^https?:\/\//.test(target)) return `<a href="${target}" target="_blank" rel="noopener">${label}</a>`;
    if (target.endsWith('.md')) {
      const resolved = resolveRelative(baseDir, target);
      const href = linkResolver(resolved);
      return href ? `<a href="${href}">${label}</a>` : label;
    }
    return label;
  });
  return out;
}

// ---- renderMarkdownToHtml line handlers ----
// Split out of renderMarkdownToHtml (was one function with cyclomatic
// complexity 16 — every line type's detection logic in one if/else-if
// chain). Each tryX below inspects one line, mutates the shared `state`,
// and returns true if it consumed the line (equivalent to the original's
// `continue`). Order matters and mirrors the original exactly, including
// the two state-transitions that aren't tied to a "did we handle it"
// return value: tryTableRow closes a still-open table on the first
// non-table line, and closeMdList runs for every line that reaches past
// the list check.

function closeMdList(state) {
  if (state.listOpen) { state.html.push('</ul>'); state.listOpen = false; }
}

function tryMdCodeFence(line, state) {
  if (!line.startsWith('```')) return false;
  state.inCode = !state.inCode;
  state.html.push(state.inCode ? '<pre><code>' : '</code></pre>');
  return true;
}

function tryMdCodeLine(line, state) {
  if (!state.inCode) return false;
  state.html.push(escapeHtml(line));
  return true;
}

function tryMdTableRow(line, state, baseDir, linkResolver) {
  if (!/^\s*\|.*\|\s*$/.test(line)) {
    if (state.inTable) { state.html.push('</table>'); state.inTable = false; }
    return false;
  }
  const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
  if (cells.every((c) => /^-+$/.test(c))) return true; // separator row
  if (!state.inTable) { state.html.push('<table>'); state.inTable = true; }
  const tag = state.html[state.html.length - 1] === '<table>' ? 'th' : 'td';
  state.html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir, linkResolver)}</${tag}>`).join('') + '</tr>');
  return true;
}

function tryMdHeading(line, state, baseDir, linkResolver) {
  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (!h) return false;
  closeMdList(state);
  const level = h[1].length;
  state.html.push(`<h${level}>${inlineFormat(h[2], baseDir, linkResolver)}</h${level}>`);
  return true;
}

function tryMdListItem(line, state, baseDir, linkResolver) {
  if (!/^-\s+/.test(line)) return false;
  if (!state.listOpen) { state.html.push('<ul>'); state.listOpen = true; }
  state.html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir, linkResolver)}</li>`);
  return true;
}

function tryMdHrOrBlank(line, state) {
  if (line.trim() === '---') { state.html.push('<hr>'); return true; }
  if (line.trim() === '') { state.html.push(''); return true; }
  return false;
}

function renderMarkdownToHtml(md, baseDir, linkResolver) {
  const state = { inTable: false, inCode: false, listOpen: false, html: [] };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (tryMdCodeFence(line, state)) continue;
    if (tryMdCodeLine(line, state)) continue;
    if (tryMdTableRow(line, state, baseDir, linkResolver)) continue;
    if (tryMdHeading(line, state, baseDir, linkResolver)) continue;
    if (tryMdListItem(line, state, baseDir, linkResolver)) continue;
    closeMdList(state);

    if (tryMdHrOrBlank(line, state)) continue;

    state.html.push(`<p>${inlineFormat(line, baseDir, linkResolver)}</p>`);
  }
  closeMdList(state);
  if (state.inTable) state.html.push('</table>');
  return state.html.join('\n');
}

module.exports = { renderMarkdownToHtml, resolveRelative };
