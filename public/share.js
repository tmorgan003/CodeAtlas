// Feature 17: public read-only share link. Deliberately not app.js reused
// wholesale — this page has no auth, no app list, no editing, nothing but
// six read-only wiki pages for the one app the token resolves to, so it
// gets its own small self-contained script rather than importing the full
// (much larger, edit-capable) management UI.

const themeToggleBtn = document.getElementById('theme-toggle');
const THEME_KEY = 'codeatlas-theme';

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
}
let currentTheme = localStorage.getItem(THEME_KEY) || (systemPrefersDark() ? 'dark' : 'light');
applyTheme(currentTheme);
themeToggleBtn.addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme(currentTheme);
});

const token = new URLSearchParams(location.search).get('token');
const appNameEl = document.getElementById('share-app-name');
const appPurposeEl = document.getElementById('share-app-purpose');
const wikiLinksEl = document.getElementById('wiki-links');
const wikiViewEl = document.getElementById('wiki-view');

async function shareApi(path) {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---- Minimal markdown renderer (same rules as the main app's, trimmed to
// read-only — no data-wiki-path edit affordances, just navigation) ----

function resolveRelative(baseDir, relPath) {
  if (relPath.startsWith('/')) return relPath.slice(1);
  const baseParts = baseDir ? baseDir.split('/') : [];
  const relParts = relPath.split('/');
  for (const part of relParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(text, baseDir) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, target) => {
    if (/^https?:\/\//.test(target)) return `<a href="${target}" target="_blank" rel="noopener">${label}</a>`;
    if (target.endsWith('.md')) {
      const resolved = resolveRelative(baseDir, target);
      return `<a data-wiki-path="${resolved}">${label}</a>`;
    }
    return label;
  });
  return out;
}

// ---- renderMarkdown line handlers ----
// Split out of renderMarkdown (was one function with cyclomatic complexity
// 16 — every line type's detection logic in one if/else-if chain). Each
// tryX below inspects one line, mutates the shared `state`, and returns
// true if it consumed the line (equivalent to the original's `continue`).
// Order matters and mirrors the original exactly, including the two
// state-transitions that aren't tied to a "did we handle it" return value:
// tryTableRow closes a still-open table on the first non-table line, and
// closeMarkdownList runs for every line that reaches past the list check.

function closeMarkdownList(state) {
  if (state.listOpen) { state.html.push('</ul>'); state.listOpen = false; }
}

function tryCodeFence(line, state) {
  if (!line.startsWith('```')) return false;
  if (!state.inCode) {
    state.inCode = true;
    state.codeLang = line.slice(3).trim();
    state.html.push(state.codeLang === 'mermaid' ? '<pre class="mermaid">' : '<pre><code>');
  } else {
    state.html.push(state.codeLang === 'mermaid' ? '</pre>' : '</code></pre>');
    state.inCode = false;
    state.codeLang = '';
  }
  return true;
}

function tryCodeLine(line, state) {
  if (!state.inCode) return false;
  state.html.push(escapeHtml(line));
  return true;
}

function tryTableRow(line, state, baseDir) {
  if (!/^\s*\|.*\|\s*$/.test(line)) {
    if (state.inTable) { state.html.push('</table>', '</div>'); state.inTable = false; }
    return false;
  }
  const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
  if (cells.every((c) => /^-+$/.test(c))) return true; // separator row
  if (!state.inTable) { state.html.push('<div class="table-scroll">', '<table>'); state.inTable = true; }
  const tag = state.html[state.html.length - 1] === '<table>' ? 'th' : 'td';
  state.html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir)}</${tag}>`).join('') + '</tr>');
  return true;
}

function tryHeading(line, state, baseDir) {
  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (!h) return false;
  closeMarkdownList(state);
  const level = h[1].length;
  state.html.push(`<h${level}>${inlineFormat(h[2], baseDir)}</h${level}>`);
  return true;
}

function tryListItem(line, state, baseDir) {
  if (!/^-\s+/.test(line)) return false;
  if (!state.listOpen) { state.html.push('<ul>'); state.listOpen = true; }
  state.html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir)}</li>`);
  return true;
}

function tryHrOrBlank(line, state) {
  if (line.trim() === '---') { state.html.push('<hr>'); return true; }
  if (line.trim() === '') { state.html.push(''); return true; }
  return false;
}

function renderMarkdown(md, baseDir) {
  const state = { inTable: false, inCode: false, codeLang: '', listOpen: false, html: [] };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (tryCodeFence(line, state)) continue;
    if (tryCodeLine(line, state)) continue;
    if (tryTableRow(line, state, baseDir)) continue;
    if (tryHeading(line, state, baseDir)) continue;
    if (tryListItem(line, state, baseDir)) continue;
    closeMarkdownList(state);

    if (tryHrOrBlank(line, state)) continue;

    state.html.push(`<p>${inlineFormat(line, baseDir)}</p>`);
  }
  closeMarkdownList(state);
  if (state.inTable) state.html.push('</table>', '</div>');
  return state.html.join('\n');
}

let currentWikiDir = '';

// Same CDN-loaded mermaid.js as the main app (see index.html/app.js) — this
// page is deliberately self-contained rather than importing app.js (see the
// header comment), so it gets its own small init + render-after-load.
if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      background: '#0f1115',
      primaryColor: '#171a21',
      primaryTextColor: '#e6e8ec',
      primaryBorderColor: '#2a2e37',
      lineColor: '#4595b5',
    },
  });
}

async function renderMermaidDiagrams(container) {
  if (!window.mermaid) return;
  const nodes = container.querySelectorAll('pre.mermaid');
  if (!nodes.length) return;
  try {
    await window.mermaid.run({ nodes, suppressErrors: true });
  } catch {
    // a malformed diagram shouldn't take the rest of the page down with it
  }
}

async function loadPage(wikiPath) {
  try {
    const { path: resolvedPath, content } = await shareApi(`/wiki-file?path=${encodeURIComponent(wikiPath)}`);
    currentWikiDir = resolvedPath.includes('/') ? resolvedPath.slice(0, resolvedPath.lastIndexOf('/')) : '';
    wikiViewEl.innerHTML = renderMarkdown(content, currentWikiDir);
    renderMermaidDiagrams(wikiViewEl);
  } catch (err) {
    wikiViewEl.textContent = 'Could not load page: ' + err.message;
  }
}

wikiViewEl.addEventListener('click', (e) => {
  const link = e.target.closest('[data-wiki-path]');
  if (link) {
    e.preventDefault();
    loadPage(link.dataset.wikiPath);
  }
});

function renderNav() {
  const pages = [
    ['Home', 'Home.md'],
    ['Architecture', 'Architecture.md'],
    ['Data Model', 'Data-Model.md'],
    ['Change Log', 'Change-Log.md'],
    ['Setup', 'Setup.md'],
    ['Progress', 'Progress.md'],
  ];
  wikiLinksEl.innerHTML = '';
  const group = document.createElement('div');
  group.className = 'wiki-nav-group';
  for (const [label, p] of pages) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = label;
    btn.addEventListener('click', () => loadPage(p));
    group.appendChild(btn);
  }
  wikiLinksEl.appendChild(group);
}

async function init() {
  if (!token) {
    appNameEl.textContent = 'No share link provided';
    wikiViewEl.textContent = 'This URL is missing its share token.';
    return;
  }
  try {
    const app = await shareApi('');
    appNameEl.textContent = app.name;
    appPurposeEl.textContent = app.purpose || '';
    document.title = `${app.name} — Shared Wiki`;
    renderNav();
    await loadPage('Home.md');
  } catch (err) {
    appNameEl.textContent = 'Share link not found';
    wikiViewEl.textContent = err.message + ' — it may have been revoked.';
  }
}

init();
