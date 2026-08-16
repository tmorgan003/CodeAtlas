// Feature 18 (static-site half): bundles a generated /wiki folder into a
// portable, self-contained static HTML site — every .md becomes a
// cross-linked .html page under a fixed dark stylesheet, with no server or
// build step required to view it. Written to <appRoot>/wiki-static-site/,
// alongside (not replacing) the markdown /wiki/ output.

const fs = require('fs');
const path = require('path');
const { renderMarkdownToHtml } = require('./markdownToHtml');

const PAGE_STYLE = `
body{background:#0f1115;color:#e6e8ec;font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:0 auto;padding:2rem;line-height:1.6}
h1,h2,h3{color:#fff}
a{color:#5b8cff}
code{background:#171a21;padding:0.1rem 0.35rem;border-radius:4px;font-size:0.9em}
pre{background:#171a21;padding:0.8rem;border-radius:6px;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:0.75rem 0}
th,td{text-align:left;padding:0.5rem;border-bottom:1px solid #2a2e37;font-size:0.9rem}
th{color:#9aa1ac;text-transform:uppercase;font-size:0.75rem}
hr{border:none;border-top:1px solid #2a2e37;margin:1.5rem 0}
`;

function collectMdFiles(dir, base = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(collectMdFiles(full, base));
    else if (entry.name.endsWith('.md')) results.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return results;
}

function buildStaticSite(wikiDir, outDir, appName) {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const relFiles = collectMdFiles(wikiDir);
  const htmlPathFor = (mdRelPath) => mdRelPath.replace(/\.md$/, '.html');
  const existing = new Set(relFiles);
  const linkResolver = (resolvedMdRelPath) => (existing.has(resolvedMdRelPath) ? htmlPathFor(resolvedMdRelPath) : null);

  for (const rel of relFiles) {
    const raw = fs.readFileSync(path.join(wikiDir, rel), 'utf8');
    const baseDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const bodyHtml = renderMarkdownToHtml(raw, baseDir, linkResolver);
    const title = (raw.match(/^#\s+(.*)$/m) || [, rel])[1];
    const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} — ${appName}</title>
<style>${PAGE_STYLE}</style></head>
<body>${bodyHtml}</body></html>
`;
    const outPath = path.join(outDir, htmlPathFor(rel));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, page, 'utf8');
  }

  // index.html at the root always points at Home, so "open the folder" has
  // an obvious entry point even if the caller doesn't know the convention.
  if (existing.has('Home.md')) {
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=Home.html"></head><body><a href="Home.html">Continue to wiki</a></body></html>`,
      'utf8'
    );
  }

  return { outDir, pageCount: relFiles.length };
}

module.exports = { buildStaticSite };
