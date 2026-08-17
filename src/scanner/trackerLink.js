// Feature 15: push a flagged issue to an external tracker (GitHub Issues or
// Jira) directly from the Issues tab. Per-app config (trackerType plus the
// generic trackerBaseUrl/trackerProjectOrRepo/trackerEmail/trackerToken
// fields — which fields matter depends on trackerType) lives on the app
// record itself, same place notifyWebhookUrl already lives.

const https = require('https');
const { URL } = require('url');

function request(urlString, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      reject(new Error('Invalid tracker URL'));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'CodeAtlas',
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsedBody = null;
          try { parsedBody = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error body */ }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsedBody, raw });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request to tracker timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function issueTitle(issue) {
  return `[${issue.severity}] ${issue.category} — ${issue.file}:${issue.line}`;
}

function issueBody(issue, app) {
  const lines = [
    issue.summary,
    '',
    `**File:** \`${issue.file}:${issue.line}\``,
    `**Severity:** ${issue.severity}`,
    `**Category:** ${issue.category}`,
  ];
  if (issue.suggestedFix) lines.push('', `**Suggested fix:** ${issue.suggestedFix}`);
  lines.push('', `_Filed from CodeAtlas for "${app.name}"._`);
  return lines.join('\n');
}

async function pushToGithub(app, issue) {
  const repo = (app.trackerProjectOrRepo || '').trim();
  if (!repo.includes('/')) throw new Error('trackerProjectOrRepo must be "owner/repo" for GitHub');
  const res = await request(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `token ${app.trackerToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: { title: issueTitle(issue), body: issueBody(issue, app) },
  });
  if (!res.ok) throw new Error(`GitHub API error (${res.status}): ${res.body?.message || res.raw.slice(0, 200)}`);
  return { url: res.body.html_url, id: String(res.body.number) };
}

async function pushToJira(app, issue) {
  const baseUrl = (app.trackerBaseUrl || '').replace(/\/$/, '');
  const projectKey = (app.trackerProjectOrRepo || '').trim();
  if (!baseUrl || !projectKey) throw new Error('trackerBaseUrl and trackerProjectOrRepo (project key) are required for Jira');
  const auth = Buffer.from(`${app.trackerEmail}:${app.trackerToken}`).toString('base64');
  const res = await request(`${baseUrl}/rest/api/2/issue`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: {
      fields: {
        project: { key: projectKey },
        summary: issueTitle(issue),
        description: issueBody(issue, app),
        issuetype: { name: 'Bug' },
      },
    },
  });
  if (!res.ok) throw new Error(`Jira API error (${res.status}): ${res.body?.errorMessages?.join('; ') || res.raw.slice(0, 200)}`);
  return { url: `${baseUrl}/browse/${res.body.key}`, id: res.body.key };
}

async function pushIssueToTracker(app, issue) {
  if (app.trackerType === 'github') return pushToGithub(app, issue);
  if (app.trackerType === 'jira') return pushToJira(app, issue);
  throw new Error(`No tracker configured for this app (trackerType: ${app.trackerType || 'none'})`);
}

module.exports = { pushIssueToTracker };
