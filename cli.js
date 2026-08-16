#!/usr/bin/env node
// Feature 10: CI-friendly CLI entry point. Runs a scan headlessly against a
// local path or a git repo URL, prints a summary, and exits non-zero when
// any issue at/above the configured severity threshold was found — so a
// pipeline can gate on it without needing the web UI or JSON data store at
// all (this never touches src/store/db.js).

const path = require('path');
const crypto = require('crypto');
const { runScan } = require('./src/scanner');
const { isRepoLink, cloneRepo } = require('./src/scanner/gitFetch');

const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function parseArgs(argv) {
  const opts = { failOn: 'Critical', json: false, deep: false, name: null, target: null };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--deep') opts.deep = true;
    else if (arg.startsWith('--fail-on=')) opts.failOn = arg.split('=')[1];
    else if (arg.startsWith('--name=')) opts.name = arg.split('=')[1];
    else if (!arg.startsWith('--')) opts.target = arg;
  }
  return opts;
}

function printUsage() {
  console.error(`Usage: node cli.js <path-or-repo-url> [options]

Options:
  --fail-on=<Critical|High|Medium|Low>  Exit 1 if any issue at/above this severity is found (default: Critical)
  --deep                                 Enable LLM-assisted deep scan mode (shells out to the local claude CLI)
  --json                                 Print machine-readable JSON summary instead of text
  --name=<name>                          Display name for the scan (default: derived from the path/repo)
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.target) {
    printUsage();
    process.exit(2);
  }
  if (!(opts.failOn in SEVERITY_ORDER)) {
    console.error(`Invalid --fail-on value "${opts.failOn}" — must be one of Critical, High, Medium, Low.`);
    process.exit(2);
  }

  const log = (msg) => { if (!opts.json) console.log(msg); };

  let localPath = opts.target;
  let appId;
  if (isRepoLink(opts.target)) {
    appId = `cli-${crypto.createHash('sha1').update(opts.target).digest('hex').slice(0, 12)}`;
    log(`Cloning ${opts.target}...`);
    try {
      localPath = await cloneRepo(appId, opts.target);
    } catch (err) {
      console.error(`Failed to clone repo: ${err.message}`);
      process.exit(2);
    }
  } else {
    localPath = path.resolve(opts.target);
    appId = `cli-${crypto.createHash('sha1').update(localPath).digest('hex').slice(0, 12)}`;
  }

  const name = opts.name || path.basename(localPath);

  let result;
  try {
    result = await runScan(localPath, { name, appId, scanMode: opts.deep ? 'deep' : 'static' }, log);
  } catch (err) {
    console.error(`Scan failed: ${err.message}`);
    process.exit(2);
  }

  const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const issue of result.issuesList) bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;

  const threshold = SEVERITY_ORDER[opts.failOn];
  const shouldFail = result.issuesList.some((i) => SEVERITY_ORDER[i.severity] <= threshold);

  const summary = {
    name,
    target: opts.target,
    wikiPath: path.join(localPath, 'wiki', 'Home.md'),
    stats: result.stats,
    issuesBySeverity: bySeverity,
    failOn: opts.failOn,
    failed: shouldFail,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log(`Scan complete: ${name}`);
    console.log(`  Wiki: ${summary.wikiPath}`);
    console.log(`  Units: ${result.stats.units}  Models: ${result.stats.models}  Routes: ${result.stats.routes}  Issues: ${result.stats.issues}`);
    console.log(`  By severity: Critical=${bySeverity.Critical} High=${bySeverity.High} Medium=${bySeverity.Medium} Low=${bySeverity.Low}`);
    console.log(shouldFail
      ? `  FAILED — issue(s) at or above "${opts.failOn}" severity were found.`
      : `  PASSED — no issues at or above "${opts.failOn}" severity.`);
  }

  process.exit(shouldFail ? 1 : 0);
}

main();
