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

function renderMarkdown(md, baseDir) {
  const lines = md.split('\n');
  const html = [];
  let inTable = false;
  let inCode = false;
  let listOpen = false;
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('```')) {
      inCode = !inCode;
      html.push(inCode ? '<pre><code>' : '</code></pre>');
      continue;
    }
    if (inCode) { html.push(escapeHtml(line)); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!inTable) { html.push('<div class="table-scroll">', '<table>'); inTable = true; }
      const tag = html[html.length - 1] === '<table>' ? 'th' : 'td';
      html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir)}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      html.push('</table>', '</div>');
      inTable = false;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inlineFormat(h[2], baseDir)}</h${level}>`);
      continue;
    }

    if (/^-\s+/.test(line)) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir)}</li>`);
      continue;
    }
    closeList();

    if (line.trim() === '---') { html.push('<hr>'); continue; }
    if (line.trim() === '') { html.push(''); continue; }
    html.push(`<p>${inlineFormat(line, baseDir)}</p>`);
  }
  closeList();
  if (inTable) html.push('</table>', '</div>');
  return html.join('\n');
}

let currentWikiDir = '';

async function loadPage(wikiPath) {
  try {
    const { path: resolvedPath, content } = await shareApi(`/wiki-file?path=${encodeURIComponent(wikiPath)}`);
    currentWikiDir = resolvedPath.includes('/') ? resolvedPath.slice(0, resolvedPath.lastIndexOf('/')) : '';
    wikiViewEl.innerHTML = renderMarkdown(content, currentWikiDir);
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
