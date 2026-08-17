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
const { collectFiles } = require('../scanner/walk');
const { CODE_EXTENSIONS } = require('../scanner/ignore');

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

// Feature 16: a rough, pre-scan Deep Scan cost estimate for a local path —
// counts source files and total code size (cheap: just fs.readdirSync/
// statSync, no file contents read), which is all we can honestly know
// before a real scan has parsed anything. Deep mode makes exactly one
// Claude CLI call per scan (see deepMode.js); the prompt it sends scales
// with detected routes/models, which in turn scale roughly with codebase
// size — so file count/size is used as a deliberately approximate proxy,
// not a precise route/model count.
router.get('/estimate', (req, res) => {
  const requested = (req.query.path || '').trim();
  if (!requested) return res.status(400).json({ error: 'path is required' });
  let resolved;
  try {
    resolved = path.resolve(requested);
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: 'Not a directory (repo URLs and not-yet-cloned paths cannot be estimated)' });
  }

  const files = collectFiles(resolved, resolved).filter((f) => CODE_EXTENSIONS.has(f.ext));
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  // Deliberately rough: ~1 route candidate per 3KB of code, ~1 model per 8KB.
  const estRoutes = Math.round(totalBytes / 3000);
  const estModels = Math.round(totalBytes / 8000);
  const promptChars = 700 + estRoutes * 40 + estModels * 120;
  const estTokens = Math.round(promptChars / 4);
  const estSeconds = Math.min(90, Math.round(15 + (estRoutes + estModels) * 0.6));

  res.json({
    fileCount: files.length,
    totalKB: Math.round(totalBytes / 1024),
    estTokens,
    estSecondsMin: Math.max(10, estSeconds - 10),
    estSecondsMax: estSeconds + 20,
  });
});

module.exports = router;
