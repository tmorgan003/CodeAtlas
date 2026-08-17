const form = document.getElementById('app-form');
const formStatus = document.getElementById('form-status');
const tableBody = document.getElementById('app-table-body');
const emptyState = document.getElementById('empty-state');
const listPanel = document.getElementById('list-panel');
const detailPanel = document.getElementById('detail-panel');
const detailName = document.getElementById('detail-name');
const detailMeta = document.getElementById('detail-meta');
const wikiNav = document.getElementById('wiki-nav');
const wikiLinks = document.getElementById('wiki-links');
const wikiView = document.getElementById('wiki-view');
const closeDetailBtn = document.getElementById('close-detail');
const wikiSearchForm = document.getElementById('wiki-search-form');
const wikiSearchInput = document.getElementById('wiki-search-input');
const themeToggleBtn = document.getElementById('theme-toggle');
const pathInput = document.getElementById('path-input');
const browseBtn = document.getElementById('browse-btn');
const browseModal = document.getElementById('browse-modal');
const browseCurrentPath = document.getElementById('browse-current-path');
const browseList = document.getElementById('browse-list');
const browseCancelBtn = document.getElementById('browse-cancel');
const browseSelectBtn = document.getElementById('browse-select');

let currentDetailId = null;
let currentWikiDir = '';

// ---- Motion helper ----
// Wraps a synchronous DOM update in a View Transition when the browser and
// the visitor's motion preference both allow it, so panel swaps and content
// changes crossfade instead of cutting hard. Falls back to a plain update
// everywhere else (older browsers, prefers-reduced-motion).
function withViewTransition(update) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !document.startViewTransition) {
    update();
    return;
  }
  document.startViewTransition(update);
}

// ---- Theme toggle ----
// The <head> inline script already applied any stored preference before
// first paint (avoids a flash of the wrong theme); this just keeps the
// button label in sync and handles the click-to-switch.

const THEME_KEY = 'codeatlas-theme';

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
}

let currentTheme = localStorage.getItem(THEME_KEY) || (systemPrefersDark() ? 'dark' : 'light');
applyTheme(currentTheme);

themeToggleBtn.addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme(currentTheme);
});

// ---- Folder browser ----
// Browsers won't hand JS a real absolute path from a directory picker, so
// this walks the server's own filesystem (same machine the scan itself
// reads from) via /api/browse instead.

let browseState = { path: null, parent: null, dirs: [] };

function renderBrowseModal() {
  browseCurrentPath.textContent = browseState.path || 'Drives';
  browseList.innerHTML = '';
  if (browseState.path) {
    const up = document.createElement('li');
    up.className = 'browse-item browse-up';
    up.textContent = '.. (up)';
    up.addEventListener('click', () => browseTo(browseState.parent));
    browseList.appendChild(up);
  }
  for (const dir of browseState.dirs) {
    const li = document.createElement('li');
    li.className = 'browse-item';
    const trimmed = dir.replace(/[\\/]+$/, '');
    li.textContent = trimmed.split(/[\\/]/).pop() || dir;
    li.title = dir;
    li.addEventListener('click', () => browseTo(dir));
    browseList.appendChild(li);
  }
  if (!browseState.dirs.length) {
    const empty = document.createElement('li');
    empty.className = 'browse-empty';
    empty.textContent = 'No subfolders here.';
    browseList.appendChild(empty);
  }
}

async function browseTo(targetPath) {
  const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
  const res = await fetch(`/api/browse${qs}`);
  if (!res.ok) {
    if (targetPath) return browseTo(null); // not a real dir (e.g. a repo URL) — fall back to drives/root
    return;
  }
  browseState = await res.json();
  renderBrowseModal();
}

browseBtn.addEventListener('click', () => {
  browseModal.classList.remove('closing');
  browseModal.hidden = false;
  browseTo(pathInput.value.trim() || null);
});

function closeBrowseModal() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { browseModal.hidden = true; return; }
  browseModal.classList.add('closing');
  browseModal.addEventListener('animationend', () => {
    browseModal.hidden = true;
    browseModal.classList.remove('closing');
  }, { once: true });
}

browseCancelBtn.addEventListener('click', closeBrowseModal);
browseSelectBtn.addEventListener('click', () => {
  if (browseState.path) pathInput.value = browseState.path;
  closeBrowseModal();
});
browseModal.addEventListener('click', (e) => { if (e.target === browseModal) closeBrowseModal(); });

async function api(path, opts) {
  const res = await fetch(`/api/apps${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

function statusClass(status) {
  return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
}

// Rows are kept and updated in place (rather than torn down and rebuilt on
// every render) so a status change — the signal engineers actually watch,
// especially while the 3s poll is running — animates on its own row instead
// of popping silently inside a fully-replaced table.
const rowElements = new Map(); // app id -> row refs

function buildRow(app) {
  const tr = document.createElement('tr');

  const nameTd = document.createElement('td');
  const nameLink = document.createElement('a');
  nameLink.href = '#';
  nameLink.style.color = 'var(--accent-text)';
  nameLink.addEventListener('click', (e) => { e.preventDefault(); openDetail(app.id); });
  nameTd.appendChild(nameLink);

  const envTd = document.createElement('td');
  const tagsTd = document.createElement('td');

  const statusTd = document.createElement('td');
  const badge = document.createElement('span');
  statusTd.appendChild(badge);

  const actionsTd = document.createElement('td');
  const scanBtn = document.createElement('button');
  scanBtn.className = 'secondary';
  scanBtn.addEventListener('click', () => triggerScan(app.id));
  actionsTd.appendChild(scanBtn);

  tr.append(nameTd, envTd, tagsTd, statusTd, actionsTd);

  const refs = { tr, nameLink, envTd, tagsTd, badge, scanBtn, lastStatus: null };
  updateRow(refs, app);
  tr.classList.add('row-enter');
  tr.addEventListener('animationend', () => tr.classList.remove('row-enter'), { once: true });
  return refs;
}

const ENV_BADGE_CLASS = { Production: 'env-production', Staging: 'env-staging', Internal: 'env-internal' };

function updateRow(refs, app) {
  refs.nameLink.textContent = app.name;
  refs.envTd.innerHTML = '';
  if (app.environment) {
    const badge = document.createElement('span');
    badge.className = 'env-badge ' + (ENV_BADGE_CLASS[app.environment] || 'env-internal');
    badge.textContent = app.environment;
    refs.envTd.appendChild(badge);
  } else {
    refs.envTd.textContent = '—';
  }

  refs.tagsTd.innerHTML = '';
  for (const tag of app.tags || []) {
    const span = document.createElement('span');
    span.className = 'tag-badge';
    span.textContent = tag;
    refs.tagsTd.appendChild(span);
  }

  const statusChanged = refs.lastStatus !== null && refs.lastStatus !== app.status;
  refs.badge.className = 'status-badge ' + statusClass(app.status);
  refs.badge.textContent = app.status;
  refs.lastStatus = app.status;

  refs.scanBtn.textContent = app.status === 'Not Started' ? 'Scan' : 'Rescan';
  refs.scanBtn.disabled = app.status === 'Scanning';

  if (statusChanged) {
    refs.badge.classList.remove('badge-flash');
    void refs.badge.offsetWidth; // restart the animation on repeated changes
    refs.badge.classList.add('badge-flash');
  }
}

function renderList(apps) {
  emptyState.hidden = apps.length > 0;
  if (!apps.length && allApps.length) {
    emptyState.hidden = false;
    emptyState.textContent = 'No applications match the current filters.';
  } else {
    emptyState.textContent = 'No applications added yet.';
  }

  const seen = new Set();
  let prevEl = null;
  for (const app of apps) {
    seen.add(app.id);
    let refs = rowElements.get(app.id);
    if (!refs) {
      refs = buildRow(app);
      rowElements.set(app.id, refs);
    } else {
      updateRow(refs, app);
    }
    const target = prevEl ? prevEl.nextSibling : tableBody.firstChild;
    if (target !== refs.tr) tableBody.insertBefore(refs.tr, target);
    prevEl = refs.tr;
  }
  for (const [id, refs] of rowElements) {
    if (!seen.has(id)) {
      refs.tr.remove();
      rowElements.delete(id);
    }
  }
}

let allApps = [];
const filterSearch = document.getElementById('filter-search');
const filterEnvironment = document.getElementById('filter-environment');
const filterOwner = document.getElementById('filter-owner');

function populateFilterOptions(apps) {
  const rebuild = (select, values, allLabel) => {
    const current = select.value;
    select.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${v}">${v}</option>`).join('');
    if (values.includes(current)) select.value = current;
  };
  rebuild(filterEnvironment, [...new Set(apps.map((a) => a.environment).filter(Boolean))].sort(), 'All environments');
  rebuild(filterOwner, [...new Set(apps.map((a) => a.owner).filter(Boolean))].sort(), 'All owners');
  updateEnvironmentSuggestions(apps);
}

// ---- Applications table sorting ----
// Click a sortable header to sort by it; click again to reverse. State is
// re-applied after every filter change so sort order survives filtering.
let sortState = { key: null, dir: 1 };
const sortableHeaders = document.querySelectorAll('#app-table th.sortable');

function updateSortIndicators() {
  for (const th of sortableHeaders) {
    const indicator = th.querySelector('.sort-indicator');
    indicator.textContent = th.dataset.sortKey === sortState.key ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
  }
}

sortableHeaders.forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    sortState = sortState.key === key ? { key, dir: -sortState.dir } : { key, dir: 1 };
    updateSortIndicators();
    applyFilters();
  });
});

function applySort(apps) {
  if (!sortState.key) return apps;
  const key = sortState.key;
  return [...apps].sort((a, b) => {
    const av = (a[key] || '').toLowerCase();
    const bv = (b[key] || '').toLowerCase();
    return av < bv ? -sortState.dir : av > bv ? sortState.dir : 0;
  });
}

function applyFilters() {
  const search = filterSearch.value.trim().toLowerCase();
  const env = filterEnvironment.value;
  const owner = filterOwner.value;
  const filtered = allApps.filter((a) => {
    if (env && a.environment !== env) return false;
    if (owner && a.owner !== owner) return false;
    if (search && !`${a.name} ${(a.tags || []).join(' ')}`.toLowerCase().includes(search)) return false;
    return true;
  });
  renderList(applySort(filtered));
}

[filterSearch, filterEnvironment, filterOwner].forEach((el) => el.addEventListener('input', applyFilters));

async function refreshList() {
  const apps = await api('');
  allApps = apps;
  populateFilterOptions(apps);
  applyFilters();
  loadDashboard();
  return apps;
}

// ---- Portfolio dashboard ----

const dashboardContent = document.getElementById('dashboard-content');
const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];

function statTile(value, label) {
  const div = document.createElement('div');
  div.className = 'stat-tile';
  const val = document.createElement('div');
  val.className = 'stat-value';
  val.textContent = value;
  const lbl = document.createElement('div');
  lbl.className = 'stat-label';
  lbl.textContent = label;
  div.append(val, lbl);
  return div;
}

async function loadDashboard() {
  let d;
  try {
    d = await api('/dashboard');
  } catch {
    return;
  }
  dashboardContent.innerHTML = '';

  const stats = document.createElement('div');
  stats.className = 'dashboard-stats';
  stats.appendChild(statTile(d.totalApps, 'Apps'));
  stats.appendChild(statTile(d.totalActiveIssues, 'Active Issues'));
  stats.appendChild(statTile(d.staleApps.length, `Stale (>${d.staleDaysThreshold}d)`));
  dashboardContent.appendChild(stats);

  const severityRow = document.createElement('div');
  severityRow.className = 'severity-chip-row';
  for (const sev of SEVERITY_ORDER) {
    const count = d.bySeverity[sev] || 0;
    if (!count) continue;
    const chip = document.createElement('span');
    chip.className = 'severity-badge ' + (SEVERITY_BADGE_CLASS[sev] || 'severity-low');
    chip.textContent = `${sev}: ${count}`;
    severityRow.appendChild(chip);
  }
  if (severityRow.children.length) dashboardContent.appendChild(severityRow);

  const envRow = document.createElement('div');
  envRow.className = 'severity-chip-row';
  for (const [env, count] of Object.entries(d.byEnvironment)) {
    const chip = document.createElement('span');
    chip.className = 'env-badge ' + (ENV_BADGE_CLASS[env] || 'env-internal');
    chip.textContent = `${env}: ${count}`;
    envRow.appendChild(chip);
  }
  if (envRow.children.length) dashboardContent.appendChild(envRow);

  if (d.staleApps.length) {
    const staleHeading = document.createElement('p');
    staleHeading.className = 'dashboard-subheading';
    staleHeading.textContent = 'Needs a rescan:';
    dashboardContent.appendChild(staleHeading);

    const list = document.createElement('ul');
    list.className = 'stale-list';
    for (const s of d.staleApps) {
      const li = document.createElement('li');
      li.className = 'stale-item';
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = s.name;
      link.style.color = 'var(--accent-text)';
      link.addEventListener('click', (e) => { e.preventDefault(); openDetail(s.id); });
      const age = document.createElement('span');
      age.className = 'stale-age';
      age.textContent = s.daysSinceScan === null ? 'never scanned' : `${s.daysSinceScan}d ago`;
      li.append(link, age);
      list.appendChild(li);
    }
    dashboardContent.appendChild(list);
  }
}

async function triggerScan(id) {
  await api(`/${id}/scan`, { method: 'POST' });
  await refreshList();
  if (currentDetailId === id) await openDetail(id);
}

// Feature 16: live progress via Server-Sent Events, in place of waiting on
// the 3s list-refresh poll to notice a status change.
let currentEventSource = null;

function closeScanStream() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

function attachScanStream(id) {
  closeScanStream();
  const list = document.createElement('ul');
  list.className = 'scan-progress-log';
  withViewTransition(() => {
    wikiView.innerHTML = '<h2>Scanning…</h2>';
    wikiView.appendChild(list);
  });

  const es = new EventSource(`/api/apps/${id}/scan-stream`);
  currentEventSource = es;
  es.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    const li = document.createElement('li');
    li.textContent = data.message;
    li.classList.add('log-enter');
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
    if (data.done) {
      closeScanStream();
      lastKnownStatus[id] = data.status || 'Done';
      refreshList();
      if (currentDetailId === id) openDetail(id);
    }
  };
  es.onerror = () => closeScanStream();
}

// Previews the same stakes-tier color the Environment badge will show once
// this app is added — Production/Staging pick up the color they'll wear in
// the table and detail panel; Internal (and blank) stay neutral, matching
// env-badge's own restraint (lowest stakes earns no accent).
const envSelect = form.querySelector('input[name="environment"]');
const environmentOptions = document.getElementById('environment-options');
const ENV_SELECT_CLASS = { Production: 'env-select-production', Staging: 'env-select-staging' };
function updateEnvSelectColor() {
  envSelect.classList.remove('env-select-production', 'env-select-staging');
  const cls = ENV_SELECT_CLASS[envSelect.value];
  if (cls) envSelect.classList.add(cls);
}
envSelect.addEventListener('input', updateEnvSelectColor);

// Teams can type any environment name (QA, Dev, DR, ...) instead of being
// locked to Production/Staging/Internal — the datalist just surfaces the
// three defaults plus whatever custom values are already in use, as
// autocomplete suggestions, not a restriction.
function updateEnvironmentSuggestions(apps) {
  const custom = [...new Set(apps.map((a) => a.environment).filter(Boolean))];
  const defaults = ['Production', 'Staging', 'Internal'];
  const all = [...new Set([...defaults, ...custom])];
  environmentOptions.innerHTML = all.map((v) => `<option value="${v}"></option>`).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formStatus.classList.remove('success', 'error');
  formStatus.textContent = 'Adding...';
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    updateEnvSelectColor();
    formStatus.textContent = 'Added.';
    formStatus.classList.add('success');
    await refreshList();
    setTimeout(() => { formStatus.textContent = ''; formStatus.classList.remove('success'); }, 2000);
  } catch (err) {
    formStatus.textContent = 'Error: ' + err.message;
    formStatus.classList.add('error');
  }
});

// ---- Portfolio-level static site export ----

const portfolioExportBtn = document.getElementById('portfolio-export-btn');
const portfolioExportStatus = document.getElementById('portfolio-export-status');

portfolioExportBtn.addEventListener('click', async () => {
  portfolioExportStatus.classList.remove('success', 'error');
  portfolioExportStatus.textContent = 'Exporting…';
  portfolioExportBtn.disabled = true;
  try {
    const res = await fetch('/api/apps/export/portfolio-static-site', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    portfolioExportStatus.textContent = `Exported ${body.exportedCount}/${body.appCount} app(s) to ${body.outDir}`;
    portfolioExportStatus.classList.add('success');
  } catch (err) {
    portfolioExportStatus.textContent = 'Error: ' + err.message;
    portfolioExportStatus.classList.add('error');
  } finally {
    portfolioExportBtn.disabled = false;
  }
});

// ---- Portfolio tech stack view ----

const techStackBtn = document.getElementById('tech-stack-btn');
const techStackPanel = document.getElementById('tech-stack-panel');
const closeTechStackBtn = document.getElementById('close-tech-stack');
const techStackContent = document.getElementById('tech-stack-content');

function techChip(app) {
  const chip = document.createElement('a');
  chip.href = '#';
  chip.className = 'tag-badge tech-app-chip';
  chip.textContent = app.name;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    techStackPanel.hidden = true;
    openDetail(app.id);
  });
  return chip;
}

async function loadTechStack() {
  const data = await fetch('/api/apps/tech-stack').then((r) => r.json());
  techStackContent.innerHTML = '';

  const shared = data.shared.filter((s) => s.apps.length > 1);
  const unique = data.shared.filter((s) => s.apps.length === 1);

  if (shared.length) {
    const heading = document.createElement('p');
    heading.className = 'dashboard-subheading';
    heading.textContent = `Shared across multiple apps (${shared.length}):`;
    techStackContent.appendChild(heading);
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Technology</th><th># Apps</th><th>Apps</th></tr>';
    for (const s of shared) {
      const tr = document.createElement('tr');
      const techTd = document.createElement('td');
      techTd.textContent = s.tech;
      const countTd = document.createElement('td');
      countTd.textContent = String(s.apps.length);
      const appsTd = document.createElement('td');
      for (const a of s.apps) appsTd.appendChild(techChip(a));
      tr.append(techTd, countTd, appsTd);
      table.appendChild(tr);
    }
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.appendChild(table);
    techStackContent.appendChild(scroll);
  } else {
    techStackContent.innerHTML = '<p class="empty-state">No technology is shared by more than one app yet.</p>';
  }

  if (unique.length) {
    const heading = document.createElement('p');
    heading.className = 'dashboard-subheading';
    heading.textContent = 'Used by one app only:';
    techStackContent.appendChild(heading);
    const row = document.createElement('div');
    row.className = 'severity-chip-row';
    for (const s of unique) {
      const chip = document.createElement('span');
      chip.className = 'tag-badge';
      chip.textContent = `${s.tech} (${s.apps[0].name})`;
      row.appendChild(chip);
    }
    techStackContent.appendChild(row);
  }
}

techStackBtn.addEventListener('click', async () => {
  listPanel.hidden = true;
  detailPanel.hidden = true;
  techStackPanel.hidden = false;
  techStackContent.innerHTML = '<p>Loading…</p>';
  await loadTechStack();
});

closeTechStackBtn.addEventListener('click', () => {
  techStackPanel.hidden = true;
  listPanel.hidden = false;
});

// ---- Cross-app issue view ----

const allIssuesBtn = document.getElementById('all-issues-btn');
const crossIssuesPanel = document.getElementById('cross-issues-panel');
const closeCrossIssuesBtn = document.getElementById('close-cross-issues');
const crossIssuesContent = document.getElementById('cross-issues-content');
const crossIssuesSearch = document.getElementById('cross-issues-search');
const crossIssuesSeverity = document.getElementById('cross-issues-severity');
const crossIssuesApp = document.getElementById('cross-issues-app');

let allCrossIssues = [];

function applyCrossIssuesFilters() {
  const search = crossIssuesSearch.value.trim().toLowerCase();
  const severity = crossIssuesSeverity.value;
  const appId = crossIssuesApp.value;
  const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const filtered = allCrossIssues
    .filter((i) => i.triage.state === 'open' || i.triage.state === 'acknowledged')
    .filter((i) => !severity || i.severity === severity)
    .filter((i) => !appId || i.appId === appId)
    .filter((i) => !search || `${i.category} ${i.file} ${i.summary}`.toLowerCase().includes(search))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  renderCrossIssuesTable(filtered);
}

function renderCrossIssuesTable(issues) {
  crossIssuesContent.innerHTML = '';
  if (!issues.length) {
    crossIssuesContent.innerHTML = '<p class="empty-state">No matching issues.</p>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'cross-issues-table fit-container';
  table.innerHTML = '<tr><th>Severity</th><th>App</th><th>Category</th><th>File</th><th>Line</th><th>Summary</th><th>Triage</th></tr>';
  const SUMMARY_TRUNCATE_AT = 65;
  for (const issue of issues) {
    const tr = document.createElement('tr');

    const severityTd = document.createElement('td');
    const severityBadge = document.createElement('span');
    severityBadge.className = 'severity-badge ' + (SEVERITY_BADGE_CLASS[issue.severity] || 'severity-low');
    severityBadge.textContent = issue.severity;
    severityTd.appendChild(severityBadge);
    tr.appendChild(severityTd);

    const appTd = document.createElement('td');
    appTd.className = 'cell-category';
    const appLink = document.createElement('a');
    appLink.href = '#';
    appLink.style.color = 'var(--accent-text)';
    appLink.textContent = issue.appName;
    appLink.title = issue.appName;
    appLink.addEventListener('click', (e) => {
      e.preventDefault();
      crossIssuesPanel.hidden = true;
      openDetail(issue.appId).then(() => loadIssuesInteractive(issue.appId));
    });
    appTd.appendChild(appLink);
    tr.appendChild(appTd);

    const categoryTd = document.createElement('td');
    categoryTd.className = 'cell-category';
    categoryTd.textContent = issue.category;
    categoryTd.title = issue.category;
    tr.appendChild(categoryTd);

    const fileTd = document.createElement('td');
    fileTd.className = 'cell-file';
    fileTd.textContent = issue.file.split('/').pop();
    fileTd.title = issue.file;
    tr.appendChild(fileTd);

    const lineTd = document.createElement('td');
    lineTd.textContent = String(issue.line);
    tr.appendChild(lineTd);

    const summaryTd = document.createElement('td');
    summaryTd.className = 'cell-summary';
    const isLong = issue.summary.length > SUMMARY_TRUNCATE_AT;
    summaryTd.textContent = isLong ? issue.summary.slice(0, SUMMARY_TRUNCATE_AT - 1).trimEnd() + '…' : issue.summary;
    summaryTd.title = issue.summary;
    tr.appendChild(summaryTd);

    const triageTd = document.createElement('td');
    const select = document.createElement('select');
    for (const s of TRIAGE_STATES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === issue.triage.state) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', async () => {
      await fetch(`/api/apps/${issue.appId}/issues/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: issue.fingerprint, state: select.value }),
      });
      await loadAllIssues();
    });
    triageTd.appendChild(select);
    tr.appendChild(triageTd);

    table.appendChild(tr);
  }
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  scroll.appendChild(table);
  crossIssuesContent.appendChild(scroll);
}

async function loadAllIssues() {
  allCrossIssues = await fetch('/api/apps/issues').then((r) => r.json());
  const apps = [...new Map(allCrossIssues.map((i) => [i.appId, i.appName])).entries()];
  const current = crossIssuesApp.value;
  crossIssuesApp.innerHTML = '<option value="">All apps</option>' + apps.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  if (apps.some(([id]) => id === current)) crossIssuesApp.value = current;
  applyCrossIssuesFilters();
}

allIssuesBtn.addEventListener('click', async () => {
  listPanel.hidden = true;
  detailPanel.hidden = true;
  crossIssuesPanel.hidden = false;
  crossIssuesContent.innerHTML = '<p>Loading…</p>';
  await loadAllIssues();
});

closeCrossIssuesBtn.addEventListener('click', () => {
  crossIssuesPanel.hidden = true;
  listPanel.hidden = false;
});

[crossIssuesSearch, crossIssuesSeverity, crossIssuesApp].forEach((el) => el.addEventListener('input', applyCrossIssuesFilters));

// ---- Bulk import ----

const bulkTextarea = document.getElementById('bulk-textarea');
const bulkSubmitBtn = document.getElementById('bulk-submit');
const bulkStatus = document.getElementById('bulk-status');

bulkSubmitBtn.addEventListener('click', async () => {
  const text = bulkTextarea.value;
  if (!text.trim()) return;
  bulkStatus.classList.remove('success', 'error');
  bulkStatus.textContent = 'Importing...';
  bulkSubmitBtn.disabled = true;
  try {
    const res = await fetch('/api/apps/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json();
    if (!res.ok && !body.created) throw new Error(body.error || `Request failed (${res.status})`);
    const parts = [`${body.created.length} app(s) added`];
    if (body.errors.length) parts.push(`${body.errors.length} line(s) failed: ` + body.errors.map((e) => `line ${e.line} (${e.error})`).join('; '));
    bulkStatus.textContent = parts.join(' — ');
    bulkStatus.classList.add(body.errors.length ? 'error' : 'success');
    if (body.created.length) bulkTextarea.value = '';
    await refreshList();
  } catch (err) {
    bulkStatus.textContent = 'Error: ' + err.message;
    bulkStatus.classList.add('error');
  } finally {
    bulkSubmitBtn.disabled = false;
  }
});

// ---- Detail view ----

function fieldRow(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value || '—';
  return [dt, dd];
}

function badgeFieldRow(label, value, badgeClass, baseClass) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (value) {
    const badge = document.createElement('span');
    badge.className = baseClass + ' ' + badgeClass;
    badge.textContent = value;
    dd.appendChild(badge);
  } else {
    dd.textContent = '—';
  }
  return [dt, dd];
}

async function openDetail(id) {
  currentDetailId = id;
  const app = await api(`/${id}`);
  withViewTransition(() => {
    listPanel.hidden = true;
    detailPanel.hidden = false;
    detailName.textContent = app.name;
    detailMeta.innerHTML = '';
    const SCHEDULE_LABELS = { 0: 'Off', 60: 'Hourly', 1440: 'Daily', 10080: 'Weekly' };

    detailMeta.append(...fieldRow('Path / Repo', app.pathOrRepo));
    detailMeta.append(...fieldRow('Purpose', app.purpose));
    detailMeta.append(...fieldRow('Owner / Team', app.owner));
    detailMeta.append(...badgeFieldRow('Environment', app.environment, ENV_BADGE_CLASS[app.environment] || 'env-internal', 'env-badge'));
    detailMeta.append(...fieldRow('Tech Stack', app.techStack));
    detailMeta.append(...fieldRow('Tags', (app.tags || []).join(', ')));
    detailMeta.append(...fieldRow('Notes', app.notes));
    detailMeta.append(...fieldRow('Scan Mode', app.scanMode === 'deep' ? 'Deep (LLM-assisted)' : 'Static (fast, pattern-based)'));

    // Feature 6: the CLI's --fail-on gating threshold, surfaced here as an
    // editable per-app setting instead of CLI-only, with a live pass/fail
    // readout against the latest scan so the setting isn't just inert text.
    const gateDt = document.createElement('dt');
    gateDt.textContent = 'CI Gate Severity';
    const gateDd = document.createElement('dd');
    const gateSelect = document.createElement('select');
    gateSelect.className = 'gate-select';
    for (const s of ['Critical', 'High', 'Medium', 'Low']) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === (app.failOnSeverity || 'Critical')) opt.selected = true;
      gateSelect.appendChild(opt);
    }
    const gateStatus = document.createElement('span');
    gateStatus.className = 'gate-status';
    async function refreshGateStatus() {
      if (app.status !== 'Done') { gateStatus.textContent = ''; return; }
      gateStatus.textContent = 'Checking…';
      gateStatus.className = 'gate-status';
      const issues = await api(`/${id}/issues`);
      const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      const threshold = order[gateSelect.value];
      const active = issues.filter((i) => i.triage.state !== 'false_positive' && i.triage.state !== 'fixed');
      const failing = active.some((i) => order[i.severity] <= threshold);
      gateStatus.textContent = failing ? 'Would FAIL CI' : 'Would PASS CI';
      gateStatus.className = 'gate-status ' + (failing ? 'gate-fail' : 'gate-pass');
    }
    gateSelect.addEventListener('change', async () => {
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ failOnSeverity: gateSelect.value }) });
      refreshGateStatus();
    });
    gateDd.append(gateSelect, document.createTextNode(' '), gateStatus);
    detailMeta.append(gateDt, gateDd);
    refreshGateStatus();

    detailMeta.append(...fieldRow('Auto-rescan', SCHEDULE_LABELS[app.scheduleMinutes] || `Every ${app.scheduleMinutes} min`));
    detailMeta.append(...fieldRow('Notify Webhook', app.notifyWebhookUrl || '—'));

    // Feature 12: weekly digest — a periodic rollup, opt-in and editable
    // per app, distinct from the on-completion webhook notification.
    const digestDt = document.createElement('dt');
    digestDt.textContent = 'Weekly Digest';
    const digestDd = document.createElement('dd');
    const digestLabel = document.createElement('label');
    digestLabel.style.display = 'inline-flex';
    digestLabel.style.alignItems = 'center';
    digestLabel.style.gap = '0.4rem';
    digestLabel.style.marginBottom = '0';
    const digestCheckbox = document.createElement('input');
    digestCheckbox.type = 'checkbox';
    digestCheckbox.checked = !!app.digestEnabled;
    digestCheckbox.disabled = !app.notifyWebhookUrl;
    digestCheckbox.addEventListener('change', async () => {
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ digestEnabled: digestCheckbox.checked }) });
    });
    const digestText = document.createElement('span');
    digestText.textContent = app.notifyWebhookUrl
      ? (app.lastDigestAt ? `Last sent ${new Date(app.lastDigestAt).toLocaleString()}` : 'Not sent yet')
      : 'Requires a Notify Webhook URL';
    digestLabel.append(digestCheckbox, digestText);
    digestDd.appendChild(digestLabel);
    detailMeta.append(digestDt, digestDd);
    detailMeta.append(...badgeFieldRow('Status', app.status, statusClass(app.status), 'status-badge'));
    detailMeta.append(...fieldRow('Wiki Location', app.wikiLink));
    detailMeta.append(...fieldRow('Last Scanned', app.scannedAt ? new Date(app.scannedAt).toLocaleString() : ''));
    if (app.error) detailMeta.append(...fieldRow('Error', app.error));
    wikiView.innerHTML = '';
  });

  if (app.status === 'Done' && app.wikiLink) {
    closeScanStream();
    wikiNav.hidden = false;
    renderWikiNav(id, app);
    await loadWikiPage(id, 'Home.md');
  } else if (app.status === 'Scanning') {
    wikiNav.hidden = true;
    attachScanStream(id);
  } else if (app.status === 'Failed') {
    wikiNav.hidden = true;
    wikiView.textContent = 'Last scan failed. See error above.';
  } else {
    wikiNav.hidden = true;
    wikiView.textContent = 'No wiki yet — run a scan.';
  }
}

function wikiNavGroup(items) {
  const group = document.createElement('div');
  group.className = 'wiki-nav-group';
  for (const [label, handler] of items) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = label;
    btn.addEventListener('click', handler);
    group.appendChild(btn);
  }
  return group;
}

function renderWikiNav(id, app) {
  wikiLinks.innerHTML = '';

  const pages = [
    ['Home', 'Home.md'],
    ['Architecture', 'Architecture.md'],
    ['Data Model', 'Data-Model.md'],
    ['Change Log', 'Change-Log.md'],
    ['Setup', 'Setup.md'],
    ['Progress', 'Progress.md'],
  ].map(([label, p]) => [label, () => loadWikiPage(id, p)]);

  const tools = [
    ['Issues', () => loadIssuesInteractive(id)],
    ['Data Dictionary', () => loadDictionaryInteractive(id)],
    ['Env Vars', () => loadEnvVarsInteractive(id)],
    ['Dependency Graph', () => loadGraphView(id)],
    ['History', () => loadHistory(id)],
  ];

  const actions = [['Export Static Site', () => exportStaticSite(id)]];
  const isRepo = /^https?:\/\/|\.git$/.test(app.pathOrRepo || '');
  if (isRepo) actions.push(['Push to Wiki Repo', () => pushGithubWiki(id)]);

  wikiLinks.append(wikiNavGroup(pages), wikiNavGroup(tools), wikiNavGroup(actions));
}

async function exportStaticSite(id) {
  try {
    wikiView.innerHTML = '<p>Exporting…</p>';
    const result = await api(`/${id}/export/static-site`, { method: 'POST' });
    const html = `<h2>Static Site Exported</h2><p>${result.pageCount} page(s) written to:</p><p><code>${result.outDir}</code></p><p style="color:var(--muted);font-size:0.85rem">Open <code>index.html</code> in that folder directly in a browser — no server needed.</p>`;
    withViewTransition(() => { wikiView.innerHTML = html; });
  } catch (err) {
    wikiView.textContent = 'Export failed: ' + err.message;
  }
}

async function pushGithubWiki(id) {
  if (!confirm('This will push the generated wiki to this repo\'s Wiki (git push to <repo>.wiki.git) using your local git credentials. Continue?')) return;
  try {
    wikiView.innerHTML = '<p>Pushing to wiki repo…</p>';
    const result = await api(`/${id}/export/github-wiki`, { method: 'POST', body: JSON.stringify({}) });
    const html = result.pushed
      ? `<h2>Pushed to Wiki Repo</h2><p>${result.pageCount} page(s) pushed to:</p><p><code>${result.wikiGitUrl}</code></p>`
      : `<h2>Nothing Pushed</h2><p>${result.reason}</p>`;
    withViewTransition(() => { wikiView.innerHTML = html; });
  } catch (err) {
    wikiView.textContent = 'Push failed: ' + err.message;
  }
}

const TRIAGE_STATES = ['open', 'acknowledged', 'false_positive', 'fixed'];
const SEVERITY_BADGE_CLASS = { Critical: 'severity-critical', High: 'severity-high', Medium: 'severity-medium', Low: 'severity-low' };

async function loadIssuesInteractive(id) {
  try {
    const issues = await api(`/${id}/issues`);
    if (!issues.length) {
      withViewTransition(() => { wikiView.innerHTML = '<p>No issues recorded yet — run a scan first.</p>'; });
      return;
    }
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    const table = document.createElement('table');
    table.className = 'issues-table fit-container';
    table.innerHTML = '<tr><th>Severity</th><th>Category</th><th>File</th><th>Line</th><th>Summary</th><th>Triage</th></tr>';
    const SUMMARY_TRUNCATE_AT = 75;
    for (const issue of issues) {
      const tr = document.createElement('tr');
      if (issue.triage.state === 'false_positive' || issue.triage.state === 'fixed') tr.style.opacity = '0.5';

      const severityTd = document.createElement('td');
      const severityBadge = document.createElement('span');
      severityBadge.className = 'severity-badge ' + (SEVERITY_BADGE_CLASS[issue.severity] || 'severity-low');
      severityBadge.textContent = issue.severity;
      severityTd.appendChild(severityBadge);
      tr.appendChild(severityTd);

      const categoryTd = document.createElement('td');
      categoryTd.className = 'cell-category';
      categoryTd.textContent = issue.category;
      categoryTd.title = issue.category;
      tr.appendChild(categoryTd);

      const fileTd = document.createElement('td');
      fileTd.className = 'cell-file';
      fileTd.textContent = issue.file.split('/').pop();
      fileTd.title = issue.file;
      tr.appendChild(fileTd);

      const lineTd = document.createElement('td');
      lineTd.textContent = String(issue.line);
      tr.appendChild(lineTd);

      const summaryTd = document.createElement('td');
      summaryTd.className = 'cell-summary';
      const isLong = issue.summary.length > SUMMARY_TRUNCATE_AT;
      const summarySpan = document.createElement('span');
      summarySpan.textContent = isLong ? issue.summary.slice(0, SUMMARY_TRUNCATE_AT - 1).trimEnd() + '…' : issue.summary;
      summaryTd.appendChild(summarySpan);
      summaryTd.appendChild(document.createTextNode(' '));
      const detailsBtn = document.createElement('button');
      detailsBtn.type = 'button';
      detailsBtn.className = 'link-button details-toggle';
      detailsBtn.textContent = 'Show details';
      summaryTd.appendChild(detailsBtn);
      tr.appendChild(summaryTd);

      const triageTd = document.createElement('td');
      const select = document.createElement('select');
      for (const s of TRIAGE_STATES) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === issue.triage.state) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', async () => {
        await api(`/${id}/issues/triage`, { method: 'POST', body: JSON.stringify({ fingerprint: issue.fingerprint, state: select.value }) });
        loadIssuesInteractive(id);
      });
      triageTd.appendChild(select);
      if (issue.triage.assignee) {
        const chip = document.createElement('div');
        chip.className = 'assignee-chip';
        chip.textContent = issue.triage.assignee;
        chip.title = 'Assigned to ' + issue.triage.assignee;
        triageTd.appendChild(chip);
      }
      tr.appendChild(triageTd);
      table.appendChild(tr);

      const detailTr = document.createElement('tr');
      detailTr.className = 'issue-detail-row';
      detailTr.hidden = true;
      const detailTd = document.createElement('td');
      detailTd.colSpan = 6;
      const dl = document.createElement('dl');
      dl.className = 'issue-detail';
      const addEntry = (term, value) => {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.append(dt, dd);
      };
      addEntry('File', issue.file);
      addEntry('Summary', issue.summary);
      if (issue.suggestedFix) addEntry('Suggested Fix', issue.suggestedFix);
      if (issue.triage.note) addEntry('Triage Note', issue.triage.note);

      const assigneeDt = document.createElement('dt');
      assigneeDt.textContent = 'Assignee';
      const assigneeDd = document.createElement('dd');
      const assigneeInput = document.createElement('input');
      assigneeInput.type = 'text';
      assigneeInput.placeholder = 'Unassigned — add a person or team';
      assigneeInput.value = issue.triage.assignee || '';
      assigneeInput.addEventListener('blur', async () => {
        if (assigneeInput.value === (issue.triage.assignee || '')) return;
        await api(`/${id}/issues/assign`, { method: 'POST', body: JSON.stringify({ fingerprint: issue.fingerprint, assignee: assigneeInput.value.trim() }) });
        loadIssuesInteractive(id);
      });
      assigneeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') assigneeInput.blur(); });
      assigneeDd.appendChild(assigneeInput);
      dl.append(assigneeDt, assigneeDd);

      detailTd.appendChild(dl);
      detailTr.appendChild(detailTd);
      table.appendChild(detailTr);

      detailsBtn.addEventListener('click', () => {
        detailTr.hidden = !detailTr.hidden;
        detailsBtn.textContent = detailTr.hidden ? 'Show details' : 'Hide details';
      });
    }
    withViewTransition(() => {
      wikiView.innerHTML = '<h2>Issues</h2><p>Setting a finding to "false_positive" or "fixed" removes it from the active count and CLI severity gating on the next scan.</p>';
      const scroll = document.createElement('div');
      scroll.className = 'table-scroll';
      scroll.appendChild(table);
      wikiView.appendChild(scroll);
    });
  } catch (err) {
    wikiView.textContent = 'Could not load issues: ' + err.message;
  }
}

async function loadDictionaryInteractive(id) {
  try {
    const models = await api(`/${id}/models`);
    if (!models.length) {
      withViewTransition(() => {
        wikiView.innerHTML = '<h2>Data Dictionary</h2><p>Edit a description and click away (or press Enter) to save. Your edits survive future rescans.</p><p>No data models detected in the latest scan.</p>';
      });
      return;
    }
    withViewTransition(() => {
      wikiView.innerHTML = '<h2>Data Dictionary</h2><p>Edit a description and click away (or press Enter) to save. Your edits survive future rescans.</p>';
      for (const model of models) {
        const section = document.createElement('div');
        section.innerHTML = `<h3>${model.name}</h3><p style="color:var(--muted);font-size:0.85rem">${model.source} — <code>${model.file}</code></p>`;
        const table = document.createElement('table');
        table.innerHTML = '<tr><th>Field</th><th>Type</th><th>Description</th></tr>';
        for (const f of model.fields) {
          const tr = document.createElement('tr');
          const nameTd = document.createElement('td');
          nameTd.textContent = f.name;
          const typeTd = document.createElement('td');
          typeTd.textContent = f.type;
          const descTd = document.createElement('td');
          const input = document.createElement('input');
          input.type = 'text';
          input.value = f.override || (f.description || '').replace('(auto-detected — add description)', '');
          input.placeholder = 'Add a description...';
          const editedBadge = document.createElement('span');
          editedBadge.className = 'override-badge';
          editedBadge.textContent = 'Edited';
          editedBadge.hidden = !f.override;
          const save = async () => {
            await api(`/${id}/models/override`, { method: 'POST', body: JSON.stringify({ modelName: model.name, fieldName: f.name, description: input.value }) });
            editedBadge.hidden = !input.value;
          };
          input.addEventListener('blur', save);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
          descTd.append(input, editedBadge);
          tr.append(nameTd, typeTd, descTd);
          table.appendChild(tr);
        }
        const scroll = document.createElement('div');
        scroll.className = 'table-scroll';
        scroll.appendChild(table);
        section.appendChild(scroll);
        wikiView.appendChild(section);
      }
    });
  } catch (err) {
    wikiView.textContent = 'Could not load data dictionary: ' + err.message;
  }
}

// Feature 13: same edit-and-save-on-blur pattern as the Data Dictionary,
// applied to the env vars the scanner found referenced in code (Setup.md
// only ever listed the bare names — this lets a user annotate what each
// one is actually for, surviving future rescans).
async function loadEnvVarsInteractive(id) {
  try {
    const vars = await api(`/${id}/env-vars`);
    if (!vars.length) {
      withViewTransition(() => {
        wikiView.innerHTML = '<h2>Environment Variables</h2><p>Edit a description and click away (or press Enter) to save. Your edits survive future rescans.</p><p>No environment variables detected in the latest scan.</p>';
      });
      return;
    }
    withViewTransition(() => {
      wikiView.innerHTML = '<h2>Environment Variables</h2><p>Edit a description and click away (or press Enter) to save. Your edits survive future rescans. Values are never shown here — populate them from your own secrets store.</p>';
      const table = document.createElement('table');
      table.innerHTML = '<tr><th>Variable</th><th>Description</th></tr>';
      for (const v of vars) {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = v.name;
        nameTd.appendChild(code);
        const descTd = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = v.description || '';
        input.placeholder = 'What is this used for?';
        const editedBadge = document.createElement('span');
        editedBadge.className = 'override-badge';
        editedBadge.textContent = 'Edited';
        editedBadge.hidden = !v.description;
        const save = async () => {
          await api(`/${id}/env-vars/override`, { method: 'POST', body: JSON.stringify({ name: v.name, description: input.value }) });
          editedBadge.hidden = !input.value;
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        descTd.append(input, editedBadge);
        tr.append(nameTd, descTd);
        table.appendChild(tr);
      }
      const scroll = document.createElement('div');
      scroll.className = 'table-scroll';
      scroll.appendChild(table);
      wikiView.appendChild(scroll);
    });
  } catch (err) {
    wikiView.textContent = 'Could not load environment variables: ' + err.message;
  }
}

// Hand-rolled SVG dependency graph — no charting library, just a circular
// layout (simplest thing that stays legible without a physics engine) with
// click-to-highlight for a node's direct edges.
// Feature 14: export the dependency graph for sharing outside the app
// (docs, tickets). The live SVG uses CSS custom properties (var(--border)
// etc.) for theming, which don't resolve once the markup leaves this page,
// so the exported copy has those inlined to their current resolved value
// first — otherwise every stroke/fill would render as black/default in
// whatever viewer opens the file.
function resolveCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function exportableSvgClone(svgEl, bgVarName) {
  const clone = svgEl.cloneNode(true);
  const varPattern = /var\((--[a-z0-9-]+)\)/gi;
  const inlineColors = (el) => {
    for (const attr of ['stroke', 'fill']) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (val && val.indexOf('var(') !== -1) {
        el.setAttribute(attr, val.replace(varPattern, (m, name) => resolveCssVar(name) || m));
      }
    }
    for (const child of Array.from(el.children || [])) inlineColors(child);
  };
  inlineColors(clone);
  clone.removeAttribute('style');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', resolveCssVar(bgVarName));
  clone.insertBefore(bg, clone.firstChild);
  return clone;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadGraphSvg(svgEl, filenameBase) {
  const clone = exportableSvgClone(svgEl, '--panel');
  const xml = new XMLSerializer().serializeToString(clone);
  downloadBlob(new Blob([xml], { type: 'image/svg+xml' }), `${filenameBase}.svg`);
}

function downloadGraphPng(svgEl, filenameBase, sizePx) {
  const clone = exportableSvgClone(svgEl, '--panel');
  clone.setAttribute('width', String(sizePx));
  clone.setAttribute('height', String(sizePx));
  const xml = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const scale = 2; // export at 2x for crisper text than the on-screen size
    const canvas = document.createElement('canvas');
    canvas.width = sizePx * scale;
    canvas.height = sizePx * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      downloadBlob(blob, `${filenameBase}.png`);
      URL.revokeObjectURL(svgUrl);
    }, 'image/png');
  };
  img.src = svgUrl;
}

async function loadGraphView(id) {
  try {
    const g = await api(`/${id}/graph`);
    if (!g.nodes.length) {
      withViewTransition(() => {
        wikiView.innerHTML = '<h2>Dependency Graph</h2><p>No import graph recorded yet — run a scan first.</p>';
      });
      return;
    }

    const size = Math.max(500, Math.min(900, 140 + g.nodes.length * 22));
    const radius = size / 2 - 70;
    const cx = size / 2, cy = size / 2;
    const positions = {};
    g.nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / g.nodes.length - Math.PI / 2;
      positions[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', '100%');
    svg.style.maxWidth = `${size}px`;
    svg.style.display = 'block';

    const edgeLines = [];
    for (const e of g.edges) {
      const a = positions[e.from], b = positions[e.to];
      if (!a || !b) continue;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('stroke', 'var(--border)');
      line.setAttribute('stroke-width', '1');
      line.dataset.from = e.from;
      line.dataset.to = e.to;
      svg.appendChild(line);
      edgeLines.push(line);
    }

    const nodeEls = {};
    for (const n of g.nodes) {
      const p = positions[n.id];
      const gEl = document.createElementNS(svgNS, 'g');
      gEl.style.cursor = 'pointer';
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', p.x);
      circle.setAttribute('cy', p.y);
      circle.setAttribute('r', 5 + Math.min(6, n.functions + n.classes));
      circle.setAttribute('fill', 'var(--accent-surface)');
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${n.id} (${n.functions} function(s), ${n.classes} class(es))`;
      circle.appendChild(title);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', p.x + (p.x > cx ? 8 : -8));
      label.setAttribute('y', p.y + 3);
      label.setAttribute('font-size', '9');
      label.setAttribute('fill', 'var(--muted)');
      label.setAttribute('text-anchor', p.x > cx ? 'start' : 'end');
      label.textContent = n.id.split('/').pop();
      gEl.append(circle, label);
      gEl.addEventListener('click', () => {
        const isActive = gEl.dataset.active === '1';
        for (const el of Object.values(nodeEls)) el.dataset.active = '0';
        for (const line of edgeLines) line.setAttribute('stroke', 'var(--border)');
        if (!isActive) {
          gEl.dataset.active = '1';
          for (const line of edgeLines) {
            if (line.dataset.from === n.id || line.dataset.to === n.id) line.setAttribute('stroke', 'var(--accent-text)');
          }
        }
      });
      svg.appendChild(gEl);
      nodeEls[n.id] = gEl;
    }

    const appMeta = allApps.find((a) => a.id === id);
    const filenameBase = (appMeta ? appMeta.name : 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-dependency-graph';

    withViewTransition(() => {
      wikiView.innerHTML = `<h2>Dependency Graph</h2><p style="color:var(--muted);font-size:0.85rem">${g.nodes.length} file(s), ${g.edges.length} resolved import edge(s). Click a node to highlight its direct connections.</p>`;
      const actions = document.createElement('div');
      actions.className = 'graph-export-actions';
      const svgBtn = document.createElement('button');
      svgBtn.type = 'button';
      svgBtn.className = 'secondary';
      svgBtn.textContent = 'Download SVG';
      svgBtn.addEventListener('click', () => downloadGraphSvg(svg, filenameBase));
      const pngBtn = document.createElement('button');
      pngBtn.type = 'button';
      pngBtn.className = 'secondary';
      pngBtn.textContent = 'Download PNG';
      pngBtn.addEventListener('click', () => downloadGraphPng(svg, filenameBase, size));
      actions.append(svgBtn, pngBtn);
      wikiView.appendChild(actions);
      wikiView.appendChild(svg);
    });
  } catch (err) {
    wikiView.textContent = 'Could not load graph: ' + err.message;
  }
}

// Hand-rolled SVG line chart (same "no charting library" approach as the
// dependency graph view) plotting issue/route counts across scans so
// growth is visible at a glance instead of only as raw table rows.
function renderHistoryChart(snapshotsAsc) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const width = 640, height = 200, padL = 30, padR = 12, padT = 14, padB = 24;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const n = snapshotsAsc.length;
  const maxVal = Math.max(1, ...snapshotsAsc.map((s) => Math.max(s.stats.issues, s.stats.routes)));
  const x = (i) => (n === 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1));
  const y = (v) => padT + innerH - (innerH * v) / maxVal;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.style.maxWidth = `${width}px`;
  svg.style.display = 'block';

  const axis = document.createElementNS(svgNS, 'path');
  axis.setAttribute('d', `M ${padL} ${padT} V ${padT + innerH} H ${padL + innerW}`);
  axis.setAttribute('fill', 'none');
  axis.setAttribute('stroke', 'var(--border)');
  svg.appendChild(axis);

  function drawSeries(key, color) {
    const points = snapshotsAsc.map((s, i) => `${x(i)},${y(s.stats[key])}`).join(' ');
    const poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '2');
    svg.appendChild(poly);
    snapshotsAsc.forEach((s, i) => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', x(i));
      c.setAttribute('cy', y(s.stats[key]));
      c.setAttribute('r', 3);
      c.setAttribute('fill', color);
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${new Date(s.scannedAt).toLocaleDateString()}: ${s.stats[key]} ${key}`;
      c.appendChild(title);
      svg.appendChild(c);
    });
  }
  drawSeries('routes', 'var(--info)');
  drawSeries('issues', 'var(--err)');

  const labelStyle = (el, anchor) => {
    el.setAttribute('font-size', '9');
    el.setAttribute('fill', 'var(--muted)');
    if (anchor) el.setAttribute('text-anchor', anchor);
  };
  const maxLabel = document.createElementNS(svgNS, 'text');
  maxLabel.setAttribute('x', 2); maxLabel.setAttribute('y', padT + 4);
  labelStyle(maxLabel); maxLabel.textContent = String(maxVal);
  svg.appendChild(maxLabel);
  const zeroLabel = document.createElementNS(svgNS, 'text');
  zeroLabel.setAttribute('x', 2); zeroLabel.setAttribute('y', padT + innerH);
  labelStyle(zeroLabel); zeroLabel.textContent = '0';
  svg.appendChild(zeroLabel);
  const firstLabel = document.createElementNS(svgNS, 'text');
  firstLabel.setAttribute('x', padL); firstLabel.setAttribute('y', height - 6);
  labelStyle(firstLabel); firstLabel.textContent = new Date(snapshotsAsc[0].scannedAt).toLocaleDateString();
  svg.appendChild(firstLabel);
  const lastLabel = document.createElementNS(svgNS, 'text');
  lastLabel.setAttribute('x', padL + innerW); lastLabel.setAttribute('y', height - 6);
  labelStyle(lastLabel, 'end'); lastLabel.textContent = new Date(snapshotsAsc[n - 1].scannedAt).toLocaleDateString();
  svg.appendChild(lastLabel);

  return svg;
}

// Feature 10: renders the result of diffing any two picked scans, capping
// long lists (CodeAtlas alone can have 1000+ issues) so a big diff doesn't
// stall the page.
function renderDiffSection(container, title, items, formatter) {
  const h = document.createElement('h4');
  h.textContent = `${title} (${items.length})`;
  container.appendChild(h);
  if (!items.length) return;
  const ul = document.createElement('ul');
  const CAP = 50;
  for (const item of items.slice(0, CAP)) {
    const li = document.createElement('li');
    li.textContent = formatter(item);
    ul.appendChild(li);
  }
  if (items.length > CAP) {
    const li = document.createElement('li');
    li.style.color = 'var(--muted)';
    li.textContent = `...and ${items.length - CAP} more.`;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

function renderDiffResult(container, response) {
  const { from, to, diff } = response;
  container.innerHTML = '';
  const summary = document.createElement('p');
  summary.style.color = 'var(--muted)';
  summary.style.fontSize = '0.85rem';
  summary.textContent = `Comparing ${new Date(from).toLocaleString()} → ${new Date(to).toLocaleString()}`;
  container.appendChild(summary);

  renderDiffSection(container, 'New issues', diff.newIssues, (i) => `[${i.severity}] ${i.category} — ${i.file}:${i.line} — ${i.summary}`);
  renderDiffSection(container, 'Resolved issues', diff.resolvedIssues, (i) => `[${i.severity}] ${i.category} — ${i.file}:${i.line} — ${i.summary}`);
  renderDiffSection(container, 'New routes', diff.newRoutes, (r) => `+ ${r.method} ${r.path} (${r.file})`);
  renderDiffSection(container, 'Removed routes', diff.removedRoutes, (r) => `− ${r.method} ${r.path} (${r.file})`);
  renderDiffSection(container, 'Added models', diff.addedModels, (m) => `+ ${m.name}`);
  renderDiffSection(container, 'Removed models', diff.removedModels, (m) => `− ${m.name}`);
}

function buildDiffPicker(id, snapshotsNewestFirst) {
  const wrap = document.createElement('div');
  wrap.className = 'diff-picker';

  const optionsHtml = snapshotsNewestFirst
    .map((s) => `<option value="${s.scannedAt}">${new Date(s.scannedAt).toLocaleString()}</option>`)
    .join('');

  const fromLabel = document.createElement('label');
  fromLabel.textContent = 'From ';
  const fromSelect = document.createElement('select');
  fromSelect.innerHTML = optionsHtml;
  fromSelect.value = snapshotsNewestFirst[snapshotsNewestFirst.length - 1].scannedAt; // oldest
  fromLabel.appendChild(fromSelect);

  const toLabel = document.createElement('label');
  toLabel.textContent = 'To ';
  const toSelect = document.createElement('select');
  toSelect.innerHTML = optionsHtml;
  toSelect.value = snapshotsNewestFirst[0].scannedAt; // newest
  toLabel.appendChild(toSelect);

  const compareBtn = document.createElement('button');
  compareBtn.type = 'button';
  compareBtn.textContent = 'Compare';

  const resultDiv = document.createElement('div');
  resultDiv.className = 'diff-result';

  compareBtn.addEventListener('click', async () => {
    resultDiv.innerHTML = '<p>Loading…</p>';
    try {
      const res = await api(`/${id}/history/diff?from=${encodeURIComponent(fromSelect.value)}&to=${encodeURIComponent(toSelect.value)}`);
      renderDiffResult(resultDiv, res);
    } catch (err) {
      resultDiv.textContent = 'Could not load diff: ' + err.message;
    }
  });

  const row = document.createElement('div');
  row.className = 'diff-picker-row';
  row.append(fromLabel, toLabel, compareBtn);
  wrap.append(row, resultDiv);
  return wrap;
}

async function loadHistory(id) {
  try {
    const snapshots = await api(`/${id}/history`); // newest-first
    if (!snapshots.length) {
      withViewTransition(() => { wikiView.innerHTML = '<p>No scan history recorded yet.</p>'; });
      return;
    }
    const rows = snapshots.map((s) => {
      const issuesCell = s.stats.issues > 0
        ? `<td class="history-issues-flag">${s.stats.issues}</td>`
        : `<td>${s.stats.issues}</td>`;
      return `<tr><td>${new Date(s.scannedAt).toLocaleString()}</td><td>${s.stats.units}</td><td>${s.stats.models}</td><td>${s.stats.routes}</td>${issuesCell}</tr>`;
    }).join('');
    withViewTransition(() => {
      wikiView.innerHTML = '<h2>Scan History</h2>';
      if (snapshots.length > 1) {
        const legend = document.createElement('div');
        legend.className = 'chart-legend';
        legend.innerHTML = '<span><i style="background:var(--err)"></i>Issues</span><span><i style="background:var(--info)"></i>Routes</span>';
        wikiView.appendChild(legend);
        wikiView.appendChild(renderHistoryChart([...snapshots].reverse()));
      }
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-scroll';
      tableWrap.innerHTML = `<table><tr><th>Scanned At</th><th>Units</th><th>Models</th><th>Routes</th><th>Issues</th></tr>${rows}</table>`;
      wikiView.appendChild(tableWrap);
      if (snapshots.length > 1) {
        const heading = document.createElement('h3');
        heading.textContent = 'Compare Any Two Scans';
        wikiView.appendChild(heading);
        wikiView.appendChild(buildDiffPicker(id, snapshots));
      }
    });
  } catch (err) {
    wikiView.textContent = 'Could not load history: ' + err.message;
  }
}

// Shortens any table column headed "File" down to just the filename,
// keeping the full path reachable via a hover title — used on wiki pages
// (e.g. Data-Model.md) whose tables list full repo-relative paths that
// would otherwise force horizontal scrolling.
function truncateFileColumns(container) {
  for (const table of container.querySelectorAll('table')) {
    const headerRow = table.querySelector('tr');
    if (!headerRow) continue;
    const headers = Array.from(headerRow.children).map((th) => th.textContent.trim());
    const fileIdx = headers.indexOf('File');
    if (fileIdx === -1) continue;
    // Switch this table to a fixed layout that fits its container instead of
    // growing to fit content — the File column is capped, other columns
    // share the rest, so the table never forces horizontal scrolling.
    table.classList.add('fit-container');
    headerRow.children[fileIdx].style.width = '22%';
    const rows = Array.from(table.querySelectorAll('tr')).slice(1);
    for (const row of rows) {
      const cell = row.children[fileIdx];
      if (!cell) continue;
      cell.classList.add('cell-file');
      const target = cell.querySelector('code') || cell;
      const full = target.textContent;
      if (!full.includes('/')) continue;
      target.textContent = full.slice(full.lastIndexOf('/') + 1);
      cell.title = full;
    }
  }
}

async function loadWikiPage(id, wikiPath) {
  try {
    const { path: resolvedPath, content } = await api(`/${id}/wiki-file?path=${encodeURIComponent(wikiPath)}`);
    currentWikiDir = resolvedPath.includes('/') ? resolvedPath.slice(0, resolvedPath.lastIndexOf('/')) : '';
    const html = renderMarkdown(content, currentWikiDir, id);
    withViewTransition(() => {
      wikiView.innerHTML = html;
      if (wikiPath === 'Data-Model.md') truncateFileColumns(wikiView);
    });
  } catch (err) {
    wikiView.textContent = 'Could not load page: ' + err.message;
  }
}

function escapeHtmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightQuery(snippet, query) {
  const escaped = escapeHtmlText(snippet);
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

async function runWikiSearch(id, query) {
  try {
    const results = await api(`/${id}/wiki-search?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      withViewTransition(() => {
        wikiView.innerHTML = `<h2>Search: "${escapeHtmlText(query)}"</h2><p>No matches found.</p>`;
      });
      return;
    }
    withViewTransition(() => {
      wikiView.innerHTML = `<h2>Search: "${escapeHtmlText(query)}"</h2>`;
      for (const r of results) {
        const div = document.createElement('div');
        div.className = 'search-result';
        const fileLink = document.createElement('div');
        fileLink.className = 'search-result-file';
        fileLink.textContent = `${r.file} (${r.totalMatches} match${r.totalMatches === 1 ? '' : 'es'})`;
        fileLink.addEventListener('click', () => loadWikiPage(id, r.file));
        div.appendChild(fileLink);
        for (const m of r.matches) {
          const p = document.createElement('p');
          p.className = 'search-snippet';
          p.innerHTML = `L${m.line}: ${highlightQuery(m.snippet, query)}`;
          div.appendChild(p);
        }
        wikiView.appendChild(div);
      }
    });
  } catch (err) {
    wikiView.textContent = 'Search failed: ' + err.message;
  }
}

wikiSearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentDetailId) return;
  const q = wikiSearchInput.value.trim();
  if (q) runWikiSearch(currentDetailId, q);
});

closeDetailBtn.addEventListener('click', () => {
  closeScanStream();
  withViewTransition(() => {
    detailPanel.hidden = true;
    listPanel.hidden = false;
  });
  currentDetailId = null;
});

// ---- Minimal markdown renderer ----

function resolveRelative(baseDir, relPath) {
  if (relPath.startsWith('/')) return relPath.slice(1);
  const baseParts = baseDir ? baseDir.split('/') : [];
  const relParts = relPath.split('/');
  for (const part of relParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(text, baseDir, appId) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, target) => {
    if (/^https?:\/\//.test(target)) return `<a href="${target}" target="_blank" rel="noopener">${label}</a>`;
    if (target.endsWith('.md')) {
      const resolved = resolveRelative(baseDir, target);
      return `<a data-wiki-path="${resolved}">${label}</a>`;
    }
    return label;
  });
  return out;
}

function renderMarkdown(md, baseDir, appId) {
  const lines = md.split('\n');
  const html = [];
  let inTable = false;
  let inCode = false;
  let listOpen = false;

  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (line.startsWith('```')) {
      inCode = !inCode;
      html.push(inCode ? '<pre><code>' : '</code></pre>');
      continue;
    }
    if (inCode) { html.push(escapeHtml(line)); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
      if (!inTable) { html.push('<div class="table-scroll">', '<table>'); inTable = true; }
      const tag = html[html.length - 1] === '<table>' ? 'th' : 'td';
      html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir, appId)}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      html.push('</table>', '</div>');
      inTable = false;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${inlineFormat(h[2], baseDir, appId)}</h${level}>`);
      continue;
    }

    if (/^-\s+/.test(line)) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir, appId)}</li>`);
      continue;
    }
    closeList();

    if (line.trim() === '---') { html.push('<hr>'); continue; }
    if (line.trim() === '') { html.push(''); continue; }

    html.push(`<p>${inlineFormat(line, baseDir, appId)}</p>`);
  }
  closeList();
  if (inTable) html.push('</table>', '</div>');

  return html.join('\n');
}

wikiView.addEventListener('click', (e) => {
  const link = e.target.closest('[data-wiki-path]');
  if (link && currentDetailId) {
    e.preventDefault();
    loadWikiPage(currentDetailId, link.dataset.wikiPath);
  }
});

// ---- Polling for in-progress scans ----

let lastKnownStatus = {};

setInterval(async () => {
  const apps = await refreshList().catch(() => []);
  for (const app of apps) {
    const prev = lastKnownStatus[app.id];
    if (app.id === currentDetailId && prev === 'Scanning' && app.status !== 'Scanning') {
      openDetail(app.id);
    }
    lastKnownStatus[app.id] = app.status;
  }
}, 3000);

refreshList();
