(function () {
  try {
    function jwtUsable(token) {
      try {
        var parts = String(token).split('.');
        if (parts.length !== 3) return false;
        var b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        var p = JSON.parse(atob(b));
        if (p.typ !== 'admin') return false;
        if (p.exp != null && Date.now() >= p.exp * 1000) return false;
        return true;
      } catch (e) { return false; }
    }
    var jwtRaw = (localStorage.getItem('barber_admin_jwt') || '').trim();
    var jwt = jwtUsable(jwtRaw) ? jwtRaw : '';
    var leg = (localStorage.getItem('barber_admin_token') || '').trim();
    var sp = new URLSearchParams(location.search);
    var urlTok = (sp.get('token') || sp.get('admin_token') || '').trim();
    if (!jwt && !leg && !urlTok) return;
    var gate = document.getElementById('adminAuthGate');
    var app = document.getElementById('adminAppRoot');
    var load = document.getElementById('adminLoader');
    if (gate) gate.classList.add('is-hidden');
    if (app) app.classList.remove('is-hidden');
    if (load) {
      load.classList.remove('is-hidden');
      load.setAttribute('aria-busy', 'true');
    }
  } catch (e) {}
})();

/* ═══════════════════════════════════════════
   CHART.JS GLOBAL DEFAULTS
═══════════════════════════════════════════ */
Chart.defaults.color = '#585248';
Chart.defaults.borderColor = '#242424';
Chart.defaults.font.family = "'Syne', system-ui, sans-serif";
Chart.defaults.font.size = 11;

const GOLD  = '#c9a84c';
const GOLD2 = '#dfc06a';
const GOLD_DIM = '#8a6820';
const GREEN = '#3fb950';
const BLUE  = '#58a6ff';
const RED   = '#f85149';
const ORANGE= '#e3a135';
const PURPLE= '#bc8cff';

const gridCfg = { color:'rgba(255,255,255,.04)', drawBorder:false };
const noLegend = { display:false };

function grd(ctx, c1, c2, v=1){
  const g = ctx.createLinearGradient(0,0,0,v);
  g.addColorStop(0, c1); g.addColorStop(1, c2); return g;
}

/* ═══════════════════════════════════════════
   API + LIVE DATA (Neon / Vercel)
═══════════════════════════════════════════ */
const DAYS_SHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
/** Matches PostgreSQL EXTRACT(DOW): 0=Sun … 6=Sat (used for dowRevenue / botPerf arrays from API). */
const DOW_LABELS_SUN0 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const LEAD_COLORS = ['#c9a84c','#3fb950','#58a6ff','#bc8cff','#e3a135','#f85149'];
const LS_ADMIN_TOKEN = 'barber_admin_token';
const LS_ADMIN_JWT = 'barber_admin_jwt';
let OVERVIEW = null;
const CHART_INSTANCES = {};
let resetFlowEmail = '';
let resetFlowToken = '';

function getUrlQueryToken() {
  try {
    const q = new URLSearchParams(location.search);
    return (q.get('token') || q.get('admin_token') || '').trim();
  } catch (_) {
    return '';
  }
}

function parseJwtPayload(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length !== 3) return null;
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b.length % 4;
    if (pad) b += '='.repeat(4 - pad);
    return JSON.parse(atob(b));
  } catch (_) {
    return null;
  }
}

function isClientJwtUsable(tok) {
  const p = parseJwtPayload(tok);
  if (!p || p.typ !== 'admin') return false;
  if (p.exp != null && typeof p.exp === 'number' && Date.now() >= p.exp * 1000) return false;
  return true;
}

function scrubExpiredOrInvalidJwt() {
  let j = '';
  try { j = (localStorage.getItem(LS_ADMIN_JWT) || '').trim(); } catch (_) {}
  if (!j) return;
  if (!isClientJwtUsable(j)) {
    try { localStorage.removeItem(LS_ADMIN_JWT); } catch (_) {}
  }
}

function getAdminJwt() {
  try {
    const j = (localStorage.getItem(LS_ADMIN_JWT) || '').trim();
    if (j.split('.').length !== 3) return '';
    return isClientJwtUsable(j) ? j : '';
  } catch (_) { return ''; }
}

function tokenForQuery() {
  const u = getUrlQueryToken();
  if (u) return u;
  const j = getAdminJwt();
  if (j) return j;
  try { return (localStorage.getItem(LS_ADMIN_TOKEN) || '').trim(); } catch (_) { return ''; }
}

function getAdminToken() {
  return tokenForQuery();
}

function hasStoredOrUrlCredential() {
  if (getUrlQueryToken()) return true;
  if (getAdminJwt()) return true;
  try { return Boolean((localStorage.getItem(LS_ADMIN_TOKEN) || '').trim()); } catch (_) { return false; }
}

function apiBase() {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) return q.replace(/\/$/, '');
    if (location.protocol === 'http:' || location.protocol === 'https:') return '';
    return 'http://localhost:3000';
  } catch (_) { return 'http://localhost:3000'; }
}

function normalizeEmailInput(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  try { s = s.normalize('NFKC'); } catch (_) {}
  return s.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function adminHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const urlTok = getUrlQueryToken();
  const jwt = getAdminJwt();
  let legacy = '';
  try { legacy = (localStorage.getItem(LS_ADMIN_TOKEN) || '').trim(); } catch (_) {}
  if (urlTok) {
    if (urlTok.split('.').length === 3) h['Authorization'] = 'Bearer ' + urlTok;
    else h['x-admin-token'] = urlTok;
  } else if (jwt) {
    h['Authorization'] = 'Bearer ' + jwt;
  } else if (legacy) {
    h['x-admin-token'] = legacy;
  }
  return h;
}

async function adminFetch(path, opts = {}) {
  return fetch(`${apiBase()}${path}`, { ...opts, headers: { ...adminHeaders(), ...(opts.headers || {}) } });
}

function authShowView(name) {
  document.querySelectorAll('[data-auth-view]').forEach((el) => {
    el.hidden = el.getAttribute('data-auth-view') !== name;
  });
}

function clearAuthErrors() {
  ['authErrLogin', 'authErrResetEmail', 'authErrResetPass'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
}

function setAuthGateError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}

function showAppHideGate() {
  const g = document.getElementById('adminAuthGate');
  const a = document.getElementById('adminAppRoot');
  if (g) g.classList.add('is-hidden');
  if (a) a.classList.remove('is-hidden');
}

function showGateHideApp() {
  const g = document.getElementById('adminAuthGate');
  const a = document.getElementById('adminAppRoot');
  if (g) g.classList.remove('is-hidden');
  if (a) a.classList.add('is-hidden');
  hideBootLoader();
}

function logoutToGate() {
  try {
    localStorage.removeItem(LS_ADMIN_JWT);
    localStorage.removeItem(LS_ADMIN_TOKEN);
  } catch (_) {}
  adminBootComplete = false;
  resetFlowEmail = '';
  resetFlowToken = '';
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('token') || u.searchParams.has('admin_token')) {
      u.searchParams.delete('token');
      u.searchParams.delete('admin_token');
      history.replaceState({}, '', u.toString());
    }
  } catch (_) {}
  showGateHideApp();
  hideBootLoader();
  hideAdminLoadBanner();
  authShowView('login');
  clearAuthErrors();
}

async function tryEnterDashboard() {
  showAppHideGate();
  showBootLoader();
  adminBootComplete = false;
  await loadAdminData({ silent: false });
}

function wireAuthForms() {
  const loginForm = document.getElementById('formAdminLogin');
  const resetEmailForm = document.getElementById('formResetEmail');
  const resetPassForm = document.getElementById('formResetPass');
  const btnShowReset = document.getElementById('btnShowReset');
  const btnBackEmail = document.getElementById('btnBackFromResetEmail');
  const btnBackPass = document.getElementById('btnBackFromResetPass');
  const btnOut = document.getElementById('btnAdminSignOut');

  if (btnShowReset) {
    btnShowReset.addEventListener('click', () => {
      clearAuthErrors();
      authShowView('reset-email');
    });
  }
  if (btnBackEmail) {
    btnBackEmail.addEventListener('click', () => {
      clearAuthErrors();
      authShowView('login');
    });
  }
  if (btnBackPass) {
    btnBackPass.addEventListener('click', () => {
      clearAuthErrors();
      authShowView('reset-email');
    });
  }
  if (btnOut) {
    btnOut.addEventListener('click', () => logoutToGate());
  }

  if (loginForm && !loginForm.dataset.wired) {
    loginForm.dataset.wired = '1';
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const submitBtn = loginForm.querySelector('button[type="submit"]');
      const email = normalizeEmailInput(document.getElementById('loginEmail')?.value);
      const password = String(document.getElementById('loginPassword')?.value || '');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset._label = submitBtn.textContent;
        submitBtn.textContent = 'Signing in…';
      }
      let r;
      try {
        r = await fetch(`${apiBase()}/api/admin/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch (err) {
        setAuthGateError('authErrLogin', 'Network error. Check that the API is running and the URL (?api=) is correct.');
        return;
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtn.dataset._label || 'Sign in';
        }
      }
      let j = {};
      try { j = await r.json(); } catch (_) {}
      if (!r.ok) {
        setAuthGateError('authErrLogin', j.error || 'Sign in failed.');
        return;
      }
      if (!j.token) {
        setAuthGateError('authErrLogin', 'Server did not return a token.');
        return;
      }
      localStorage.setItem(LS_ADMIN_JWT, j.token);
      try { localStorage.removeItem(LS_ADMIN_TOKEN); } catch (_) {}
      try {
        const u = new URL(location.href);
        u.searchParams.delete('token');
        u.searchParams.delete('admin_token');
        history.replaceState({}, '', u.toString());
      } catch (_) {}
      await tryEnterDashboard();
    });
  }

  if (resetEmailForm && !resetEmailForm.dataset.wired) {
    resetEmailForm.dataset.wired = '1';
    resetEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const email = normalizeEmailInput(document.getElementById('resetEmailStep1')?.value);
      const r = await fetch(`${apiBase()}/api/admin/auth/verify-reset-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email }),
      });
      let j = {};
      try { j = await r.json(); } catch (_) {}
      if (!r.ok) {
        let msg = 'Something went wrong. Please try again.';
        if (r.status === 404) {
          msg = "We couldn't find an account with that email. Please check the address and try again, or go back to sign in.";
        } else if (r.status === 400) {
          msg = 'Please enter a valid email address.';
        } else if (r.status === 429) {
          msg = 'Too many attempts. Please wait a few minutes and try again.';
        } else if (r.status === 503) {
          msg = 'This service is temporarily unavailable. Please try again later.';
        }
        alert(msg);
        return;
      }
      resetFlowEmail = email;
      resetFlowToken = j.resetToken || '';
      if (!resetFlowToken) {
        alert('Something went wrong. Please start the reset process again from sign in.');
        return;
      }
      const hint = document.getElementById('resetPassEmailHint');
      if (hint) hint.textContent = `Choose a new password for ${email}.`;
      authShowView('reset-pass');
    });
  }

  if (resetPassForm && !resetPassForm.dataset.wired) {
    resetPassForm.dataset.wired = '1';
    resetPassForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const password = String(document.getElementById('resetNewPass')?.value || '');
      const passwordConfirm = String(document.getElementById('resetNewPass2')?.value || '');
      const r = await fetch(`${apiBase()}/api/admin/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          email: resetFlowEmail,
          resetToken: resetFlowToken,
          password,
          passwordConfirm,
        }),
      });
      let j = {};
      try { j = await r.json(); } catch (_) {}
      if (!r.ok) {
        const err = j && j.error ? String(j.error) : '';
        const msg =
          err && err.length > 0 && err.length < 160
            ? err
            : 'Could not update your password. Please try again or request a new reset from sign in.';
        alert(msg);
        return;
      }
      resetFlowEmail = '';
      resetFlowToken = '';
      authShowView('login');
      alert('Your password has been updated. You can sign in now.');
    });
  }
}

async function bootstrapAdmin() {
  wireAuthForms();
  scrubExpiredOrInvalidJwt();
  if (hasStoredOrUrlCredential()) {
    await tryEnterDashboard();
    return;
  }
  showGateHideApp();
}
function destroyCharts() {
  Object.keys(CHART_INSTANCES).forEach((k) => { try { CHART_INSTANCES[k].destroy(); } catch (_) {} delete CHART_INSTANCES[k]; });
}
function padArr(arr, len, fill = 0) {
  const a = (arr || []).slice();
  while (a.length < len) a.push(fill);
  return a.slice(0, len);
}

/* ═══════════════════════════════════════════
   PAGE NAVIGATION
═══════════════════════════════════════════ */
const pageTitles = {
  dashboard:    ['Dashboard','Overview'],
  analytics:    ['Analytics','Detailed Metrics'],
  insights:     ['Insights','Performance Intelligence'],
  appointments: ['Appointments','Schedule & Bookings'],
  leads:        ['Leads','Captured Contacts'],
  visitors:     ['Visitors','Traffic & Sessions'],
  revenue:      ['Revenue','Financial Overview'],
  services:     ['Services','Menu Performance'],
  settings:     ['Settings','Configuration'],
};

function showPage(id, btn) {
  document.querySelectorAll('.content').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  if(btn) btn.classList.add('active');
  const t = pageTitles[id] || [id,''];
  document.getElementById('pageTitle').innerHTML = `${t[0]} <span>${t[1]}</span>`;
}

function setFilter(f, btn) {
  document.querySelectorAll('.date-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function toggleFilter(btn) {
  btn.closest('.table-toolbar').querySelectorAll('.table-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function filterTable(input, tableId) {
  const val = input.value.toLowerCase();
  document.querySelectorAll('#' + tableId + ' tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(val) ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════
   BUILD TABLES
═══════════════════════════════════════════ */
function statusPill(s) {
  const map = { confirmed:'confirmed', pending:'pending', completed:'completed', cancelled:'cancelled' };
  const labels = { confirmed:'● Confirmed', pending:'● Pending', completed:'✓ Completed', cancelled:'✕ Cancelled' };
  return `<span class="status-pill ${map[s]||'pending'}">${labels[s]||s}</span>`;
}

function mapApptStatus(st) {
  const x = String(st || 'pending').toLowerCase();
  if (x === 'completed') return 'completed';
  if (x === 'cancelled') return 'cancelled';
  if (x === 'confirmed') return 'confirmed';
  return 'pending';
}

function escapeCell(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

async function viewSessionMessages(sessionId) {
  const r = await adminFetch('/api/admin/sessions/' + encodeURIComponent(sessionId) + '/messages');
  if (!r.ok) { alert('Could not load messages'); return; }
  const j = await r.json();
  const txt = (j.messages || []).map(m => `${m.role}: ${m.content}`).join('\n\n---\n\n');
  alert(txt.slice(0, 8000) || 'No messages stored yet.');
}

function sessionDevice(s) {
  if (s.device_hint === 'mobile') return '📱 Mobile';
  if (s.device_hint === 'desktop') return '💻 Desktop';
  const ua = (s.user_agent || '').toLowerCase();
  if (/mobile|android|iphone|ipad/i.test(ua)) return '📱 Mobile';
  return '💻 Desktop';
}

function sessionVisitorLabel(s) {
  if (s.outcome === 'booked') return 'Booked';
  if (s.outcome === 'engaged') return 'Lead';
  return 'Bounced';
}

function formatSessionDuration(started, ended) {
  const ms = new Date(ended) - new Date(started);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function patchLeadRecord(leadId, body) {
  const r = await adminFetch(`/api/admin/leads/${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (r.status === 401) {
    if (hasStoredOrUrlCredential()) {
      logoutToGate();
      setAuthGateError('authErrLogin', 'Session expired. Please sign in again.');
    } else {
      showAdminLoadBanner('Admin API rejected the request. Sign in, or use <code>?token=…</code> with <code>ADMIN_TOKEN</code>.');
    }
    return;
  }
  if (!r.ok) {
    const t = await r.text();
    alert('Could not save: ' + t);
    return;
  }
  await loadAdminData();
}

async function deleteLeadRecord(leadId) {
  const id = Number(leadId);
  if (!Number.isFinite(id)) return;
  if (!confirm('Delete this lead permanently? This cannot be undone.')) return;
  const r = await adminFetch(`/api/admin/leads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r.status === 401) {
    if (hasStoredOrUrlCredential()) {
      logoutToGate();
      setAuthGateError('authErrLogin', 'Session expired. Please sign in again.');
    }
    return;
  }
  if (!r.ok) {
    const t = await r.text();
    alert('Could not delete: ' + t);
    return;
  }
  await loadAdminData();
}

function partitionLeadsForUi(rows) {
  const queue = [];
  const cancelled = [];
  const done = [];
  for (const l of rows || []) {
    const st = String(l.appointment_status || 'pending').toLowerCase();
    if (st === 'completed') done.push(l);
    else if (st === 'cancelled') cancelled.push(l);
    else queue.push(l);
  }
  return { queue, cancelled, done };
}

function leadRowHtml(l) {
  const cap = l.captured_at ? new Date(l.captured_at).toLocaleString('en-GB') : '—';
  const crm = String(l.crm_status || 'new').toLowerCase();
  const id = Number(l.id);
  const crmOpts = ['new', 'contacted', 'converted'];
  const crmSel = crmOpts.map((v) =>
    `<option value="${v}"${crm === v ? ' selected' : ''}>${v}</option>`,
  ).join('');
  const crmCell = Number.isFinite(id)
    ? `<select class="admin-inline-select" onchange="patchLeadRecord(${id},{crm_status:this.value})">${crmSel}</select>`
    : escapeCell(crm);
  const apptSt = mapApptStatus(l.appointment_status);
  const apptOpts = ['pending', 'confirmed', 'completed', 'cancelled'];
  const apptSel = apptOpts.map((v) =>
    `<option value="${v}"${apptSt === v ? ' selected' : ''}>${v}</option>`,
  ).join('');
  const bookingCell = Number.isFinite(id)
    ? `<select class="admin-inline-select" onchange="patchLeadRecord(${id},{appointment_status:this.value})">${apptSel}</select>`
    : escapeCell(String(l.appointment_status || '—'));
  const sid = String(l.session_id || '').replace(/'/g, "\\'");
  const canDone = Number.isFinite(id) && !['completed', 'cancelled'].includes(apptSt);
  const doneBtn = canDone
    ? `<button type="button" class="appt-btn appt-btn-done" title="Mark service completed" onclick="patchLeadRecord(${id},{appointment_status:'completed'})">Done</button>`
    : '';
  const delBtn = Number.isFinite(id)
    ? `<button type="button" class="appt-btn appt-btn-danger" title="Delete lead" onclick="deleteLeadRecord(${id})">Delete</button>`
    : '';
  return `
    <tr data-lead-id="${l.id}">
      <td class="td-name">${escapeCell(l.name)}</td>
      <td style="color:var(--text2)">${escapeCell(l.phone)}</td>
      <td><span class="td-service">${escapeCell(l.service)}</span></td>
      <td style="color:var(--text2);font-size:.75rem">${escapeCell(cap)}</td>
      <td style="text-align:center">${l.conversation_turns ?? 0}</td>
      <td>${crmCell}</td>
      <td>${bookingCell}</td>
      <td><div class="appt-actions-row">
        <button type="button" class="appt-btn" onclick="viewSessionMessages('${sid}')">Chat</button>
        ${doneBtn}
        ${delBtn}
      </div></td>
    </tr>`;
}

function buildApptTable() {
  const tbody = document.getElementById('apptBody');
  const rows = (OVERVIEW && OVERVIEW.appointments) ? OVERVIEW.appointments : [];
  const apptOpts = ['pending', 'confirmed', 'completed', 'cancelled'];
  tbody.innerHTML = rows.map((a) => {
    const st = mapApptStatus(a.appointment_status);
    const amt = a.amount_eur != null ? Number(a.amount_eur) : '—';
    const id = Number(a.id);
    const sel = apptOpts.map((v) =>
      `<option value="${v}"${st === v ? ' selected' : ''}>${v}</option>`,
    ).join('');
    const statusCell = Number.isFinite(id)
      ? `<select class="admin-inline-select" onchange="patchLeadRecord(${id},{appointment_status:this.value})">${sel}</select>`
      : escapeCell(String(a.appointment_status || '—'));
    return `
    <tr>
      <td class="td-name">${escapeCell(a.name)}</td>
      <td><span class="td-service">${escapeCell(a.service)}</span></td>
      <td>${escapeCell(a.preferred_date || '—')}</td>
      <td>${escapeCell(a.preferred_time || '—')}</td>
      <td style="color:var(--text2)">${escapeCell(a.phone)}</td>
      <td class="td-amount">${typeof amt === 'number' ? '€' + amt.toFixed(0) : amt}</td>
      <td>${statusCell}</td>
      <td>
        <div class="appt-actions-row">
          <button type="button" class="appt-btn" onclick="viewSessionMessages('${(a.session_id || '').replace(/'/g, "\\'")}')">Chat</button>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="padding:20px;color:var(--text3)">No bookings yet — data syncs from the customer chatbot.</td></tr>';
}

function buildLeadsTable() {
  const qBody = document.getElementById('leadsQueueBody');
  const cBody = document.getElementById('leadsCancelledBody');
  const dBody = document.getElementById('leadsCompletedBody');
  if (!qBody || !cBody || !dBody) return;
  const rows = (OVERVIEW && OVERVIEW.leads) ? OVERVIEW.leads : [];
  const { queue, cancelled, done } = partitionLeadsForUi(rows);

  const section = (title, hint, list) => {
    const head = `<tr class="leads-section-row"><td colspan="8"><strong>${title}</strong><span class="leads-hint">${hint}</span></td></tr>`;
    if (!list.length) {
      return head + `<tr><td colspan="8" style="padding:16px;color:var(--text3)">No rows.</td></tr>`;
    }
    return head + list.map(leadRowHtml).join('');
  };

  qBody.innerHTML = section('Up next', 'First come, first served — oldest at top', queue);
  cBody.innerHTML = cancelled.length
    ? section('Cancelled', 'FCFS by captured time', cancelled)
    : '';
  dBody.innerHTML = section('Completed', 'Finished visits — oldest first', done);
}

function buildLeadCards() {
  const container = document.getElementById('leadCards');
  const { queue, cancelled } = partitionLeadsForUi((OVERVIEW && OVERVIEW.leads) || []);
  const cards = [...queue, ...cancelled].slice(0, 6);
  container.innerHTML = cards.map((l, i) => {
    const initials = String(l.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2);
    const color = LEAD_COLORS[i % LEAD_COLORS.length];
    const cap = l.captured_at ? new Date(l.captured_at).toLocaleString('en-GB') : '';
    return `
    <div class="lead-card">
      <div class="lead-card-top">
        <div class="lead-avatar" style="background:${color}20;color:${color};border:1px solid ${color}40">${escapeCell(initials)}</div>
        <div><div class="lead-name">${escapeCell(l.name)}</div><div class="lead-date">${escapeCell(cap)}</div></div>
      </div>
      <div class="lead-details">
        <div class="lead-detail-row"><span class="lead-detail-icon">📞</span>${escapeCell(l.phone)}</div>
        <div class="lead-detail-row"><span class="lead-detail-icon">✂️</span>${escapeCell(l.service)}</div>
        <div class="lead-detail-row"><span class="lead-detail-icon">💬</span>${l.conversation_turns ?? 0} messages in session</div>
      </div>
      <div class="lead-actions">
        <button type="button" class="lead-action-btn" onclick="viewSessionMessages('${(l.session_id || '').replace(/'/g, "\\'")}')">💬 Transcript</button>
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--text3);padding:12px">No recent leads.</p>';
}

function buildVisitorsTable() {
  const tbody = document.getElementById('visitorsBody');
  const rows = (OVERVIEW && OVERVIEW.sessions) ? OVERVIEW.sessions : [];
  tbody.innerHTML = rows.map((s) => {
    const shortId = (s.session_id || '').slice(0, 8) + '…';
    const started = s.started_at ? new Date(s.started_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
    const dur = formatSessionDuration(s.started_at, s.last_activity_at);
    const lbl = sessionVisitorLabel(s);
    const pill = lbl === 'Booked' ? 'completed' : lbl === 'Lead' ? 'pending' : 'cancelled';
    return `
    <tr>
      <td style="font-family:monospace;font-size:.72rem;color:var(--text2);cursor:pointer" title="Open transcript" onclick="viewSessionMessages('${(s.session_id || '').replace(/'/g, "\\'")}')">${escapeCell(shortId)}</td>
      <td>${escapeCell(started)}</td>
      <td>${escapeCell(dur)}</td>
      <td style="text-align:center">${s.message_count ?? 0}</td>
      <td>${sessionDevice(s)}</td>
      <td><span class="status-pill ${pill}">${escapeCell(lbl)}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="padding:20px;color:var(--text3)">No sessions yet.</td></tr>';
}

function buildServicesTable() {
  const svc = (OVERVIEW && OVERVIEW.services) ? OVERVIEW.services : [];
  const max = Math.max(1, ...svc.map((x) => x.bookings));
  const tbody = document.getElementById('servicesBody');
  tbody.innerHTML = svc.map((s, i) => {
    const pct = Math.round((s.bookings / max) * 100);
    return `
    <tr>
      <td style="color:var(--text3);font-size:.75rem">${String(i + 1).padStart(2, '0')}</td>
      <td class="td-name">${escapeCell(s.name)}</td>
      <td class="td-amount">€${s.price}</td>
      <td>${s.bookings}</td>
      <td class="td-amount">€${Number(s.revenue).toLocaleString()}</td>
      <td style="width:140px">
        <div class="service-bar-track"><div class="service-bar-fill" style="width:${pct}%"></div></div>
        <div style="font-size:.65rem;color:var(--text3);margin-top:3px">${pct}% of top</div>
      </td>
      <td style="color:var(--text3);font-size:.8rem">Live</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="padding:16px;color:var(--text3)">No service stats until bookings exist.</td></tr>';
}

/* ═══════════════════════════════════════════
   HEATMAP
═══════════════════════════════════════════ */
function buildHeatmap(levels) {
  const labels = document.getElementById('heatmapLabels');
  const grid   = document.getElementById('heatmapGrid');
  if (!labels || !grid) return;
  labels.innerHTML = '';
  grid.innerHTML = '';
  ['Mo','Tu','We','Th','Fr','Sa','Su'].forEach((d) => {
    const el = document.createElement('div');
    el.className = 'heatmap-day-label';
    el.textContent = d;
    labels.appendChild(el);
  });
  const arr = (levels && levels.length === 84) ? levels : Array(84).fill(0);
  for (let i = 0; i < 84; i++) {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    const lv = Math.min(5, Math.max(0, Number(arr[i]) || 0));
    cell.setAttribute('data-level', String(lv));
    grid.appendChild(cell);
  }
}

/* ═══════════════════════════════════════════
   CHARTS (data from GET /api/admin/overview)
═══════════════════════════════════════════ */
function initChartsFromOverview(O) {
  const ov = O || {};
  destroyCharts();
  const weekRevData = padArr(ov.revenueWeek, 7, 0);
  const weekLbl = (ov.revenueWeekLabels && ov.revenueWeekLabels.length === 7) ? ov.revenueWeekLabels : DAYS_SHORT;
  const monthRevData = padArr(ov.monthlyRev, 12, 0);
  const monthLbl = padArr(ov.monthlyRevLabels, 12, '').map((x, i) => x || MONTHS[i % 12]);
  const priorYearRev = padArr(ov.monthlyRevPriorYear, 12, 0);
  const weekAppt = ov.weekApptBars || [];
  const weekApptLabels = weekAppt.map((_, i) => `W${i + 1}`);
  const hourlyData = padArr(ov.hourlyData, 24, 0);
  const dowRevData = padArr(ov.dowRevenue, 7, 0);
  const funnelData = padArr(ov.funnel, 4, 0);
  const svcWeek = (ov.servicesWeek && ov.servicesWeek.length) ? ov.servicesWeek : (ov.services && ov.services.length ? ov.services : []);
  const SERVICE_DATA = (ov.services && ov.services.length) ? ov.services : [];
  const botS = padArr(ov.botPerf && ov.botPerf.sessionsByDow, 7, 0);
  const botL = padArr(ov.botPerf && ov.botPerf.leadsByDow, 7, 0);
  const vData = padArr(ov.sessionsByDay30, 30, 0);
  const vLbl = (ov.sessionsByDay30Labels && ov.sessionsByDay30Labels.length === 30)
    ? ov.sessionsByDay30Labels
    : Array.from({ length: 30 }, (_, i) => `D${i + 1}`);

  const mk = (id, chart) => { if (id && chart) CHART_INSTANCES[id] = chart; };

  const rEl = document.getElementById('revenueChart');
  if (rEl) {
    const mx = Math.max(1, ...weekRevData, 0);
    mk('rev', new Chart(rEl.getContext('2d'), { type: 'bar', data: {
      labels: weekLbl,
      datasets: [{
        data: weekRevData,
        backgroundColor: weekRevData.map((v) => (v === mx && v > 0 ? GOLD : 'rgba(201,168,76,.25)')),
        borderColor: GOLD, borderWidth: 1, borderRadius: 6,
      }],
    }, options: { plugins: { legend: noLegend, tooltip: { callbacks: { label: (c) => ' €' + c.raw } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg, ticks: { callback: (v) => '€' + v } } }, responsive: true, maintainAspectRatio: false } }));
  }

  const dEl = document.getElementById('servicesDonut');
  const legend = document.getElementById('donut-legend');
  if (dEl && legend) {
    const top = (svcWeek.length ? svcWeek : SERVICE_DATA).slice(0, 5);
    const labels = top.length ? top.map((s) => (s.name || '').slice(0, 16)) : ['—'];
    const donutVals = top.length ? top.map((s) => Math.max(0, Number(s.bookings) || 0)) : [1];
    const donutColors = [GOLD, BLUE, GREEN, PURPLE, ORANGE];
    legend.innerHTML = '';
    labels.forEach((l, i) => {
      legend.innerHTML += `<div class="legend-item"><div class="legend-dot" style="background:${donutColors[i % donutColors.length]}"></div>${escapeCell(l)}</div>`;
    });
    mk('donut', new Chart(dEl.getContext('2d'), { type: 'doughnut', data: {
      labels,
      datasets: [{ data: donutVals.map((v) => v || 0.01), backgroundColor: donutColors, borderColor: '#161616', borderWidth: 3, hoverOffset: 8 }],
    }, options: { plugins: { legend: noLegend, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${Math.round(c.raw)} bookings` } } },
      cutout: '68%', responsive: true, maintainAspectRatio: false } }));
  }

  const mEl = document.getElementById('monthlyRevChart');
  if (mEl) {
    const mCtx = mEl.getContext('2d');
    const mGrad = grd(mCtx, 'rgba(201,168,76,.35)', 'rgba(201,168,76,0)', 260);
    mk('monthly', new Chart(mCtx, { type: 'line', data: {
      labels: monthLbl,
      datasets: [
        { label: 'Rolling 12m', data: monthRevData, borderColor: GOLD, backgroundColor: mGrad, tension: 0.4, fill: true, pointBackgroundColor: GOLD, pointRadius: 4 },
        { label: 'Prior year month', data: priorYearRev, borderColor: 'rgba(255,255,255,.15)', backgroundColor: 'transparent', tension: 0.4, fill: false, pointRadius: 0, borderDash: [4, 4] },
      ],
    }, options: { plugins: { legend: { labels: { color: '#a09a8e', usePointStyle: true, pointStyleWidth: 10 } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg, ticks: { callback: (v) => '€' + v.toLocaleString() } } }, responsive: true, maintainAspectRatio: false } }));
  }

  const wEl = document.getElementById('weeklyApptChart');
  if (wEl) {
    mk('weekAppt', new Chart(wEl.getContext('2d'), { type: 'bar', data: {
      labels: weekApptLabels.length ? weekApptLabels : ['—'],
      datasets: [{ data: weekAppt.length ? weekAppt : [0], backgroundColor: 'rgba(63,185,80,.35)', borderColor: GREEN, borderWidth: 1, borderRadius: 5 }],
    }, options: { plugins: { legend: noLegend }, scales: { x: { grid: gridCfg }, y: { grid: gridCfg } }, responsive: true, maintainAspectRatio: false } }));
  }

  const fEl = document.getElementById('funnelChart');
  if (fEl) {
    mk('funnel', new Chart(fEl.getContext('2d'), { type: 'bar', data: {
      labels: ['Visitors', 'Started Chat', 'Leads', 'Booked'],
      datasets: [{ data: funnelData, backgroundColor: [BLUE, 'rgba(201,168,76,.6)', GOLD, GREEN], borderRadius: 6 }],
    }, options: { indexAxis: 'y', plugins: { legend: noLegend, tooltip: { callbacks: { label: (c) => ` ${c.raw} users` } } },
      scales: { x: { grid: gridCfg }, y: { grid: { display: false } } }, responsive: true, maintainAspectRatio: false } }));
  }

  const hEl = document.getElementById('hourlyChart');
  if (hEl) {
    const hCtx = hEl.getContext('2d');
    const hGrad = grd(hCtx, 'rgba(88,166,255,.4)', 'rgba(88,166,255,0)', 200);
    mk('hourly', new Chart(hCtx, { type: 'line', data: {
      labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
      datasets: [{ data: hourlyData, borderColor: BLUE, backgroundColor: hGrad, tension: 0.4, fill: true, pointRadius: 0 }],
    }, options: { plugins: { legend: noLegend }, scales: { x: { grid: gridCfg }, y: { grid: gridCfg, min: 0 } }, responsive: true, maintainAspectRatio: false } }));
  }

  const bEl = document.getElementById('botPerfChart');
  if (bEl) {
    mk('bot', new Chart(bEl.getContext('2d'), { type: 'line', data: {
      labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      datasets: [
        { label: 'Sessions', data: botS, borderColor: BLUE, backgroundColor: 'rgba(88,166,255,.1)', tension: 0.4, fill: true, pointRadius: 3 },
        { label: 'Bookings', data: botL, borderColor: GOLD, backgroundColor: 'transparent', tension: 0.4, fill: false, pointRadius: 3 },
      ],
    }, options: { plugins: { legend: { labels: { color: '#a09a8e', usePointStyle: true } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg, min: 0 } }, responsive: true, maintainAspectRatio: false } }));
  }

  const dowEl = document.getElementById('dowChart');
  if (dowEl) {
    mk('dow', new Chart(dowEl.getContext('2d'), { type: 'bar', data: {
      labels: DOW_LABELS_SUN0,
      datasets: [{ data: dowRevData, backgroundColor: DOW_LABELS_SUN0.map((_, i) => (i === 5 ? GOLD : 'rgba(201,168,76,.3)')), borderRadius: 5 }],
    }, options: { plugins: { legend: noLegend, tooltip: { callbacks: { label: (c) => (c.raw === 0 ? 'Closed' : ' €' + c.raw) } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg, ticks: { callback: (v) => (v === 0 ? 'Closed' : '€' + v) } } }, responsive: true, maintainAspectRatio: false } }));
  }

  const vEl = document.getElementById('visitorsChart');
  if (vEl) {
    const vCtx = vEl.getContext('2d');
    const vGrad = grd(vCtx, 'rgba(88,166,255,.3)', 'rgba(88,166,255,0)', 260);
    mk('visitors', new Chart(vCtx, { type: 'line', data: {
      labels: vLbl,
      datasets: [{ data: vData, borderColor: BLUE, backgroundColor: vGrad, tension: 0.4, fill: true, pointRadius: 0 }],
    }, options: { plugins: { legend: noLegend }, scales: { x: { grid: gridCfg, ticks: { maxTicksLimit: 8 } }, y: { grid: gridCfg, min: 0 } }, responsive: true, maintainAspectRatio: false } }));
  }

  const tEl = document.getElementById('trafficDonut');
  const tLeg = document.getElementById('trafficLegend');
  const st = ov.stats || {};
  const mobN = Math.max(0, Number(st.mobileN) || 0);
  const deskN = Math.max(0, Number(st.desktopN) || 0);
  const tData = mobN + deskN > 0 ? [mobN, deskN] : [1, 0];
  if (tEl) {
    mk('traffic', new Chart(tEl.getContext('2d'), { type: 'doughnut', data: {
      labels: ['Mobile', 'Desktop'],
      datasets: [{ data: tData, backgroundColor: [GOLD, BLUE], borderColor: '#161616', borderWidth: 3, hoverOffset: 6 }],
    }, options: { plugins: { legend: noLegend }, cutout: '62%', responsive: true, maintainAspectRatio: false } }));
  }
  if (tLeg) {
    tLeg.innerHTML = `<div class="legend-item"><div class="legend-dot" style="background:#c9a84c"></div>Mobile (${mobN})</div>
      <div class="legend-item"><div class="legend-dot" style="background:#58a6ff"></div>Desktop (${deskN})</div>`;
  }

  const yEl = document.getElementById('yearlyChart');
  if (yEl) {
    mk('yearly', new Chart(yEl.getContext('2d'), { type: 'bar', data: {
      labels: monthLbl,
      datasets: [
        { label: 'Rolling 12m', data: monthRevData, backgroundColor: 'rgba(201,168,76,.7)', borderRadius: 5 },
        { label: 'Prior year', data: priorYearRev, backgroundColor: 'rgba(255,255,255,.07)', borderRadius: 5 },
      ],
    }, options: { plugins: { legend: { labels: { color: '#a09a8e', usePointStyle: true } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg, ticks: { callback: (v) => '€' + v.toLocaleString() } } }, responsive: true, maintainAspectRatio: false } }));
  }

  const rsEl = document.getElementById('revByService');
  if (rsEl) {
    const cols = [GOLD, 'rgba(201,168,76,.6)', BLUE, GREEN, PURPLE, ORANGE, RED, 'rgba(88,166,255,.5)', 'rgba(63,185,80,.5)'];
    const svcList = SERVICE_DATA.length ? SERVICE_DATA : [{ name: '—', revenue: 0 }];
    mk('revSvc', new Chart(rsEl.getContext('2d'), { type: 'doughnut', data: {
      labels: svcList.map((s) => (s.name || '').split(' ')[0]),
      datasets: [{ data: svcList.map((s) => Math.max(0, Number(s.revenue) || 0) || 0.01),
        backgroundColor: svcList.map((_, i) => cols[i % cols.length]), borderColor: '#161616', borderWidth: 2, hoverOffset: 6 }],
    }, options: { plugins: { legend: noLegend }, cutout: '55%', responsive: true, maintainAspectRatio: false } }));
  }

  const rdEl = document.getElementById('revByDay');
  if (rdEl) {
    mk('revDay', new Chart(rdEl.getContext('2d'), { type: 'bar', data: {
      labels: DOW_LABELS_SUN0,
      datasets: [{ data: dowRevData, backgroundColor: DOW_LABELS_SUN0.map((_, i) => (i === 5 ? GOLD : 'rgba(201,168,76,.35)')), borderRadius: 5 }],
    }, options: { plugins: { legend: noLegend, tooltip: { callbacks: { label: (c) => (c.raw === 0 ? 'Closed' : ' €' + c.raw) } } },
      scales: { x: { grid: gridCfg }, y: { grid: gridCfg } }, responsive: true, maintainAspectRatio: false } }));
  }
}

const ACTIVITY_DOT_CLASS = { green: 1, gold: 1, blue: 1, purple: 1 };
function renderActivityFeed(acts) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  feed.innerHTML = (acts || []).slice(0, 8).map((a) => {
    const dot = ACTIVITY_DOT_CLASS[a.dot] ? a.dot : 'gold';
    return `<div class="activity-item">
      <div class="activity-dot ${dot}"></div>
      <div class="activity-text">${a.text || ''}</div>
      <div class="activity-time">${escapeCell(a.time || '')}</div>
    </div>`;
  }).join('');
  if (!acts || !acts.length) {
    feed.innerHTML = '<div class="activity-item"><div class="activity-dot blue"></div><div class="activity-text">No activity yet — conversations appear when customers use the chatbot.</div><div class="activity-time">—</div></div>';
  }
}

function pctDeltaText(cur, prev) {
  if (prev == null || prev === 0) return cur > 0 ? { text: 'new', cls: 'up' } : { text: '—', cls: '' };
  const p = Math.round(((cur - prev) / prev) * 100);
  return { text: `${p >= 0 ? '↑' : '↓'} ${Math.abs(p)}%`, cls: p >= 0 ? 'up' : 'down' };
}

function setDeltaEl(id, cur, prev) {
  const el = document.getElementById(id);
  if (!el) return;
  const { text, cls } = pctDeltaText(cur, prev);
  el.textContent = text;
  el.className = 'stat-change' + (cls ? ' ' + cls : '');
}

function setAbsDeltaEl(id, cur, prev, suffix = '') {
  const el = document.getElementById(id);
  if (!el) return;
  const d = cur - prev;
  if (prev === 0 && cur === 0) {
    el.textContent = '—';
    el.className = 'stat-change';
    return;
  }
  el.textContent = d === 0 ? '—' : `${d > 0 ? '↑' : '↓'} ${Math.abs(d)}${suffix}`;
  el.className = 'stat-change ' + (d >= 0 ? 'up' : 'down');
}

function applyDashboardKpi(ov) {
  const k = ov.kpi || {};
  const s = ov.stats || {};
  const sr = document.getElementById('s-rev');
  const sa = document.getElementById('s-appt');
  const sv = document.getElementById('s-vis');
  const sc = document.getElementById('s-conv');
  if (sr) sr.textContent = String(Math.round(k.revenueToday || 0));
  if (sa) sa.textContent = String(k.appointmentsToday || 0);
  if (sv) sv.textContent = String(k.visitorsToday || 0);
  if (sc) sc.textContent = String(k.conversionPct || 0);
  const ba = document.getElementById('badge-appt');
  const bl = document.getElementById('badge-leads');
  const tl = Number(k.totalLeads) || 0;
  const ln = Number(k.leadsNew) || 0;
  const oa = Number(k.openAppointments) || 0;
  /* Appointments: pending/confirmed first; else total booking rows. Leads: CRM “new” first; else total (so one converted lead still shows volume). */
  if (ba) ba.textContent = String(oa > 0 ? oa : tl);
  if (bl) bl.textContent = String(ln > 0 ? ln : tl);

  const rt = Math.round(k.revenueToday || 0);
  const ry = Math.round(s.revYesterday || 0);
  setDeltaEl('dash-rev-delta', rt, ry);

  const at = k.appointmentsToday || 0;
  const ay = s.bookingsYesterday || 0;
  setAbsDeltaEl('dash-appt-delta', at, ay, '');

  const visitorsTodayCount = k.visitorsToday || 0;
  const visitorsYesterdayCount = s.visitorsYesterday || 0;
  setDeltaEl('dash-vis-delta', visitorsTodayCount, visitorsYesterdayCount);

  const cwd = s.convWeekDelta;
  const elC = document.getElementById('dash-conv-delta');
  if (elC) {
    if (cwd === 0 || cwd == null) {
      elC.textContent = '—';
      elC.className = 'stat-change';
    } else {
      elC.textContent = `${cwd > 0 ? '↑' : '↓'} ${Math.abs(cwd)} pts`;
      elC.className = 'stat-change ' + (cwd >= 0 ? 'up' : 'down');
    }
  }

  const wk = document.getElementById('dash-chart-week-rev');
  if (wk) wk.textContent = '€' + Math.round(s.revWeekSum || 0).toLocaleString('en-GB');

  const tsn = document.getElementById('insight-top-svc-name');
  const tsp = document.getElementById('insight-top-svc-pct');
  if (tsn) tsn.textContent = s.topServiceName || '—';
  if (tsp) tsp.textContent = (s.topServicePct != null ? s.topServicePct : 0) + '% of all bookings';

  const iat = document.getElementById('insight-avg-ticket');
  if (iat) iat.textContent = '€' + (Number(s.avgTicketMonth) || 0).toFixed(2);

  const ipk = document.getElementById('insight-peak-hour');
  if (ipk) ipk.textContent = s.peakHourLabel || '—';

  const ieg = document.getElementById('insight-engage-pct');
  if (ieg) ieg.textContent = (s.engagementPct || 0) + '%';

  const ilt = document.getElementById('insight-leads-today');
  if (ilt) ilt.textContent = String(k.appointmentsToday || 0);

  const icw = document.getElementById('insight-cancelled-week');
  if (icw) icw.textContent = String(s.cancelledWeek || 0);

  const anRev = document.getElementById('an-rev-month');
  const anBook = document.getElementById('an-book-month');
  const anVis = document.getElementById('an-vis-month');
  const anConv = document.getElementById('an-conv-month');
  if (anRev) anRev.textContent = Math.round(s.revMonth || 0).toLocaleString('en-GB');
  if (anBook) anBook.textContent = String(s.bookingsMonth || 0);
  if (anVis) anVis.textContent = String(s.sessionsMonth || 0);
  if (anConv) {
    const sm = s.sessionsMonth || 0;
    anConv.textContent = sm > 0 ? String(Math.min(100, Math.round(((s.bookingsMonth || 0) / sm) * 100))) : '0';
  }
  setDeltaEl('an-rev-delta', s.revMonth || 0, s.revPrevMonth || 0);
  setDeltaEl('an-book-delta', s.bookingsMonth || 0, s.bookingsPrevMonth || 0);
  setDeltaEl('an-vis-delta', s.sessionsMonth || 0, s.sessionsPrevMonth || 0);

  const anM = document.getElementById('an-chart-month-rev');
  if (anM) anM.textContent = '€' + Math.round(s.revMonth || 0).toLocaleString('en-GB');

  const subW = document.getElementById('weeklyApptSubtitle');
  if (subW && ov.weekApptBars) subW.textContent = `Last ${ov.weekApptBars.length} weeks (from DB)`;

  const iat2 = document.getElementById('in-avg-ticket');
  if (iat2) iat2.textContent = (Number(s.avgTicketMonth) || 0).toFixed(1);
  const itd = document.getElementById('in-ticket-delta');
  if (itd) {
    const a = Number(s.avgTicketMonth) || 0;
    const b = Number(s.avgTicketPrevMonth) || 0;
    if (b <= 0 && a <= 0) {
      itd.textContent = '—';
      itd.className = 'stat-change';
    } else if (b <= 0) {
      itd.textContent = '↑';
      itd.className = 'stat-change up';
    } else {
      const diff = a - b;
      itd.textContent = `${diff >= 0 ? '↑' : '↓'} €${Math.abs(diff).toFixed(2)}`;
      itd.className = 'stat-change ' + (diff >= 0 ? 'up' : 'down');
    }
  }
  const ibp = document.getElementById('in-booked-pct');
  if (ibp) ibp.textContent = String(s.outcomeBookedPct || 0);
  const ism = document.getElementById('in-sess-min');
  if (ism) ism.textContent = (Number(s.avgSessionMin) || 0).toFixed(1);
  const ifp = document.getElementById('in-funnel-pct');
  if (ifp) ifp.textContent = String(s.funnelBookedPct || 0);

  const ibd = document.getElementById('in-busiest-dow');
  const ibds = document.getElementById('in-busiest-dow-sub');
  if (ibd) ibd.textContent = s.busiestDowLabel || '—';
  if (ibds) ibds.textContent = `${s.busiestDowLeads30d || 0} bookings on that weekday (30d)`;

  const iam = document.getElementById('in-avg-msgs');
  if (iam) iam.textContent = (Number(k.avgMessages) || 0).toFixed(1);

  const imo = document.getElementById('in-mobile-pct');
  const imos = document.getElementById('in-mobile-sub');
  if (imo) imo.textContent = (s.mobilePct30 || 0) + '%';
  if (imos) imos.textContent = `mobile ${s.mobileN || 0} · desktop ${s.desktopN || 0}`;

  const ifcp = document.getElementById('in-funnel-card-pct');
  if (ifcp) ifcp.textContent = String(s.funnelBookedPct || 0);

  const iprem = document.getElementById('in-premium-pct');
  if (iprem) iprem.textContent = String(s.premiumPct || 0);

  const itl = document.getElementById('in-total-leads');
  if (itl) itl.textContent = String(s.totalLeadsAll || 0);

  const visTodayEl = document.getElementById('vis-today');
  if (visTodayEl) visTodayEl.textContent = String(k.visitorsToday || 0);
  setDeltaEl('vis-today-delta', k.visitorsToday || 0, s.visitorsYesterday || 0);

  const vam = document.getElementById('vis-avg-min');
  if (vam) vam.textContent = (Number(s.avgSessionMin) || 0).toFixed(1);

  const vmp = document.getElementById('vis-mobile-pct');
  const vmc = document.getElementById('vis-mobile-count');
  if (vmp) vmp.textContent = String(s.mobilePct30 || 0);
  if (vmc) vmc.textContent = `${s.mobileN || 0} mobile · ${s.desktopN || 0} desktop`;

  const vbp = document.getElementById('vis-booked-pct');
  if (vbp) vbp.textContent = String(s.outcomeBookedPct || 0);

  const r0 = document.getElementById('rev-today');
  const r1 = document.getElementById('rev-week');
  const r2 = document.getElementById('rev-month');
  const r3 = document.getElementById('rev-ytd');
  if (r0) r0.textContent = Math.round(k.revenueToday || 0).toLocaleString('en-GB');
  if (r1) r1.textContent = Math.round(s.revWeekSum || 0).toLocaleString('en-GB');
  if (r2) r2.textContent = Math.round(s.revMonth || 0).toLocaleString('en-GB');
  if (r3) r3.textContent = Math.round(s.revYtd || 0).toLocaleString('en-GB');

  setDeltaEl('rev-today-delta', k.revenueToday || 0, s.revYesterday || 0);
  setDeltaEl('rev-week-delta', s.revWeekSum || 0, s.revPrevWeek || 0);
  setDeltaEl('rev-month-delta', s.revMonth || 0, s.revPrevMonth || 0);
  setDeltaEl('rev-ytd-delta', s.revYtd || 0, s.revYtdPriorYear || 0);

  const ys = document.getElementById('yearlyChartSubtitle');
  if (ys) {
    const y = new Date().getUTCFullYear();
    ys.textContent = `€ rolling 12m vs same month ${y - 1}`;
  }

  const nAppt = (ov.appointments || []).length;
  const nLeads = (ov.leads || []).length;
  const ap = document.getElementById('apptPaginationLabel');
  const lp = document.getElementById('leadsPaginationLabel');
  if (ap) ap.textContent = nAppt ? `Showing ${nAppt} appointment${nAppt === 1 ? '' : 's'} (loaded)` : 'No appointments';
  if (lp) {
    if (!nLeads) lp.textContent = 'No leads';
    else {
      const { queue, cancelled, done } = partitionLeadsForUi(ov.leads || []);
      lp.textContent = `${nLeads} leads · ${queue.length} up next · ${done.length} completed${cancelled.length ? ` · ${cancelled.length} cancelled` : ''}`;
    }
  }

  buildTodaySchedule(ov);
  buildInsightServiceBars(ov);
  buildRevenueGoalsBars(ov);
}

function buildTodaySchedule(ov) {
  const container = document.getElementById('apptTodayList');
  const sub = document.getElementById('dash-today-schedule-sub');
  if (!container) return;
  const today = (ov.kpi && ov.kpi.shopDateToday) || new Date().toISOString().slice(0, 10);
  const rows = (ov.appointments || []).filter((a) => {
    const cap = (a.captured_at || '').slice(0, 10);
    const pref = (a.preferred_date || '').slice(0, 10);
    return cap === today || pref === today;
  }).slice(0, 8);

  if (sub) sub.textContent = rows.length ? `${rows.length} today · from bookings` : 'No bookings dated today yet';

  if (!rows.length) {
    container.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:.85rem">No appointments for today in the database. Open Appointments for the full list.</div>';
    return;
  }

  const pill = (st) => {
    const x = String(st || 'pending').toLowerCase();
    if (x === 'completed') return '<span class="status-pill completed">✓ Done</span>';
    if (x === 'cancelled') return '<span class="status-pill cancelled">✕ Cancelled</span>';
    if (x === 'confirmed') return '<span class="status-pill confirmed">● Confirmed</span>';
    return '<span class="status-pill pending">● Pending</span>';
  };

  container.innerHTML = rows.map((a) => {
    const t = (a.preferred_time || '—').trim();
    const parts = t.match(/^(\d{1,2}):(\d{2})/);
    let hh = '—';
    let apm = '';
    if (parts) {
      let h = parseInt(parts[1], 10);
      apm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      hh = String(h) + ':' + parts[2];
    }
    const amt = a.amount_eur != null ? '€' + Number(a.amount_eur).toFixed(0) : '—';
    return `<div class="appt-item">
      <div class="appt-time-block"><div class="appt-time">${escapeCell(hh)}</div><div class="appt-period">${escapeCell(apm || '—')}</div></div>
      <div class="appt-divider"></div>
      <div class="appt-info"><div class="appt-name">${escapeCell(a.name)}</div><div class="appt-service">${escapeCell(a.service)}</div></div>
      <div class="appt-right">${pill(a.appointment_status)}<div class="appt-price">${escapeCell(amt)}</div></div>
    </div>`;
  }).join('');
}

function buildInsightServiceBars(ov) {
  const el = document.getElementById('insightServiceBars');
  if (!el) return;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const rows = (ov.leads || []).filter((l) => {
    const c = l.captured_at ? new Date(l.captured_at).getTime() : 0;
    return c >= monthStart.getTime();
  });
  const bySvc = {};
  rows.forEach((l) => {
    const n = l.service || '—';
    if (!bySvc[n]) bySvc[n] = { revenue: 0, bookings: 0 };
    bySvc[n].bookings += 1;
    bySvc[n].revenue += Number(l.amount_eur) || 0;
  });
  const list = Object.entries(bySvc).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const maxR = Math.max(1, ...list.map((x) => x.revenue));
  el.innerHTML = list.length ? list.map((s) => {
    const pct = Math.round((s.revenue / maxR) * 100);
    return `<div class="service-bar-item"><div class="service-bar-label"><span>${escapeCell(s.name)}</span><span>€${Math.round(s.revenue).toLocaleString('en-GB')} · ${s.bookings} bookings</span></div><div class="service-bar-track"><div class="service-bar-fill" style="width:${pct}%"></div></div></div>`;
  }).join('') : '<div style="padding:16px;color:var(--text3)">No bookings in the current month yet.</div>';
}

function buildRevenueGoalsBars(ov) {
  const el = document.getElementById('revenueGoalsBars');
  if (!el) return;
  const mRev = ov.monthlyRev || [];
  const mLbl = ov.monthlyRevLabels || [];
  const n = mRev.length;
  const take = Math.min(4, n);
  const start = Math.max(0, n - take);
  const slice = [];
  for (let i = start; i < n; i++) slice.push({ rev: mRev[i] || 0, lbl: mLbl[i] || `M${i + 1}` });
  const maxIn6 = Math.max(1, ...mRev.slice(Math.max(0, n - 6)));
  const target = maxIn6 * 1.1;
  el.innerHTML = slice.length ? slice.map((x) => {
    const pct = Math.min(100, Math.round(((x.rev || 0) / target) * 100));
    return `<div class="service-bar-item" style="margin-bottom:12px"><div class="service-bar-label"><span>${escapeCell(x.lbl)}</span><span>€${Math.round(x.rev).toLocaleString('en-GB')} / target €${Math.round(target).toLocaleString('en-GB')}</span></div><div class="service-bar-track"><div class="service-bar-fill" style="width:${pct}%"></div></div></div>`;
  }).join('') : '<div style="padding:12px;color:var(--text3)">No monthly data yet.</div>';
}

function showAdminLoadBanner(html) {
  const el = document.getElementById('adminLoadBanner');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = html;
}

function hideAdminLoadBanner() {
  const el = document.getElementById('adminLoadBanner');
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
}

let adminBootComplete = false;

function setLoaderStatus(text) {
  const s = document.getElementById('adminLoaderStatus');
  if (s) s.textContent = text;
}

function showBootLoader() {
  const root = document.getElementById('adminLoader');
  const err = document.getElementById('adminLoaderError');
  const retry = document.getElementById('adminLoaderRetry');
  if (!root) return;
  root.classList.remove('is-hidden');
  root.setAttribute('aria-busy', 'true');
  if (err) {
    err.hidden = true;
    err.innerHTML = '';
  }
  if (retry) retry.hidden = true;
  setLoaderStatus('Loading dashboard data…');
}

function hideBootLoader() {
  const root = document.getElementById('adminLoader');
  if (!root) return;
  root.classList.add('is-hidden');
  root.setAttribute('aria-busy', 'false');
}

function showBootLoaderError(html) {
  const err = document.getElementById('adminLoaderError');
  const retry = document.getElementById('adminLoaderRetry');
  if (err) {
    err.innerHTML = html;
    err.hidden = false;
  }
  if (retry) retry.hidden = false;
  setLoaderStatus('Could not load data.');
}

async function loadAdminData(opts = {}) {
  const silent = !!opts.silent;
  if (!silent && !adminBootComplete) {
    showBootLoader();
  }

  let r;
  try {
    r = await adminFetch('/api/admin/overview');
  } catch (e) {
    if (!silent && !adminBootComplete) {
      showBootLoaderError('Network error: ' + escapeCell(String(e && e.message ? e.message : e)));
    } else if (silent) {
      showAdminLoadBanner('Refresh failed: ' + escapeCell(String(e && e.message ? e.message : e)));
    }
    return;
  }

  if (r.status === 401) {
    if (hasStoredOrUrlCredential()) {
      logoutToGate();
      setAuthGateError('authErrLogin', 'Session expired or invalid. Please sign in again.');
      return;
    }
    if (!silent && !adminBootComplete) {
      showBootLoaderError('This server requires sign-in or an admin token. Use email and password, or add <code>?token=…</code> when using <code>ADMIN_TOKEN</code>.');
    } else {
      showAdminLoadBanner('Admin API returned 401. Sign in again or open with <code>?token=…</code> if the server uses a static token.');
    }
    return;
  }
  if (!r.ok) {
    const t = await r.text();
    if (!silent && !adminBootComplete) {
      showBootLoaderError('Could not load data. Is the API running?<br><br>' + escapeCell(t.slice(0, 400)));
    } else {
      showAdminLoadBanner('Could not load data. Is the API running? ' + escapeCell(t.slice(0, 200)));
    }
    return;
  }

  hideAdminLoadBanner();
  let json;
  try {
    json = await r.json();
  } catch (e) {
    if (!silent && !adminBootComplete) {
      showBootLoaderError('Invalid response from server.');
    }
    return;
  }

  OVERVIEW = json;
  applyDashboardKpi(OVERVIEW);
  buildApptTable();
  buildLeadsTable();
  buildLeadCards();
  buildVisitorsTable();
  buildServicesTable();
  buildHeatmap(OVERVIEW.heatmap);
  renderActivityFeed(OVERVIEW.activities);
  initChartsFromOverview(OVERVIEW);

  adminBootComplete = true;
  hideBootLoader();
}

document.addEventListener('DOMContentLoaded', () => {
  const retryBtn = document.getElementById('adminLoaderRetry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      adminBootComplete = false;
      loadAdminData({ silent: false });
    });
  }

  bootstrapAdmin();

  const ex = document.getElementById('btnExportCsv');
  if (ex) {
    ex.addEventListener('click', () => {
      const t = getAdminToken();
      const base = `${apiBase()}/api/leads/download`;
      const url = t ? `${base}?token=${encodeURIComponent(t)}` : base;
      window.open(url, '_blank');
    });
  }
  setInterval(() => {
    const app = document.getElementById('adminAppRoot');
    if (app && !app.classList.contains('is-hidden')) loadAdminData({ silent: true });
  }, 120000);
});