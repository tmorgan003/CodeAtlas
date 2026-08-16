// Feature 18 (GitHub/GitLab Wiki half): pushes the generated wiki to a
// repo's companion wiki repo (both GitHub and GitLab use the <repo>.wiki.git
// convention). Wiki repos are conventionally flat — no folders in the
// sidebar — so nested pages (Components/Src.md) get flattened to
// Components-Src.md and internal links are rewritten to match.
//
// This is a real `git push` to whatever remote the caller gives it — it
// only runs on an explicit user action (never automatically), and relies on
// the machine's own git credentials the same way cloneRepo() already does;
// CodeAtlas doesn't manage or store any auth itself.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveRelative } = require('./markdownToHtml');

const execFileAsync = promisify(execFile);
const EXPORT_CLONE_DIR = path.join(__dirname, '..', '..', 'data', 'wiki-exports');

function deriveWikiGitUrl(repoUrl) {
  if (!repoUrl) return null;
  const base = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}.wiki.git`;
}

function collectMdFiles(dir, base = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(collectMdFiles(full, base));
    else if (entry.name.endsWith('.md')) results.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return results;
}

const flatName = (relPath) => relPath.replace(/\//g, '-');

function rewriteLinksForFlatWiki(content, fromRelPath, flatMap) {
  const fromDir = fromRelPath.includes('/') ? fromRelPath.slice(0, fromRelPath.lastIndexOf('/')) : '';
  return content.replace(/\]\(([^)]+\.md)\)/g, (match, target) => {
    if (/^https?:\/\//.test(target)) return match;
    const resolved = resolveRelative(fromDir, target);
    const flat = flatMap[resolved];
    return flat ? `](${flat})` : match;
  });
}

async function pushToGithubWiki(wikiDir, repoUrl, cloneKey, opts = {}) {
  const wikiGitUrl = deriveWikiGitUrl(repoUrl);
  if (!wikiGitUrl) throw new Error('Could not derive a wiki git URL — no repo URL on file for this app.');

  fs.mkdirSync(EXPORT_CLONE_DIR, { recursive: true });
  const cloneDir = path.join(EXPORT_CLONE_DIR, cloneKey);
  if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });

  await execFileAsync('git', ['clone', wikiGitUrl, cloneDir], { windowsHide: true });

  for (const entry of fs.readdirSync(cloneDir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(cloneDir, entry), { recursive: true, force: true });
  }

  const relFiles = collectMdFiles(wikiDir);
  const flatMap = {};
  for (const rel of relFiles) flatMap[rel] = flatName(rel);
  for (const rel of relFiles) {
    const raw = fs.readFileSync(path.join(wikiDir, rel), 'utf8');
    const rewritten = rewriteLinksForFlatWiki(raw, rel, flatMap);
    fs.writeFileSync(path.join(cloneDir, flatMap[rel]), rewritten, 'utf8');
  }

  await execFileAsync('git', ['add', '-A'], { cwd: cloneDir, windowsHide: true });

  const commitMsg = opts.commitMessage || `CodeAtlas wiki update (${new Date().toISOString()})`;
  try {
    await execFileAsync('git', ['-c', 'user.name=CodeAtlas', '-c', 'user.email=codeatlas@localhost', 'commit', '-m', commitMsg], { cwd: cloneDir, windowsHide: true });
  } catch (err) {
    const out = `${err.stdout || ''}${err.message || ''}`;
    if (/nothing to commit/i.test(out)) return { pushed: false, reason: 'No changes to push (wiki content unchanged since last export).' };
    throw err;
  }

  if (opts.dryRun) return { pushed: false, reason: 'Dry run — committed locally, not pushed.', cloneDir, pageCount: relFiles.length };

  await execFileAsync('git', ['push', 'origin', 'HEAD'], { cwd: cloneDir, windowsHide: true });
  return { pushed: true, wikiGitUrl, pageCount: relFiles.length };
}

module.exports = { deriveWikiGitUrl, pushToGithubWiki, collectMdFiles, flatName, rewriteLinksForFlatWiki };
