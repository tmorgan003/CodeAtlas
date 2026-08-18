// Feature 12: pattern-based issue suppression — a rule matches by category
// (or "any") plus a glob-style file pattern (same syntax/engine as
// customIgnore.js's per-app ignore patterns) and auto-suppresses every
// issue that matches it, present and future — e.g. "Leftover Debug
// Logging" in "test/**" — as opposed to triage.js's per-finding
// false-positive marking, which only ever affects one specific finding.
// Applied at the same point triage.isDismissed already is (see triage.js),
// so every existing consumer (active issue counts, CI gate, cross-app
// Issues list) respects suppression rules without being touched itself.

// Suppression safety: a rule silences a whole class of findings — present
// and future, across the entire codebase — which is exactly the kind of
// broad, easy-to-forget-about action that needs a paper trail. Every rule
// now requires a written reason and an expiration date (no permanent,
// unexplained suppressions), and every create/remove is appended to a
// global audit log (data/suppression-audit-log.json) recording who did it
// and when — otherwise a developer under deadline pressure silences a real
// finding to unblock a build, and nothing else on the team notices until
// an incident.

const path = require('path');
const crypto = require('crypto');
const { globToRegExp } = require('./customIgnore');
const jsonFileStore = require('../jsonFileStore');
const auditLog = require('./auditLog');

const RULES_DIR = path.join(__dirname, '..', '..', 'data', 'suppression-rules');
const MAX_EXPIRY_DAYS = 365;

function rulesFile(appId) {
  return path.join(RULES_DIR, `${appId}.json`);
}

function loadRules(appId) {
  const rules = jsonFileStore.load(rulesFile(appId), []);
  return Array.isArray(rules) ? rules : [];
}

function saveRules(appId, rules) {
  jsonFileStore.save(rulesFile(appId), rules);
}

function isExpired(rule) {
  return !!rule.expiresAt && new Date(rule.expiresAt).getTime() < Date.now();
}

function addRule(appId, { category, filePattern, reason, expiresAt }, actor) {
  const trimmedPattern = (filePattern || '').trim();
  if (!trimmedPattern) throw new Error('File pattern is required');
  try {
    globToRegExp(trimmedPattern);
  } catch {
    throw new Error(`Invalid pattern: "${trimmedPattern}"`);
  }
  const trimmedReason = (reason || '').trim();
  if (!trimmedReason) throw new Error('A reason is required — explain why this finding is being suppressed.');

  if (!expiresAt) throw new Error('An expiration date is required — suppressions cannot be permanent.');
  const expiryDate = new Date(expiresAt);
  if (Number.isNaN(expiryDate.getTime())) throw new Error('Invalid expiration date.');
  const now = Date.now();
  if (expiryDate.getTime() <= now) throw new Error('Expiration date must be in the future.');
  if (expiryDate.getTime() > now + MAX_EXPIRY_DAYS * 86400000) throw new Error(`Expiration date can be at most ${MAX_EXPIRY_DAYS} days out — request a new suppression if it's still needed after that.`);

  const rules = loadRules(appId);
  const entry = {
    id: crypto.randomUUID(),
    category: (category || '').trim() || 'any',
    filePattern: trimmedPattern,
    reason: trimmedReason,
    expiresAt: expiryDate.toISOString(),
    createdBy: actor || 'unknown',
    createdAt: new Date().toISOString(),
  };
  rules.push(entry);
  saveRules(appId, rules);
  auditLog.appendAuditLog({ kind: 'suppression-rule', action: 'created', appId, ruleId: entry.id, category: entry.category, filePattern: entry.filePattern, reason: entry.reason, expiresAt: entry.expiresAt, by: entry.createdBy, at: entry.createdAt });
  return entry;
}

function removeRule(appId, id, actor) {
  const rules = loadRules(appId);
  const removed = rules.find((r) => r.id === id);
  const remaining = rules.filter((r) => r.id !== id);
  saveRules(appId, remaining);
  if (removed) {
    auditLog.appendAuditLog({ kind: 'suppression-rule', action: 'removed', appId, ruleId: removed.id, category: removed.category, filePattern: removed.filePattern, reason: removed.reason, by: actor || 'unknown', at: new Date().toISOString() });
  }
  return remaining;
}

function matchesRule(issue, rule) {
  if (isExpired(rule)) return false;
  if (rule.category !== 'any' && rule.category !== issue.category) return false;
  try {
    return globToRegExp(rule.filePattern).test(issue.file);
  } catch {
    return false;
  }
}

function matchesAnyRule(issue, rules) {
  return rules.some((r) => matchesRule(issue, r));
}

module.exports = { loadRules, saveRules, addRule, removeRule, matchesAnyRule, isExpired };
