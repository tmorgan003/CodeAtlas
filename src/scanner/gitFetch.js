const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const REPOS_DIR = path.join(__dirname, '..', '..', 'data', 'repos');

function isRepoLink(pathOrRepo) {
  return /^https?:\/\//.test(pathOrRepo) || /^git@/.test(pathOrRepo) || /\.git$/.test(pathOrRepo);
}

// Clones (or re-clones, for a clean up-to-date copy) a repo URL into a
// per-app directory under data/repos and returns the local path to scan.
// Async (execFile, not execFileSync) — a synchronous clone would block the
// whole Node event loop, freezing every other request the server is
// handling for as long as the clone takes.
async function cloneRepo(appId, repoUrl) {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  const dest = path.join(REPOS_DIR, appId);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  await execFileAsync('git', ['clone', '--depth', '1', repoUrl, dest], { windowsHide: true });
  return dest;
}

module.exports = { isRepoLink, cloneRepo };
