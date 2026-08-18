// Feature 4: real dependency vulnerability data via `npm audit --json`
// instead of only the small hardcoded advisory list. Requires network
// access to the npm registry; returns null (not an empty array) on any
// failure so the caller can fall back to the static list and say so.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const SEVERITY_MAP = { critical: 'Critical', high: 'High', moderate: 'Medium', low: 'Low', info: 'Low' };
const MAX_ISSUES = 30;

async function fetchNpmAuditStdout(rootPath) {
  try {
    // No dynamic input in this command string — safe to pass as one literal
    // via the shell (needed on Windows, where `npm` resolves to npm.cmd).
    const result = await execFileAsync('npm audit --json', {
      cwd: rootPath,
      timeout: 25000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });
    return result.stdout;
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found — the JSON we
    // want is still on stdout in that case, so only give up if there's none.
    return err && err.stdout ? err.stdout.toString('utf8') : null;
  }
}

function parseNpmAuditVulnerabilities(stdout) {
  if (!stdout) return null;
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  const vulns = report.vulnerabilities;
  return vulns && typeof vulns === 'object' ? vulns : null;
}

function describeFixAvailability(info) {
  if (!info.fixAvailable) return 'No automatic fix available yet — check the advisory for guidance.';
  if (typeof info.fixAvailable !== 'object') return 'Fix available via `npm audit fix`.';
  const majorNote = info.fixAvailable.isSemVerMajor ? ' (major version bump)' : '';
  return `Fix available: upgrade to ${info.fixAvailable.name}@${info.fixAvailable.version}${majorNote}.`;
}

function buildNpmAuditIssue(name, info) {
  const severity = SEVERITY_MAP[info.severity] || 'Medium';
  const via = Array.isArray(info.via)
    ? info.via.map((v) => (typeof v === 'string' ? v : v.title)).filter(Boolean).slice(0, 3).join('; ')
    : String(info.via || '');
  return {
    file: 'package.json',
    line: 1,
    severity,
    category: 'Outdated/Vulnerable Dependency',
    source: 'dependency-audit',
    summary: `${name} (${info.range || 'range unknown'}) — ${info.severity} severity. ${via}`,
    suggestedFix: `${describeFixAvailability(info)} (Live data from \`npm audit\`.)`,
  };
}

// Async (execFile, not execFileSync) — a synchronous `npm audit` call blocks
// the whole Node event loop for however long it takes to hit the registry,
// freezing every other request the server is handling in the meantime.
async function runNpmAudit(rootPath) {
  const pkgJsonPath = path.join(rootPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const stdout = await fetchNpmAuditStdout(rootPath);
  const vulns = parseNpmAuditVulnerabilities(stdout);
  if (!vulns) return null;

  const entries = Object.entries(vulns);
  const issues = entries.slice(0, MAX_ISSUES).map(([name, info]) => buildNpmAuditIssue(name, info));
  if (entries.length > MAX_ISSUES) {
    issues.push({
      file: 'package.json',
      line: 1,
      severity: 'Low',
      category: 'Outdated/Vulnerable Dependency',
      source: 'dependency-audit',
      summary: `npm audit reported ${entries.length} vulnerable dependencies total; only the first ${MAX_ISSUES} are listed above.`,
      suggestedFix: 'Run `npm audit` directly for the full list.',
    });
  }
  return issues;
}

module.exports = { runNpmAudit };
