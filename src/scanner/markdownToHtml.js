// Server-side markdown -> HTML string renderer, used only for static-site
// export (feature 18). Deliberately the same minimal feature set as the
// frontend's client-side renderer in public/app.js (headers, bold, inline
// code, tables, lists, links) — this is a generated wiki of a known shape,
// not arbitrary markdown, so a full CommonMark implementation isn't needed.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveRelative(baseDir, relPath) {
  if (relPath.startsWith('/')) return relPath.slice(1);
  const baseParts = baseDir ? baseDir.split('/') : [];
  for (const part of relPath.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
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

function renderMarkdownToHtml(md, baseDir, linkResolver) {
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
      if (!inTable) { html.push('<table>'); inTable = true; }
      const tag = html[html.length - 1] === '<table>' ? 'th' : 'td';
      html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir, linkResolver)}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      html.push('</table>');
      inTable = false;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inlineFormat(h[2], baseDir, linkResolver)}</h${level}>`);
      continue;
    }
    if (/^-\s+/.test(line)) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir, linkResolver)}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '---') { html.push('<hr>'); continue; }
    if (line.trim() === '') { html.push(''); continue; }
    html.push(`<p>${inlineFormat(line, baseDir, linkResolver)}</p>`);
  }
  closeList();
  if (inTable) html.push('</table>');
  return html.join('\n');
}

module.exports = { renderMarkdownToHtml, resolveRelative };
