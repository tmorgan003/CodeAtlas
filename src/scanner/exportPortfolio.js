// Feature 11: Export Static Site works per app; this bundles every app's
// wiki into one shared output directory (each under its own slug
// subfolder, reusing buildStaticSite as-is) plus a root index.html
// summarizing the whole portfolio — for a combined review instead of
// opening each app's export separately.

const fs = require('fs');
const path = require('path');
const { buildStaticSite, PAGE_STYLE } = require('./exportSite');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'app';
}

function buildPortfolioStaticSite(apps, outDir) {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const usedSlugs = new Set();
  const results = [];
  for (const app of apps) {
    let slug = slugify(app.name);
    while (usedSlugs.has(slug)) slug += '-2';
    usedSlugs.add(slug);

    if (!app.localPath) { results.push({ app, slug, error: 'Not scanned yet' }); continue; }
    const wikiDir = path.join(app.localPath, 'wiki');
    if (!fs.existsSync(wikiDir)) { results.push({ app, slug, error: 'No wiki generated yet' }); continue; }
    try {
      const built = buildStaticSite(wikiDir, path.join(outDir, slug), app.name);
      results.push({ app, slug, pageCount: built.pageCount });
    } catch (err) {
      results.push({ app, slug, error: String((err && err.message) || err) });
    }
  }

  const rows = results.map((r) => {
    const env = r.app.environment || '—';
    if (r.error) return `<tr><td>${r.app.name}</td><td>${env}</td><td>${r.app.status}</td><td colspan="2">${r.error}</td></tr>`;
    const issues = r.app.stats ? r.app.stats.issues : '—';
    return `<tr><td><a href="${r.slug}/Home.html">${r.app.name}</a></td><td>${env}</td><td>${r.app.status}</td><td>${issues}</td><td>${r.pageCount} page(s)</td></tr>`;
  }).join('');

  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Portfolio Review</title>
<style>${PAGE_STYLE}</style></head>
<body>
<h1>Portfolio Review</h1>
<p>${results.length} application(s), generated ${new Date().toLocaleString()}.</p>
<table><tr><th>App</th><th>Environment</th><th>Status</th><th>Active Issues</th><th>Wiki</th></tr>${rows}</table>
</body></html>
`;
  fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');

  return { outDir, appCount: results.length, exportedCount: results.filter((r) => !r.error).length };
}

module.exports = { buildPortfolioStaticSite };
