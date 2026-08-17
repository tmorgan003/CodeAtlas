// Feature: basic login/roles. See src/store/users.js and
// src/middleware/auth.js for why this is deliberately minimal.

const express = require('express');
const users = require('../store/users');
const auth = require('../middleware/auth');

const router = express.Router();

function setCookie(res, token) {
  const maxAgeSec = Math.floor(auth.SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  const user = users.verifyPassword(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = auth.createSession(user);
  setCookie(res, token);
  res.json(user);
});

router.post('/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  clearCookie(res);
  res.status(204).end();
});

router.get('/me', (req, res) => {
  res.json(req.user || { username: null, role: 'viewer' });
});

// Admin-only user management, so a team can add named accounts instead of
// everyone sharing the seeded admin/admin login.
router.get('/users', auth.requireRole('admin'), (req, res) => {
  res.json(users.loadAll());
});

router.post('/users', auth.requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  try {
    res.status(201).json(users.create(username, password, role));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.patch('/users/:username', auth.requireRole('admin'), (req, res) => {
  const { role } = req.body || {};
  try {
    res.json(users.setRole(req.params.username, role));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/users/:username', auth.requireRole('admin'), (req, res) => {
  try {
    users.remove(req.params.username);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

module.exports = router;
