// Feature 15: in-app wiki search. Live, on-demand full-text search across a
// scanned app's generated /wiki/**/*.md files — no pre-built index, since a
// generated wiki is small (tens of files, a few KB each) and reading them
// fresh on every search keeps results correct after a rescan or an edit to
// a data-dictionary description without any invalidation logic to get wrong.

const fs = require('fs');
const path = require('path');

const MAX_FILES = 200;
const MAX_MATCHES_PER_FILE = 5;
const MAX_RESULTS = 30;
const SNIPPET_RADIUS = 60;

function collectMdFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    if (results.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function searchWiki(wikiDir, query) {
  const q = query.toLowerCase();
  const files = collectMdFiles(wikiDir);
  const results = [];

  for (const absFile of files) {
    let content;
    try {
      content = fs.readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    if (!lower.includes(q)) continue;

    const relFile = path.relative(wikiDir, absFile).split(path.sep).join('/');
    const lines = content.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
      const lineLower = lines[i].toLowerCase();
      if (!lineLower.includes(q)) continue;
      const idx = lineLower.indexOf(q);
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(lines[i].length, idx + q.length + SNIPPET_RADIUS);
      const snippet = (start > 0 ? '…' : '') + lines[i].slice(start, end) + (end < lines[i].length ? '…' : '');
      matches.push({ line: i + 1, snippet });
    }
    const totalMatches = (lower.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    results.push({ file: relFile, totalMatches, matches });
  }

  results.sort((a, b) => b.totalMatches - a.totalMatches);
  return results.slice(0, MAX_RESULTS);
}

module.exports = { searchWiki };
