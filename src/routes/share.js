// Feature 17: public read-only share link. Deliberately a separate router
// from apps.js's /:id/... surface, not just a differently-gated route on
// it — everything here is reachable with zero authentication by design (the
// whole point is "anyone with the URL"), so it's scoped as narrowly as
// possible: looked up by an opaque random token (not the app's real id),
// and limited to serving generated wiki pages read-only. No issues, no
// triage, no settings, no list of other apps — a leaked share link exposes
// exactly one app's wiki, nothing else.

const express = require('express');
const db = require('../store/db');
const { resolveWikiFile } = require('../scanner/wikiFileResolver');

const router = express.Router();

function findByToken(token) {
  if (!token) return null;
  return db.loadAll().find((a) => a.shareToken === token) || null;
}

router.get('/:token', (req, res) => {
  const app = findByToken(req.params.token);
  if (!app) return res.status(404).json({ error: 'Share link not found or revoked' });
  res.json({ name: app.name, purpose: app.purpose, environment: app.environment });
});

router.get('/:token/wiki-file', (req, res) => {
  const app = findByToken(req.params.token);
  if (!app || !app.localPath) return res.status(404).json({ error: 'Share link not found or revoked' });
  const result = resolveWikiFile(app, req.query.path);
  if (!result) return res.status(404).json({ error: 'File not found' });
  res.json(result);
});

module.exports = router;
