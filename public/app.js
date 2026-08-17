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
const trackerForm = document.getElementById('tracker-form');
const trackerFormStatus = document.getElementById('tracker-form-status');

let currentDetailId = null;
let currentDetailApp = null;
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

// Feature 16: rough pre-scan cost estimate for the Deep scan checkbox —
// re-checked whenever the checkbox or path changes, so the warning isn't
// just a generic "uses your Claude usage" with no number behind it.
const deepScanCheckbox = document.getElementById('deep-scan-checkbox');
const deepScanEstimate = document.getElementById('deep-scan-estimate');

async function updateDeepScanEstimate() {
  if (!deepScanCheckbox.checked) { deepScanEstimate.textContent = ''; return; }
  const targetPath = pathInput.value.trim();
  if (!targetPath || /^https?:\/\/|\.git$/.test(targetPath)) {
    deepScanEstimate.textContent = 'Deep scan makes one Claude CLI call per scan, typically well under a minute. (Cost estimate unavailable for a repo URL until it is cloned — try a local path instead.)';
    return;
  }
  deepScanEstimate.textContent = 'Estimating…';
  try {
    const res = await fetch(`/api/browse/estimate?path=${encodeURIComponent(targetPath)}`);
    const body = await res.json();
    if (!res.ok) { deepScanEstimate.textContent = body.error || 'Could not estimate.'; return; }
    deepScanEstimate.textContent = `Deep scan estimate: ${body.fileCount} source file(s), ~${body.totalKB}KB → roughly ${body.estTokens} enrichment prompt token(s), ${body.estSecondsMin}-${body.estSecondsMax}s for the single Claude call (rough, based on codebase size).`;
  } catch {
    deepScanEstimate.textContent = '';
  }
}

deepScanCheckbox.addEventListener('change', updateDeepScanEstimate);
pathInput.addEventListener('blur', updateDeepScanEstimate);

// ---- Auth (basic RBAC: viewer < editor < admin) ----
// Gates three actions: Data Dictionary edits (editor+), CI Gate Severity
// changes (admin), and triggering/enabling a Deep scan (admin). Everything
// else in the app stays readable without logging in — see src/store/users.js
// for why this is intentionally minimal.

const authWidget = document.getElementById('auth-widget');
const loginModal = document.getElementById('login-modal');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const loginCancelBtn = document.getElementById('login-cancel');
const usersDetails = document.getElementById('users-details');
const failOnSeveritySelectEl = document.querySelector('#app-form select[name="failOnSeverity"]');

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };
let currentUser = { username: null, role: 'viewer' };

function hasRole(minRole) {
  return ROLE_RANK[currentUser.role] >= ROLE_RANK[minRole];
}

// Disables/greys out the gated controls that are static (created once at
// page load) based on the current role. Controls rebuilt per-render (the
// detail panel's gate select, Data Dictionary inputs) check hasRole()
// directly at build time instead — see openDetail and loadDictionaryInteractive.
function applyRoleGating() {
  const isAdmin = hasRole('admin');
  deepScanCheckbox.disabled = !isAdmin;
  deepScanCheckbox.title = isAdmin ? '' : 'Requires the "admin" role — log in as an admin to enable Deep scan.';
  if (!isAdmin && deepScanCheckbox.checked) {
    deepScanCheckbox.checked = false;
    updateDeepScanEstimate();
  }
  if (failOnSeveritySelectEl) {
    failOnSeveritySelectEl.disabled = !isAdmin;
    failOnSeveritySelectEl.title = isAdmin ? '' : 'Requires the "admin" role to set anything other than the default (Critical).';
    if (!isAdmin) failOnSeveritySelectEl.value = 'Critical';
  }
  applyFilters(); // re-render the app table so per-row Deep-scan gating (scanBtn) picks up the new role
}

function openLoginModal() {
  loginStatus.textContent = '';
  loginStatus.classList.remove('success', 'error');
  loginForm.reset();
  loginModal.hidden = false;
}
function closeLoginModal() { loginModal.hidden = true; }

function renderAuthWidget() {
  authWidget.innerHTML = '';
  if (currentUser.username) {
    const label = document.createElement('span');
    label.innerHTML = `${currentUser.username} <span class="auth-role">(${currentUser.role})</span>`;
    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'secondary';
    logoutBtn.textContent = 'Log Out';
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      currentUser = { username: null, role: 'viewer' };
      renderAuthWidget();
      applyRoleGating();
    });
    authWidget.append(label, logoutBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'secondary';
    loginBtn.textContent = 'Log In';
    loginBtn.addEventListener('click', openLoginModal);
    authWidget.appendChild(loginBtn);
  }
  usersDetails.hidden = !hasRole('admin');
}

async function loadAuthState() {
  currentUser = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({ username: null, role: 'viewer' }));
  renderAuthWidget();
  applyRoleGating();
}

loginCancelBtn.addEventListener('click', closeLoginModal);
loginModal.addEventListener('click', (e) => { if (e.target === loginModal) closeLoginModal(); });

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(loginForm);
  loginStatus.classList.remove('success', 'error');
  loginStatus.textContent = 'Logging in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    currentUser = body;
    closeLoginModal();
    renderAuthWidget();
    applyRoleGating();
  } catch (err) {
    loginStatus.textContent = 'Error: ' + err.message;
    loginStatus.classList.add('error');
  }
});

// ---- Manage users (admin only) ----

const usersTable = document.getElementById('users-table');
const userNewUsername = document.getElementById('user-new-username');
const userNewPassword = document.getElementById('user-new-password');
const userNewRole = document.getElementById('user-new-role');
const userAddBtn = document.getElementById('user-add-btn');
const userManageStatus = document.getElementById('user-manage-status');

function renderUsers(list) {
  usersTable.innerHTML = '<tr><th>Username</th><th>Role</th><th></th></tr>';
  for (const u of list) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = u.username;

    const roleTd = document.createElement('td');
    const roleSelect = document.createElement('select');
    for (const r of ['viewer', 'editor', 'admin']) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if (r === u.role) opt.selected = true;
      roleSelect.appendChild(opt);
    }
    roleSelect.addEventListener('change', async () => {
      await fetch(`/api/auth/users/${encodeURIComponent(u.username)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleSelect.value }),
      });
      if (u.username === currentUser.username) {
        currentUser = { ...currentUser, role: roleSelect.value };
        renderAuthWidget();
        applyRoleGating();
      }
    });
    roleTd.appendChild(roleSelect);

    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
      if (res.ok) {
        loadUsers();
      } else {
        const body = await res.json().catch(() => ({}));
        userManageStatus.textContent = 'Error: ' + (body.error || 'Could not remove user');
        userManageStatus.classList.add('error');
      }
    });
    actionTd.appendChild(removeBtn);

    tr.append(nameTd, roleTd, actionTd);
    usersTable.appendChild(tr);
  }
}

async function loadUsers() {
  if (!hasRole('admin')) return;
  const list = await fetch('/api/auth/users').then((r) => r.json()).catch(() => []);
  renderUsers(list);
}

userAddBtn.addEventListener('click', async () => {
  const username = userNewUsername.value.trim();
  const password = userNewPassword.value;
  const role = userNewRole.value;
  userManageStatus.classList.remove('success', 'error');
  try {
    const res = await fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    userNewUsername.value = '';
    userNewPassword.value = '';
    userManageStatus.textContent = `Added "${username}".`;
    userManageStatus.classList.add('success');
    loadUsers();
  } catch (err) {
    userManageStatus.textContent = 'Error: ' + err.message;
    userManageStatus.classList.add('error');
  }
});

usersDetails.addEventListener('toggle', () => { if (usersDetails.open) loadUsers(); });

loadAuthState();

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
  // RBAC: a Deep-mode app burns real Claude usage on every run — only an
  // admin can fire it, so a non-admin sees the button disabled up front
  // instead of clicking it and hitting a 403.
  const deepGated = app.scanMode === 'deep' && !hasRole('admin');
  refs.scanBtn.disabled = app.status === 'Scanning' || app.status === 'Queued' || deepGated;
  refs.scanBtn.title = deepGated ? 'This app is set to Deep scan — requires the "admin" role to trigger.' : '';

  // Feature 17: archived apps stay in the list (when "Show archived" is
  // on) but read as retired, not active — dimmed row, no flashing badge.
  refs.tr.classList.toggle('row-archived', !!app.archived);

  if (statusChanged && !app.archived) {
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
const filterShowArchived = document.getElementById('filter-show-archived');

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
filterShowArchived.addEventListener('change', refreshList);

async function refreshList() {
  const apps = await api(filterShowArchived.checked ? '?includeArchived=true' : '');
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

  // Feature 20: scan queue visibility — only shown while something's
  // actually running/waiting, so it doesn't clutter the dashboard at rest.
  const q = await fetch('/api/apps/scan-queue').then((r) => r.json()).catch(() => null);
  if (q && (q.active > 0 || q.queued.length > 0)) {
    const queueNote = document.createElement('p');
    queueNote.className = 'scan-queue-note';
    const parts = [`${q.active}/${q.maxConcurrent} scan slot(s) active`];
    if (q.queued.length) parts.push(`${q.queued.length} queued: ${q.queued.map((a) => `${a.name} (#${a.position})`).join(', ')}`);
    queueNote.textContent = parts.join(' — ');
    dashboardContent.appendChild(queueNote);
  }

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
    deepScanEstimate.textContent = '';
    formStatus.textContent = 'Added.';
    formStatus.classList.add('success');
    await refreshList();
    setTimeout(() => { formStatus.textContent = ''; formStatus.classList.remove('success'); }, 2000);
  } catch (err) {
    formStatus.textContent = 'Error: ' + err.message;
    formStatus.classList.add('error');
  }
});

// ---- Compare two apps ----

const compareAppsBtn = document.getElementById('compare-apps-btn');
const comparePanel = document.getElementById('compare-panel');
const closeCompareBtn = document.getElementById('close-compare');
const compareContent = document.getElementById('compare-content');
const compareAppA = document.getElementById('compare-app-a');
const compareAppB = document.getElementById('compare-app-b');
const compareRunBtn = document.getElementById('compare-run-btn');

function compareRow(label, valA, valB, differs) {
  const tr = document.createElement('tr');
  const labelTd = document.createElement('td');
  labelTd.textContent = label;
  labelTd.style.color = 'var(--muted)';
  const aTd = document.createElement('td');
  aTd.textContent = valA;
  const bTd = document.createElement('td');
  bTd.textContent = valB;
  if (differs) { aTd.className = bTd.className = 'compare-diff'; }
  tr.append(labelTd, aTd, bTd);
  return tr;
}

async function runCompare() {
  const idA = compareAppA.value;
  const idB = compareAppB.value;
  if (!idA || !idB || idA === idB) {
    compareContent.innerHTML = '<p class="empty-state">Pick two different apps.</p>';
    return;
  }
  compareContent.innerHTML = '<p>Loading…</p>';
  try {
    const { a, b } = await fetch(`/api/apps/compare?a=${idA}&b=${idB}`).then((r) => r.json());
    const table = document.createElement('table');
    const head = document.createElement('tr');
    head.innerHTML = `<th></th><th>${a.name}</th><th>${b.name}</th>`;
    table.appendChild(head);
    table.appendChild(compareRow('Environment', a.environment || '—', b.environment || '—', a.environment !== b.environment));
    table.appendChild(compareRow('Owner / Team', a.owner || '—', b.owner || '—', a.owner !== b.owner));
    table.appendChild(compareRow('Status', a.status, b.status, a.status !== b.status));
    table.appendChild(compareRow('Last Scanned', a.scannedAt ? new Date(a.scannedAt).toLocaleString() : '—', b.scannedAt ? new Date(b.scannedAt).toLocaleString() : '—', false));
    const sA = a.stats || {}, sB = b.stats || {};
    table.appendChild(compareRow('Units', sA.units ?? '—', sB.units ?? '—', sA.units !== sB.units));
    table.appendChild(compareRow('Models', sA.models ?? '—', sB.models ?? '—', sA.models !== sB.models));
    table.appendChild(compareRow('Routes', sA.routes ?? '—', sB.routes ?? '—', sA.routes !== sB.routes));
    table.appendChild(compareRow('Active Issues', sA.issues ?? '—', sB.issues ?? '—', sA.issues !== sB.issues));
    for (const sev of SEVERITY_ORDER) {
      table.appendChild(compareRow(`  ${sev}`, a.bySeverity[sev], b.bySeverity[sev], a.bySeverity[sev] !== b.bySeverity[sev]));
    }
    const sharedTech = a.tech.filter((t) => b.tech.includes(t));
    table.appendChild(compareRow('Tech Stack', a.tech.join(', ') || '—', b.tech.join(', ') || '—', false));

    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.appendChild(table);
    compareContent.innerHTML = '';
    if (sharedTech.length) {
      const note = document.createElement('p');
      note.style.color = 'var(--muted)';
      note.style.fontSize = '0.82rem';
      note.textContent = `Shared: ${sharedTech.join(', ')}. Highlighted rows above differ between the two apps.`;
      compareContent.appendChild(note);
    }
    compareContent.appendChild(scroll);
  } catch (err) {
    compareContent.textContent = 'Could not compare: ' + err.message;
  }
}

// Feature 11: cross-environment comparison — jump straight into comparing
// two specific apps (e.g. the same app's Staging vs Production entries)
// instead of picking both from scratch in the dropdowns. Reuses the same
// generic two-app compare view/API; only the entry point differs.
function openCompareWith(idA, idB) {
  listPanel.hidden = true;
  detailPanel.hidden = true;
  comparePanel.hidden = false;
  const options = allApps.map((a) => `<option value="${a.id}">${a.name} (${a.environment || 'no env'})</option>`).join('');
  compareAppA.innerHTML = options;
  compareAppB.innerHTML = options;
  if (idA) compareAppA.value = idA;
  if (idB) compareAppB.value = idB;
  if (!idA && !idB && allApps.length > 1) compareAppB.selectedIndex = 1;
  compareContent.innerHTML = '';
  if (idA && idB) runCompare();
}

compareAppsBtn.addEventListener('click', () => openCompareWith(null, null));

closeCompareBtn.addEventListener('click', () => {
  comparePanel.hidden = true;
  listPanel.hidden = false;
});

compareRunBtn.addEventListener('click', runCompare);

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

// ---- Scan calendar ----

const scanCalendarBtn = document.getElementById('scan-calendar-btn');
const scanCalendarPanel = document.getElementById('scan-calendar-panel');
const closeScanCalendarBtn = document.getElementById('close-scan-calendar');
const scanCalendarContent = document.getElementById('scan-calendar-content');

function formatDueIn(nextDueAt) {
  const diffMs = new Date(nextDueAt).getTime() - Date.now();
  const diffHours = diffMs / 3600000;
  if (diffHours < -1) return `${Math.round(-diffHours)}h overdue`;
  if (diffHours < 0) return 'due now';
  if (diffHours < 1) return 'due within the hour';
  if (diffHours < 24) return `due in ${Math.round(diffHours)}h`;
  return `due in ${Math.round(diffHours / 24)}d`;
}

function scanCalendarRow(entry) {
  const li = document.createElement('li');
  li.className = 'stale-item';
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = entry.name;
  link.style.color = 'var(--accent-text)';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    scanCalendarPanel.hidden = true;
    openDetail(entry.id);
  });
  const when = document.createElement('span');
  when.className = 'stale-age';
  when.textContent = `${new Date(entry.nextDueAt).toLocaleString()} — ${formatDueIn(entry.nextDueAt)}`;
  if (entry.overdue) when.style.color = 'var(--err)';
  li.append(link, when);
  return li;
}

async function loadScanCalendar() {
  scanCalendarContent.innerHTML = '<p>Loading…</p>';
  try {
    const { scheduled, unscheduled } = await fetch('/api/apps/calendar').then((r) => r.json());
    scanCalendarContent.innerHTML = '';

    if (scheduled.length) {
      const overdueCount = scheduled.filter((e) => e.overdue).length;
      if (overdueCount) {
        const note = document.createElement('p');
        note.className = 'scan-queue-note';
        note.style.color = 'var(--err)';
        note.textContent = `${overdueCount} app(s) overdue for their scheduled rescan.`;
        scanCalendarContent.appendChild(note);
      }
      const list = document.createElement('ul');
      list.className = 'stale-list';
      for (const entry of scheduled) list.appendChild(scanCalendarRow(entry));
      scanCalendarContent.appendChild(list);
    } else {
      scanCalendarContent.innerHTML = '<p class="empty-state">No apps have an Auto-rescan interval set.</p>';
    }

    if (unscheduled.length) {
      const heading = document.createElement('p');
      heading.className = 'dashboard-subheading';
      heading.textContent = `Not on a schedule (${unscheduled.length}):`;
      scanCalendarContent.appendChild(heading);
      const row = document.createElement('div');
      row.className = 'severity-chip-row';
      for (const entry of unscheduled) {
        const chip = document.createElement('a');
        chip.href = '#';
        chip.className = 'tag-badge tech-app-chip';
        chip.textContent = entry.name;
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          scanCalendarPanel.hidden = true;
          openDetail(entry.id);
        });
        row.appendChild(chip);
      }
      scanCalendarContent.appendChild(row);
    }
  } catch (err) {
    scanCalendarContent.textContent = 'Could not load scan calendar: ' + err.message;
  }
}

scanCalendarBtn.addEventListener('click', async () => {
  listPanel.hidden = true;
  detailPanel.hidden = true;
  scanCalendarPanel.hidden = false;
  await loadScanCalendar();
});

closeScanCalendarBtn.addEventListener('click', () => {
  scanCalendarPanel.hidden = true;
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
const crossIssuesSource = document.getElementById('cross-issues-source');

let allCrossIssues = [];

function applyCrossIssuesFilters() {
  const search = crossIssuesSearch.value.trim().toLowerCase();
  const severity = crossIssuesSeverity.value;
  const appId = crossIssuesApp.value;
  const source = crossIssuesSource.value;
  const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const filtered = allCrossIssues
    .filter((i) => i.triage.state === 'open' || i.triage.state === 'acknowledged')
    .filter((i) => !i.suppressedByRule)
    .filter((i) => !severity || i.severity === severity)
    .filter((i) => !appId || i.appId === appId)
    .filter((i) => !source || (i.source || 'static') === source)
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

[crossIssuesSearch, crossIssuesSeverity, crossIssuesApp, crossIssuesSource].forEach((el) => el.addEventListener('input', applyCrossIssuesFilters));

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

// ---- Manage owners (feature 19: Owner/Team validated against a saved list) ----

const ownerOptionsList = document.getElementById('owner-options');
const ownersListEl = document.getElementById('owners-list');
const ownerNewInput = document.getElementById('owner-new-input');
const ownerAddBtn = document.getElementById('owner-add-btn');
const ownerManageStatus = document.getElementById('owner-manage-status');

function renderOwners(ownerNames) {
  ownerOptionsList.innerHTML = ownerNames.map((o) => `<option value="${o}"></option>`).join('');
  ownersListEl.innerHTML = '';
  for (const name of ownerNames) {
    const chip = document.createElement('span');
    chip.className = 'tag-badge owner-chip';
    const label = document.createElement('span');
    label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'owner-remove-btn';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${name}`;
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/owners/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.json());
      renderOwners(updated);
    });
    chip.append(label, removeBtn);
    ownersListEl.appendChild(chip);
  }
}

async function loadOwners() {
  const list = await fetch('/api/owners').then((r) => r.json());
  renderOwners(list);
}

ownerAddBtn.addEventListener('click', async () => {
  const name = ownerNewInput.value.trim();
  if (!name) return;
  ownerManageStatus.classList.remove('success', 'error');
  try {
    const updated = await fetch('/api/owners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json());
    renderOwners(updated);
    ownerNewInput.value = '';
    ownerManageStatus.textContent = `Added "${name}".`;
    ownerManageStatus.classList.add('success');
    setTimeout(() => { ownerManageStatus.textContent = ''; ownerManageStatus.classList.remove('success'); }, 2000);
  } catch (err) {
    ownerManageStatus.textContent = 'Error: ' + err.message;
    ownerManageStatus.classList.add('error');
  }
});
ownerNewInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ownerAddBtn.click(); } });

loadOwners();

// ---- Ignore patterns (per app, glob-style) ----

const ignorePatternsTable = document.getElementById('ignore-patterns-table');
const ignorePatternNewInput = document.getElementById('ignore-pattern-new-input');
const ignorePatternAddBtn = document.getElementById('ignore-pattern-add-btn');
const ignorePatternStatus = document.getElementById('ignore-pattern-status');

function renderIgnorePatterns(appId, patterns) {
  ignorePatternsTable.innerHTML = '<tr><th>Pattern</th><th></th></tr>';
  for (const pattern of patterns) {
    const tr = document.createElement('tr');
    const patternTd = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = pattern;
    input.addEventListener('blur', async () => {
      const newPattern = input.value.trim();
      if (!newPattern || newPattern === pattern) { input.value = pattern; return; }
      const updated = await fetch(`/api/apps/${appId}/ignore-patterns`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPattern: pattern, newPattern }),
      }).then((r) => r.json());
      renderIgnorePatterns(appId, updated);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    patternTd.appendChild(input);
    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/apps/${appId}/ignore-patterns/${encodeURIComponent(pattern)}`, { method: 'DELETE' }).then((r) => r.json());
      renderIgnorePatterns(appId, updated);
    });
    actionTd.appendChild(removeBtn);
    tr.append(patternTd, actionTd);
    ignorePatternsTable.appendChild(tr);
  }
}

async function loadIgnorePatterns(appId) {
  const patterns = await fetch(`/api/apps/${appId}/ignore-patterns`).then((r) => r.json());
  renderIgnorePatterns(appId, patterns);
}

ignorePatternAddBtn.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const pattern = ignorePatternNewInput.value.trim();
  if (!pattern) return;
  ignorePatternStatus.classList.remove('success', 'error');
  try {
    const updated = await fetch(`/api/apps/${currentDetailId}/ignore-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern }),
    }).then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `Request failed (${r.status})`); });
      return r.json();
    });
    renderIgnorePatterns(currentDetailId, updated);
    ignorePatternNewInput.value = '';
    ignorePatternStatus.textContent = `Added "${pattern}". Takes effect on the next scan.`;
    ignorePatternStatus.classList.add('success');
    setTimeout(() => { ignorePatternStatus.textContent = ''; ignorePatternStatus.classList.remove('success'); }, 3000);
  } catch (err) {
    ignorePatternStatus.textContent = 'Error: ' + err.message;
    ignorePatternStatus.classList.add('error');
  }
});
ignorePatternNewInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ignorePatternAddBtn.click(); } });

// ---- Masking rules (per app, custom secret-detection regex) ----

const maskRulesTable = document.getElementById('mask-rules-table');
const maskRuleNewName = document.getElementById('mask-rule-new-name');
const maskRuleNewPattern = document.getElementById('mask-rule-new-pattern');
const maskRuleNewSeverity = document.getElementById('mask-rule-new-severity');
const maskRuleAddBtn = document.getElementById('mask-rule-add-btn');
const maskRuleStatus = document.getElementById('mask-rule-status');
const MASK_RULE_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];

function renderMaskRules(appId, rules) {
  maskRulesTable.innerHTML = '<tr><th>Name</th><th>Pattern</th><th>Severity</th><th></th></tr>';
  for (const rule of rules) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = rule.name;
    nameInput.addEventListener('blur', async () => {
      if (nameInput.value.trim() === rule.name || !nameInput.value.trim()) { nameInput.value = rule.name; return; }
      const updated = await fetch(`/api/apps/${appId}/mask-rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value.trim() }),
      }).then((r) => r.json());
      renderMaskRules(appId, updated);
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    nameTd.appendChild(nameInput);

    const patternTd = document.createElement('td');
    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.addEventListener('blur', async () => {
      if (patternInput.value.trim() === rule.pattern || !patternInput.value.trim()) { patternInput.value = rule.pattern; return; }
      const res = await fetch(`/api/apps/${appId}/mask-rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern: patternInput.value.trim() }),
      });
      const body = await res.json();
      if (!res.ok) { patternInput.value = rule.pattern; maskRuleStatus.textContent = 'Error: ' + body.error; maskRuleStatus.classList.add('error'); return; }
      renderMaskRules(appId, body);
    });
    patternInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') patternInput.blur(); });
    patternTd.appendChild(patternInput);

    const severityTd = document.createElement('td');
    const severitySelect = document.createElement('select');
    for (const s of MASK_RULE_SEVERITIES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === rule.severity) opt.selected = true;
      severitySelect.appendChild(opt);
    }
    severitySelect.addEventListener('change', async () => {
      const updated = await fetch(`/api/apps/${appId}/mask-rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ severity: severitySelect.value }),
      }).then((r) => r.json());
      renderMaskRules(appId, updated);
    });
    severityTd.appendChild(severitySelect);

    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/apps/${appId}/mask-rules/${rule.id}`, { method: 'DELETE' }).then((r) => r.json());
      renderMaskRules(appId, updated);
    });
    actionTd.appendChild(removeBtn);

    tr.append(nameTd, patternTd, severityTd, actionTd);
    maskRulesTable.appendChild(tr);
  }
}

async function loadMaskRules(appId) {
  const rules = await fetch(`/api/apps/${appId}/mask-rules`).then((r) => r.json());
  renderMaskRules(appId, rules);
}

maskRuleAddBtn.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const name = maskRuleNewName.value.trim();
  const pattern = maskRuleNewPattern.value.trim();
  if (!name || !pattern) return;
  maskRuleStatus.classList.remove('success', 'error');
  try {
    const res = await fetch(`/api/apps/${currentDetailId}/mask-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pattern, severity: maskRuleNewSeverity.value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    renderMaskRules(currentDetailId, body);
    maskRuleNewName.value = '';
    maskRuleNewPattern.value = '';
    maskRuleStatus.textContent = `Added "${name}". Takes effect on the next scan.`;
    maskRuleStatus.classList.add('success');
    setTimeout(() => { maskRuleStatus.textContent = ''; maskRuleStatus.classList.remove('success'); }, 3000);
  } catch (err) {
    maskRuleStatus.textContent = 'Error: ' + err.message;
    maskRuleStatus.classList.add('error');
  }
});
maskRuleNewPattern.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); maskRuleAddBtn.click(); } });

// ---- Suppression rules (Feature 12: pattern-based auto-suppression, vs.
// triage's per-finding false-positive marking) ----

const suppressionRulesTable = document.getElementById('suppression-rules-table');
const suppressionRuleNewCategory = document.getElementById('suppression-rule-new-category');
const suppressionRuleNewPattern = document.getElementById('suppression-rule-new-pattern');
const suppressionRuleNewNote = document.getElementById('suppression-rule-new-note');
const suppressionRuleAddBtn = document.getElementById('suppression-rule-add-btn');
const suppressionRuleStatus = document.getElementById('suppression-rule-status');

function renderSuppressionRules(appId, rules) {
  suppressionRulesTable.innerHTML = '<tr><th>Category</th><th>File Pattern</th><th>Note</th><th></th></tr>';
  for (const rule of rules) {
    const tr = document.createElement('tr');
    const catTd = document.createElement('td');
    catTd.textContent = rule.category === 'any' ? 'Any' : rule.category;
    const patternTd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = rule.filePattern;
    patternTd.appendChild(code);
    const noteTd = document.createElement('td');
    noteTd.textContent = rule.note || '—';
    noteTd.style.color = 'var(--muted)';
    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/apps/${appId}/suppression-rules/${rule.id}`, { method: 'DELETE' }).then((r) => r.json());
      renderSuppressionRules(appId, updated);
    });
    actionTd.appendChild(removeBtn);
    tr.append(catTd, patternTd, noteTd, actionTd);
    suppressionRulesTable.appendChild(tr);
  }
}

async function loadSuppressionRules(appId) {
  const rules = await fetch(`/api/apps/${appId}/suppression-rules`).then((r) => r.json());
  renderSuppressionRules(appId, rules);
}

suppressionRuleAddBtn.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const category = suppressionRuleNewCategory.value.trim();
  const filePattern = suppressionRuleNewPattern.value.trim();
  const note = suppressionRuleNewNote.value.trim();
  if (!filePattern) return;
  suppressionRuleStatus.classList.remove('success', 'error');
  try {
    const res = await fetch(`/api/apps/${currentDetailId}/suppression-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, filePattern, note }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    await loadSuppressionRules(currentDetailId);
    suppressionRuleNewCategory.value = '';
    suppressionRuleNewPattern.value = '';
    suppressionRuleNewNote.value = '';
    suppressionRuleStatus.textContent = 'Added — matches hide immediately in Issues below; overall counts update on the next scan.';
    suppressionRuleStatus.classList.add('success');
    setTimeout(() => { suppressionRuleStatus.textContent = ''; suppressionRuleStatus.classList.remove('success'); }, 4000);
  } catch (err) {
    suppressionRuleStatus.textContent = 'Error: ' + err.message;
    suppressionRuleStatus.classList.add('error');
  }
});
suppressionRuleNewPattern.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); suppressionRuleAddBtn.click(); } });

// ---- Onboarding checklist (Feature 13) ----

const onboardingChecklistEl = document.getElementById('onboarding-checklist');
const onboardingSummaryBadge = document.getElementById('onboarding-summary-badge');

function renderOnboardingChecklist(appId, checklist) {
  onboardingSummaryBadge.textContent = `${checklist.doneCount}/${checklist.total}`;
  onboardingSummaryBadge.className = 'tag-badge ' + (checklist.complete ? 'status-done' : '');
  onboardingChecklistEl.innerHTML = '';
  for (const item of checklist.items) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.done;
    if (item.auto) {
      checkbox.disabled = true;
      label.title = 'Derived automatically from this app\'s Owner/Tags fields — edit those above instead.';
    } else {
      checkbox.addEventListener('change', async () => {
        const updated = await fetch(`/api/apps/${appId}/onboarding`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [item.id]: checkbox.checked }),
        }).then((r) => r.json());
        renderOnboardingChecklist(appId, updated);
      });
    }
    const text = document.createElement('span');
    text.textContent = item.label + (item.auto ? ' (auto)' : '');
    label.append(checkbox, text);
    li.appendChild(label);
    onboardingChecklistEl.appendChild(li);
  }
}

async function loadOnboardingChecklist(appId) {
  const checklist = await fetch(`/api/apps/${appId}/onboarding`).then((r) => r.json());
  renderOnboardingChecklist(appId, checklist);
}

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
  currentDetailApp = app;
  withViewTransition(() => {
    listPanel.hidden = true;
    detailPanel.hidden = false;
    detailName.textContent = app.name;
    detailMeta.innerHTML = '';
    const SCHEDULE_LABELS = { 0: 'Off', 60: 'Hourly', 1440: 'Daily', 10080: 'Weekly' };

    detailMeta.append(...fieldRow('Path / Repo', app.pathOrRepo));

    // Feature: scan a specific branch/tag/commit instead of always the
    // default branch (repo URL targets only — a local path ignores this).
    // Editable here, takes effect on the next scan.
    const gitRefDt = document.createElement('dt');
    gitRefDt.textContent = 'Git Ref';
    const gitRefDd = document.createElement('dd');
    const gitRefInput = document.createElement('input');
    gitRefInput.type = 'text';
    gitRefInput.placeholder = 'default branch';
    gitRefInput.value = app.gitRef || '';
    gitRefInput.addEventListener('blur', async () => {
      if (gitRefInput.value === (app.gitRef || '')) return;
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ gitRef: gitRefInput.value.trim() }) });
    });
    gitRefInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') gitRefInput.blur(); });
    gitRefDd.appendChild(gitRefInput);
    detailMeta.append(gitRefDt, gitRefDd);
    detailMeta.append(...fieldRow('Purpose', app.purpose));
    detailMeta.append(...fieldRow('Owner / Team', app.owner));
    detailMeta.append(...badgeFieldRow('Environment', app.environment, ENV_BADGE_CLASS[app.environment] || 'env-internal', 'env-badge'));

    // Feature 11: cross-environment comparison — apps sharing this app's
    // name but registered under a different Environment (e.g. "Billing API"
    // in Staging vs Production) are almost always the same underlying
    // service scanned twice, so surface a one-click compare against each.
    const siblings = allApps.filter((a) => a.id !== app.id && a.name.toLowerCase() === app.name.toLowerCase());
    if (siblings.length) {
      const crossEnvDt = document.createElement('dt');
      crossEnvDt.textContent = 'Cross-Environment';
      const crossEnvDd = document.createElement('dd');
      for (const sib of siblings) {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'tag-badge tech-app-chip';
        link.textContent = `vs. ${sib.environment || 'no env'}`;
        link.title = `Compare against "${sib.name}" (${sib.environment || 'no env'})`;
        link.addEventListener('click', (e) => { e.preventDefault(); openCompareWith(app.id, sib.id); });
        crossEnvDd.appendChild(link);
      }
      detailMeta.append(crossEnvDt, crossEnvDd);
    }

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
    gateSelect.disabled = !hasRole('admin');
    if (gateSelect.disabled) gateSelect.title = 'Requires the "admin" role to change.';
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
      const active = issues.filter((i) => i.triage.state !== 'false_positive' && i.triage.state !== 'fixed' && !i.suppressedByRule);
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

    // Feature: on-completion webhook, plus the severity threshold that
    // gates it (see notifySeverity in db.js / notify.js) — was hardcoded to
    // "High" (Critical+High), now editable per app like gitRef/blur-to-save.
    const notifyDt = document.createElement('dt');
    notifyDt.textContent = 'Notify Webhook';
    const notifyDd = document.createElement('dd');
    const notifyUrlInput = document.createElement('input');
    notifyUrlInput.type = 'text';
    notifyUrlInput.placeholder = 'Slack incoming webhook or generic URL';
    notifyUrlInput.value = app.notifyWebhookUrl || '';
    notifyUrlInput.style.width = '60%';
    const notifySeveritySelect = document.createElement('select');
    for (const s of ['Critical', 'High', 'Medium', 'Low']) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s === 'Critical' ? 'Critical only' : `${s}+`;
      if (s === (app.notifySeverity || 'High')) opt.selected = true;
      notifySeveritySelect.appendChild(opt);
    }
    const saveNotify = async () => {
      app.notifyWebhookUrl = notifyUrlInput.value.trim();
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ notifyWebhookUrl: app.notifyWebhookUrl, notifySeverity: notifySeveritySelect.value }) });
    };
    notifyUrlInput.addEventListener('blur', saveNotify);
    notifyUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') notifyUrlInput.blur(); });
    notifySeveritySelect.addEventListener('change', saveNotify);
    notifyDd.append(notifyUrlInput, document.createTextNode(' '), notifySeveritySelect);
    detailMeta.append(notifyDt, notifyDd);

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

    // Feature 17: archiving retires an app from the default list/portfolio
    // rollups without touching its stored scan history — reversible from
    // here at any time.
    const archiveDt = document.createElement('dt');
    archiveDt.textContent = 'Archived';
    const archiveDd = document.createElement('dd');
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'secondary';
    archiveBtn.textContent = app.archived ? 'Unarchive' : 'Archive';
    archiveBtn.addEventListener('click', async () => {
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: !app.archived }) });
      await refreshList();
      openDetail(id);
    });
    archiveDd.appendChild(archiveBtn);
    if (app.archived) {
      const note = document.createElement('span');
      note.style.marginLeft = '0.6rem';
      note.style.color = 'var(--muted)';
      note.style.fontSize = '0.82rem';
      note.textContent = 'Hidden from the default list and portfolio rollups. Scan history is kept.';
      archiveDd.appendChild(note);
    }
    detailMeta.append(archiveDt, archiveDd);

    detailMeta.append(...fieldRow('Wiki Location', app.wikiLink));
    detailMeta.append(...fieldRow('Last Scanned', app.scannedAt ? new Date(app.scannedAt).toLocaleString() : ''));
    if (app.lastScannedRef) {
      const refText = (app.lastScannedRef.branch ? `${app.lastScannedRef.branch} @ ` : '') + app.lastScannedRef.commit
        + (app.lastScannedRef.ref && app.lastScannedRef.ref !== app.lastScannedRef.branch ? ` (requested: ${app.lastScannedRef.ref})` : '');
      detailMeta.append(...fieldRow('Last Scanned Ref', refText));
    }
    if (app.error) detailMeta.append(...fieldRow('Error', app.error));

    trackerForm.trackerType.value = app.trackerType || 'none';
    trackerForm.trackerBaseUrl.value = app.trackerBaseUrl || '';
    trackerForm.trackerProjectOrRepo.value = app.trackerProjectOrRepo || '';
    trackerForm.trackerEmail.value = app.trackerEmail || '';
    trackerForm.trackerToken.value = app.trackerToken || '';
    trackerFormStatus.textContent = '';
    trackerFormStatus.classList.remove('success', 'error');

    wikiView.innerHTML = '';
  });

  loadIgnorePatterns(id);
  loadMaskRules(id);
  loadSuppressionRules(id);
  loadOnboardingChecklist(id);

  if (app.status === 'Done' && app.wikiLink) {
    closeScanStream();
    wikiNav.hidden = false;
    await renderWikiNav(id, app);
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

trackerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentDetailId) return;
  trackerFormStatus.classList.remove('success', 'error');
  trackerFormStatus.textContent = 'Saving…';
  const data = Object.fromEntries(new FormData(trackerForm).entries());
  try {
    await api(`/${currentDetailId}`, { method: 'PATCH', body: JSON.stringify(data) });
    trackerFormStatus.textContent = 'Saved.';
    trackerFormStatus.classList.add('success');
    setTimeout(() => { trackerFormStatus.textContent = ''; trackerFormStatus.classList.remove('success'); }, 2000);
  } catch (err) {
    trackerFormStatus.textContent = 'Error: ' + err.message;
    trackerFormStatus.classList.add('error');
  }
});

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

async function renderWikiNav(id, app) {
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
    ['Process Flows', () => loadProcessFlowsView(id)],
    ['Dependency Graph', () => loadGraphView(id)],
    ['History', () => loadHistory(id)],
  ];

  const actions = [['Export Static Site', () => exportStaticSite(id)]];
  const isRepo = /^https?:\/\/|\.git$/.test(app.pathOrRepo || '');
  if (isRepo) actions.push(['Push to Wiki Repo', () => pushGithubWiki(id)]);

  wikiLinks.append(wikiNavGroup(pages), wikiNavGroup(tools));

  // Feature 10: custom wiki sections — team-added markdown pages that live
  // outside the generated wiki/ dir, so they persist across rescans. Own
  // nav group since the count is per-app and open-ended.
  try {
    const customSections = await api(`/${id}/wiki-sections`);
    if (customSections.length) {
      wikiLinks.appendChild(wikiNavGroup(customSections.map((s) => [s.title, () => loadCustomSection(id, s.slug)])));
    }
  } catch {
    // non-fatal — custom pages just won't show up in the nav this time
  }

  wikiLinks.append(wikiNavGroup(actions));
}

// ---- Custom wiki sections (Feature 10) ----

function renderCustomSectionEditor(id, section) {
  withViewTransition(() => {
    wikiView.innerHTML = '';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = section.title;
    titleInput.className = 'custom-section-title-input';

    const meta = document.createElement('p');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '0.8rem';
    const setMetaText = () => { meta.textContent = `Custom page — persists across rescans. Last edited ${new Date(section.updatedAt).toLocaleString()}.`; };
    setMetaText();

    const textarea = document.createElement('textarea');
    textarea.value = section.content;
    textarea.rows = 16;
    textarea.className = 'custom-section-textarea';
    textarea.placeholder = 'Write this page in Markdown...';

    const status = document.createElement('p');
    status.className = 'form-status';

    const previewHeading = document.createElement('h3');
    previewHeading.textContent = 'Preview';
    const preview = document.createElement('div');
    const updatePreview = () => { preview.innerHTML = renderMarkdown(textarea.value, '', id); };
    updatePreview();

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Delete Page';
    deleteBtn.addEventListener('click', async () => {
      await api(`/${id}/wiki-sections/${encodeURIComponent(section.slug)}`, { method: 'DELETE' });
      await renderWikiNav(id, currentDetailApp);
      loadWikiPage(id, 'Home.md');
    });

    const save = async () => {
      status.classList.remove('success', 'error');
      status.textContent = 'Saving…';
      try {
        const updated = await api(`/${id}/wiki-sections/${encodeURIComponent(section.slug)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: titleInput.value, content: textarea.value }),
        });
        section.title = updated.title;
        section.content = updated.content;
        section.updatedAt = updated.updatedAt;
        setMetaText();
        status.textContent = 'Saved.';
        status.classList.add('success');
        await renderWikiNav(id, currentDetailApp); // title may have changed
        setTimeout(() => { status.textContent = ''; status.classList.remove('success'); }, 1500);
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.classList.add('error');
      }
    };
    titleInput.addEventListener('blur', save);
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });
    textarea.addEventListener('input', updatePreview);
    textarea.addEventListener('blur', save);

    wikiView.append(titleInput, meta, textarea, status, deleteBtn, document.createElement('hr'), previewHeading, preview);
  });
}

async function loadCustomSection(id, slug) {
  try {
    const sections = await api(`/${id}/wiki-sections`);
    const section = sections.find((s) => s.slug === slug);
    if (!section) { wikiView.textContent = 'Page not found — it may have been deleted.'; return; }
    renderCustomSectionEditor(id, section);
  } catch (err) {
    wikiView.textContent = 'Could not load page: ' + err.message;
  }
}

const addPageForm = document.getElementById('add-page-form');
const addPageTitleInput = document.getElementById('add-page-title-input');

addPageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentDetailId) return;
  const title = addPageTitleInput.value.trim();
  if (!title) return;
  try {
    const section = await api(`/${currentDetailId}/wiki-sections`, { method: 'POST', body: JSON.stringify({ title, content: '' }) });
    addPageTitleInput.value = '';
    await renderWikiNav(currentDetailId, currentDetailApp);
    renderCustomSectionEditor(currentDetailId, section);
  } catch (err) {
    wikiView.textContent = 'Could not create page: ' + err.message;
  }
});

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
    const [issues, app] = await Promise.all([api(`/${id}/issues`), api(`/${id}`)]);
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
      tr.dataset.source = issue.source || 'static';
      if (issue.triage.state === 'false_positive' || issue.triage.state === 'fixed' || issue.suppressedByRule) tr.style.opacity = '0.5';

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
      if (issue.suppressedByRule) {
        const badge = document.createElement('div');
        badge.className = 'override-badge';
        badge.textContent = 'Auto-suppressed';
        badge.title = 'Matches a Suppression Rule above — excluded from active counts and CI gating regardless of this triage state.';
        triageTd.appendChild(badge);
      }
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
      detailTr.dataset.source = tr.dataset.source;
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

      // Feature 15: push this issue to the app's configured external
      // tracker (GitHub Issues / Jira). Hidden entirely when no tracker is
      // configured; once linked, shows a link instead of a push button so
      // it can't be filed twice from here.
      if (app.trackerType && app.trackerType !== 'none') {
        const trackerDt = document.createElement('dt');
        trackerDt.textContent = 'Tracker';
        const trackerDd = document.createElement('dd');
        if (issue.triage.externalRef && issue.triage.externalRef.url) {
          const link = document.createElement('a');
          link.href = issue.triage.externalRef.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = `View in ${issue.triage.externalRef.type === 'jira' ? 'Jira' : 'GitHub'} (${issue.triage.externalRef.id}) ↗`;
          trackerDd.appendChild(link);
        } else {
          const pushBtn = document.createElement('button');
          pushBtn.type = 'button';
          pushBtn.className = 'secondary';
          pushBtn.textContent = `Push to ${app.trackerType === 'jira' ? 'Jira' : 'GitHub'}`;
          const pushStatus = document.createElement('span');
          pushStatus.className = 'tracker-push-status';
          pushBtn.addEventListener('click', async () => {
            pushBtn.disabled = true;
            pushStatus.textContent = 'Pushing…';
            pushStatus.className = 'tracker-push-status';
            try {
              await api(`/${id}/issues/push-to-tracker`, { method: 'POST', body: JSON.stringify({ fingerprint: issue.fingerprint }) });
              loadIssuesInteractive(id);
            } catch (err) {
              pushStatus.textContent = 'Error: ' + err.message;
              pushStatus.className = 'tracker-push-status error';
              pushBtn.disabled = false;
            }
          });
          trackerDd.append(pushBtn, document.createTextNode(' '), pushStatus);
        }
        dl.append(trackerDt, trackerDd);
      }

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

      // Feature 2: npm-audit / dependency-advisory findings are tagged
      // source: "dependency-audit" at emission time (npmAudit.js,
      // issues.js's checkKnownVulnerableDeps); everything else is implicitly
      // "static". This just toggles row visibility — no re-fetch/re-render.
      const filterBar = document.createElement('div');
      filterBar.className = 'filter-bar';
      const sourceLabel = document.createElement('label');
      sourceLabel.textContent = 'Source ';
      sourceLabel.style.color = 'var(--muted)';
      sourceLabel.style.fontSize = '0.85rem';
      const sourceSelect = document.createElement('select');
      sourceSelect.id = 'issues-source-filter';
      sourceSelect.innerHTML = '<option value="">All sources</option><option value="static">Static findings</option><option value="dependency-audit">Dependency audit</option>';
      sourceSelect.addEventListener('change', () => {
        const filter = sourceSelect.value;
        for (const row of table.querySelectorAll('tr[data-source]')) {
          const matches = !filter || row.dataset.source === filter;
          row.hidden = !matches;
          if (!matches && row.classList.contains('issue-detail-row') === false) {
            // hide a filtered-out row's detail row too, even if it was expanded
            const next = row.nextElementSibling;
            if (next && next.classList.contains('issue-detail-row')) next.hidden = true;
          }
        }
      });
      sourceLabel.appendChild(sourceSelect);
      filterBar.appendChild(sourceLabel);
      wikiView.appendChild(filterBar);

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
          if (!hasRole('editor')) {
            input.disabled = true;
            input.title = 'Requires the "editor" role or higher to edit.';
          }
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

// Feature: real process-flow diagrams. Architecture.md/Process-Flows/*.md
// only ever rendered each route's step trace as a numbered markdown list —
// this turns that same step data into an actual flow diagram, hand-rolled
// SVG (same no-charting-library approach as the dependency graph below):
// one horizontal lane per route, one box per step, connected by arrows.
function truncateLabel(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function classifyStepBox(step, isFirst, isLast) {
  if (isFirst) return { fill: 'var(--accent-surface)', stroke: 'var(--accent-surface)', text: '#fff' };
  if (/side effect/i.test(step)) return { fill: 'var(--badge-info-bg)', stroke: 'var(--info)', text: 'var(--text)' };
  if (/unhandled failure/i.test(step)) return { fill: 'var(--badge-err-bg)', stroke: 'var(--err)', text: 'var(--text)' };
  if (isLast) {
    return /no explicit response/i.test(step)
      ? { fill: 'var(--badge-warn-bg)', stroke: 'var(--warn)', text: 'var(--text)' }
      : { fill: 'var(--badge-ok-bg)', stroke: 'var(--ok)', text: 'var(--text)' };
  }
  return { fill: 'var(--inset)', stroke: 'var(--border)', text: 'var(--text)' };
}

function renderProcessFlowDiagram(entryPoints, group) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const BOX_W = 200, BOX_H = 56, GAP_X = 44, GAP_Y = 22, PAD = 16;
  const entryLabel = 'Entry: ' + (entryPoints.length ? truncateLabel(entryPoints.join(', '), 30) : 'entry point');

  const rows = group.routes.map((r) => [entryLabel, `${r.method} ${r.path}`, ...r.steps.slice(1)]);
  const maxBoxes = Math.max(1, ...rows.map((r) => r.length));
  const width = PAD * 2 + maxBoxes * BOX_W + (maxBoxes - 1) * GAP_X;
  const height = PAD * 2 + rows.length * BOX_H + (rows.length - 1) * GAP_Y;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.style.display = 'block';

  rows.forEach((boxes, ri) => {
    const y = PAD + ri * (BOX_H + GAP_Y);
    boxes.forEach((stepText, bi) => {
      const x = PAD + bi * (BOX_W + GAP_X);
      if (bi > 0) {
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', x - GAP_X);
        line.setAttribute('y1', y + BOX_H / 2);
        line.setAttribute('x2', x - 6);
        line.setAttribute('y2', y + BOX_H / 2);
        line.setAttribute('stroke', 'var(--border)');
        line.setAttribute('stroke-width', '2');
        svg.appendChild(line);
        const arrow = document.createElementNS(svgNS, 'polygon');
        arrow.setAttribute('points', `${x - 6},${y + BOX_H / 2 - 5} ${x},${y + BOX_H / 2} ${x - 6},${y + BOX_H / 2 + 5}`);
        arrow.setAttribute('fill', 'var(--border)');
        svg.appendChild(arrow);
      }
      const style = classifyStepBox(stepText, bi === 0, bi === boxes.length - 1);
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', BOX_W);
      rect.setAttribute('height', BOX_H);
      rect.setAttribute('rx', 6);
      rect.setAttribute('fill', style.fill);
      rect.setAttribute('stroke', style.stroke);
      rect.setAttribute('stroke-width', '1.5');
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = stepText;
      rect.appendChild(title);
      svg.appendChild(rect);

      const words = truncateLabel(stepText, 46).split(' ');
      const lineHeight = 13;
      const linesOfText = [];
      let current = '';
      for (const w of words) {
        if ((current + ' ' + w).trim().length > 24) { linesOfText.push(current.trim()); current = w; }
        else current = (current + ' ' + w).trim();
      }
      if (current) linesOfText.push(current);
      const startY = y + BOX_H / 2 - ((linesOfText.length - 1) * lineHeight) / 2 + 4;
      linesOfText.slice(0, 3).forEach((lineText, li) => {
        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', x + BOX_W / 2);
        text.setAttribute('y', startY + li * lineHeight);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '10.5');
        text.setAttribute('fill', style.text);
        text.textContent = lineText;
        svg.appendChild(text);
      });
    });
  });

  return svg;
}

async function loadProcessFlowsView(id) {
  try {
    const data = await api(`/${id}/process-flows`);
    if (!data.groups.length) {
      withViewTransition(() => {
        wikiView.innerHTML = '<h2>Process Flows</h2><p>No routes/endpoints were detected by pattern matching — run a scan first, or this app may not expose HTTP routes.</p>';
      });
      return;
    }
    withViewTransition(() => {
      wikiView.innerHTML = '<h2>Process Flows</h2><p style="color:var(--muted);font-size:0.85rem">Each lane traces one route from the app\'s entry point through its handler to a response — hover a box for the full step text. Blue-bordered boxes are detected data/network side effects; green/amber-bordered boxes show whether the handler actually sent a response.</p>';
      for (const group of data.groups) {
        const section = document.createElement('div');
        section.innerHTML = `<h3>${group.name} (${group.routes.length} route${group.routes.length === 1 ? '' : 's'})</h3>`;
        const scroll = document.createElement('div');
        scroll.className = 'table-scroll';
        scroll.appendChild(renderProcessFlowDiagram(data.entryPoints, group));
        section.appendChild(scroll);
        wikiView.appendChild(section);
      }
    });
  } catch (err) {
    wikiView.textContent = 'Could not load process flows: ' + err.message;
  }
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
