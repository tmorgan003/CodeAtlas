// Feature: custom wiki sections — team-added markdown pages (e.g. a
// "Runbook" or "On-call Notes" page) that live alongside the generated
// wiki but are never touched by the scanner. Stored separately from the
// app's own wiki/ directory (which runScan freely overwrites on every
// rescan) so a custom page survives rescans automatically — there's
// nothing for the scanner to clobber, because it never writes here.

const fs = require('fs');
const path = require('path');

const SECTIONS_DIR = path.join(__dirname, '..', '..', 'data', 'custom-wiki-sections');

function filePath(appId) {
  return path.join(SECTIONS_DIR, `${appId}.json`);
}

function ensure() {
  fs.mkdirSync(SECTIONS_DIR, { recursive: true });
}

function loadSections(appId) {
  ensure();
  const p = filePath(appId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function saveSections(appId, sections) {
  ensure();
  fs.writeFileSync(filePath(appId), JSON.stringify(sections, null, 2), 'utf8');
}

function slugify(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function addSection(appId, title, content) {
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle) throw new Error('Title is required');
  const sections = loadSections(appId);
  const base = slugify(trimmedTitle);
  let slug = base;
  let n = 2;
  while (sections.some((s) => s.slug === slug)) slug = `${base}-${n++}`;
  const now = new Date().toISOString();
  const entry = { slug, title: trimmedTitle, content: content || '', createdAt: now, updatedAt: now };
  sections.push(entry);
  saveSections(appId, sections);
  return entry;
}

function updateSection(appId, slug, { title, content }) {
  const sections = loadSections(appId);
  const entry = sections.find((s) => s.slug === slug);
  if (!entry) throw new Error(`Custom section "${slug}" not found`);
  if (title !== undefined && title.trim()) entry.title = title.trim();
  if (content !== undefined) entry.content = content;
  entry.updatedAt = new Date().toISOString();
  saveSections(appId, sections);
  return entry;
}

function removeSection(appId, slug) {
  const sections = loadSections(appId);
  const next = sections.filter((s) => s.slug !== slug);
  saveSections(appId, next);
  return next.length !== sections.length;
}

module.exports = { loadSections, addSection, updateSection, removeSection };
