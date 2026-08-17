const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const REPOS_DIR = path.join(__dirname, '..', '..', 'data', 'repos');

function isRepoLink(pathOrRepo) {
  return /^https?:\/\//.test(pathOrRepo) || /^git@/.test(pathOrRepo) || /\.git$/.test(pathOrRepo);
}

// Feature: after cloning, resolve exactly what got checked out — the short
// commit SHA always, plus the branch name when HEAD is actually on one (not
// after checking out a tag or a bare commit, where git leaves HEAD detached).
async function resolveCheckedOutRef(dest) {
  const commit = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dest, windowsHide: true })).stdout.trim();
  let branch = null;
  try {
    const branchOut = (await execFileAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dest, windowsHide: true })).stdout.trim();
    branch = branchOut || null;
  } catch {
    branch = null; // detached HEAD (tag or bare commit checkout) — commit alone still identifies it
  }
  return { commit, branch };
}

// Clones (or re-clones, for a clean up-to-date copy) a repo URL into a
// per-app directory under data/repos and returns the local path to scan
// plus which ref actually got checked out.
//
// `ref` (optional) is a branch, tag, or commit SHA to scan instead of the
// repo's default branch. Branches/tags support a shallow `--branch` clone;
// an arbitrary commit SHA doesn't (git clone --branch only accepts refs
// that exist as a ref, not a bare commit), so a `--branch` failure falls
// back to a full clone + explicit checkout, which works uniformly for all
// three ref kinds.
//
// Async (execFile, not execFileSync) — a synchronous clone would block the
// whole Node event loop, freezing every other request the server is
// handling for as long as the clone takes.
async function cloneRepo(appId, repoUrl, ref) {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  const dest = path.join(REPOS_DIR, appId);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const trimmedRef = (ref || '').trim();
  if (!trimmedRef) {
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, dest], { windowsHide: true });
  } else {
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--branch', trimmedRef, repoUrl, dest], { windowsHide: true });
    } catch {
      // Not a branch/tag name (or the shallow clone otherwise failed) — full
      // clone plus an explicit checkout handles a commit SHA too.
      fs.rmSync(dest, { recursive: true, force: true });
      await execFileAsync('git', ['clone', repoUrl, dest], { windowsHide: true });
      await execFileAsync('git', ['checkout', trimmedRef], { cwd: dest, windowsHide: true });
    }
  }

  const resolved = await resolveCheckedOutRef(dest);
  return { path: dest, ref: trimmedRef || null, commit: resolved.commit, branch: resolved.branch };
}

module.exports = { isRepoLink, cloneRepo };
