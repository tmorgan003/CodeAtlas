// Feature 6: optional, opt-in enrichment pass that shells out to the local
// `claude` CLI (headless/print mode) to turn the static scan's verified
// facts into plain-language prose — a purpose paragraph, an architecture
// narrative, and human-readable data-dictionary field descriptions. It is
// given facts already extracted by the static pass and told not to invent
// anything beyond them; it never re-reads the repo itself. One call per
// scan, kept under a hard timeout, and any failure just means "deep mode
// didn't enrich this scan" — the static wiki output is never blocked on it.

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Async (execFile, not execFileSync) — this call can take tens of seconds
// (LLM latency), and a synchronous version blocks the whole Node event loop
// for that entire time, freezing every other request the server is
// handling — including, ironically, the live-progress stream for this very
// scan.
async function runClaudePrompt(prompt, timeoutMs) {
  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt, '--output-format', 'text', '--permission-mode', 'dontAsk'], {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

function extractJsonBlock(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function buildEnrichment({ meta, structureInfo, routeGroups, models }, timeoutMs = 90000) {
  const modelSummary = models.map((m) => ({ name: m.name, fields: m.fields.map((f) => ({ name: f.name, type: f.type })) }));
  const routeSummary = routeGroups.groups.map((g) => ({ group: g.name, routes: g.routes.map((r) => `${r.method} ${r.path}`) }));

  const prompt = `You are enriching auto-generated static-analysis documentation for a codebase with plain-language prose. Given this factual summary (already extracted by static analysis — do not invent facts beyond what's given, and say so plainly if there isn't enough to go on), respond with ONLY a single JSON object, no markdown fences and no other text, matching exactly this shape:
{"purpose": "2-4 sentence plain-language paragraph describing what this application does and who would use it", "architectureNotes": "2-4 sentence paragraph describing how data flows through the system based on the routes and models below", "fieldDescriptions": {"<ModelName>": {"<fieldName>": "one short plain-language sentence describing what this field holds"}}}

Facts:
- App name: ${meta.name || 'unknown'}
- Submitted purpose (may be blank): ${meta.purpose || '(none provided)'}
- Frameworks detected: ${structureInfo.frameworks.join(', ') || 'none detected'}
- Entry points: ${structureInfo.entryPoints.join(', ') || 'none detected'}
- Top-level directories: ${structureInfo.topLevelDirs.join(', ') || 'none'}
- Route groups: ${JSON.stringify(routeSummary)}
- Data models: ${JSON.stringify(modelSummary)}

Respond with ONLY the JSON object.`;

  const raw = await runClaudePrompt(prompt, timeoutMs);
  const parsed = extractJsonBlock(raw);
  if (!parsed) return null;
  return {
    purpose: typeof parsed.purpose === 'string' ? parsed.purpose : null,
    architectureNotes: typeof parsed.architectureNotes === 'string' ? parsed.architectureNotes : null,
    fieldDescriptions: parsed.fieldDescriptions && typeof parsed.fieldDescriptions === 'object' ? parsed.fieldDescriptions : {},
  };
}

// Junior-developer learning path, continued: issues.js's CATEGORY_CODE_EXAMPLE
// gives every scan a generic before/after for free (no LLM, no cost) — this
// goes further, when Deep Scan is already paying for a Claude call anyway,
// by proposing an actual diff for the SPECIFIC flagged line using its real
// surrounding source, not a generic shape. Deliberately scoped to a small
// set of categories where a mechanical, context-free fix is usually
// correct (moving a literal into an env var, escaping an interpolation,
// adding a page size) — not every category, since something like "Possible
// Dead Code" or "High Cyclomatic Complexity" is a judgment call a
// single-shot LLM call shouldn't be trusted to just rewrite for you.
const DIFF_ELIGIBLE_CATEGORIES = new Set([
  'Hardcoded Secret',
  'Possible High-Entropy Secret',
  'Cross-Site Scripting (XSS) Risk',
  'Unbounded Loop Over Unpaginated Data',
]);
const MAX_DIFF_PROPOSALS = 5;
const CONTEXT_LINES = 6;

function fileContextAround(fileContent, line, contextLines = CONTEXT_LINES) {
  const lines = fileContent.split('\n');
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
}

// readFile(relPath) -> string | null, supplied by the caller (already knows
// how to safely resolve a relPath against the scan root — see walk.js's
// readFileSafe) rather than this module reaching outside its own concern to
// touch the filesystem/scan root itself.
async function proposeFixDiffs(issues, readFile, timeoutMs = 60000, promptFn = runClaudePrompt) {
  const eligible = issues.filter((i) => DIFF_ELIGIBLE_CATEGORIES.has(i.category)).slice(0, MAX_DIFF_PROPOSALS);
  const results = {};
  for (const issue of eligible) {
    const raw = readFile(issue.file);
    if (!raw) continue;
    const context = fileContextAround(raw, issue.line);
    const prompt = `You are proposing a minimal, mechanical code fix for a single flagged static-analysis finding. Respond with ONLY a single JSON object, no markdown fences and no other text, matching exactly this shape:
{"diff": "a short snippet showing the minimal change as removed/added lines (e.g. lines prefixed with - for old code and + for new code), or null if you can't propose a safe fix from this context alone", "explanation": "one short sentence"}

Finding: ${issue.category} — ${issue.summary}
File: ${issue.file}, flagged at line ${issue.line}

Source context (line numbers included, do not include them in your diff):
${context}

Respond with ONLY the JSON object.`;
    const rawResponse = await promptFn(prompt, timeoutMs);
    const parsed = extractJsonBlock(rawResponse);
    if (parsed && typeof parsed.diff === 'string' && parsed.diff.trim()) {
      results[fingerprintKey(issue)] = { diff: parsed.diff, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' };
    }
  }
  return results;
}

// Mirrors triage.js's fingerprintIssue exactly (category+file+line+summary)
// without importing triage.js itself — that module already depends on
// suppressionRules.js, and this one has no other reason to sit in that
// dependency chain for one string-building function.
function fingerprintKey(issue) {
  return `${issue.category}::${issue.file}::${issue.line}::${issue.summary}`;
}

module.exports = { buildEnrichment, proposeFixDiffs, DIFF_ELIGIBLE_CATEGORIES };
