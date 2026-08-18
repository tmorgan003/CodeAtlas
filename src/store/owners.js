// Feature 19: Owner/Team was free text, so the same team ended up spelled
// three different ways across apps ("Platform Team" / "platform team" /
// "Platform"). This is CodeAtlas's own lightweight stand-in for tying that
// field to a real directory — a saved, de-duplicated list of known owner
// names that new/updated apps are validated against.

const path = require('path');
const jsonFileStore = require('../jsonFileStore');

const OWNERS_PATH = path.join(__dirname, '..', '..', 'data', 'owners.json');

function loadAll() {
  return jsonFileStore.load(OWNERS_PATH, []);
}

function saveAll(owners) {
  jsonFileStore.save(OWNERS_PATH, owners);
}

function add(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Owner name is required');
  const owners = loadAll();
  if (!owners.some((o) => o.toLowerCase() === trimmed.toLowerCase())) {
    owners.push(trimmed);
    owners.sort((a, b) => a.localeCompare(b));
    saveAll(owners);
  }
  return owners;
}

function remove(name) {
  const owners = loadAll().filter((o) => o.toLowerCase() !== (name || '').toLowerCase());
  saveAll(owners);
  return owners;
}

// A blank owner is always valid (unassigned) — only a non-blank value has
// to match the saved list.
function isValid(name) {
  if (!name || !name.trim()) return true;
  return loadAll().some((o) => o.toLowerCase() === name.trim().toLowerCase());
}

module.exports = { loadAll, add, remove, isValid };
