// Shared by GET /:id/wiki-file (apps.js) and the public read-only share
// route (share.js) — both need identical resolution: a saved page override
// (Feature 16) takes priority, then the file on disk under the app's own
// wiki/ dir, with the same monorepo sub-package fallback (Feature 9) when
// the requested path escapes wiki/ but is still inside the scan root under
// some "wiki" subdirectory. Kept in one place so a future fix to this logic
// doesn't have to be made twice.

const fs = require('fs');
const path = require('path');
const wikiOverrides = require('./wikiOverrides');

// Returns { path, content, overridden, updatedAt? } or null if not found.
function resolveWikiFile(app, requestedPath) {
  const requested = requestedPath || 'Home.md';

  const pageOverrides = wikiOverrides.loadOverrides(app.id);
  if (pageOverrides[requested]) {
    return { path: requested, content: pageOverrides[requested].content, overridden: true, updatedAt: pageOverrides[requested].updatedAt };
  }

  const wikiDir = path.join(app.localPath, 'wiki');
  const wikiRoot = path.resolve(wikiDir);
  const appRoot = path.resolve(app.localPath);
  const inWiki = path.resolve(wikiDir, requested);
  const inAppRoot = path.resolve(appRoot, requested);
  const candidates = [];
  if (inWiki === wikiRoot || inWiki.startsWith(wikiRoot + path.sep)) candidates.push(inWiki);
  if ((inAppRoot === appRoot || inAppRoot.startsWith(appRoot + path.sep)) && inAppRoot.split(path.sep).includes('wiki')) {
    candidates.push(inAppRoot);
  }
  const resolved = candidates.find((p) => fs.existsSync(p));
  if (!resolved) return null;
  return { path: requested, content: fs.readFileSync(resolved, 'utf8'), overridden: false };
}

module.exports = { resolveWikiFile };
