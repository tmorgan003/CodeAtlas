const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '__pycache__', 'venv', '.venv', 'env', 'coverage',
  '.pytest_cache', '.mypy_cache', 'vendor', 'bin', 'obj', '.gradle',
  '.idea', '.vscode', 'wiki', '.cache', 'tmp', 'temp', '.turbo',
  // Generated output/state, same category as wiki/ above: 'data' is
  // CodeAtlas's own runtime store (apps.json, scan graphs, history, cache)
  // and 'graphify-out' is the graphify tool's output — scanning either as
  // if it were the target app's source floods results with hashes/UUIDs
  // pulled from a scanner's own prior output, not real secrets.
  'data', 'graphify-out',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.swift', '.scala', '.sql',
]);

function isIgnoredDir(name) {
  return IGNORED_DIRS.has(name) || name.startsWith('.') && name !== '.' && name !== '..';
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.wav', '.mov', '.avi',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', 'composer.lock',
]);

module.exports = { CODE_EXTENSIONS, BINARY_EXTENSIONS, SKIP_FILES, isIgnoredDir };
