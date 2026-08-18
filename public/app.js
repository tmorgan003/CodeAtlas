const form = document.getElementById('app-form');
const formStatus = document.getElementById('form-status');
const tableBody = document.getElementById('app-table-body');
const emptyState = document.getElementById('empty-state');
const brandHomeLink = document.getElementById('brand-home-link');
const dashboardPanel = document.getElementById('dashboard-panel');
const breadcrumbEl = document.getElementById('breadcrumb');
const breadcrumbHome = document.getElementById('breadcrumb-home');
const breadcrumbCurrent = document.getElementById('breadcrumb-current');
const listPanel = document.getElementById('list-panel');
const detailPanel = document.getElementById('detail-panel');
const detailName = document.getElementById('detail-name');
const detailMetaOverview = document.getElementById('detail-meta-overview');
const detailMetaSettings = document.getElementById('detail-meta-settings');
const detailMetaDanger = document.getElementById('detail-meta-danger');
const editAppBtn = document.getElementById('edit-app-btn');
const editAppForm = document.getElementById('edit-app-form');
const editAppCancelBtn = document.getElementById('edit-app-cancel-btn');
const editAppStatus = document.getElementById('edit-app-status');
const wikiNav = document.getElementById('wiki-nav');
const wikiLinks = document.getElementById('wiki-links');
const wikiView = document.getElementById('wiki-view');
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

// ---- Mermaid diagrams (Process Flow pages) ----
// Loaded from CDN in index.html; startOnLoad is off since wiki content is
// injected dynamically (innerHTML) rather than present at page load, so
// renderMermaidDiagrams runs it manually after each wiki page render.
// Colors match this feature's own classDef palette (see mermaidFlow.js on
// the server) rather than following the light/dark toggle — kept as one
// consistent scheme regardless of page theme, the same way a syntax-
// highlighted code block usually does.
if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      background: '#0f1115',
      primaryColor: '#171a21',
      primaryTextColor: '#e6e8ec',
      primaryBorderColor: '#2a2e37',
      lineColor: '#4595b5',
    },
  });
}

async function renderMermaidDiagrams(container) {
  if (!window.mermaid) return;
  const nodes = container.querySelectorAll('pre.mermaid');
  if (!nodes.length) return;
  try {
    await window.mermaid.run({ nodes, suppressErrors: true });
  } catch {
    // a malformed diagram shouldn't take the rest of the page down with it
  }
}

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
    label.append(document.createTextNode(currentUser.username + ' '));
    const roleSpan = document.createElement('span');
    roleSpan.className = 'auth-role';
    roleSpan.textContent = `(${currentUser.role})`;
    label.appendChild(roleSpan);
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
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = allLabel;
    select.appendChild(allOpt);
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }
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

// tone (optional): 'err' | 'sev-high' | 'warn' — lets a stat carry the same
// urgency signal its number represents instead of sitting in the same
// neutral tile as a plain count. Data-driven (see loadDashboard's tone
// calls below), not decorative — a tile only tints when what it's counting
// actually needs attention.
function statTile(value, label, tone) {
  const div = document.createElement('div');
  div.className = 'stat-tile' + (tone ? ` stat-tile-${tone}` : '');
  const val = document.createElement('div');
  val.className = 'stat-value';
  val.textContent = value;
  const lbl = document.createElement('div');
  lbl.className = 'stat-label';
  lbl.textContent = label;
  div.append(val, lbl);
  return div;
}

const TREND_SEVERITY_VAR = { Critical: '--err', High: '--sev-high', Medium: '--warn', Low: '--info' };

// Plain CSS stacked bars, not a charting library — 14 data points doesn't
// need one, and this stays inside the "no new dependency" pattern the rest
// of this codebase already follows (npmAudit/OSV shell out to existing
// tools; nothing here pulls in a new npm package for a single view).
function buildTrendChart(points) {
  const wrap = document.createElement('div');
  wrap.className = 'trend-chart';
  const heading = document.createElement('p');
  heading.className = 'dashboard-subheading';
  heading.textContent = 'Open issues by severity, last 14 days:';
  wrap.appendChild(heading);

  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const bars = document.createElement('div');
  bars.className = 'trend-bars';
  for (const point of points) {
    const barCol = document.createElement('div');
    barCol.className = 'trend-bar-col';
    barCol.title = `${point.date}: ${point.total} open (Critical ${point.bySeverity.Critical}, High ${point.bySeverity.High}, Medium ${point.bySeverity.Medium}, Low ${point.bySeverity.Low})`;
    const stack = document.createElement('div');
    stack.className = 'trend-bar-stack';
    stack.style.height = `${Math.round((point.total / maxTotal) * 100)}%`;
    for (const sev of ['Low', 'Medium', 'High', 'Critical']) {
      const count = point.bySeverity[sev];
      if (!count) continue;
      const seg = document.createElement('div');
      seg.className = 'trend-bar-seg';
      seg.style.flexGrow = String(count);
      seg.style.background = `var(${TREND_SEVERITY_VAR[sev]})`;
      stack.appendChild(seg);
    }
    barCol.appendChild(stack);
    bars.appendChild(barCol);
  }
  wrap.appendChild(bars);
  return wrap;
}

// The 3s poll (see setInterval below) calls refreshList -> loadDashboard on
// every tick regardless of whether anything actually changed, and this
// function used to unconditionally tear down and rebuild dashboardContent
// from scratch every time — visibly flickering/"refreshing" the whole
// Portfolio Overview panel every few seconds even when nothing was
// different. Cache a signature of the last-rendered data and skip the
// rebuild when it's unchanged.
let lastDashboardSignature = null;

// ---- loadDashboard section renderers ----
// Split out of loadDashboard (was one function with cyclomatic complexity
// 29 — every dashboard section's branches summed together). Each renderer
// owns one section and appends directly to dashboardContent.

function computeIssuesTone(d) {
  return d.bySeverity.Critical > 0 ? 'err'
    : d.bySeverity.High > 0 ? 'sev-high'
    : d.totalActiveIssues > 0 ? 'warn'
    : null;
}

// Feature 20: scan queue visibility — only shown while something's actually
// running/waiting, so it doesn't clutter the dashboard at rest.
function renderScanQueueNote(q) {
  if (!(q && (q.active > 0 || q.queued.length > 0))) return;
  const queueNote = document.createElement('p');
  queueNote.className = 'scan-queue-note';
  const parts = [`${q.active}/${q.maxConcurrent} scan slot(s) active`];
  if (q.queued.length) parts.push(`${q.queued.length} queued: ${q.queued.map((a) => `${a.name} (#${a.position})`).join(', ')}`);
  queueNote.textContent = parts.join(' — ');
  dashboardContent.appendChild(queueNote);
}

function renderStatsTiles(d, trend) {
  const stats = document.createElement('div');
  stats.className = 'dashboard-stats';
  stats.appendChild(statTile(d.totalApps, 'Apps'));
  const issuesTone = computeIssuesTone(d);
  stats.appendChild(statTile(d.totalActiveIssues, 'Active Issues', issuesTone));
  stats.appendChild(statTile(d.staleApps.length, `Stale (>${d.staleDaysThreshold}d)`, d.staleApps.length > 0 ? 'warn' : null));
  if (trend) stats.appendChild(statTile(trend.resolvedThisWeek, 'Resolved This Week', trend.resolvedThisWeek > 0 ? 'ok' : null));
  dashboardContent.appendChild(stats);
  return issuesTone;
}

function renderSeverityChipRow(d) {
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
}

function renderEnvironmentChipRow(d) {
  const envRow = document.createElement('div');
  envRow.className = 'severity-chip-row';
  for (const [env, count] of Object.entries(d.byEnvironment)) {
    const chip = document.createElement('span');
    chip.className = 'env-badge ' + (ENV_BADGE_CLASS[env] || 'env-internal');
    chip.textContent = `${env}: ${count}`;
    envRow.appendChild(chip);
  }
  if (envRow.children.length) dashboardContent.appendChild(envRow);
}

function renderStaleAppsList(d) {
  if (!d.staleApps.length) return;
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

// Feature 14: flag apps whose latest scan ran meaningfully longer than the
// portfolio average (see the /dashboard route for the threshold logic).
function renderSlowAppsList(d) {
  if (!d.slowApps.length) return;
  const slowHeading = document.createElement('p');
  slowHeading.className = 'dashboard-subheading';
  slowHeading.textContent = `Slow scans (portfolio average: ${formatDuration(d.avgDurationMs)}):`;
  dashboardContent.appendChild(slowHeading);

  const list = document.createElement('ul');
  list.className = 'stale-list';
  for (const s of d.slowApps) {
    const li = document.createElement('li');
    li.className = 'stale-item';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = s.name;
    link.style.color = 'var(--accent-text)';
    link.addEventListener('click', (e) => { e.preventDefault(); openDetail(s.id); });
    const dur = document.createElement('span');
    dur.className = 'stale-age';
    dur.textContent = `${formatDuration(s.durationMs)} — ${s.filesProcessed} file(s)`;
    li.append(link, dur);
    list.appendChild(li);
  }
  dashboardContent.appendChild(list);
}

async function loadDashboard() {
  let d;
  try {
    d = await api('/dashboard');
  } catch {
    return;
  }

  const q = await fetch('/api/apps/scan-queue').then((r) => r.json()).catch(() => null);

  // Trend visibility: replays scan history against today's triage state to
  // show whether the portfolio is improving or drifting, not just its
  // current snapshot.
  const trend = await fetch('/api/apps/dashboard/trend').then((r) => r.json()).catch(() => null);

  const signature = JSON.stringify({ d, q, trend });
  if (signature === lastDashboardSignature) return;
  lastDashboardSignature = signature;

  dashboardContent.innerHTML = '';

  renderScanQueueNote(q);
  const issuesTone = renderStatsTiles(d, trend);

  // Surface the same severity signal on the nav entry point itself — the
  // stat tile above only exists once you're already on the dashboard, but
  // "how urgent is this" is exactly what should be visible on the button
  // that gets you to the issues list in the first place.
  allIssuesBadge.hidden = d.totalActiveIssues === 0;
  allIssuesBadge.textContent = String(d.totalActiveIssues);
  allIssuesBadge.className = 'severity-badge ' + (ISSUES_BADGE_TONE_CLASS[issuesTone] || 'severity-low');

  renderSeverityChipRow(d);
  renderEnvironmentChipRow(d);

  if (trend && trend.points.some((p) => p.total > 0)) dashboardContent.appendChild(buildTrendChart(trend.points));

  renderStaleAppsList(d);
  renderSlowAppsList(d);
}

async function triggerScan(id) {
  try {
    await api(`/${id}/scan`, { method: 'POST' });
  } catch (err) {
    // A rejected scan trigger (e.g. RBAC blocking a non-admin from a
    // Deep-mode app) previously vanished as a silent unhandled rejection —
    // surface it wherever the user can currently see it.
    await refreshList();
    if (currentDetailId === id) wikiView.textContent = 'Could not start scan: ' + err.message;
    return;
  }
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

// Briefly highlights and scrolls a just-created row into view — the
// visible link between "I submitted a form" and "CodeAtlas is now tracking
// this app," which a flat status line alone doesn't show (see row-just-added
// in styles.css for why this is a longer, deliberate fade, not a flash).
function markRowJustAdded(id, shouldScroll = true) {
  const refs = rowElements.get(id);
  if (!refs) return;
  if (shouldScroll) refs.tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  refs.tr.classList.remove('row-just-added');
  void refs.tr.offsetWidth; // restart if the same row was just highlighted
  refs.tr.classList.add('row-just-added');
  refs.tr.addEventListener('animationend', () => refs.tr.classList.remove('row-just-added'), { once: true });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formStatus.classList.remove('success', 'error');
  formStatus.textContent = 'Adding...';
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const entry = await api('', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    updateEnvSelectColor();
    deepScanEstimate.textContent = '';
    formStatus.textContent = `Added "${entry.name}" — tracked below.`;
    formStatus.classList.add('success');
    await refreshList();
    markRowJustAdded(entry.id);
    setTimeout(() => { formStatus.textContent = ''; formStatus.classList.remove('success'); }, 2000);
  } catch (err) {
    formStatus.textContent = 'Error: ' + err.message;
    formStatus.classList.add('error');
  }
});

// ---- Edit an existing application's fields ----
// Reuses the same field set as "Add an Application" (name, pathOrRepo,
// purpose, owner, environment, techStack, tags, notes, scanMode) — those
// were previously only settable at creation time.

editAppBtn.addEventListener('click', () => {
  const app = currentDetailApp;
  if (!app) return;
  editAppForm.elements.name.value = app.name || '';
  editAppForm.elements.pathOrRepo.value = app.pathOrRepo || '';
  editAppForm.elements.purpose.value = app.purpose || '';
  editAppForm.elements.owner.value = app.owner || '';
  editAppForm.elements.environment.value = app.environment || '';
  editAppForm.elements.techStack.value = app.techStack || '';
  editAppForm.elements.tags.value = (app.tags || []).join(', ');
  editAppForm.elements.notes.value = app.notes || '';
  editAppForm.elements.scanMode.checked = app.scanMode === 'deep';
  editAppStatus.textContent = '';
  detailMetaOverview.hidden = true;
  editAppForm.hidden = false;
});

editAppCancelBtn.addEventListener('click', () => {
  editAppForm.hidden = true;
  detailMetaOverview.hidden = false;
});

editAppForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentDetailId) return;
  editAppStatus.classList.remove('success', 'error');
  editAppStatus.textContent = 'Saving...';
  const data = Object.fromEntries(new FormData(editAppForm).entries());
  data.scanMode = editAppForm.elements.scanMode.checked ? 'deep' : 'static'; // unchecked checkboxes are omitted by FormData
  try {
    await api(`/${currentDetailId}`, { method: 'PATCH', body: JSON.stringify(data) });
    editAppStatus.textContent = 'Saved.';
    editAppStatus.classList.add('success');
    await openDetail(currentDetailId);
    await refreshList();
  } catch (err) {
    editAppStatus.textContent = 'Error: ' + err.message;
    editAppStatus.classList.add('error');
  }
});

// ---- Compare two apps ----

const compareAppsBtn = document.getElementById('compare-apps-btn');
const comparePanel = document.getElementById('compare-panel');
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

function buildCompareTableHead(a, b) {
  const head = document.createElement('tr');
  const headA = document.createElement('th');
  headA.textContent = a.name;
  const headB = document.createElement('th');
  headB.textContent = b.name;
  head.append(document.createElement('th'), headA, headB);
  return head;
}

function buildCompareStatRows(a, b) {
  const sA = a.stats || {}, sB = b.stats || {};
  return [
    compareRow('Units', sA.units ?? '—', sB.units ?? '—', sA.units !== sB.units),
    compareRow('Models', sA.models ?? '—', sB.models ?? '—', sA.models !== sB.models),
    compareRow('Routes', sA.routes ?? '—', sB.routes ?? '—', sA.routes !== sB.routes),
    compareRow('Active Issues', sA.issues ?? '—', sB.issues ?? '—', sA.issues !== sB.issues),
  ];
}

function buildCompareSeverityRows(a, b) {
  return SEVERITY_ORDER.map((sev) => compareRow(`  ${sev}`, a.bySeverity[sev], b.bySeverity[sev], a.bySeverity[sev] !== b.bySeverity[sev]));
}

function buildCompareTable(a, b) {
  const table = document.createElement('table');
  table.appendChild(buildCompareTableHead(a, b));
  table.appendChild(compareRow('Environment', a.environment || '—', b.environment || '—', a.environment !== b.environment));
  table.appendChild(compareRow('Owner / Team', a.owner || '—', b.owner || '—', a.owner !== b.owner));
  table.appendChild(compareRow('Status', a.status, b.status, a.status !== b.status));
  table.appendChild(compareRow('Last Scanned', a.scannedAt ? new Date(a.scannedAt).toLocaleString() : '—', b.scannedAt ? new Date(b.scannedAt).toLocaleString() : '—', false));
  for (const row of buildCompareStatRows(a, b)) table.appendChild(row);
  for (const row of buildCompareSeverityRows(a, b)) table.appendChild(row);
  table.appendChild(compareRow('Tech Stack', a.tech.join(', ') || '—', b.tech.join(', ') || '—', false));
  return table;
}

function buildCompareSharedTechNote(a, b) {
  const sharedTech = a.tech.filter((t) => b.tech.includes(t));
  if (!sharedTech.length) return null;
  const note = document.createElement('p');
  note.style.color = 'var(--muted)';
  note.style.fontSize = '0.82rem';
  note.textContent = `Shared: ${sharedTech.join(', ')}. Highlighted rows above differ between the two apps.`;
  return note;
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
    const table = buildCompareTable(a, b);
    const note = buildCompareSharedTechNote(a, b);

    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.appendChild(table);
    compareContent.innerHTML = '';
    if (note) compareContent.appendChild(note);
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
  showOnly(comparePanel);
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
const techStackContent = document.getElementById('tech-stack-content');

function techChip(app) {
  const chip = document.createElement('a');
  chip.href = '#';
  chip.className = 'tag-badge tech-app-chip';
  chip.textContent = app.name;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
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
  showOnly(techStackPanel);
  techStackContent.innerHTML = '<p>Loading…</p>';
  await loadTechStack();
});


// ---- Manage tags (Feature 19) ----

const manageTagsBtn = document.getElementById('manage-tags-btn');
const tagsPanel = document.getElementById('tags-panel');
const tagsTable = document.getElementById('tags-table');
const tagsMergeTarget = document.getElementById('tags-merge-target');
const tagsMergeBtn = document.getElementById('tags-merge-btn');
const tagsStatus = document.getElementById('tags-status');

async function loadTagsPanel() {
  tagsTable.innerHTML = '<tr><th></th><th>Tag</th><th>Apps</th><th></th></tr>';
  const tags = await fetch('/api/apps/tags').then((r) => r.json());
  if (!tags.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-state';
    td.textContent = 'No tags in use yet.';
    tr.appendChild(td);
    tagsTable.appendChild(tr);
    return;
  }
  for (const t of tags) {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tag-merge-checkbox';
    checkbox.dataset.tag = t.tag;
    checkTd.appendChild(checkbox);

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = t.tag;
    nameInput.addEventListener('blur', async () => {
      const newTag = nameInput.value.trim();
      if (!newTag || newTag === t.tag) { nameInput.value = t.tag; return; }
      tagsStatus.classList.remove('success', 'error');
      const res = await fetch(`/api/apps/tags/${encodeURIComponent(t.tag)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newTag }),
      });
      const body = await res.json();
      if (!res.ok) {
        tagsStatus.textContent = 'Error: ' + body.error;
        tagsStatus.classList.add('error');
        nameInput.value = t.tag;
        return;
      }
      tagsStatus.textContent = `Renamed "${t.tag}" to "${newTag}" on ${body.updatedCount} app(s).`;
      tagsStatus.classList.add('success');
      await refreshList();
      loadTagsPanel();
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    nameTd.appendChild(nameInput);

    const appsTd = document.createElement('td');
    for (const a of t.apps) appsTd.appendChild(techChip(a));

    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Delete';
    removeBtn.addEventListener('click', async () => {
      tagsStatus.classList.remove('success', 'error');
      const res = await fetch(`/api/apps/tags/${encodeURIComponent(t.tag)}`, { method: 'DELETE' });
      const body = await res.json();
      tagsStatus.textContent = `Deleted "${t.tag}" from ${body.updatedCount} app(s).`;
      tagsStatus.classList.add('success');
      await refreshList();
      loadTagsPanel();
    });
    actionTd.appendChild(removeBtn);

    tr.append(checkTd, nameTd, appsTd, actionTd);
    tagsTable.appendChild(tr);
  }
}

manageTagsBtn.addEventListener('click', () => {
  showOnly(tagsPanel);
  tagsStatus.textContent = '';
  tagsStatus.classList.remove('success', 'error');
  loadTagsPanel();
});


tagsMergeBtn.addEventListener('click', async () => {
  const target = tagsMergeTarget.value.trim();
  const selected = Array.from(document.querySelectorAll('.tag-merge-checkbox:checked')).map((cb) => cb.dataset.tag);
  tagsStatus.classList.remove('success', 'error');
  if (!target || !selected.length) {
    tagsStatus.textContent = 'Pick a target name and check at least one tag to merge.';
    tagsStatus.classList.add('error');
    return;
  }
  try {
    const res = await fetch('/api/apps/tags/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceTags: selected, targetTag: target }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    tagsStatus.textContent = `Merged ${selected.length} tag(s) into "${target}" on ${body.updatedCount} app(s).`;
    tagsStatus.classList.add('success');
    tagsMergeTarget.value = '';
    await refreshList();
    loadTagsPanel();
  } catch (err) {
    tagsStatus.textContent = 'Error: ' + err.message;
    tagsStatus.classList.add('error');
  }
});

// ---- Scan calendar ----

const scanCalendarBtn = document.getElementById('scan-calendar-btn');
const scanCalendarPanel = document.getElementById('scan-calendar-panel');
const scanCalendarContent = document.getElementById('scan-calendar-content');

// Feature 14: scan performance metrics — shared duration formatter used by
// the detail panel, scan history table, and the dashboard's slow-scan flags.
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

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
  showOnly(scanCalendarPanel);
  await loadScanCalendar();
});


// ---- Cross-app issue view ----

const allIssuesBtn = document.getElementById('all-issues-btn');
const allIssuesBadge = document.getElementById('all-issues-badge');
const ISSUES_BADGE_TONE_CLASS = { err: 'severity-critical', 'sev-high': 'severity-high', warn: 'severity-medium' };
const crossIssuesPanel = document.getElementById('cross-issues-panel');
const crossIssuesContent = document.getElementById('cross-issues-content');
const crossIssuesSearch = document.getElementById('cross-issues-search');
const crossIssuesSeverity = document.getElementById('cross-issues-severity');
const crossIssuesApp = document.getElementById('cross-issues-app');
const crossIssuesSource = document.getElementById('cross-issues-source');

// Every top-level view (the app list, an app's detail page, and each of the
// five dashboard-button destinations) is mutually exclusive — exactly one
// should ever be visible. Routing every switch through here (instead of each
// call site hand-toggling .hidden on just the two panels it knows about)
// guarantees that invariant — e.g. jumping from "All Issues" straight into
// an app's detail view no longer leaves both panels visible — and scrolls
// the new view into place, since the dashboard's nav buttons sit well above
// where their target panel renders and gave no feedback that anything had
// happened without it.
const ALL_PANELS = [listPanel, detailPanel, comparePanel, techStackPanel, tagsPanel, scanCalendarPanel, crossIssuesPanel];

// Static label for every subpage except the detail view, whose breadcrumb
// text is the app's name and gets set separately in openDetail() once it's
// known.
const PANEL_BREADCRUMB_LABEL = new Map([
  [comparePanel, 'Compare Apps'],
  [techStackPanel, 'Tech Stack'],
  [tagsPanel, 'Manage Tags'],
  [scanCalendarPanel, 'Scan Calendar'],
  [crossIssuesPanel, 'All Issues'],
]);

function showOnly(panel) {
  for (const p of ALL_PANELS) p.hidden = (p !== panel);
  // The full Portfolio Overview (stat tiles, severity badges, the six
  // action buttons) only makes sense on the list/home view — repeating it
  // at the top of every subpage meant scrolling past the same block twice
  // to reach the content you actually came for. Everywhere else gets a
  // one-line breadcrumb instead.
  const isHome = panel === listPanel;
  dashboardPanel.hidden = !isHome;
  breadcrumbEl.hidden = isHome;
  if (!isHome && panel !== detailPanel) breadcrumbCurrent.textContent = PANEL_BREADCRUMB_LABEL.get(panel) || '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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

const CROSS_ISSUE_SUMMARY_TRUNCATE_AT = 65;

// ---- Claude Code fix-prompt generation ----
// Builds a ready-to-paste prompt describing one issue (or, for a group, all
// grouped issues) with enough context — file, line, category, summary,
// suggested fix, and CWE/before-after example where the scanner has them —
// that pasting it straight into Claude Code is enough to act on.

function buildIssueFixPrompt(issue) {
  const lines = [
    'Fix this issue found by CodeAtlas static analysis:',
    '',
    `File: ${issue.file}`,
    `Line: ${issue.line}`,
    `Category: ${issue.category} (${issue.severity} severity)`,
    `Summary: ${issue.summary}`,
  ];
  if (issue.suggestedFix) lines.push(`Suggested fix: ${issue.suggestedFix}`);
  if (issue.cwe) lines.push(`CWE / OWASP: ${issue.cwe}`);
  if (issue.codeExample) {
    lines.push('', 'Example of the vulnerable pattern:', '```', issue.codeExample.before, '```');
    lines.push('Example of the fixed pattern:', '```', issue.codeExample.after, '```');
  }
  lines.push('', `Open ${issue.file} around line ${issue.line}, understand the surrounding code, and apply a fix for this specific issue without changing unrelated behavior.`);
  return lines.join('\n');
}

function buildIssueGroupFixPrompt(group) {
  const lines = [`Fix these ${group.length} related issues found by CodeAtlas static analysis (same category, same file):`, ''];
  group.forEach((issue, i) => {
    lines.push(`${i + 1}. ${issue.file}:${issue.line} — ${issue.summary}`);
    if (issue.suggestedFix) lines.push(`   Suggested fix: ${issue.suggestedFix}`);
  });
  const cwes = [...new Set(group.map((i) => i.cwe).filter(Boolean))];
  if (cwes.length) lines.push('', `CWE / OWASP: ${cwes.join('; ')}`);
  lines.push('', 'Address each of these individually, applying the appropriate fix at each location without changing unrelated behavior.');
  return lines.join('\n');
}

async function copyPromptToClipboard(text, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

function buildCopyPromptButton(label, promptText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-button';
  btn.textContent = label;
  btn.addEventListener('click', () => copyPromptToClipboard(promptText, btn));
  return btn;
}

function buildCrossIssueRow(issue, table) {
  const tr = document.createElement('tr');
  tr.dataset.severity = issue.severity;

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
    openDetail(issue.appId).then(() => loadIssuesInteractive(issue.appId));
  });
  appTd.appendChild(appLink);
  tr.appendChild(appTd);

  const categoryTd = document.createElement('td');
  categoryTd.className = 'cell-category';
  categoryTd.textContent = issue.category;
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
  const isLong = issue.summary.length > CROSS_ISSUE_SUMMARY_TRUNCATE_AT;
  const summarySpan = document.createElement('span');
  summarySpan.textContent = isLong ? issue.summary.slice(0, CROSS_ISSUE_SUMMARY_TRUNCATE_AT - 1).trimEnd() + '…' : issue.summary;
  summaryTd.appendChild(summarySpan);
  summaryTd.title = issue.summary;
  summaryTd.appendChild(document.createTextNode(' '));
  const detailsBtn = document.createElement('button');
  detailsBtn.type = 'button';
  detailsBtn.className = 'link-button details-toggle';
  detailsBtn.textContent = 'Show details';
  summaryTd.appendChild(detailsBtn);
  tr.appendChild(summaryTd);

  const triageTd = document.createElement('td');
  const select = document.createElement('select');
  select.className = triageSelectClass(issue.triage.state);
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

  const detailTr = document.createElement('tr');
  detailTr.className = 'issue-detail-row';
  detailTr.hidden = true;
  const detailTd = document.createElement('td');
  detailTd.colSpan = 7;
  const dl = document.createElement('dl');
  dl.className = 'issue-detail';
  const addEntry = (term, value) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  };
  const addCodeEntry = (term, code) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    const pre = document.createElement('pre');
    pre.className = 'issue-code-example';
    pre.textContent = code;
    dd.appendChild(pre);
    dl.append(dt, dd);
  };
  addEntry('File', issue.file);
  addEntry('Summary', issue.summary);
  if (issue.suggestedFix) addEntry('Suggested Fix', issue.suggestedFix);
  if (issue.cwe) addEntry('CWE / OWASP', issue.cwe);
  if (issue.proposedFix) {
    addCodeEntry('Proposed Fix (Deep Scan)', issue.proposedFix.diff);
    if (issue.proposedFix.explanation) addEntry('Why this fix', issue.proposedFix.explanation);
  } else if (issue.codeExample) {
    addCodeEntry('Before', issue.codeExample.before);
    addCodeEntry('After', issue.codeExample.after);
  }
  const fixDt = document.createElement('dt');
  fixDt.textContent = 'Fix';
  const fixDd = document.createElement('dd');
  fixDd.appendChild(buildCopyPromptButton('Copy Claude Code Prompt', buildIssueFixPrompt(issue)));
  dl.append(fixDt, fixDd);
  detailTd.appendChild(dl);
  detailTr.appendChild(detailTd);
  table.appendChild(detailTr);

  detailsBtn.addEventListener('click', () => {
    detailTr.hidden = !detailTr.hidden;
    detailsBtn.textContent = detailTr.hidden ? 'Show details' : 'Hide details';
  });
}

// Scoped to a single app (unlike groupIssuesForDisplay's per-app-page use) —
// grouping across apps too would collapse "route.ts is dead code in App A"
// and "route.ts is dead code in App B" into one misleading row implying a
// single shared cause, when they're two unrelated findings that happen to
// share a rule and a basename.
function groupCrossIssuesForDisplay(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const key = issue.appId + '|' + issue.category + '|' + issue.file.split('/').pop();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  return [...groups.values()];
}

function buildCrossIssueGroupRow(group, table, groupId) {
  const worst = group.reduce((a, b) => (SEVERITY_RANK[b.severity] < SEVERITY_RANK[a.severity] ? b : a));
  const basename = group[0].file.split('/').pop();

  const groupTr = document.createElement('tr');
  groupTr.className = 'issue-group-row';
  groupTr.dataset.severity = worst.severity;

  const sevTd = document.createElement('td');
  const sevBadge = document.createElement('span');
  sevBadge.className = 'severity-badge ' + (SEVERITY_BADGE_CLASS[worst.severity] || 'severity-low');
  sevBadge.textContent = worst.severity;
  sevTd.appendChild(sevBadge);
  groupTr.appendChild(sevTd);

  const appTd = document.createElement('td');
  appTd.className = 'cell-category';
  appTd.textContent = group[0].appName;
  groupTr.appendChild(appTd);

  const catTd = document.createElement('td');
  catTd.className = 'cell-category';
  catTd.textContent = group[0].category;
  groupTr.appendChild(catTd);

  const fileTd = document.createElement('td');
  fileTd.className = 'cell-file';
  fileTd.textContent = `${basename} (×${group.length})`;
  groupTr.appendChild(fileTd);

  groupTr.appendChild(document.createElement('td')); // Line varies per occurrence

  const summaryTd = document.createElement('td');
  summaryTd.className = 'cell-summary';
  const groupToggle = document.createElement('button');
  groupToggle.type = 'button';
  groupToggle.className = 'link-button details-toggle';
  groupToggle.textContent = `Show ${group.length} occurrences`;
  summaryTd.appendChild(groupToggle);
  summaryTd.appendChild(document.createTextNode(' '));
  summaryTd.appendChild(buildCopyPromptButton('Copy Fix Prompt (All)', buildIssueGroupFixPrompt(group)));
  groupTr.appendChild(summaryTd);

  const bulkTriageTd = document.createElement('td');
  const bulkSelect = document.createElement('select');
  bulkSelect.className = 'bulk-triage-select';
  const bulkPlaceholder = document.createElement('option');
  bulkPlaceholder.value = '';
  bulkPlaceholder.textContent = `Set all ${group.length} to…`;
  bulkSelect.appendChild(bulkPlaceholder);
  for (const s of TRIAGE_STATES) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    bulkSelect.appendChild(opt);
  }
  bulkSelect.addEventListener('change', async () => {
    const state = bulkSelect.value;
    if (!state) return;
    await fetch(`/api/apps/${group[0].appId}/issues/triage-bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprints: group.map((i) => i.fingerprint), state }),
    });
    await loadAllIssues();
  });
  bulkTriageTd.appendChild(bulkSelect);
  groupTr.appendChild(bulkTriageTd);
  table.appendChild(groupTr);

  const memberRows = [];
  for (const issue of group) {
    const before = table.rows.length;
    buildCrossIssueRow(issue, table);
    for (let i = before; i < table.rows.length; i++) {
      const row = table.rows[i];
      row.hidden = true;
      row.dataset.issueGroup = groupId;
      memberRows.push(row);
    }
  }
  groupToggle.addEventListener('click', () => {
    const expand = memberRows[0].hidden;
    for (const row of memberRows) {
      if (row.classList.contains('issue-detail-row')) continue;
      row.hidden = !expand;
    }
    groupToggle.textContent = expand ? `Hide ${group.length} occurrences` : `Show ${group.length} occurrences`;
  });
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

  let groupSeq = 0;
  for (const group of groupCrossIssuesForDisplay(issues)) {
    if (group.length === 1) buildCrossIssueRow(group[0], table);
    else buildCrossIssueGroupRow(group, table, `cross-issue-group-${groupSeq++}`);
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
  showOnly(crossIssuesPanel);
  crossIssuesContent.innerHTML = '<p>Loading…</p>';
  await loadAllIssues();
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
    // Same "here's what you just created" moment as the single-app form,
    // extended to every row a bulk import produced (scrolling to the first
    // one — jumping to each in turn would fight the user for the scrollbar).
    body.created.forEach((entry, i) => markRowJustAdded(entry.id, i === 0));
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
const ignorePatternNewReason = document.getElementById('ignore-pattern-new-reason');
const ignorePatternNewExpires = document.getElementById('ignore-pattern-new-expires');
const ignorePatternAddBtn = document.getElementById('ignore-pattern-add-btn');
const ignorePatternStatus = document.getElementById('ignore-pattern-status');

function renderIgnorePatterns(appId, patterns) {
  ignorePatternsTable.innerHTML = '<tr><th>Pattern</th><th>Reason</th><th>Expires</th><th>By</th><th></th></tr>';
  for (const entry of patterns) {
    const tr = document.createElement('tr');
    const patternTd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = entry.pattern;
    patternTd.appendChild(code);
    const reasonTd = document.createElement('td');
    reasonTd.textContent = entry.reason || '—';
    reasonTd.style.color = 'var(--muted)';
    const expiresTd = document.createElement('td');
    const expired = entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now();
    expiresTd.textContent = entry.expiresAt ? new Date(entry.expiresAt).toLocaleDateString() : '—';
    if (expired) { expiresTd.style.color = 'var(--err)'; expiresTd.title = 'Expired — no longer skipping this pattern.'; }
    const byTd = document.createElement('td');
    byTd.textContent = entry.createdBy || 'unknown';
    byTd.style.color = 'var(--muted)';
    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/apps/${appId}/ignore-patterns/${entry.id}`, { method: 'DELETE' }).then((r) => r.json());
      renderIgnorePatterns(appId, updated);
      loadSuppressionAuditLog(appId);
    });
    actionTd.appendChild(removeBtn);
    tr.append(patternTd, reasonTd, expiresTd, byTd, actionTd);
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
  const reason = ignorePatternNewReason.value.trim();
  const expiresAt = ignorePatternNewExpires.value;
  if (!pattern) return;
  ignorePatternStatus.classList.remove('success', 'error');
  try {
    const updated = await fetch(`/api/apps/${currentDetailId}/ignore-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, reason, expiresAt }),
    }).then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `Request failed (${r.status})`); });
      return r.json();
    });
    renderIgnorePatterns(currentDetailId, updated);
    loadSuppressionAuditLog(currentDetailId);
    ignorePatternNewInput.value = '';
    ignorePatternNewReason.value = '';
    ignorePatternNewExpires.value = '';
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
const suppressionRuleNewReason = document.getElementById('suppression-rule-new-reason');
const suppressionRuleNewExpires = document.getElementById('suppression-rule-new-expires');
const suppressionRuleAddBtn = document.getElementById('suppression-rule-add-btn');
const suppressionRuleStatus = document.getElementById('suppression-rule-status');

function renderSuppressionRules(appId, rules) {
  suppressionRulesTable.innerHTML = '<tr><th>Category</th><th>File Pattern</th><th>Reason</th><th>Expires</th><th>By</th><th></th></tr>';
  for (const rule of rules) {
    const tr = document.createElement('tr');
    const catTd = document.createElement('td');
    catTd.textContent = rule.category === 'any' ? 'Any' : rule.category;
    const patternTd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = rule.filePattern;
    patternTd.appendChild(code);
    const reasonTd = document.createElement('td');
    reasonTd.textContent = rule.reason || '—';
    reasonTd.style.color = 'var(--muted)';
    const expiresTd = document.createElement('td');
    const expired = rule.expiresAt && new Date(rule.expiresAt).getTime() < Date.now();
    expiresTd.textContent = rule.expiresAt ? new Date(rule.expiresAt).toLocaleDateString() : '—';
    if (expired) { expiresTd.style.color = 'var(--err)'; expiresTd.title = 'Expired — no longer suppressing matches.'; }
    const byTd = document.createElement('td');
    byTd.textContent = rule.createdBy || 'unknown';
    byTd.style.color = 'var(--muted)';
    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const updated = await fetch(`/api/apps/${appId}/suppression-rules/${rule.id}`, { method: 'DELETE' }).then((r) => r.json());
      renderSuppressionRules(appId, updated);
      loadSuppressionAuditLog(appId);
    });
    actionTd.appendChild(removeBtn);
    tr.append(catTd, patternTd, reasonTd, expiresTd, byTd, actionTd);
    suppressionRulesTable.appendChild(tr);
  }
}

async function loadSuppressionRules(appId) {
  const rules = await fetch(`/api/apps/${appId}/suppression-rules`).then((r) => r.json());
  renderSuppressionRules(appId, rules);
}

const suppressionAuditLogTable = document.getElementById('suppression-audit-log-table');

async function loadSuppressionAuditLog(appId) {
  if (!suppressionAuditLogTable) return;
  const log = await fetch('/api/apps/suppression-audit-log').then((r) => r.json()).catch(() => []);
  const forApp = log.filter((entry) => entry.appId === appId);
  suppressionAuditLogTable.innerHTML = '<tr><th>When</th><th>Who</th><th>Action</th><th>Kind</th><th>Pattern</th><th>Reason</th></tr>';
  if (!forApp.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty-state';
    td.textContent = 'No suppression activity recorded for this app yet.';
    tr.appendChild(td);
    suppressionAuditLogTable.appendChild(tr);
    return;
  }
  for (const entry of forApp) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(entry.at).toLocaleString(),
      entry.by || 'unknown',
      entry.action,
      entry.kind === 'ignore-pattern' ? 'Ignore Pattern' : 'Suppression Rule',
      entry.filePattern || '—',
      entry.reason || '—',
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    suppressionAuditLogTable.appendChild(tr);
  }
}

suppressionRuleAddBtn.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const category = suppressionRuleNewCategory.value.trim();
  const filePattern = suppressionRuleNewPattern.value.trim();
  const reason = suppressionRuleNewReason.value.trim();
  const expiresAt = suppressionRuleNewExpires.value;
  if (!filePattern) return;
  suppressionRuleStatus.classList.remove('success', 'error');
  try {
    const res = await fetch(`/api/apps/${currentDetailId}/suppression-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, filePattern, reason, expiresAt }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    await loadSuppressionRules(currentDetailId);
    loadSuppressionAuditLog(currentDetailId);
    suppressionRuleNewCategory.value = '';
    suppressionRuleNewPattern.value = '';
    suppressionRuleNewReason.value = '';
    suppressionRuleNewExpires.value = '';
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

// Where each checklist item's "take me there" link should land — reused
// across renders rather than rebuilt per item, since the destinations are
// fixed regardless of which app is open.
const ONBOARDING_JUMP_TARGETS = {
  firstFix: () => {
    const issuesBtn = Array.from(document.querySelectorAll('#wiki-links button')).find((b) => b.textContent === 'Issues');
    if (issuesBtn) issuesBtn.click();
  },
  ciGate: () => {
    const gateSelect = document.querySelector('.gate-select');
    if (gateSelect) gateSelect.closest('.detail-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  suppression: () => {
    const details = document.getElementById('suppression-rules-details');
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
};

function renderOnboardingChecklist(appId, checklist) {
  onboardingSummaryBadge.textContent = `${checklist.doneCount}/${checklist.total}`;
  onboardingSummaryBadge.className = 'tag-badge ' + (checklist.complete ? 'status-done' : '');
  onboardingChecklistEl.innerHTML = '';
  for (const item of checklist.items) {
    const li = document.createElement('li');
    li.className = 'onboarding-item';

    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.done;
    if (!item.manualField || item.auto) {
      checkbox.disabled = true;
      label.title = item.auto ? 'Derived automatically from real activity on this app.' : 'Not yet done.';
    } else {
      checkbox.addEventListener('change', async () => {
        const updated = await fetch(`/api/apps/${appId}/onboarding`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [item.manualField]: checkbox.checked }),
        }).then((r) => r.json());
        renderOnboardingChecklist(appId, updated);
      });
    }
    const text = document.createElement('span');
    text.textContent = item.label + (item.done && item.auto ? ' ✓' : '');
    label.append(checkbox, text);
    li.appendChild(label);

    const why = document.createElement('p');
    why.className = 'onboarding-why';
    why.textContent = item.why;
    li.appendChild(why);

    if (!item.done) {
      const ctaRow = document.createElement('p');
      ctaRow.className = 'onboarding-cta';
      const ctaText = document.createElement('span');
      ctaText.textContent = item.cta;
      ctaRow.appendChild(ctaText);
      const jump = ONBOARDING_JUMP_TARGETS[item.id];
      if (jump) {
        ctaRow.appendChild(document.createTextNode(' '));
        const jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'link-button';
        jumpBtn.textContent = 'Take me there →';
        jumpBtn.addEventListener('click', jump);
        ctaRow.appendChild(jumpBtn);
      }
      li.appendChild(ctaRow);
    }

    onboardingChecklistEl.appendChild(li);
  }
}

async function loadOnboardingChecklist(appId) {
  const checklist = await fetch(`/api/apps/${appId}/onboarding`).then((r) => r.json());
  renderOnboardingChecklist(appId, checklist);
}

// ---- Public read-only share link ----

async function loadShareStatus(appId, container) {
  try {
    const { enabled, token } = await fetch(`/api/apps/${appId}/share`).then((r) => r.json());
    renderShareStatus(appId, container, enabled, token);
  } catch (err) {
    container.textContent = 'Could not load share status: ' + err.message;
  }
}

function renderShareStatus(appId, container, enabled, token) {
  container.innerHTML = '';
  const canManage = hasRole('admin');

  if (!enabled) {
    const note = document.createElement('span');
    note.style.color = 'var(--muted)';
    note.textContent = 'Not shared. ';
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'secondary';
    enableBtn.textContent = 'Enable Sharing';
    enableBtn.disabled = !canManage;
    if (!canManage) enableBtn.title = 'Requires the "admin" role or higher.';
    enableBtn.addEventListener('click', async () => {
      const res = await fetch(`/api/apps/${appId}/share`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) { container.textContent = 'Error: ' + body.error; return; }
      renderShareStatus(appId, container, true, body.token);
    });
    container.append(note, enableBtn);
    return;
  }

  const url = `${location.origin}/share.html?token=${token}`;
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.readOnly = true;
  urlInput.value = url;
  urlInput.style.width = '55%';
  urlInput.addEventListener('click', () => urlInput.select());

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'secondary';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      urlInput.select();
    }
  });

  const revokeBtn = document.createElement('button');
  revokeBtn.type = 'button';
  revokeBtn.className = 'secondary';
  revokeBtn.textContent = 'Revoke';
  revokeBtn.disabled = !canManage;
  if (!canManage) revokeBtn.title = 'Requires the "admin" role or higher.';
  revokeBtn.addEventListener('click', async () => {
    await fetch(`/api/apps/${appId}/share`, { method: 'DELETE' });
    renderShareStatus(appId, container, false, null);
  });

  container.append(urlInput, document.createTextNode(' '), copyBtn, document.createTextNode(' '), revokeBtn);
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

// ---- openDetail card renderers ----
// Split out of openDetail's withViewTransition callback (was a single
// ~260-line arrow function with cyclomatic complexity 36 — every card's
// branches summed into one function). Each renderer below is its own
// top-level function, so its branches count against its own (much lower)
// complexity instead of the callback's.

// Feature 11: cross-environment comparison — apps sharing this app's name
// but registered under a different Environment (e.g. "Billing API" in
// Staging vs Production) are almost always the same underlying service
// scanned twice, so surface a one-click compare against each.
function renderCrossEnvironmentRow(app) {
  const siblings = allApps.filter((a) => a.id !== app.id && a.name.toLowerCase() === app.name.toLowerCase());
  if (!siblings.length) return;
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
  detailMetaOverview.append(crossEnvDt, crossEnvDd);
}

// ---- Overview card: read-only facts about what this app is ----
function renderOverviewCard(app) {
  detailMetaOverview.append(...fieldRow('Path / Repo', app.pathOrRepo));
  detailMetaOverview.append(...fieldRow('Purpose', app.purpose));
  detailMetaOverview.append(...fieldRow('Owner / Team', app.owner));
  detailMetaOverview.append(...badgeFieldRow('Environment', app.environment, ENV_BADGE_CLASS[app.environment] || 'env-internal', 'env-badge'));

  renderCrossEnvironmentRow(app);

  detailMetaOverview.append(...fieldRow('Tech Stack', app.techStack));
  detailMetaOverview.append(...fieldRow('Tags', (app.tags || []).join(', ')));
  detailMetaOverview.append(...fieldRow('Notes', app.notes));
  detailMetaOverview.append(...fieldRow('Scan Mode', app.scanMode === 'deep' ? 'Deep (LLM-assisted)' : 'Static (fast, pattern-based)'));
  detailMetaOverview.append(...badgeFieldRow('Status', app.status, statusClass(app.status), 'status-badge'));

  // Feature 14: scan performance metrics — duration and files processed
  // (cache hits + misses) from the most recent scan.
  if (app.stats && app.stats.durationMs !== undefined) {
    detailMetaOverview.append(...fieldRow('Last Scan Performance', `${formatDuration(app.stats.durationMs)} — ${app.stats.filesProcessed} file(s) processed (${app.stats.cacheHits} cached, ${app.stats.cacheMisses} reprocessed)`));
  }

  detailMetaOverview.append(...fieldRow('Wiki Location', app.wikiLink));
  detailMetaOverview.append(...fieldRow('Last Scanned', app.scannedAt ? new Date(app.scannedAt).toLocaleString() : ''));
  if (app.lastScannedRef) {
    const refText = (app.lastScannedRef.branch ? `${app.lastScannedRef.branch} @ ` : '') + app.lastScannedRef.commit
      + (app.lastScannedRef.ref && app.lastScannedRef.ref !== app.lastScannedRef.branch ? ` (requested: ${app.lastScannedRef.ref})` : '');
    detailMetaOverview.append(...fieldRow('Last Scanned Ref', refText));
  }
  if (app.error) detailMetaOverview.append(...fieldRow('Error', app.error));
}

// Feature: scan a specific branch/tag/commit instead of always the
// default branch (repo URL targets only — a local path ignores this).
function renderGitRefField(app, id) {
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
  detailMetaSettings.append(gitRefDt, gitRefDd);
}

// Feature 6: the CLI's --fail-on gating threshold, surfaced here as an
// editable per-app setting instead of CLI-only, with a live pass/fail
// readout against the latest scan so the setting isn't just inert text.
function renderGateField(app, id) {
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
  detailMetaSettings.append(gateDt, gateDd);
  refreshGateStatus();
}

// Feature: on-completion webhook, plus the severity threshold that
// gates it (see notifySeverity in db.js / notify.js) — was hardcoded to
// "High" (Critical+High), now editable per app like gitRef/blur-to-save.
function renderNotifyField(app, id) {
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
  detailMetaSettings.append(notifyDt, notifyDd);
}

// Feature 12: weekly digest — a periodic rollup, opt-in and editable
// per app, distinct from the on-completion webhook notification.
function renderDigestField(app, id) {
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
  detailMetaSettings.append(digestDt, digestDd);
}

// ---- Danger Zone card: destructive or exposure-widening actions ----

// Feature 17: archiving retires an app from the default list/portfolio
// rollups without touching its stored scan history — reversible from
// here at any time.
function renderArchiveField(app, id) {
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
  detailMetaDanger.append(archiveDt, archiveDd);
}

async function openDetail(id) {
  currentDetailId = id;
  const app = await api(`/${id}`);
  currentDetailApp = app;
  withViewTransition(() => {
    showOnly(detailPanel);
    breadcrumbCurrent.textContent = app.name;
    detailName.textContent = app.name;
    detailMetaOverview.innerHTML = '';
    detailMetaSettings.innerHTML = '';
    detailMetaDanger.innerHTML = '';
    editAppForm.hidden = true;
    detailMetaOverview.hidden = false;
    editAppStatus.textContent = '';
    const SCHEDULE_LABELS = { 0: 'Off', 60: 'Hourly', 1440: 'Daily', 10080: 'Weekly' };

    renderOverviewCard(app);
    renderGitRefField(app, id);
    renderGateField(app, id);
    detailMetaSettings.append(...fieldRow('Auto-rescan', SCHEDULE_LABELS[app.scheduleMinutes] || `Every ${app.scheduleMinutes} min`));
    renderNotifyField(app, id);
    renderDigestField(app, id);
    renderArchiveField(app, id);

    // Public read-only share link — unauthenticated, scoped to just this
    // app's wiki (see src/routes/share.js). Generating/revoking requires
    // admin, same weight as the other admin-only actions.
    const shareDt = document.createElement('dt');
    shareDt.textContent = 'Public Share Link';
    const shareDd = document.createElement('dd');
    const shareStatus = document.createElement('span');
    shareStatus.textContent = 'Loading…';
    shareDd.appendChild(shareStatus);
    detailMetaDanger.append(shareDt, shareDd);
    loadShareStatus(id, shareDd);

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
  loadSuppressionAuditLog(id);
  loadOnboardingChecklist(id);

  if (app.status === 'Done' && app.wikiLink) {
    closeScanStream();
    wikiNav.hidden = false;
    await renderWikiNav(id, app);
    setActiveWikiNav('Home.md');
    await loadWikiPage(id, 'Home.md');
  } else if (app.status === 'Scanning') {
    wikiNav.hidden = true;
    attachScanStream(id);
  } else if (app.status === 'Failed') {
    // Feature 20: distinct Failed handling — the full error detail and a
    // one-click Retry Scan right where the user is already looking,
    // instead of a bare "see error above" pointing back at the summary row.
    wikiNav.hidden = true;
    wikiView.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'scan-failed-box';
    const heading = document.createElement('h3');
    heading.textContent = 'Scan Failed';
    const errText = document.createElement('p');
    errText.className = 'scan-failed-message';
    errText.textContent = app.error || 'No error detail was recorded.';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = 'Retry Scan';
    retryBtn.addEventListener('click', () => triggerScan(id));
    box.append(heading, errText, retryBtn);
    wikiView.appendChild(box);
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

// The wiki nav is the app's primary in-context navigation (13+ same-shaped
// buttons across several groups) and previously gave no indication of which
// page you were actually on — every button looked identical whether or not
// its page was the one currently showing in wikiView. `key` marks a button
// as a navigation destination (pages, tools, custom sections); action
// buttons like "Export Static Site" pass no key and are never marked active.
function setActiveWikiNav(key) {
  wikiLinks.querySelectorAll('button[data-nav-key]').forEach((b) => {
    b.classList.toggle('wiki-nav-active', b.dataset.navKey === key);
  });
}

function wikiNavGroup(items) {
  const group = document.createElement('div');
  group.className = 'wiki-nav-group';
  for (const [label, handler, key] of items) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = label;
    if (key) btn.dataset.navKey = key;
    btn.addEventListener('click', () => {
      if (key) setActiveWikiNav(key);
      handler();
    });
    group.appendChild(btn);
  }
  return group;
}

// A native <select> jump-menu rather than a custom dropdown component — the
// browser already solves positioning/keyboard/overlay-escape for free, and
// the currently-picked item's label showing in the closed select doubles as
// a lightweight "you're here" cue without a second visual system.
function wikiNavMoreDropdown(items) {
  const wrap = document.createElement('span');
  wrap.className = 'wiki-nav-more';
  const select = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'More ▾';
  select.appendChild(placeholder);
  for (const [label, , key] of items) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const picked = items.find(([, , key]) => key === select.value);
    select.value = '';
    if (!picked) return;
    const [, handler, key] = picked;
    setActiveWikiNav(key);
    handler();
  });
  wrap.appendChild(select);
  return wrap;
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
  ].map(([label, p]) => [label, () => loadWikiPage(id, p), p]);

  const tools = [
    ['Issues', () => loadIssuesInteractive(id), 'Issues'],
    ['Env Vars', () => loadEnvVarsInteractive(id), 'Env Vars'],
    ['History', () => loadHistory(id), 'History'],
  ];

  // Less frequently reached for than the tabs above — grouped under one
  // "More" jump-menu instead of three more same-weight buttons in the row.
  const moreItems = [
    ['Data Dictionary', () => loadDictionaryInteractive(id), 'Data Dictionary'],
    ['Process Flows', () => loadProcessFlowsView(id), 'Process Flows'],
    ['Dependency Graph', () => loadGraphView(id), 'Dependency Graph'],
  ];

  const actions = [['Export Static Site', () => exportStaticSite(id)]];
  const isRepo = /^https?:\/\/|\.git$/.test(app.pathOrRepo || '');
  if (isRepo) actions.push(['Push to Wiki Repo', () => pushGithubWiki(id)]);

  wikiLinks.append(wikiNavGroup(pages), wikiNavGroup(tools), wikiNavMoreDropdown(moreItems));

  // Feature 10: custom wiki sections — team-added markdown pages that live
  // outside the generated wiki/ dir, so they persist across rescans. Own
  // nav group since the count is per-app and open-ended.
  try {
    const customSections = await api(`/${id}/wiki-sections`);
    if (customSections.length) {
      wikiLinks.appendChild(wikiNavGroup(customSections.map((s) => [s.title, () => loadCustomSection(id, s.slug), `custom:${s.slug}`])));
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
      setActiveWikiNav('Home.md');
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
        setActiveWikiNav(`custom:${section.slug}`);
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
    setActiveWikiNav(`custom:${section.slug}`);
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

// The triage select otherwise carries zero color signal — every state
// (including "fixed") renders as the same neutral control, so telling
// "still open" from "resolved" means reading the text in every row instead
// of scanning for it. Same restrained pattern as env-select-production/
// -staging: border + text color only, no fill. "open" and "false_positive"
// stay neutral on purpose — open is the default/common case (nothing to
// flag), and false_positive already reads as dismissed via the row's
// existing opacity fade.
function triageSelectClass(state) {
  if (state === 'fixed') return 'triage-select-ok';
  if (state === 'acknowledged') return 'triage-select-info';
  return '';
}

const ISSUE_ROW_SUMMARY_TRUNCATE_AT = 75;
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// A single issue's row + its hidden detail row — extracted so the same
// rendering can be reused both for a standalone finding and for each member
// of a collapsed duplicate-finding group (see groupIssuesForDisplay below).
// ---- buildIssueRow helpers ----
// Split out of buildIssueRow (was one function with cyclomatic complexity
// 24 — the primary row, detail row, and tracker-push section's branches all
// summed together). Each piece below builds one cell or one dl section.

function buildIssueSummaryCell(issue) {
  const summaryTd = document.createElement('td');
  summaryTd.className = 'cell-summary';
  const isLong = issue.summary.length > ISSUE_ROW_SUMMARY_TRUNCATE_AT;
  const summarySpan = document.createElement('span');
  summarySpan.textContent = isLong ? issue.summary.slice(0, ISSUE_ROW_SUMMARY_TRUNCATE_AT - 1).trimEnd() + '…' : issue.summary;
  summaryTd.appendChild(summarySpan);
  summaryTd.appendChild(document.createTextNode(' '));
  const detailsBtn = document.createElement('button');
  detailsBtn.type = 'button';
  detailsBtn.className = 'link-button details-toggle';
  detailsBtn.textContent = 'Show details';
  summaryTd.appendChild(detailsBtn);
  return { summaryTd, detailsBtn };
}

function buildIssueTriageCell(issue, id) {
  const triageTd = document.createElement('td');
  const select = document.createElement('select');
  select.className = triageSelectClass(issue.triage.state);
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
  return triageTd;
}

function buildIssuePrimaryRow(issue, id) {
  const tr = document.createElement('tr');
  tr.dataset.source = issue.source || 'static';
  tr.dataset.severity = issue.severity;
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
  tr.appendChild(categoryTd);

  const fileTd = document.createElement('td');
  fileTd.className = 'cell-file';
  fileTd.textContent = issue.file.split('/').pop();
  fileTd.title = issue.file;
  tr.appendChild(fileTd);

  const lineTd = document.createElement('td');
  lineTd.textContent = String(issue.line);
  tr.appendChild(lineTd);

  const { summaryTd, detailsBtn } = buildIssueSummaryCell(issue);
  tr.appendChild(summaryTd);
  tr.appendChild(buildIssueTriageCell(issue, id));

  return { tr, detailsBtn };
}

function buildIssueDetailEntries(issue) {
  const dl = document.createElement('dl');
  dl.className = 'issue-detail';
  const addEntry = (term, value) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  };
  const addCodeEntry = (term, code) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    const pre = document.createElement('pre');
    pre.className = 'issue-code-example';
    pre.textContent = code;
    dd.appendChild(pre);
    dl.append(dt, dd);
  };
  addEntry('File', issue.file);
  addEntry('Summary', issue.summary);
  if (issue.suggestedFix) addEntry('Suggested Fix', issue.suggestedFix);
  if (issue.cwe) addEntry('CWE / OWASP', issue.cwe);
  if (issue.proposedFix) {
    addCodeEntry('Proposed Fix (Deep Scan)', issue.proposedFix.diff);
    if (issue.proposedFix.explanation) addEntry('Why this fix', issue.proposedFix.explanation);
  } else if (issue.codeExample) {
    addCodeEntry('Before', issue.codeExample.before);
    addCodeEntry('After', issue.codeExample.after);
  }
  if (issue.triage.note) addEntry('Triage Note', issue.triage.note);
  return dl;
}

function appendAssigneeEntry(dl, issue, id) {
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
}

function buildTrackerPushControls(issue, id, app) {
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
  const frag = document.createDocumentFragment();
  frag.append(pushBtn, document.createTextNode(' '), pushStatus);
  return frag;
}

// Feature 15: push this issue to the app's configured external
// tracker (GitHub Issues / Jira). Hidden entirely when no tracker is
// configured; once linked, shows a link instead of a push button so
// it can't be filed twice from here.
function appendTrackerEntry(dl, issue, id, app) {
  if (!app.trackerType || app.trackerType === 'none') return;
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
    trackerDd.appendChild(buildTrackerPushControls(issue, id, app));
  }
  dl.append(trackerDt, trackerDd);
}

function appendFixPromptEntry(dl, issue) {
  const fixDt = document.createElement('dt');
  fixDt.textContent = 'Fix';
  const fixDd = document.createElement('dd');
  fixDd.appendChild(buildCopyPromptButton('Copy Claude Code Prompt', buildIssueFixPrompt(issue)));
  dl.append(fixDt, fixDd);
}

function buildIssueDetailRow(issue, id, app, sourceValue) {
  const detailTr = document.createElement('tr');
  detailTr.className = 'issue-detail-row';
  detailTr.dataset.source = sourceValue;
  detailTr.hidden = true;
  const detailTd = document.createElement('td');
  detailTd.colSpan = 6;
  const dl = buildIssueDetailEntries(issue);
  appendAssigneeEntry(dl, issue, id);
  appendTrackerEntry(dl, issue, id, app);
  appendFixPromptEntry(dl, issue);
  detailTd.appendChild(dl);
  detailTr.appendChild(detailTd);
  return detailTr;
}

function buildIssueRow(issue, table, id, app) {
  const { tr, detailsBtn } = buildIssuePrimaryRow(issue, id);
  table.appendChild(tr);

  const detailTr = buildIssueDetailRow(issue, id, app, tr.dataset.source);
  table.appendChild(detailTr);

  detailsBtn.addEventListener('click', () => {
    detailTr.hidden = !detailTr.hidden;
    detailsBtn.textContent = detailTr.hidden ? 'Show details' : 'Hide details';
  });
}

// Same category + same displayed file name reads as duplicate rows even
// when the underlying files genuinely differ (e.g. five distinct route.ts
// files under different directories, each individually flagged) — the File
// column only ever shows the basename. Grouping by that same pair collapses
// what would otherwise be N visually-identical rows into one, with the
// individual (still individually triage-able) rows one click away.
function groupIssuesForDisplay(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const key = issue.category + '|' + issue.file.split('/').pop();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  return [...groups.values()];
}

function buildIssueGroupRow(group, table, id, app, groupId) {
  const worst = group.reduce((a, b) => (SEVERITY_RANK[b.severity] < SEVERITY_RANK[a.severity] ? b : a));
  const basename = group[0].file.split('/').pop();
  const sameSource = group.every((i) => (i.source || 'static') === (group[0].source || 'static'));

  const groupTr = document.createElement('tr');
  groupTr.className = 'issue-group-row';
  groupTr.dataset.severity = worst.severity;
  if (sameSource) groupTr.dataset.source = group[0].source || 'static';

  const sevTd = document.createElement('td');
  const sevBadge = document.createElement('span');
  sevBadge.className = 'severity-badge ' + (SEVERITY_BADGE_CLASS[worst.severity] || 'severity-low');
  sevBadge.textContent = worst.severity;
  sevTd.appendChild(sevBadge);
  groupTr.appendChild(sevTd);

  const catTd = document.createElement('td');
  catTd.className = 'cell-category';
  catTd.textContent = group[0].category;
  groupTr.appendChild(catTd);

  const fileTd = document.createElement('td');
  fileTd.className = 'cell-file';
  fileTd.textContent = `${basename} (×${group.length})`;
  groupTr.appendChild(fileTd);

  groupTr.appendChild(document.createElement('td')); // Line varies per occurrence

  const summaryTd = document.createElement('td');
  summaryTd.className = 'cell-summary';
  const groupToggle = document.createElement('button');
  groupToggle.type = 'button';
  groupToggle.className = 'link-button details-toggle';
  groupToggle.textContent = `Show ${group.length} occurrences`;
  summaryTd.appendChild(groupToggle);
  summaryTd.appendChild(document.createTextNode(' '));
  summaryTd.appendChild(buildCopyPromptButton('Copy Fix Prompt (All)', buildIssueGroupFixPrompt(group)));
  groupTr.appendChild(summaryTd);

  // Bulk triage: one action for the whole group instead of the per-finding
  // dropdown N times — the exact "48 near-duplicate rows" problem this
  // grouping was built to fix would otherwise just move from "read 48 rows"
  // to "click 48 dropdowns".
  const bulkTriageTd = document.createElement('td');
  const bulkSelect = document.createElement('select');
  bulkSelect.className = 'bulk-triage-select';
  const bulkPlaceholder = document.createElement('option');
  bulkPlaceholder.value = '';
  bulkPlaceholder.textContent = `Set all ${group.length} to…`;
  bulkSelect.appendChild(bulkPlaceholder);
  for (const s of TRIAGE_STATES) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    bulkSelect.appendChild(opt);
  }
  bulkSelect.addEventListener('change', async () => {
    const state = bulkSelect.value;
    if (!state) return;
    await api(`/${id}/issues/triage-bulk`, { method: 'POST', body: JSON.stringify({ fingerprints: group.map((i) => i.fingerprint), state }) });
    loadIssuesInteractive(id);
  });
  bulkTriageTd.appendChild(bulkSelect);
  groupTr.appendChild(bulkTriageTd);
  table.appendChild(groupTr);

  const memberRows = [];
  for (const issue of group) {
    const before = table.rows.length;
    buildIssueRow(issue, table, id, app);
    for (let i = before; i < table.rows.length; i++) {
      const row = table.rows[i];
      row.hidden = true;
      row.dataset.issueGroup = groupId;
      memberRows.push(row);
    }
  }
  groupToggle.addEventListener('click', () => {
    const expand = memberRows[0].hidden;
    for (const row of memberRows) {
      // A member's own detail row stays collapsed even as the group opens —
      // only that row's own "Show details" toggle should reveal it.
      if (row.classList.contains('issue-detail-row')) continue;
      row.hidden = !expand;
    }
    groupToggle.textContent = expand ? `Hide ${group.length} occurrences` : `Show ${group.length} occurrences`;
  });
}

async function loadIssuesInteractive(id) {
  try {
    const [issues, app] = await Promise.all([api(`/${id}/issues`), api(`/${id}`)]);
    if (!issues.length) {
      withViewTransition(() => { wikiView.innerHTML = '<p>No issues recorded yet — run a scan first.</p>'; });
      return;
    }
    issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const table = document.createElement('table');
    table.className = 'issues-table fit-container';
    table.innerHTML = '<tr><th>Severity</th><th>Category</th><th>File</th><th>Line</th><th>Summary</th><th>Triage</th></tr>';

    let groupSeq = 0;
    for (const group of groupIssuesForDisplay(issues)) {
      if (group.length === 1) buildIssueRow(group[0], table, id, app);
      else buildIssueGroupRow(group, table, id, app, `issue-group-${groupSeq++}`);
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
          // Grouped members are governed by their group's toggle, not this
          // filter directly — filtering the (ungrouped) top-level rows and
          // group headers is enough; a filtered-out group's members stay
          // reachable only by first expanding a header that itself matched.
          if (row.dataset.issueGroup) continue;
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
        const modelHeading = document.createElement('h3');
        modelHeading.textContent = model.name;
        const modelMeta = document.createElement('p');
        modelMeta.style.color = 'var(--muted)';
        modelMeta.style.fontSize = '0.85rem';
        modelMeta.append(model.source + ' — ');
        const modelFileCode = document.createElement('code');
        modelFileCode.textContent = model.file;
        modelMeta.appendChild(modelFileCode);
        section.append(modelHeading, modelMeta);
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
        const groupHeading = document.createElement('h3');
        groupHeading.textContent = `${group.name} (${group.routes.length} route${group.routes.length === 1 ? '' : 's'})`;
        section.appendChild(groupHeading);
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
        for (const el of Object.values(nodeEls)) { el.dataset.active = '0'; el.style.opacity = '1'; }
        for (const line of edgeLines) line.setAttribute('stroke', 'var(--border)');
        searchInput.value = '';
        searchStatus.textContent = '';
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

    // Feature 18: dependency graph search — jump to/highlight a specific
    // file node instead of hunting for it by eye among a dense graph.
    // Reuses the same click-to-highlight styling (default edge color vs.
    // accent), just driven by a text match instead of a click.
    const searchStatus = document.createElement('span');
    searchStatus.className = 'graph-search-status';
    function applyGraphSearch(query) {
      const q = query.trim().toLowerCase();
      for (const line of edgeLines) line.setAttribute('stroke', 'var(--border)');
      if (!q) {
        for (const el of Object.values(nodeEls)) { el.style.opacity = '1'; el.dataset.active = '0'; }
        searchStatus.textContent = '';
        return;
      }
      const matchIds = g.nodes.map((n) => n.id).filter((nid) => nid.toLowerCase().includes(q));
      const matchSet = new Set(matchIds);
      for (const [nid, el] of Object.entries(nodeEls)) {
        const isMatch = matchSet.has(nid);
        el.style.opacity = isMatch ? '1' : '0.15';
        el.dataset.active = isMatch ? '1' : '0';
      }
      for (const line of edgeLines) {
        if (matchSet.has(line.dataset.from) || matchSet.has(line.dataset.to)) line.setAttribute('stroke', 'var(--accent-text)');
      }
      searchStatus.textContent = matchIds.length
        ? `${matchIds.length} match(es).`
        : 'No matching files.';
      if (matchIds.length) {
        const first = nodeEls[matchIds[0]];
        if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search files in this graph...';
    searchInput.className = 'graph-search-input';
    searchInput.addEventListener('input', () => applyGraphSearch(searchInput.value));

    withViewTransition(() => {
      wikiView.innerHTML = `<h2>Dependency Graph</h2><p style="color:var(--muted);font-size:0.85rem">${g.nodes.length} file(s), ${g.edges.length} resolved import edge(s). Click a node to highlight its direct connections.</p>`;
      const searchRow = document.createElement('div');
      searchRow.className = 'graph-search-row';
      searchRow.append(searchInput, searchStatus);
      wikiView.appendChild(searchRow);
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
      // Feature 14: scan performance metrics — older snapshots predate
      // durationMs/filesProcessed, so fall back to an em dash instead of
      // showing "undefined" or "NaNs".
      const durationCell = s.stats.durationMs !== undefined ? formatDuration(s.stats.durationMs) : '—';
      const filesCell = s.stats.filesProcessed !== undefined ? s.stats.filesProcessed : '—';
      return `<tr><td>${new Date(s.scannedAt).toLocaleString()}</td><td>${s.stats.units}</td><td>${s.stats.models}</td><td>${s.stats.routes}</td>${issuesCell}<td>${durationCell}</td><td>${filesCell}</td></tr>`;
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
      tableWrap.innerHTML = `<table><tr><th>Scanned At</th><th>Units</th><th>Models</th><th>Routes</th><th>Issues</th><th>Duration</th><th>Files</th></tr>${rows}</table>`;
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

// Feature 16: inline wiki editing beyond the Data Dictionary. Change-Log.md
// and Progress.md are auto-generated logs (scan mechanics, not authored
// prose) — editing them wouldn't make sense, since the next scan's log
// entry would just get appended after whatever a human wrote. Every other
// generated page (Home, Architecture, Data Model, Setup, and any
// monorepo sub-package's copies of the same) is eligible.
const WIKI_EDIT_EXCLUDED = new Set(['Change-Log.md', 'Progress.md']);

function isWikiPageEditable(wikiPath) {
  const basename = wikiPath.includes('/') ? wikiPath.slice(wikiPath.lastIndexOf('/') + 1) : wikiPath;
  return !WIKI_EDIT_EXCLUDED.has(basename);
}

async function loadWikiPage(id, wikiPath) {
  try {
    const { path: resolvedPath, content, overridden, updatedAt } = await api(`/${id}/wiki-file?path=${encodeURIComponent(wikiPath)}`);
    currentWikiDir = resolvedPath.includes('/') ? resolvedPath.slice(0, resolvedPath.lastIndexOf('/')) : '';
    const html = renderMarkdown(content, currentWikiDir, id);
    withViewTransition(() => {
      wikiView.innerHTML = html;
      if (wikiPath === 'Data-Model.md') truncateFileColumns(wikiView);
      if (isWikiPageEditable(resolvedPath)) {
        wikiView.appendChild(renderWikiEditToolbar(id, resolvedPath, content, overridden, updatedAt));
      }
      // Must run inside this callback, not after withViewTransition(...)
      // returns — document.startViewTransition() invokes its update
      // callback asynchronously (after capturing the "before" snapshot), so
      // code sequenced after the call runs before wikiView.innerHTML is
      // actually applied and finds no <pre class="mermaid"> to render yet.
      renderMermaidDiagrams(wikiView);
    });
  } catch (err) {
    wikiView.textContent = 'Could not load page: ' + err.message;
  }
}

function renderWikiEditToolbar(id, pagePath, content, overridden, updatedAt) {
  const wrap = document.createElement('div');
  wrap.className = 'wiki-edit-toolbar';

  if (overridden) {
    const banner = document.createElement('p');
    banner.className = 'wiki-override-banner';
    banner.textContent = `Manually edited (${new Date(updatedAt).toLocaleString()}) — showing the saved version, not regenerated from the latest scan.`;
    wrap.appendChild(banner);
  }

  const canEdit = hasRole('editor');
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'secondary';
  editBtn.textContent = overridden ? 'Edit Saved Version' : 'Edit This Page';
  editBtn.disabled = !canEdit;
  if (!canEdit) editBtn.title = 'Requires the "editor" role or higher to edit.';
  editBtn.addEventListener('click', () => renderWikiPageEditor(id, pagePath, content));
  wrap.appendChild(editBtn);

  if (overridden) {
    const revertBtn = document.createElement('button');
    revertBtn.type = 'button';
    revertBtn.className = 'secondary';
    revertBtn.textContent = 'Revert to Generated';
    revertBtn.disabled = !canEdit;
    if (!canEdit) revertBtn.title = 'Requires the "editor" role or higher.';
    revertBtn.addEventListener('click', async () => {
      await api(`/${id}/wiki-file/override?path=${encodeURIComponent(pagePath)}`, { method: 'DELETE' });
      loadWikiPage(id, pagePath);
    });
    wrap.appendChild(revertBtn);
  }

  return wrap;
}

function renderWikiPageEditor(id, pagePath, content) {
  withViewTransition(() => {
    wikiView.innerHTML = '';

    const note = document.createElement('p');
    note.className = 'bulk-help';
    note.textContent = 'Editing the raw Markdown for this page. Saving overrides the generated version — it persists across rescans until you revert it.';

    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.rows = 20;
    textarea.className = 'custom-section-textarea';

    const status = document.createElement('p');
    status.className = 'form-status';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      status.classList.remove('success', 'error');
      status.textContent = 'Saving…';
      try {
        await api(`/${id}/wiki-file/override`, { method: 'POST', body: JSON.stringify({ path: pagePath, content: textarea.value }) });
        loadWikiPage(id, pagePath);
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.classList.add('error');
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => loadWikiPage(id, pagePath));

    wikiView.append(note, textarea, status, saveBtn, cancelBtn);
  });
}

function escapeHtmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAndHighlightQuery(snippet, query) {
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
          p.innerHTML = `L${m.line}: ${escapeAndHighlightQuery(m.snippet, query)}`;
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

// Shared by the brand mark, the breadcrumb's "Home" link, and (formerly) six
// separate "← Back to list" buttons, one per subpage — all of them mean the
// same thing: leave whatever subpage/detail view is open and land on the
// literal top of the page (header + Portfolio Overview + list), not just the
// list panel scrolled to its own top edge, so this overrides showOnly's own
// scroll target.
function goHome() {
  closeScanStream();
  withViewTransition(() => showOnly(listPanel));
  currentDetailId = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

brandHomeLink.addEventListener('click', (e) => { e.preventDefault(); goHome(); });
breadcrumbHome.addEventListener('click', (e) => { e.preventDefault(); goHome(); });

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

// ---- renderMarkdown line handlers ----
// Split out of renderMarkdown (was one function with cyclomatic complexity
// 16 — every line type's detection logic in one if/else-if chain). Each
// tryX below inspects one line, mutates the shared `state`, and returns
// true if it consumed the line (equivalent to the original's `continue`).
// Order matters and mirrors the original exactly, including the two
// state-transitions that aren't tied to a "did we handle it" return value:
// tryTableRow closes a still-open table on the first non-table line, and
// closeMarkdownList runs for every line that reaches past the list check.

function closeMarkdownList(state) {
  if (state.listOpen) { state.html.push('</ul>'); state.listOpen = false; }
}

function tryCodeFence(line, state) {
  if (!line.startsWith('```')) return false;
  if (!state.inCode) {
    state.inCode = true;
    state.codeLang = line.slice(3).trim();
    state.html.push(state.codeLang === 'mermaid' ? '<pre class="mermaid">' : '<pre><code>');
  } else {
    state.html.push(state.codeLang === 'mermaid' ? '</pre>' : '</code></pre>');
    state.inCode = false;
    state.codeLang = '';
  }
  return true;
}

function tryCodeLine(line, state) {
  if (!state.inCode) return false;
  state.html.push(escapeHtml(line));
  return true;
}

function tryTableRow(line, state, baseDir, appId) {
  if (!/^\s*\|.*\|\s*$/.test(line)) {
    if (state.inTable) { state.html.push('</table>', '</div>'); state.inTable = false; }
    return false;
  }
  const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
  if (cells.every((c) => /^-+$/.test(c))) return true; // separator row
  if (!state.inTable) { state.html.push('<div class="table-scroll">', '<table>'); state.inTable = true; }
  const tag = state.html[state.html.length - 1] === '<table>' ? 'th' : 'td';
  state.html.push('<tr>' + cells.map((c) => `<${tag}>${inlineFormat(c, baseDir, appId)}</${tag}>`).join('') + '</tr>');
  return true;
}

function tryHeading(line, state, baseDir, appId) {
  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (!h) return false;
  closeMarkdownList(state);
  const level = h[1].length;
  state.html.push(`<h${level}>${inlineFormat(h[2], baseDir, appId)}</h${level}>`);
  return true;
}

function tryListItem(line, state, baseDir, appId) {
  if (!/^-\s+/.test(line)) return false;
  if (!state.listOpen) { state.html.push('<ul>'); state.listOpen = true; }
  state.html.push(`<li>${inlineFormat(line.replace(/^-\s+/, ''), baseDir, appId)}</li>`);
  return true;
}

function tryHrOrBlank(line, state) {
  if (line.trim() === '---') { state.html.push('<hr>'); return true; }
  if (line.trim() === '') { state.html.push(''); return true; }
  return false;
}

function renderMarkdown(md, baseDir, appId) {
  const state = { inTable: false, inCode: false, codeLang: '', listOpen: false, html: [] };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (tryCodeFence(line, state)) continue;
    if (tryCodeLine(line, state)) continue;
    if (tryTableRow(line, state, baseDir, appId)) continue;
    if (tryHeading(line, state, baseDir, appId)) continue;
    if (tryListItem(line, state, baseDir, appId)) continue;
    closeMarkdownList(state);

    if (tryHrOrBlank(line, state)) continue;

    state.html.push(`<p>${inlineFormat(line, baseDir, appId)}</p>`);
  }
  closeMarkdownList(state);
  if (state.inTable) state.html.push('</table>', '</div>');

  return state.html.join('\n');
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
