// Feature 12: pattern-based issue suppression — a rule matches by category
// (or "any") plus a glob-style file pattern (same syntax/engine as
// customIgnore.js's per-app ignore patterns) and auto-suppresses every
// issue that matches it, present and future — e.g. "Leftover Debug
// Logging" in "test/**" — as opposed to triage.js's per-finding
// false-positive marking, which only ever affects one specific finding.
// Applied at the same point triage.isDismissed already is (see triage.js),
// so every existing consumer (active issue counts, CI gate, cross-app
// Issues list) respects suppression rules without being touched itself.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { globToRegExp } = require('./customIgnore');

const RULES_DIR = path.join(__dirname, '..', '..', 'data', 'suppression-rules');

function rulesFile(appId) {
  return path.join(RULES_DIR, `${appId}.json`);
}

function loadRules(appId) {
  const file = rulesFile(appId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRules(appId, rules) {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.writeFileSync(rulesFile(appId), JSON.stringify(rules, null, 2), 'utf8');
}

function addRule(appId, { category, filePattern, note }) {
  const trimmedPattern = (filePattern || '').trim();
  if (!trimmedPattern) throw new Error('File pattern is required');
  try {
    globToRegExp(trimmedPattern);
  } catch {
    throw new Error(`Invalid pattern: "${trimmedPattern}"`);
  }
  const rules = loadRules(appId);
  const entry = {
    id: crypto.randomUUID(),
    category: (category || '').trim() || 'any',
    filePattern: trimmedPattern,
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  rules.push(entry);
  saveRules(appId, rules);
  return entry;
}

function removeRule(appId, id) {
  const rules = loadRules(appId).filter((r) => r.id !== id);
  saveRules(appId, rules);
  return rules;
}

function matchesRule(issue, rule) {
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

module.exports = { loadRules, saveRules, addRule, removeRule, matchesAnyRule };
