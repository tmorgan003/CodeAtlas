// Feature: masking rules UI. The actual secret-detection regexes (kvRe,
// awsKeyRe, privKeyRe in issues.js's scanSecrets) are hardcoded — this lets
// a user add their own regex patterns per app (e.g. an internal token
// format the built-in checks don't know about) from the UI, applied
// alongside the built-in checks on every future scan.

const path = require('path');
const crypto = require('crypto');
const jsonFileStore = require('../jsonFileStore');

const RULES_DIR = path.join(__dirname, '..', '..', 'data', 'mask-rules');
const VALID_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const MAX_MATCHES_PER_FILE = 20; // same spirit as npmAudit's MAX_ISSUES cap — a runaway pattern shouldn't flood the Issues list

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

function validatePattern(pattern) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err.message}`);
  }
}

function addRule(appId, { name, pattern, severity }) {
  const trimmedName = (name || '').trim();
  const trimmedPattern = (pattern || '').trim();
  if (!trimmedName) throw new Error('Rule name is required');
  if (!trimmedPattern) throw new Error('Pattern is required');
  validatePattern(trimmedPattern);
  const rules = loadRules(appId);
  rules.push({
    id: crypto.randomUUID(),
    name: trimmedName,
    pattern: trimmedPattern,
    severity: VALID_SEVERITIES.has(severity) ? severity : 'Medium',
  });
  saveRules(appId, rules);
  return rules;
}

function updateRule(appId, id, { name, pattern, severity }) {
  const rules = loadRules(appId);
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error('Rule not found');
  if (name !== undefined) {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Rule name is required');
    rule.name = trimmedName;
  }
  if (pattern !== undefined) {
    const trimmedPattern = pattern.trim();
    if (!trimmedPattern) throw new Error('Pattern is required');
    validatePattern(trimmedPattern);
    rule.pattern = trimmedPattern;
  }
  if (severity !== undefined && VALID_SEVERITIES.has(severity)) rule.severity = severity;
  saveRules(appId, rules);
  return rules;
}

function removeRule(appId, id) {
  const rules = loadRules(appId).filter((r) => r.id !== id);
  saveRules(appId, rules);
  return rules;
}

// Applied against raw (unmasked) file content — same as the built-in
// scanSecrets checks in issues.js: the value we're looking for legitimately
// lives inside a string literal, so masking it out would defeat the point.
function applyCustomRules(relPath, content, rules, lineOf) {
  const issues = [];
  for (const rule of rules) {
    let re;
    try {
      re = new RegExp(rule.pattern, 'g');
    } catch {
      continue; // invalid regex saved some other way (shouldn't happen via addRule/updateRule) — skip rather than crash the scan
    }
    let m;
    let count = 0;
    while (count < MAX_MATCHES_PER_FILE && (m = re.exec(content))) {
      count++;
      issues.push({
        file: relPath,
        line: lineOf(content, m.index),
        severity: rule.severity,
        category: `Custom Pattern: ${rule.name}`,
        summary: `Matched custom masking rule "${rule.name}" (/${rule.pattern}/).`,
        suggestedFix: 'Review this match — refine the pattern in the app\'s Masking Rules settings if this is a false positive.',
      });
      if (re.lastIndex === m.index) re.lastIndex++; // guard against a zero-length match looping forever
    }
  }
  return issues;
}

module.exports = { loadRules, addRule, updateRule, removeRule, applyCustomRules, VALID_SEVERITIES };
