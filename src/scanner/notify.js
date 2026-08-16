// Feature 19 (notification half): after a scan, if the app has a webhook
// URL configured and new Critical/High severity issues appeared since the
// last scan, POST a summary to it. Uses a `{ text }` payload — the format
// Slack (and many other chat tools) accept directly for an incoming
// webhook — so this covers "Slack or generic webhook" with zero
// dependencies. Real SMTP email notification is out of scope here: there's
// no mail server configured in this environment to build or test that
// against honestly.

const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJson(urlString, payload) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      resolve({ ok: false, error: 'invalid URL' });
      return;
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function severityAtLeastHigh(issue) {
  return issue.severity === 'Critical' || issue.severity === 'High';
}

async function notifyIfNeeded(app, diff) {
  if (!app.notifyWebhookUrl) return null;
  if (!diff) return null; // first scan, or scan didn't produce a diff (no appId)
  const notable = diff.newIssues.filter(severityAtLeastHigh);
  if (!notable.length) return null;

  const lines = notable.slice(0, 10).map((i) => `• [${i.severity}] ${i.category} — ${i.file}:${i.line} — ${i.summary}`);
  const text = `*CodeAtlas: ${notable.length} new Critical/High issue(s) in "${app.name}"*\n${lines.join('\n')}${notable.length > 10 ? `\n…and ${notable.length - 10} more` : ''}\nWiki: ${app.wikiLink || '(unavailable)'}`;

  return postJson(app.notifyWebhookUrl, { text });
}

module.exports = { notifyIfNeeded, postJson };
