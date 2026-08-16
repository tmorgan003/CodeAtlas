// Backend for the "Browse…" folder picker on the submission form. Browsers
// cannot hand JS a real absolute filesystem path from a directory picker
// (that's deliberately withheld for privacy/security) — but CodeAtlas is a
// local tool whose server already has full read access to this same
// machine's filesystem (that's what the scanner itself does), so a small
// server-side directory listing is what actually makes a working folder
// browser possible here. Directories only — no file contents are exposed.

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function listWindowsDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const drivePath = `${String.fromCharCode(i)}:\\`;
    if (fs.existsSync(drivePath)) drives.push(drivePath);
  }
  return drives;
}

function safeListDirNames(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

router.get('/', (req, res) => {
  const requested = (req.query.path || '').trim();

  if (!requested) {
    if (process.platform === 'win32') {
      return res.json({ path: null, parent: null, dirs: listWindowsDrives() });
    }
    return res.json({ path: '/', parent: null, dirs: safeListDirNames('/').map((d) => path.posix.join('/', d)) });
  }

  let resolved;
  try {
    resolved = path.resolve(requested);
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  const parentDir = path.dirname(resolved);
  const parent = parentDir === resolved ? null : parentDir; // null at a filesystem root (drive root or "/")
  const dirs = safeListDirNames(resolved).map((d) => path.join(resolved, d));
  res.json({ path: resolved, parent, dirs });
});

module.exports = router;
