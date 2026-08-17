// Feature 19: manage the saved Owner/Team list the app form validates
// against, so ownership data stays consistent across apps.

const express = require('express');
const owners = require('../store/owners');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(owners.loadAll());
});

router.post('/', (req, res) => {
  const { name } = req.body || {};
  try {
    res.status(201).json(owners.add(name));
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

router.delete('/:name', (req, res) => {
  res.json(owners.remove(req.params.name));
});

module.exports = router;
