const fs = require('fs');
const path = require('path');
const { fingerprintIssue } = require('./triage');
const { getOwner } = require('./ownership');

function slugify(name) {
  return name
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9\- ]/g, ' ')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('-');
}

function ensureWikiDirs(wikiDir) {
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'Components'), { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'Data-Dictionary'), { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'Process-Flows'), { recursive: true });
}

function write(wikiDir, relFile, content) {
  const full = path.join(wikiDir, relFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// ---- Progress.md ----

function initProgress(wikiDir, unitNames) {
  const rows = unitNames.map((u) => `| ${u} | Not Started |`).join('\n');
  const content = `# Progress\n\nThis file tracks scan progress directory-by-directory so the scan can resume if interrupted. Statuses: Not Started, In Progress, Done.\n\n| Directory | Status |\n|---|---|\n${rows}\n`;
  write(wikiDir, 'Progress.md', content);
}

function updateProgress(wikiDir, unitNames, statusMap) {
  const rows = unitNames.map((u) => `| ${u} | ${statusMap[u] || 'Not Started'} |`).join('\n');
  const content = `# Progress\n\nThis file tracks scan progress directory-by-directory so the scan can resume if interrupted. Statuses: Not Started, In Progress, Done.\n\n| Directory | Status |\n|---|---|\n${rows}\n`;
  write(wikiDir, 'Progress.md', content);
}

// ---- Home.md ----

// ---- writeHome section builders ----
// Split out of writeHome (was one function with cyclomatic complexity 21 —
// every section's conditional lines summed together). Each builder returns
// the markdown lines for one section; writeHome just concatenates them.

function buildHomeHeaderLines(meta, enrichment) {
  const lines = [];
  lines.push(`# ${meta.name || 'Application'} Wiki`);
  lines.push('');
  const purpose = (enrichment && enrichment.purpose) || meta.purpose;
  if (purpose) lines.push(`**Purpose:** ${purpose}${enrichment && enrichment.purpose ? ' _(deep-scan generated)_' : ''}`);
  if (meta.owner) lines.push(`**Owner/Team:** ${meta.owner}`);
  if (meta.environment) lines.push(`**Environment:** ${meta.environment}`);
  if (meta.notes) lines.push(`**Notes:** ${meta.notes}`);
  lines.push('');
  return lines;
}

function buildHomeTechStackLines(structureInfo) {
  const lines = [];
  lines.push('## Tech Stack');
  lines.push('');
  const eco = structureInfo.manifests.map((m) => m.ecosystem).filter((v, i, a) => a.indexOf(v) === i);
  lines.push(`- **Ecosystem(s):** ${eco.length ? eco.join(', ') : 'Not detected from a standard manifest file'}`);
  lines.push(`- **Frameworks detected:** ${structureInfo.frameworks.length ? structureInfo.frameworks.join(', ') : 'None detected'}`);
  lines.push(`- **Package manifests:** ${structureInfo.manifests.map((m) => m.path).join(', ') || 'None found'}`);
  lines.push(`- **Entry points:** ${structureInfo.entryPoints.length ? structureInfo.entryPoints.join(', ') : 'None detected'}`);
  lines.push('');
  return lines;
}

function buildHomeQuickLinksLines(unitNames, hasChangeLog) {
  const lines = [];
  lines.push('## Quick Links');
  lines.push('');
  lines.push('- [Architecture](Architecture.md) — system design, data flow, entry points');
  lines.push('- [Data Model](Data-Model.md) — schema relationships and API contracts');
  lines.push('- [Issues](Issues.md) — flagged vulnerabilities and quality issues');
  lines.push('- [Setup](Setup.md) — how to run this app locally');
  if (hasChangeLog) lines.push('- [Change Log](Change-Log.md) — what changed since the last scan');
  lines.push('- [Progress](Progress.md) — scan progress tracker');
  lines.push('');
  lines.push('### Components');
  lines.push('');
  for (const u of unitNames) lines.push(`- [Components/${slugify(u)}](Components/${slugify(u)}.md)`);
  lines.push('');
  return lines;
}

function buildHomePackagesLines(packages) {
  if (!packages || !packages.length) return [];
  const lines = [];
  lines.push('## Packages (Monorepo)');
  lines.push('');
  lines.push('This repo contains multiple independently-scanned sub-packages, each with its own wiki:');
  lines.push('');
  for (const p of packages) {
    if (p.error) lines.push(`- **${p.name}** — scan failed: ${p.error}`);
    else lines.push(`- **${p.name}** — [wiki](${p.wikiLink}) (${p.stats.units} units, ${p.stats.models} models, ${p.stats.routes} routes, ${p.stats.issues} issues)`);
  }
  lines.push('');
  return lines;
}

function buildHomeScanSummaryLines(unitNames, modelCount, routeCount, issueCount, enrichment) {
  const lines = [];
  lines.push('## Scan Summary');
  lines.push('');
  lines.push(`- ${unitNames.length} top-level directory unit(s) documented`);
  lines.push(`- ${modelCount} data model(s)/table(s) detected`);
  lines.push(`- ${routeCount} route/endpoint(s) detected`);
  lines.push(`- ${issueCount} issue(s) flagged (see [Issues](Issues.md))`);
  if (enrichment) lines.push('- Deep scan: LLM-assisted prose enrichment applied (purpose, architecture notes, field descriptions)');
  lines.push('');
  lines.push('_This documentation was generated by a static-analysis scanner (CodeAtlas). It reads source patterns, not runtime behavior — verify anything load-bearing before relying on it._');
  return lines;
}

function writeHome(wikiDir, { meta, structureInfo, unitNames, modelCount, routeCount, issueCount, enrichment, packages, hasChangeLog }) {
  const lines = [
    ...buildHomeHeaderLines(meta, enrichment),
    ...buildHomeTechStackLines(structureInfo),
    ...buildHomeQuickLinksLines(unitNames, hasChangeLog),
    ...buildHomePackagesLines(packages),
    ...buildHomeScanSummaryLines(unitNames, modelCount, routeCount, issueCount, enrichment),
  ];
  write(wikiDir, 'Home.md', lines.join('\n'));
}

// ---- Architecture.md ----

function renderTree(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const lines = [`${indent}- ${node.name}/`];
  for (const child of node.children) lines.push(...renderTree(child, depth + 1));
  return lines;
}

function writeArchitecture(wikiDir, { structureInfo, routeGroups, modelCount, enrichment }) {
  const lines = [];
  lines.push('# Architecture');
  lines.push('');
  lines.push('[Home](Home.md) · [Data Model](Data-Model.md) · [Issues](Issues.md)');
  lines.push('');
  if (enrichment && enrichment.architectureNotes) {
    lines.push(enrichment.architectureNotes);
    lines.push('');
    lines.push('_(above paragraph is deep-scan generated; sections below are derived directly from static analysis)_');
    lines.push('');
  }
  lines.push('## Directory Structure');
  lines.push('');
  lines.push('```');
  lines.push(...renderTree(structureInfo.tree));
  lines.push('```');
  lines.push('');
  lines.push('## Tech Stack & Build Tooling');
  lines.push('');
  for (const m of structureInfo.manifests) lines.push(`- **${m.ecosystem}** — manifest: \`${m.path}\`, package manager: ${m.pkgManager}`);
  if (!structureInfo.manifests.length) lines.push('- No standard package manifest detected.');
  lines.push('');
  lines.push('## Entry Points');
  lines.push('');
  for (const e of structureInfo.entryPoints) lines.push(`- \`${e}\``);
  if (!structureInfo.entryPoints.length) lines.push('- No conventional entry point file was detected — check the manifest\'s run scripts.');
  lines.push('');
  lines.push('## Data Flow');
  lines.push('');
  lines.push(`This application exposes ${routeGroups.totalRoutes} detected route/endpoint(s) across ${routeGroups.groups.length} grouping(s), and ${modelCount} detected data model(s). At a high level, requests enter through the entry point(s) above, are routed to handler functions (see [Process-Flows](Process-Flows/)), which read/write the data models documented in [Data Model](Data-Model.md) and return a response.`);
  lines.push('');
  lines.push('## Process Flow Groups');
  lines.push('');
  for (const g of routeGroups.groups) lines.push(`- [Process-Flows/${g.slug}](Process-Flows/${g.slug}.md) — ${g.routes.length} route(s)`);
  if (!routeGroups.groups.length) lines.push('- No routes/endpoints were detected by pattern matching.');
  write(wikiDir, 'Architecture.md', lines.join('\n'));
}

// ---- Components/*.md ----

// Split out of writeComponentPage (was one function with cyclomatic
// complexity 15 — every per-file section's branches summed together, plus
// the outer loop and early-return).
async function buildComponentFileSectionLines(fc, ownershipCtx) {
  const lines = [];
  lines.push(`## \`${fc.relPath}\``);
  lines.push('');
  lines.push(`${fc.lines} lines.`);
  if (ownershipCtx) {
    const owner = await getOwner(ownershipCtx, fc.relPath);
    if (owner) lines.push(`**Owner:** ${owner.owner} _(${owner.source}${owner.detail ? ` — ${owner.detail}` : ''})_`);
  }
  lines.push('');
  if (fc.imports.length) {
    lines.push(`**Dependencies (imports):** ${fc.imports.map((i) => `\`${i}\``).join(', ')}`);
    lines.push('');
  }
  if (fc.classes.length) {
    lines.push('**Classes:**');
    lines.push('');
    for (const c of fc.classes) {
      lines.push(`- \`${c.name}\`${c.extends ? ` extends \`${c.extends}\`` : ''} — line ${c.line}`);
    }
    lines.push('');
  }
  if (fc.functions.length) {
    lines.push('**Functions/Methods:**');
    lines.push('');
    lines.push('| Name | Parameters | Line |');
    lines.push('|---|---|---|');
    for (const f of fc.functions) {
      lines.push(`| \`${f.name}\` | \`${f.params || '—'}\` | ${f.line} |`);
    }
    lines.push('');
  }
  if (!fc.classes.length && !fc.functions.length) {
    lines.push('_No functions or classes extracted from this file (may be config, types-only, or use a pattern this scanner doesn\'t recognize)._');
    lines.push('');
  }
  return lines;
}

async function writeComponentPage(wikiDir, unitLabel, fileComponents, ownershipCtx) {
  const slug = slugify(unitLabel);
  const lines = [];
  lines.push(`# Components: ${unitLabel}`);
  lines.push('');
  lines.push('[Home](../Home.md) · [Architecture](../Architecture.md)');
  lines.push('');
  if (!fileComponents.length) {
    lines.push('_No source files with extractable components were found in this directory (may contain only assets, config, or data files)._');
    write(wikiDir, `Components/${slug}.md`, lines.join('\n'));
    return slug;
  }
  for (const fc of fileComponents) {
    lines.push(...await buildComponentFileSectionLines(fc, ownershipCtx));
  }
  lines.push('---');
  lines.push('_Purpose and side-effect notes above are inferred from imports/calls found in source (e.g. db/network client usage implies a data or network side effect). Confirm against the actual code for anything critical._');
  write(wikiDir, `Components/${slug}.md`, lines.join('\n'));
  return slug;
}

// ---- Data-Dictionary/*.md and Data-Model.md ----

function writeDataDictionaryPage(wikiDir, model, enrichment, overrides = {}) {
  const slug = slugify(model.name);
  const enrichedFields = (enrichment && enrichment.fieldDescriptions && enrichment.fieldDescriptions[model.name]) || {};
  const lines = [];
  lines.push(`# ${model.name}`);
  lines.push('');
  lines.push('[Data Model](../Data-Model.md) · [Home](../Home.md)');
  lines.push('');
  lines.push(`**Source:** ${model.source} — \`${model.file}\` (line ${model.line})`);
  lines.push('');
  lines.push('## Fields');
  lines.push('');
  lines.push('| Field | Type | Nullable | Default | Constraints | Description | Source |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const f of model.fields) {
    let desc;
    if (overrides[f.name]) desc = `${overrides[f.name]} _(human-edited)_`;
    else if (enrichedFields[f.name]) desc = `${enrichedFields[f.name]} _(deep-scan generated)_`;
    else desc = f.description;
    lines.push(`| \`${f.name}\` | ${f.type} | ${f.nullable ? 'Yes' : 'No'} | ${f.default ?? '—'} | ${f.constraints.length ? f.constraints.join(', ') : '—'} | ${desc} | auto-detected from \`${model.file}\` |`);
  }
  if (!model.fields.length) lines.push('| _(no fields parsed)_ | | | | | | |');
  lines.push('');
  if (model.relationships.length) {
    lines.push('## Relationships');
    lines.push('');
    for (const r of model.relationships) lines.push(`- \`${r.field}\` → ${r.type} → \`${r.target}\``);
    lines.push('');
  }
  write(wikiDir, `Data-Dictionary/${slug}.md`, lines.join('\n'));
  return slug;
}

function writeDataModel(wikiDir, models, routeGroups) {
  const lines = [];
  lines.push('# Data Model');
  lines.push('');
  lines.push('[Home](Home.md) · [Architecture](Architecture.md)');
  lines.push('');
  lines.push('## Tables / Models');
  lines.push('');
  if (!models.length) {
    lines.push('_No schema/model definitions were detected by pattern matching (SQL `CREATE TABLE`, Prisma, Mongoose, Django models, TypeORM entities). If this app has a data layer, it may use a format this scanner doesn\'t recognize yet._');
  } else {
    lines.push('| Model | Source | File | Fields | Relationships |');
    lines.push('|---|---|---|---|---|');
    for (const m of models) {
      const slug = slugify(m.name);
      lines.push(`| [${m.name}](Data-Dictionary/${slug}.md) | ${m.source} | \`${m.file}\` | ${m.fields.length} | ${m.relationships.length} |`);
    }
  }
  lines.push('');
  lines.push('## API Contracts (detected routes)');
  lines.push('');
  if (!routeGroups.totalRoutes) {
    lines.push('_No routes/endpoints were detected by pattern matching._');
  } else {
    lines.push('| Method | Path | Handler | File | Flow Doc |');
    lines.push('|---|---|---|---|---|');
    for (const g of routeGroups.groups) {
      for (const r of g.routes) {
        lines.push(`| ${r.method} | \`${r.path}\` | \`${r.handlerName}\` | \`${r.file}\` | [${g.name}](Process-Flows/${g.slug}.md) |`);
      }
    }
  }
  write(wikiDir, 'Data-Model.md', lines.join('\n'));
}

// ---- Process-Flows/*.md ----

function writeProcessFlowPage(wikiDir, group) {
  const lines = [];
  lines.push(`# Process Flow: ${group.name}`);
  lines.push('');
  lines.push('[Data Model](../Data-Model.md) · [Home](../Home.md)');
  lines.push('');
  for (const r of group.routes) {
    lines.push(`## ${r.method} \`${r.path}\``);
    lines.push('');
    lines.push(`Handled in \`${r.file}\` (line ${r.line}) by \`${r.handlerName}\`.${r.traced ? '' : ' _(handler body not resolved by static scan — trace below is limited.)_'}`);
    lines.push('');
    r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  write(wikiDir, `Process-Flows/${group.slug}.md`, lines.join('\n'));
}

function groupRoutes(allRoutes) {
  const groups = new Map();
  for (const r of allRoutes) {
    const seg = r.path.split('/').filter(Boolean)[0] || 'root';
    const key = seg.replace(/[:{}].*/, '') || 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const result = [];
  for (const [key, routes] of groups) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    result.push({ name, slug: slugify(name), routes });
  }
  return { groups: result, totalRoutes: allRoutes.length };
}

// ---- Issues.md ----

const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function writeIssues(wikiDir, issues, triageMap = {}) {
  const withTriage = issues.map((i) => ({ ...i, _triage: triageMap[fingerprintIssue(i)] || null }));
  const active = withTriage.filter((i) => !i._triage || i._triage.state === 'acknowledged');
  const dismissed = withTriage.filter((i) => i._triage && (i._triage.state === 'false_positive' || i._triage.state === 'fixed'));
  const sortedActive = active.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const lines = [];
  lines.push('# Issues');
  lines.push('');
  lines.push('[Home](Home.md) · [Architecture](Architecture.md)');
  lines.push('');
  lines.push(`Flagged by static pattern matching. ${sortedActive.length} active finding(s)${dismissed.length ? `, ${dismissed.length} dismissed (see below)` : ''}.`);
  lines.push('');

  // Code efficiency and maintainability: a concrete starting point for
  // cleanup, pulled from whichever oversized-function/high-complexity
  // findings already made the cut above (see complexity.js) rather than a
  // second, separately-collected ranking — same source of truth, just
  // resorted by the number in each summary instead of by severity.
  const complexityCategories = new Set(['Oversized Function', 'High Cyclomatic Complexity', 'Deep Nesting']);
  const worstOffenders = sortedActive
    .filter((i) => complexityCategories.has(i.category))
    .map((i) => ({ issue: i, metric: parseInt((i.summary.match(/(\d+)/) || [])[1], 10) || 0 }))
    .sort((a, b) => b.metric - a.metric)
    .slice(0, 5);
  if (worstOffenders.length) {
    lines.push('**Worst offenders (complexity/size):**');
    lines.push('');
    for (const { issue } of worstOffenders) {
      lines.push(`- \`${issue.file}:${issue.line}\` — ${issue.category}: ${issue.summary}`);
    }
    lines.push('');
  }

  lines.push('| Severity | Category | File | Line | Summary | Suggested Fix | CWE / OWASP |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const i of sortedActive) {
    const ack = i._triage ? ' _(acknowledged' + (i._triage.note ? `: ${i._triage.note}` : '') + ')_' : '';
    lines.push(`| ${i.severity} | ${i.category} | \`${i.file}\` | ${i.line} | ${i.summary}${ack} | ${i.suggestedFix} | ${i.cwe || '—'} |`);
  }
  if (!sortedActive.length) lines.push('| — | — | — | — | No active issues flagged | — | — |');
  if (dismissed.length) {
    lines.push('');
    lines.push('## Dismissed');
    lines.push('');
    lines.push('Marked false-positive or fixed by a reviewer — excluded from the active count and from CLI severity gating, but kept here for a paper trail.');
    lines.push('');
    lines.push('| Severity | Category | File | Line | Summary | State | Note |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const i of dismissed) {
      lines.push(`| ${i.severity} | ${i.category} | \`${i.file}\` | ${i.line} | ${i.summary} | ${i._triage.state} | ${i._triage.note || '—'} |`);
    }
  }
  write(wikiDir, 'Issues.md', lines.join('\n'));
}

// ---- Change-Log.md ----

function writeChangeLog(wikiDir, diff, currentScannedAt) {
  const lines = [];
  lines.push('# Change Log');
  lines.push('');
  lines.push('[Home](Home.md) · [Issues](Issues.md)');
  lines.push('');
  if (!diff) {
    lines.push(`This is the first recorded scan (${currentScannedAt}) — nothing to compare against yet. Future scans will show a diff here.`);
    write(wikiDir, 'Change-Log.md', lines.join('\n'));
    return;
  }
  lines.push(`Comparing this scan (${currentScannedAt}) against the previous one (${diff.previousScanAt}).`);
  lines.push('');
  lines.push('## Issues');
  lines.push('');
  lines.push(`- ${diff.newIssues.length} new issue(s)`);
  lines.push(`- ${diff.resolvedIssues.length} resolved issue(s)`);
  if (diff.newIssues.length) {
    lines.push('');
    lines.push('**New:**');
    for (const i of diff.newIssues) lines.push(`- [${i.severity}] ${i.category} — \`${i.file}:${i.line}\` — ${i.summary}`);
  }
  if (diff.resolvedIssues.length) {
    lines.push('');
    lines.push('**Resolved:**');
    for (const i of diff.resolvedIssues) lines.push(`- [${i.severity}] ${i.category} — \`${i.file}:${i.line}\` — ${i.summary}`);
  }
  lines.push('');
  lines.push('## Routes');
  lines.push('');
  lines.push(`- ${diff.newRoutes.length} new route(s)`);
  lines.push(`- ${diff.removedRoutes.length} removed route(s)`);
  for (const r of diff.newRoutes) lines.push(`- + ${r.method} \`${r.path}\` (\`${r.file}\`)`);
  for (const r of diff.removedRoutes) lines.push(`- − ${r.method} \`${r.path}\` (\`${r.file}\`)`);
  lines.push('');
  lines.push('## Data Models');
  lines.push('');
  lines.push(`- ${diff.addedModels.length} added model(s)`);
  lines.push(`- ${diff.removedModels.length} removed model(s)`);
  for (const m of diff.addedModels) lines.push(`- + ${m.name}`);
  for (const m of diff.removedModels) lines.push(`- − ${m.name}`);
  write(wikiDir, 'Change-Log.md', lines.join('\n'));
}

// ---- Setup.md ----

function writeSetup(wikiDir, { structureInfo, envVars, meta }) {
  const lines = [];
  lines.push('# Setup');
  lines.push('');
  lines.push('[Home](Home.md)');
  lines.push('');
  lines.push('## Running Locally');
  lines.push('');
  const pkgJson = structureInfo.manifests.find((m) => m.file === 'package.json');
  if (pkgJson) {
    lines.push('```');
    lines.push('npm install');
    lines.push('npm start   # or check package.json "scripts" for the actual dev command');
    lines.push('```');
  } else if (structureInfo.manifests.find((m) => m.file === 'requirements.txt')) {
    lines.push('```');
    lines.push('pip install -r requirements.txt');
    lines.push('python <entry point — see Architecture.md>');
    lines.push('```');
  } else {
    lines.push(`No standard manifest was detected. Entry point(s) found: ${structureInfo.entryPoints.join(', ') || 'none'}.`);
  }
  lines.push('');
  lines.push('## Environment Variables');
  lines.push('');
  lines.push('Referenced in code (values not shown — populate from your own secrets store):');
  lines.push('');
  if (envVars.length) {
    for (const v of envVars) lines.push(`- \`${v}\``);
  } else {
    lines.push('_None detected by pattern matching._');
  }
  lines.push('');
  if (meta.environment) {
    lines.push(`## Target Environment`);
    lines.push('');
    lines.push(`This entry was submitted as: **${meta.environment}**.`);
  }
  write(wikiDir, 'Setup.md', lines.join('\n'));
}

module.exports = {
  slugify,
  ensureWikiDirs,
  initProgress,
  updateProgress,
  writeHome,
  writeArchitecture,
  writeChangeLog,
  writeComponentPage,
  writeDataDictionaryPage,
  writeDataModel,
  writeProcessFlowPage,
  groupRoutes,
  writeIssues,
  writeSetup,
};
