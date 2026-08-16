const fs = require('fs');
const path = require('path');
const { listTopLevel, readFileSafe } = require('./walk');

const MANIFESTS = [
  { file: 'package.json', ecosystem: 'Node.js', pkgManager: 'npm/yarn/pnpm' },
  { file: 'requirements.txt', ecosystem: 'Python', pkgManager: 'pip' },
  { file: 'pyproject.toml', ecosystem: 'Python', pkgManager: 'poetry/pip' },
  { file: 'Pipfile', ecosystem: 'Python', pkgManager: 'pipenv' },
  { file: 'go.mod', ecosystem: 'Go', pkgManager: 'go modules' },
  { file: 'Cargo.toml', ecosystem: 'Rust', pkgManager: 'cargo' },
  { file: 'pom.xml', ecosystem: 'Java', pkgManager: 'maven' },
  { file: 'build.gradle', ecosystem: 'Java/Kotlin', pkgManager: 'gradle' },
  { file: 'build.gradle.kts', ecosystem: 'Kotlin', pkgManager: 'gradle' },
  { file: 'Gemfile', ecosystem: 'Ruby', pkgManager: 'bundler' },
  { file: 'composer.json', ecosystem: 'PHP', pkgManager: 'composer' },
];

const ENTRY_CANDIDATES = [
  'server.js', 'index.js', 'app.js', 'main.js',
  'server.ts', 'index.ts', 'app.ts', 'main.ts',
  'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py',
  'main.go', 'cmd/main.go',
  'main.rs', 'src/main.rs',
  'Program.cs',
];

const FRAMEWORK_HINTS = [
  { dep: 'express', name: 'Express' },
  { dep: 'fastify', name: 'Fastify' },
  { dep: 'koa', name: 'Koa' },
  { dep: '@nestjs/core', name: 'NestJS' },
  { dep: 'next', name: 'Next.js' },
  { dep: 'react', name: 'React' },
  { dep: 'vue', name: 'Vue' },
  { dep: '@angular/core', name: 'Angular' },
  { dep: 'svelte', name: 'Svelte' },
  { dep: 'django', name: 'Django' },
  { dep: 'flask', name: 'Flask' },
  { dep: 'fastapi', name: 'FastAPI' },
  { dep: 'sequelize', name: 'Sequelize' },
  { dep: 'typeorm', name: 'TypeORM' },
  { dep: 'prisma', name: 'Prisma' },
  { dep: 'mongoose', name: 'Mongoose' },
];

function detectManifests(rootPath) {
  const found = [];
  for (const m of MANIFESTS) {
    const p = path.join(rootPath, m.file);
    if (fs.existsSync(p)) found.push({ ...m, path: m.file });
  }
  return found;
}

function detectFrameworks(rootPath, manifests) {
  const frameworks = new Set();
  const pkgJson = manifests.find((m) => m.file === 'package.json');
  if (pkgJson) {
    const raw = readFileSafe(path.join(rootPath, 'package.json'));
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const hint of FRAMEWORK_HINTS) {
          if (allDeps[hint.dep]) frameworks.add(hint.name);
        }
      } catch { /* invalid JSON, skip */ }
    }
  }
  const reqTxt = readFileSafe(path.join(rootPath, 'requirements.txt'));
  if (reqTxt) {
    const lower = reqTxt.toLowerCase();
    for (const hint of FRAMEWORK_HINTS) {
      if (lower.includes(hint.dep)) frameworks.add(hint.name);
    }
  }
  return [...frameworks];
}

function detectEntryPoints(rootPath) {
  const found = [];
  for (const candidate of ENTRY_CANDIDATES) {
    const p = path.join(rootPath, candidate);
    if (fs.existsSync(p)) found.push(candidate);
  }
  const pkgJsonPath = path.join(rootPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const raw = readFileSafe(pkgJsonPath);
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        if (pkg.main && !found.includes(pkg.main)) found.push(`${pkg.main} (package.json "main")`);
        if (pkg.scripts && pkg.scripts.start) found.push(`npm start -> "${pkg.scripts.start}"`);
      } catch { /* skip */ }
    }
  }
  return found;
}

// Walk the whole tree (skipping ignored dirs) just to build a directory map for Home/Architecture pages.
function buildDirectoryTree(rootPath, dirPath = rootPath, depth = 0, maxDepth = 4) {
  const name = path.basename(dirPath) || dirPath;
  const node = { name, relPath: path.relative(rootPath, dirPath).split(path.sep).join('/') || '.', children: [] };
  if (depth >= maxDepth) return node;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return node;
  }
  const { isIgnoredDir } = require('./ignore');
  for (const e of entries) {
    if (e.isDirectory() && !isIgnoredDir(e.name)) {
      node.children.push(buildDirectoryTree(rootPath, path.join(dirPath, e.name), depth + 1, maxDepth));
    }
  }
  return node;
}

const WORKSPACE_DIR_NAMES = new Set(['packages', 'apps', 'services', 'libs', 'modules']);

function hasOwnManifest(dirPath) {
  return MANIFESTS.some((m) => fs.existsSync(path.join(dirPath, m.file)));
}

// Feature 9: monorepo detection. Finds sub-packages either as direct
// top-level directories with their own manifest (root/frontend/package.json,
// root/backend/package.json) or nested one level under a conventional
// workspace directory (root/packages/*/package.json — Lerna/Yarn/pnpm style).
function findSubPackages(rootPath, topLevelDirs) {
  const { isIgnoredDir } = require('./ignore');
  const subPackages = [];
  for (const dirName of topLevelDirs) {
    const dirPath = path.join(rootPath, dirName);
    if (hasOwnManifest(dirPath)) {
      subPackages.push({ name: dirName, relPath: dirName, absPath: dirPath, direct: true });
      continue;
    }
    if (WORKSPACE_DIR_NAMES.has(dirName.toLowerCase())) {
      let entries;
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const e of entries) {
        if (!e.isDirectory() || isIgnoredDir(e.name)) continue;
        const subPath = path.join(dirPath, e.name);
        if (hasOwnManifest(subPath)) {
          subPackages.push({ name: `${dirName}/${e.name}`, relPath: `${dirName}/${e.name}`, absPath: subPath, direct: false });
        }
      }
    }
  }
  return subPackages;
}

function analyzeStructure(rootPath) {
  const { dirs, files } = listTopLevel(rootPath);
  const manifests = detectManifests(rootPath);
  const frameworks = detectFrameworks(rootPath, manifests);
  const entryPoints = detectEntryPoints(rootPath);
  const tree = buildDirectoryTree(rootPath);
  return {
    topLevelDirs: dirs,
    topLevelFiles: files,
    manifests,
    frameworks,
    entryPoints,
    tree,
  };
}

module.exports = { analyzeStructure, buildDirectoryTree, findSubPackages };
