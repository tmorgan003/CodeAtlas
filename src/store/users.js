// Feature: basic role-based access control. A local single-team tool
// doesn't need a real identity provider, but a few actions (editing the
// Data Dictionary, changing the CI gate severity, triggering a Deep scan)
// are consequential enough — cost money, change what blocks CI, or
// overwrite a teammate's edit — that they shouldn't be one click away
// for anyone with the URL. This is intentionally minimal: three fixed
// roles, no self-serve signup, plaintext-adjacent local JSON storage
// (passwords are hashed, nothing else is), good enough for a small team
// on a trusted network, not meant to withstand a real threat model.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jsonFileStore = require('../jsonFileStore');

const USERS_PATH = path.join(__dirname, '..', '..', 'data', 'users.json');

const ROLES = ['viewer', 'editor', 'admin'];
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return `${useSalt}:${hash}`;
}

function verifyHash(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function seedIfMissing() {
  if (fs.existsSync(USERS_PATH)) return;
  // Seed one admin account so RBAC is usable out of the box. Credentials
  // are deliberately obvious and logged loudly — this stands in for a
  // real "set your password on first login" flow a production app would
  // have, which is out of scope here.
  const seeded = [{ username: 'admin', role: 'admin', passwordHash: hashPassword('admin') }];
  jsonFileStore.save(USERS_PATH, seeded);
  console.warn('[users] Seeded default account admin/admin (role: admin) — change this via the Manage Users panel.');
}

function loadAllRaw() {
  seedIfMissing();
  return jsonFileStore.load(USERS_PATH, []);
}

function saveAll(users) {
  jsonFileStore.save(USERS_PATH, users);
}

function toPublic(u) {
  return { username: u.username, role: u.role };
}

function loadAll() {
  return loadAllRaw().map(toPublic);
}

function findByUsername(username) {
  return loadAllRaw().find((u) => u.username.toLowerCase() === String(username || '').toLowerCase()) || null;
}

function verifyPassword(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  return verifyHash(password, user.passwordHash) ? toPublic(user) : null;
}

function create(username, password, role) {
  const trimmed = (username || '').trim();
  if (!trimmed) throw new Error('Username is required');
  if (!password || password.length < 4) throw new Error('Password must be at least 4 characters');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  const users = loadAllRaw();
  if (users.some((u) => u.username.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`User "${trimmed}" already exists`);
  }
  const entry = { username: trimmed, role, passwordHash: hashPassword(password) };
  users.push(entry);
  saveAll(users);
  return toPublic(entry);
}

function setRole(username, role) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  const users = loadAllRaw();
  const user = users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user) throw new Error(`User "${username}" not found`);
  user.role = role;
  saveAll(users);
  return toPublic(user);
}

function remove(username) {
  const users = loadAllRaw();
  const remaining = users.filter((u) => u.username.toLowerCase() !== String(username || '').toLowerCase());
  if (remaining.filter((u) => u.role === 'admin').length === 0) {
    throw new Error('Cannot remove the last admin account');
  }
  saveAll(remaining);
}

module.exports = { ROLES, ROLE_RANK, loadAll, findByUsername, verifyPassword, create, setRole, remove };
