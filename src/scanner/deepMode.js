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

module.exports = { buildEnrichment };
