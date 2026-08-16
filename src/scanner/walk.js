const fs = require('fs');
const path = require('path');
const { isIgnoredDir } = require('./ignore');

const MAX_FILE_BYTES = 400 * 1024; // skip reading contents of anything bigger than this

function listTopLevel(rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!isIgnoredDir(e.name)) dirs.push(e.name);
    } else if (e.isFile()) {
      files.push(e.name);
    }
  }
  dirs.sort();
  files.sort();
  return { dirs, files };
}

// Recursively collect every file under dirPath (not descending into ignored dirs).
// Returns [{ relPath, absPath, ext, sizeBytes }]
function collectFiles(rootPath, dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      if (isIgnoredDir(e.name)) continue;
      results.push(...collectFiles(rootPath, abs));
    } else if (e.isFile()) {
      const stat = fs.statSync(abs);
      results.push({
        relPath: path.relative(rootPath, abs).split(path.sep).join('/'),
        absPath: abs,
        ext: path.extname(e.name).toLowerCase(),
        sizeBytes: stat.size,
      });
    }
  }
  return results;
}

function readFileSafe(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

module.exports = { listTopLevel, collectFiles, readFileSafe };
