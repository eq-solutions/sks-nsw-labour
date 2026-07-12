/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/auth.js  —  EQ Solves Field
// Access gate (PIN check, remember-me, token verify),
// agency mode, staff timesheet self-entry gate,
// supervisor password modal, logout.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

const ACCESS_KEY       = 'eq_access_v1';
const STAFF_TS_SESSION = 'eq_staff_ts';

// ── EQ Shell iframe handoff ───────────────────────────────────
// Sends a status postMessage to the parent shell (core.eq.solutions).
// No-ops silently when not in an iframe (window.parent === window).
function _postHandoffStatus(msg) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        Object.assign({ source: 'eq-field-shell-handoff', version: 1 }, msg),
        '*'
      );
    }
  } catch (e) { /* cross-origin postMessage can throw in restricted contexts */ }
}

// Send 'boot' as soon as auth.js is parsed — before window.onload and
// before loadTenantConfig's two sequential Supabase round trips. This
// stops the shell's overlay timeout (10–30s) from firing on mobile
// cold-starts. A second 'boot' from _consumeShellToken is harmless.
(function _earlyBootSignal() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  if (new URLSearchParams(hash).get('sh')) {
    _postHandoffStatus({ kind: 'boot', hasHash: true });
  }
}());

// Reads #sh=<token> from the URL hash, calls verify-pin with
// action='verify-shell-token', and on success sets sessionStorage so
// the rest of the app starts as if the user had entered their PIN.
// Returns true on success, false on any failure (falls through to PIN gate).
async function _consumeShellToken() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  _postHandoffStatus({ kind: 'boot', hasHash: !!hash });
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = params.get('sh');
  if (!token) {
    _postHandoffStatus({ kind: 'no-sh-param' });
    return false;
  }
  // Clear the hash so the one-shot token is never stored in browser history.
  try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
  try {
    const resp = await fetch('/.netlify/functions/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-shell-token', token })
    });
    if (!resp.ok) {
      _postHandoffStatus({ kind: 'http-error', status: resp.status });
      return false;
    }
    const data = JSON.parse(await resp.text());
    if (!data.valid) {
      _postHandoffStatus({ kind: 'rejected' });
      return false;
    }
    if (data.tenant_slug && data.tenant_slug !== TENANT.ORG_SLUG) {
      _postHandoffStatus({ kind: 'tenant-mismatch', expected: TENANT.ORG_SLUG, got: data.tenant_slug });
      return false;
    }
    sessionStorage.setItem(ACCESS_KEY, '1');
    sessionStorage.setItem('eq_logged_in_name', data.name || '');
    // v3.10.96 — durable role: written at every login path, read by initApp on
    // every boot so supervisor status survives a same-tab reload (the SW
    // auto-reload used to drop supervisors to view-only).
    sessionStorage.setItem('eq_role', data.role === 'supervisor' ? 'supervisor' : 'staff');
    // Phase C1: stash the canonical identity id so initApp can resolve the
    // person deterministically by people.canonical_id (not by name string).
    // Absent on legacy shell tokens — resolver no-ops and name resolution
    // remains the fallback.
    if (data.canonical_id) sessionStorage.setItem('eq_canonical_id', data.canonical_id);
    if (data.phone) sessionStorage.setItem('eq_canonical_phone', data.phone);
    if (data.role === 'supervisor') {
      sessionStorage.setItem('eq_auto_admin', '1');
      // Pre-set supervisor state so sidebar paints unlocked from first frame,
      // same as the local remember-me restore path.
      isManager          = true;
      currentManagerName = data.name || '';
      if (typeof applyManagerMode === 'function') applyManagerMode();
    }
    if (data.sessionToken) {
      sessionStorage.setItem('eq_session_token', data.sessionToken);
      localStorage.setItem('eq_agent_token', data.sessionToken);
      // Stage-1 org-JWT: pre-mint the nspbmir data-plane JWT immediately
      // after shell handoff so the first sbFetch already has an authed token.
      // ensureOrgJwt is a no-op when ORG_JWT_ENABLED is off (dark mode).
      if (typeof ensureOrgJwt === 'function') ensureOrgJwt(true).catch(() => {});
    }
    _postHandoffStatus({ kind: 'accepted', name: data.name, role: data.role });
    return true;
  } catch (e) {
    _postHandoffStatus({ kind: 'network-error', detail: (e && e.message) || String(e) });
    return false;
  }
}

let staffTsMode   = false;
let staffTsPerson = null;
let agencyMode    = false;
let agencyName    = '';

// v3.4.59: BATTLE-TEST #45 — bounded token mint so checkPin() can await
// the verify-pin → sessionToken roundtrip before showing the app. Was
// fire-and-forget which raced fast-clicker leave submissions (the
// triggerLeaveEmail fetch fires before the token lands in localStorage,
// send-email rejects on missing x-eq-token, email silently drops).
// AbortController bounds the wait to 3s so a dead verify-pin can't
// hang the login UI — failure path just proceeds without a token,
// matching the original "non-fatal" intent.
async function _mintAndStoreEqToken(code, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch('/.netlify/functions/verify-pin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, name, remember: false }),
      signal:  controller.signal
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (data && data.valid && data.sessionToken) {
      localStorage.setItem('eq_agent_token', data.sessionToken);
      sessionStorage.setItem('eq_session_token', data.sessionToken);
      console.info('EQ[auth] agent token minted');
      return data.sessionToken;
    }
    console.warn('EQ[auth] agent token NOT minted — verify-pin returned', data);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      console.warn('EQ[auth] agent token mint timed out (3s) — proceeding without');
    } else {
      console.warn('EQ[auth] agent token mint failed:', e && e.message || e);
    }
  }
  return null;
}

// ── Gate dropdown ─────────────────────────────────────────────

let gateNameList = [];

async function populateGateDropdown() {
  if (TENANT.ORG_SLUG === 'eq' || TENANT.ORG_SLUG === 'demo') {
    gateNameList = [];
    (SEED.managers || []).forEach(m => gateNameList.push({ name: m.name, group: 'Supervision', sub: m.category || '' }));
    (SEED.people   || []).forEach(p => gateNameList.push({ name: p.name, group: p.group || '', sub: '' }));
    renderGateNameList();
    return;
  }
  // Tenant-keyed cache — prevents demo names leaking into SKS picker and
  // vice versa when the same browser has visited both tenants.
  const cacheKey = 'eq_gate_names_' + TENANT.ORG_SLUG;
  try {
    // Clean up the legacy un-keyed cache from earlier versions
    localStorage.removeItem('eq_gate_names');
    const cached = localStorage.getItem(cacheKey);
    if (cached) gateNameList = JSON.parse(cached);
  } catch (e) {}
  try {
    const people   = await sbFetch('people?select=name,group&order=name.asc');
    const managers = await sbFetch('managers?select=name,category&order=name.asc');
    gateNameList   = [];
    if (managers && managers.length) managers.forEach(m => gateNameList.push({ name: m.name, group: 'Supervision', sub: m.category || '' }));
    if (people   && people.length)   people.forEach(p   => gateNameList.push({ name: p.name, group: normaliseGroupFromDb(p.group) || '', sub: '' }));
    try { localStorage.setItem(cacheKey, JSON.stringify(gateNameList)); } catch (e) {}
  } catch (e) { console.warn('EQ[gate] could not load names, using cache:', e && e.message || e); }
  renderGateNameList();
}

function renderGateNameList(filter) {
  const container = document.getElementById('gate-name-list');
  if (!container) return;
  const query   = (filter || '').toLowerCase();
  let matches   = gateNameList;
  if (query) matches = matches.filter(p => p.name.toLowerCase().includes(query));

  const groupOrder  = ['Supervision', ...PEOPLE_GROUPS];
  const groupColors = { 'Supervision': '#7C77B9', 'Direct': '#1F335C', 'Apprentice': '#7C77B9', 'Labour Hire': '#34486C' };

  let html = '';
  if (!matches.length) {
    html = `<div style="padding:16px;text-align:center;color:var(--ink-4);font-size:13px">${query ? 'No matches found' : 'Loading…'}</div>`;
  } else {
    groupOrder.forEach(g => {
      const gm    = matches.filter(p => p.group === g);
      if (!gm.length) return;
      const color = groupColors[g] || '#666';
      html += `<div onclick="toggleGateGroup(this)" style="padding:10px 14px;font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.5px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:#F8FAFC;border-bottom:1px solid #E5E7EB">
        <span>${g} (${gm.length})</span><span class="gate-grp-arr" style="transition:transform .2s">▼</span>
      </div>
      <div class="gate-grp-items">`;
      gm.forEach(p => {
        const initial = p.name.charAt(0).toUpperCase();
        const safeName = p.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        html += `<div onclick="selectGateName('${safeName}')" style="padding:14px 16px;font-size:15px;font-weight:600;color:#1F335C;cursor:pointer;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;gap:10px" onmouseover="this.style.background='#F0F4F8'" onmouseout="this.style.background=''">
          <span style="width:34px;height:34px;border-radius:50%;background:${color};color:white;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0">${initial}</span>
          ${esc(p.name)}
        </div>`;
      });
      html += '</div>';
    });
  }
  container.innerHTML = html;
}

function toggleGateNamePicker() {
  const picker = document.getElementById('gate-name-picker');
  if (picker.style.display === 'none') {
    picker.style.display = '';
    renderGateNameList();
    const search = picker.querySelector('input[type=search]');
    if (search) setTimeout(() => search.focus(), 50);
  } else {
    picker.style.display = 'none';
  }
}

function toggleGateGroup(el) {
  const items = el.nextElementSibling;
  const arrow = el.querySelector('.gate-grp-arr');
  if (items.style.display === 'none') { items.style.display = ''; if (arrow) arrow.style.transform = 'rotate(0deg)'; }
  else                                 { items.style.display = 'none'; if (arrow) arrow.style.transform = 'rotate(-90deg)'; }
}

function filterGatePickerNames() {
  const query = document.getElementById('gate-name-search').value;
  renderGateNameList(query);
  if (query) {
    document.querySelectorAll('.gate-grp-items').forEach(el => el.style.display = '');
    document.querySelectorAll('.gate-grp-arr').forEach(el => el.style.transform = 'rotate(0deg)');
  }
}

function selectGateName(name) {
  document.getElementById('gate-name').value = name;
  const txt = document.getElementById('gate-selected-text');
  txt.textContent = name;
  txt.style.color = '#1F335C';
  document.getElementById('gate-name-picker').style.display = 'none';
  const search = document.getElementById('gate-name-search');
  if (search) search.value = '';
  document.getElementById('gate-err').textContent = '';
  setTimeout(() => document.getElementById('gate-pin').focus(), 50);
}

// Close picker when clicking outside
document.addEventListener('click', function(e) {
  const picker = document.getElementById('gate-name-picker');
  if (picker && picker.style.display !== 'none' &&
      !e.target.closest('#gate-name-picker') &&
      !e.target.closest('#gate-selected-name')) {
    picker.style.display = 'none';
  }
});

// Global Enter handler on the gate — submits login from anywhere on the
// gate card (not just the PIN input), so long as focus isn't inside the
// name-search box or another input that handles its own Enter.
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const gate = document.getElementById('access-gate');
  if (!gate || gate.classList.contains('hidden')) return;
  // Ignore Enter inside the name-search input (that's for filtering)
  const t = e.target;
  if (t && t.id === 'gate-name-search') return;
  // If user has selected a name, submit — otherwise open picker
  const hasName = (document.getElementById('gate-name') || {}).value;
  if (!hasName) {
    if (typeof toggleGateNamePicker === 'function') toggleGateNamePicker();
    return;
  }
  e.preventDefault();
  if (typeof checkPin === 'function') checkPin();
});

// ── PIN check (main gate) ─────────────────────────────────────

async function checkPin() {
  const name = document.getElementById('gate-name').value;
  const val  = (document.getElementById('gate-pin').value || '').trim();

  if (!name) { document.getElementById('gate-err').textContent = 'Please tap and select your name first.'; return; }

  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem('eq_logged_in_name');
  sessionStorage.removeItem('eq_auto_admin');

  if (!val) { document.getElementById('gate-err').textContent = 'Please enter your access code.'; return; }

  // Client-side access codes (set by tenant branding). Validates locally so
  // we don't need the Netlify verify-pin function for simple code-gated
  // tenants. Staff code = view-only; supervisor code = auto-unlock to
  // Supervision mode.
  if (window.__TENANT_CODES__) {
    const codes = window.__TENANT_CODES__;
    let role = null;
    if (codes.staff      && val === codes.staff)      role = 'staff';
    if (codes.supervisor && val === codes.supervisor) role = 'supervisor';
    if (role) {
      sessionStorage.setItem(ACCESS_KEY, '1');
      sessionStorage.setItem('eq_logged_in_name', name);
      if (role === 'supervisor') sessionStorage.setItem('eq_auto_admin', '1');
      sessionStorage.setItem('eq_role', role);   // v3.10.96 — durable role
      // Persistent "remember me" for tenant-code gate (no server token).
      try {
        const remember = document.getElementById('gate-remember');
        const days = (window.__TENANT_REMEMBER_DAYS__ || 0);
        if (remember && remember.checked && days > 0) {
          const payload = {
            slug:  TENANT.ORG_SLUG,
            name:  name,
            role:  role,
            // Store the code so checkAccess() can re-mint a server-side
            // session token on auto-restore (needed for EQ Agent etc).
            // Local-only — never leaves the user's browser.
            code:  val,
            exp:   Date.now() + (days * 24 * 60 * 60 * 1000)
          };
          localStorage.setItem('eq_local_remember_' + TENANT.ORG_SLUG, JSON.stringify(payload));
        } else {
          localStorage.removeItem('eq_local_remember_' + TENANT.ORG_SLUG);
        }
      } catch (e) {}
      // ── Mint a server-side session token for protected features ──
      // The local code-gate doesn't talk to the server, so features like
      // send-email and EQ Agent (which call Netlify functions) have nothing
      // to authenticate with. Mint the same code via verify-pin, which
      // compares against STAFF_CODE/MANAGER_CODE env vars per-tenant and
      // returns a signed 7-day session token. Failures are silent —
      // core app functionality doesn't depend on this.
      // v3.4.37: lifted eq/demo exclusion — both tenants now have Netlify
      // backends and need tokens for send-email to work.
      // v3.4.59: BATTLE-TEST #45 — await the mint (3s bounded) so subsequent
      // protected fetches have a token. Was IIFE fire-and-forget which
      // raced fast-clicker leave submissions on slow connections.
      await _mintAndStoreEqToken(val, name);
      // Stage-1 org-JWT: pre-mint immediately after PIN success so the
      // first data fetch uses the authenticated token. No-op when dark.
      if (typeof ensureOrgJwt === 'function') ensureOrgJwt(true).catch(() => {});
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
      initPushOptIn(name);
      _showCoreNudge(name);
    } else {
      document.getElementById('gate-err').textContent = 'Incorrect code. Please try again.';
      document.getElementById('gate-pin').value = '';
      document.getElementById('gate-pin').focus();
    }
    return;
  }

  // Demo mode
  if (TENANT.ORG_SLUG === 'eq' || TENANT.ORG_SLUG === 'demo') {
    let role = null;
    if (val === 'demo')     role = 'staff';
    if (val === 'demo1234') role = 'supervisor';
    if (role) {
      sessionStorage.setItem(ACCESS_KEY, '1');
      sessionStorage.setItem('eq_logged_in_name', name);
      if (role === 'supervisor') sessionStorage.setItem('eq_auto_admin', '1');
      sessionStorage.setItem('eq_role', role);   // v3.10.96 — durable role
      // Mint a server-side session token so demo can call protected
      // endpoints (send-email etc). Demo only — eq tenant has no backend.
      // v3.4.59: BATTLE-TEST #45 — await (was IIFE fire-and-forget).
      if (TENANT.ORG_SLUG === 'demo') {
        await _mintAndStoreEqToken(val, name);
      }
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
      initPushOptIn(name);
      _showCoreNudge(name);
    } else {
      document.getElementById('gate-err').textContent = 'Incorrect code. Use the demo codes shown above.';
      document.getElementById('gate-pin').value = '';
      document.getElementById('gate-pin').focus();
    }
    return;
  }

  // Production: server-side validation
  try {
    const btn = document.querySelector('.gate-btn');
    btn.textContent = 'Checking…'; btn.disabled = true;
    const resp = await fetch('/.netlify/functions/verify-pin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code: val, name, remember: document.getElementById('gate-remember').checked })
    });
    btn.textContent = 'Enter'; btn.disabled = false;

    if (!resp.ok && resp.status === 404) {
      document.getElementById('gate-err').textContent = 'Login service not found. Contact Royce.';
      return;
    }
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      document.getElementById('gate-err').textContent = 'Login service error. Try the reset button below.';
      return;
    }
    if (data.locked) { document.getElementById('gate-err').textContent = data.message || 'Too many attempts. Try again later.'; document.getElementById('gate-pin').value = ''; return; }
    if (data.attemptsRemaining && data.attemptsRemaining <= 2) {
      document.getElementById('gate-err').textContent = data.attemptsRemaining + ' attempt(s) remaining before lockout.';
    }
    if (data.valid) {
      sessionStorage.setItem(ACCESS_KEY, '1');
      sessionStorage.setItem('eq_logged_in_name', name);
      if (data.role === 'supervisor') sessionStorage.setItem('eq_auto_admin', '1');
      sessionStorage.setItem('eq_role', data.role === 'supervisor' ? 'supervisor' : 'staff');   // v3.10.96 — durable role
      if (data.token) localStorage.setItem('eq_remember_token', data.token);
      if (data.sessionToken) {
        sessionStorage.setItem('eq_session_token', data.sessionToken);
        localStorage.setItem('eq_agent_token',     data.sessionToken);
      }
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
      initPushOptIn(name);
      _showCoreNudge(name);
    } else {
      document.getElementById('gate-err').textContent = 'Incorrect code. Please try again.';
      document.getElementById('gate-pin').value = '';
      document.getElementById('gate-pin').focus();
    }
  } catch (e) {
    const btn = document.querySelector('.gate-btn');
    btn.textContent = 'Enter'; btn.disabled = false;
    // v3.4.59: BATTLE-TEST #47 — clear the PIN input on the outer catch
    // path. Success + known-failure paths already clear it; only the
    // network-error / JSON-parse-fail path was leaving the typed PIN
    // visible in the DOM (browser dev-tools / accidental screen-share /
    // form auto-fill exposure).
    const pinInput = document.getElementById('gate-pin');
    if (pinInput) pinInput.value = '';
    document.getElementById('gate-err').textContent = 'Connection error: ' + e.message;
  }
}

async function checkAccess() {
  if (sessionStorage.getItem(ACCESS_KEY) === '1') {
    // Already authenticated — tell the shell overlay to clear.
    _postHandoffStatus({
      kind: 'accepted',
      name: sessionStorage.getItem('eq_logged_in_name') || '',
      // v3.10.96 — read the durable role; fall back to the legacy one-shot flag
      // for sessions that were open across the upgrade.
      role: sessionStorage.getItem('eq_role') || (sessionStorage.getItem('eq_auto_admin') === '1' ? 'supervisor' : 'staff')
    });
    return true;
  }

  // EQ Shell iframe SSO — try to consume a #sh= token before PIN gate.
  if (await _consumeShellToken()) return true;

  // Local "remember me" restore for tenant-code gate (no server).
  try {
    const rawLocal = localStorage.getItem('eq_local_remember_' + TENANT.ORG_SLUG);
    if (rawLocal) {
      const p = JSON.parse(rawLocal);
      if (p && p.exp && Date.now() < p.exp && p.slug === TENANT.ORG_SLUG) {
        sessionStorage.setItem(ACCESS_KEY, '1');
        sessionStorage.setItem('eq_logged_in_name', p.name || '');
        sessionStorage.setItem('eq_role', p.role === 'supervisor' ? 'supervisor' : 'staff');   // v3.10.96 — durable role
        if (p.role === 'supervisor') {
          sessionStorage.setItem('eq_auto_admin', '1');
          // v3.4.79: pre-set the manager state so the sidebar paints
          // unlocked from the first frame instead of flashing
          // "View only" for ~2s while initApp's loadFromSupabase
          // resolves. initApp still calls applyManagerMode later;
          // it's idempotent so the second call is a no-op refresh.
          isManager          = true;
          currentManagerName = p.name || 'Supervisor';
          if (typeof applyManagerMode === 'function') applyManagerMode();
        }
        // Re-mint a server-side session token for EQ Agent etc.
        // Only possible if the stored payload includes the code (newer
        // logins do; older ones won't until the user logs in again).
        if (p.code) {
          (async () => {
            try {
              const resp = await fetch('/.netlify/functions/verify-pin', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ code: p.code, name: p.name, remember: false })
              });
              const data = await resp.json();
              if (data && data.valid && data.sessionToken) {
                localStorage.setItem('eq_agent_token', data.sessionToken);
                sessionStorage.setItem('eq_session_token', data.sessionToken);
                console.info('EQ[auth] agent token re-minted on restore');
              } else {
                console.warn('EQ[auth] restore re-mint failed:', data);
              }
            } catch (e) {
              console.warn('EQ[auth] restore re-mint error:', e && e.message || e);
            }
          })();
        } else if (!p.code) {
          console.info('EQ[auth] restored from legacy remember-me (no code stored) — log out and back in once to enable EQ Agent');
        }
        return true;
      } else {
        localStorage.removeItem('eq_local_remember_' + TENANT.ORG_SLUG);
      }
    }
  } catch (e) {}

  {
    const token = localStorage.getItem('eq_remember_token');
    if (token) {
      try {
        const resp = await fetch('/.netlify/functions/verify-pin', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'verify-token', token })
        });
        const data = JSON.parse(await resp.text());
        if (data.valid) {
          sessionStorage.setItem(ACCESS_KEY, '1');
          sessionStorage.setItem('eq_logged_in_name', data.name);
          if (data.role === 'supervisor') sessionStorage.setItem('eq_auto_admin', '1');
          sessionStorage.setItem('eq_role', data.role === 'supervisor' ? 'supervisor' : 'staff');   // v3.10.96 — durable role
          // Phase C1: preserve the canonical identity across remember-me
          // restores so SSO users keep deterministic person resolution.
          if (data.canonical_id) sessionStorage.setItem('eq_canonical_id', data.canonical_id);
          if (data.phone) sessionStorage.setItem('eq_canonical_phone', data.phone);
          if (data.sessionToken) {
            sessionStorage.setItem('eq_session_token', data.sessionToken);
            localStorage.setItem('eq_agent_token',     data.sessionToken);
          }
          return true;
        }
      } catch (e) {}
      localStorage.removeItem('eq_remember_token');
    }
  }
  document.getElementById('access-gate').classList.remove('hidden');
  populateGateDropdown();
  return false;
}

function logoutUser() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem('eq_logged_in_name');
  sessionStorage.removeItem('eq_canonical_id');
  sessionStorage.removeItem('eq_canonical_phone');
  sessionStorage.removeItem('eq_auto_admin');
  sessionStorage.removeItem('eq_role');   // v3.10.96 — clear durable role on logout
  sessionStorage.removeItem('eq_agency');
  sessionStorage.removeItem('eq_session_token');
  localStorage.removeItem('eq_remember_token');
  localStorage.removeItem('eq_agent_token');
  try { localStorage.removeItem('eq_local_remember_' + TENANT.ORG_SLUG); } catch (e) {}
  window.location.reload();
}

// ── Supervisor password modal ─────────────────────────────────

let currentManagerName = '';

function toggleManagerMode() {
  if (isManager) {
    auditLog('Locked manager mode', 'Access', null, null);
    isManager          = false;
    currentManagerName = '';
    sessionStorage.setItem('eq_role', 'staff');   // v3.10.96 — view-only choice survives a reload
    applyManagerMode();
    // v3.10.41: re-render so the current page drops edit affordances
    // (re-disables inputs, hides supervisor-only chips) immediately.
    if (typeof currentPage !== 'undefined' && currentPage && typeof renderCurrentPage === 'function') renderCurrentPage();
    showToast('Switched to view only');
    return;
  }
  const sel  = document.getElementById('manager-name-select');
  // v3.4.61: keep this list in sync with `catOrder` in scripts/managers.js.
  // BUG history: when "Executive" was added in v3.4.42 (so Mark/John/Royce
  // could be grouped together on the Supervision page), this duplicate
  // allowlist was missed. Effect: Executive-category supervisors couldn't
  // unlock supervisor mode — their names didn't appear in this dropdown.
  // Spotted on SKS where Royce (Executive) tried to unlock and his own
  // name was missing from the picker. Long-term fix: extract to a shared
  // constant. Short-term: mirror managers.js exactly.
  const SUPERVISOR_CATEGORIES = ['Executive','Management','Operations','Project Management','Construction','Supervisor','Internal','Other'];
  const mgrs = (STATE.managers || []).filter(m =>
    SUPERVISOR_CATEGORIES.includes(m.category)
  );
  sel.innerHTML = '<option value="">— Select your name —</option>' +
    [...mgrs].sort((a, b) => a.name.localeCompare(b.name))
      .map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  if (currentManagerName) sel.value = currentManagerName;
  openModal('modal-manager-pw');
  setTimeout(() => {
    const inp = document.getElementById('manager-pw-input');
    if (inp) { inp.value = ''; inp.focus(); }
    document.getElementById('manager-pw-error').style.display = 'none';
  }, 120);
}

async function submitManagerPassword() {
  const pw   = (document.getElementById('manager-pw-input').value || '').trim();
  const name = (document.getElementById('manager-name-select').value || '').trim();
  const isDemo = (TENANT.ORG_SLUG === 'eq' || TENANT.ORG_SLUG === 'demo');
  const errEl = document.getElementById('manager-pw-error');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
  const clearErr = () => { if (errEl) errEl.style.display = 'none'; };

  // v3.4.31: surface specific failure reasons instead of one catch-all error.
  // Empty-field guards run before the network call so we don't waste an
  // attempt against the rate-limit budget on obvious typos.
  if (!name) {
    showErr('Please select your name from the dropdown.');
    document.getElementById('manager-name-select').focus();
    return;
  }
  if (!pw) {
    showErr('Please enter your supervision password.');
    document.getElementById('manager-pw-input').focus();
    return;
  }
  clearErr();

  let validPw = false;
  let serverErr = null;
  if (isDemo) {
    validPw = pw === 'demo1234'; // DEMO_FLAG
  } else {
    try {
      const r = await fetch('/.netlify/functions/verify-pin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: pw, name, role: 'supervisor' })
      });
      if (r.ok) {
        const d = await r.json();
        validPw = !!(d.valid && d.role === 'supervisor');
        if (!validPw && d.attemptsRemaining != null) {
          serverErr = `Incorrect password — ${d.attemptsRemaining} attempt${d.attemptsRemaining === 1 ? '' : 's'} remaining.`;
        } else if (!validPw) {
          serverErr = 'Incorrect password.';
        }
      } else if (r.status === 429) {
        try {
          const d = await r.json();
          serverErr = d.message || 'Too many failed attempts — try again in 15 minutes.';
        } catch (_) {
          serverErr = 'Too many failed attempts — try again in 15 minutes.';
        }
      } else if (r.status === 404) {
        console.warn('SEC-002: verify-pin not deployed, fallback');
        validPw = pw === MANAGER_PASSWORD;
        if (!validPw) serverErr = 'Incorrect password.';
      } else {
        serverErr = `Server error (${r.status}). Please try again.`;
      }
    } catch (e) {
      console.warn('SEC-002: verify-pin unreachable:', e.message);
      validPw = pw === MANAGER_PASSWORD;
      if (!validPw) serverErr = 'Couldn\'t reach the server — check your connection and try again.';
    }
  }

  if (validPw) {
    isManager          = true;
    currentManagerName = name;
    sessionStorage.setItem('eq_role', 'supervisor');   // v3.10.96 — mid-session unlock survives a reload
    applyManagerMode();
    // v3.10.41: re-render the page you're already on so edit affordances
    // (disabled job/hours inputs, supervisor-only chips) switch on
    // immediately. applyManagerMode() only repaints the lock chrome —
    // without this, unlocking while sitting on Timesheets left every
    // cell disabled until you navigated away and back.
    if (typeof currentPage !== 'undefined' && currentPage && typeof renderCurrentPage === 'function') renderCurrentPage();
    closeModal('modal-manager-pw');
    showToast('Supervision mode unlocked — ' + name);
    auditLog('Unlocked manager mode', 'Access', null, null);
  } else {
    showErr(serverErr || 'Incorrect password.');
    document.getElementById('manager-pw-input').value = '';
    document.getElementById('manager-pw-input').focus();
    // v3.4.35: track unlock failures so Royce can see auth friction.
    if (window.EQ_ANALYTICS && EQ_ANALYTICS.events) {
      EQ_ANALYTICS.events.unlockFailed({ reason: serverErr || 'Incorrect password.' });
    }
  }
}

function applyManagerMode() {
  const icon     = document.getElementById('lock-icon');
  const label    = document.getElementById('lock-label');
  const status   = document.getElementById('lock-status');
  const btn      = document.getElementById('manager-lock-btn');
  const auditBtn = document.getElementById('audit-log-btn');
  // v3.4.76: undo / redo are supervisor-only — flip visibility every
  // time the lock state changes so view-only users never see the
  // controls. _updateUndoButton handles tooltip + disabled state.
  const undoBtn  = document.getElementById('topbar-undo-btn');
  const redoBtn  = document.getElementById('topbar-redo-btn');
  if (undoBtn) undoBtn.style.display = isManager ? '' : 'none';
  if (redoBtn) redoBtn.style.display = isManager ? '' : 'none';
  if (typeof _updateUndoButton === 'function') _updateUndoButton();

  // Restore anything applyStaffMode() hid if a supervisor unlocks mid-session.
  if (isManager) {
    document.querySelectorAll('[data-staff-hidden]').forEach(el => {
      el.style.display = '';
      el.removeAttribute('data-staff-hidden');
    });
    // Restore all repurposed nav buttons back to supervisor defaults
    const _origLabels    = { 'mnav-schedule': 'My Week', 'mnav-roster': 'Roster', 'mnav-dashboard': 'Dashboard' };
    const _origFallbacks = { 'mnav-schedule': "mobileNav('schedule')", 'mnav-roster': "mobileNav('roster')", 'mnav-dashboard': "mobileNav('dashboard')" };
    ['mnav-schedule', 'mnav-roster', 'mnav-dashboard'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.getAttribute('data-staff-orig-html')) return;
      el.innerHTML = el.getAttribute('data-staff-orig-html');
      el.setAttribute('onclick', el.getAttribute('data-staff-orig-onclick') || _origFallbacks[id]);
      el.setAttribute('aria-label', _origLabels[id]);
      el.removeAttribute('data-staff-orig-html');
      el.removeAttribute('data-staff-orig-onclick');
      el.style.display = '';
    });
  }

  if (isManager) {
    document.body.classList.add('manager-mode');
    if (icon)     icon.textContent    = '🔓';
    if (label)    label.textContent   = 'Supervision mode';
    // v3.4.20 (L17): surface the current supervisor's name while unlocked so
    // shared-device hand-offs can't silently attribute actions to the
    // previous unlocker. Symptom on SKS prod: Royce approved Tara's leave
    // but audit + email showed Ben Ritchie as approver because Ben had
    // unlocked earlier and the session persisted unchanged.
    if (status)   {
      const who = (currentManagerName || '').trim();
      status.textContent = who ? (who + ' — unlocked') : 'Editing unlocked';
      status.style.color = '#86EFAC';
    }
    if (btn)      btn.style.background = 'rgba(22,163,74,.25)';
    if (auditBtn) auditBtn.style.display = 'inline';
  } else {
    document.body.classList.remove('manager-mode');
    if (icon)     icon.textContent    = '🔒';
    const loggedInName = sessionStorage.getItem('eq_logged_in_name');
    if (label)    label.textContent   = loggedInName || 'Access';
    if (status)   { status.textContent = 'View only — tap to unlock'; status.style.color = 'rgba(255,255,255,.9)'; }
    if (btn)      btn.style.background = 'rgba(0,0,0,.25)';
    if (auditBtn) auditBtn.style.display = 'none';
  }
  updateMobileLock();
}

function updateMobileLock() {
  const btn    = document.getElementById('mobile-lock-btn');
  const icon   = document.getElementById('mobile-lock-icon');
  const status = document.getElementById('mobile-lock-status');
  if (isManager) {
    if (btn)    { btn.classList.remove('locked'); btn.classList.add('unlocked'); }
    if (icon)   icon.textContent   = '🔓';
    // v3.4.20 (L17): include the current supervisor's name so a shared
    // device doesn't silently attribute actions to the previous unlocker.
    if (status) {
      const who = (currentManagerName || '').trim();
      status.textContent = who
        ? ('Unlocked as ' + who + ' — tap to lock')
        : 'Supervision mode — tap to lock';
    }
  } else {
    if (btn)    { btn.classList.remove('unlocked'); btn.classList.add('locked'); }
    if (icon)   icon.textContent   = '🔒';
    if (status) status.textContent = 'View only — tap to unlock';
  }
}

// ── Staff (non-manager) mobile cleanup ───────────────────────
// Hides nav items and UI chrome that are irrelevant to employees
// viewing their own schedule. Marks hidden elements with
// data-staff-hidden so applyManagerMode() can restore them if a
// supervisor unlocks mid-session on the same device.
function applyStaffMode() {
  if (isManager) return;
  // Calendar has no staff use-case — hide it
  const mnav_cal = document.getElementById('mnav-calendar');
  if (mnav_cal && mnav_cal.style.display !== 'none') {
    mnav_cal.setAttribute('data-staff-hidden', '1');
    mnav_cal.style.display = 'none';
  }
  // Repurpose the three supervisor nav slots for staff: Home / Schedule / Leave
  const staffNav = [
    { id: 'mnav-schedule',  onclick: "mobileNav('home')",     label: 'Home',     html: '<span class="mnav-icon">⌂</span>Home' },
    { id: 'mnav-roster',    onclick: "mobileNav('schedule')", label: 'Schedule', html: '<span class="mnav-icon">📅</span>Schedule' },
    { id: 'mnav-dashboard', onclick: "mobileNav('leave')",    label: 'Leave',    html: '<span class="mnav-icon">✈</span>Leave' },
  ];
  staffNav.forEach(({ id, onclick, label, html }) => {
    const el = document.getElementById(id);
    if (!el || el.getAttribute('data-staff-orig-html')) return;
    el.setAttribute('data-staff-orig-html', el.innerHTML);
    el.setAttribute('data-staff-orig-onclick', el.getAttribute('onclick') || '');
    el.setAttribute('onclick', onclick);
    el.setAttribute('aria-label', label);
    el.innerHTML = html;
    el.style.display = '';
  });
}

// ── Agency access ─────────────────────────────────────────────

function getAgencies() {
  const people = (STATE.people && STATE.people.length) ? STATE.people : (SEED.people || []);
  return [...new Set(people.filter(p => p.agency && p.agency.trim()).map(p => p.agency.trim()))].sort();
}

function openAgencyGate() {
  document.getElementById('agency-gate').classList.remove('hidden');
  document.getElementById('agency-gate').style.display = 'flex';
  const agencies = getAgencies();
  const sel      = document.getElementById('agency-select');
  sel.innerHTML  = '<option value="">— Select your agency —</option>' +
    agencies.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  document.getElementById('agency-err').style.display = 'none';
  document.getElementById('agency-code').value = '';
}

function closeAgencyGate() {
  document.getElementById('agency-gate').classList.add('hidden');
  document.getElementById('agency-gate').style.display = 'none';
}

function _getAgencyPassword(agency) {
  // NOTE: This is client-computable — intentional for agency read-only access
  // Full fix: move to verify-pin server function with agency mode
  return agency.toUpperCase().replace(/[^A-Z]/g, '') + new Date().getFullYear().toString();
}

function checkAgencyLogin() {
  const agency = document.getElementById('agency-select').value;
  const code   = document.getElementById('agency-code').value.trim();
  if (!agency) { document.getElementById('agency-err').textContent = 'Please select your agency.'; document.getElementById('agency-err').style.display = 'block'; return; }
  if (code === _getAgencyPassword(agency)) {
    agencyMode = true; agencyName = agency;
    sessionStorage.setItem(ACCESS_KEY, '1');
    sessionStorage.setItem('eq_agency', agency);
    closeAgencyGate();
    document.getElementById('access-gate').classList.add('hidden');
    initApp();
  } else {
    document.getElementById('agency-err').textContent = 'Incorrect code. Please try again.';
    document.getElementById('agency-err').style.display = 'block';
    document.getElementById('agency-code').value = '';
    document.getElementById('agency-code').focus();
  }
}

function agencyLogout() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem('eq_agency');
  location.reload();
}

function applyAgencyMode() {
  if (!agencyMode) return;
  document.querySelectorAll('.nav-item').forEach(el => { if (el.id !== 'nav-timesheets') el.style.display = 'none'; });
  document.querySelectorAll('.nav-label').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.mobile-nav-item').forEach(el => { if (el.id !== 'mnav-timesheets') el.style.display = 'none'; });
  const lockBtn   = document.getElementById('manager-lock-btn');   if (lockBtn)   lockBtn.style.display   = 'none';
  const mobileLock = document.getElementById('mobile-lock-btn');   if (mobileLock) mobileLock.style.display = 'none';
  const appTab    = document.getElementById('ts-tab-app');         if (appTab)    appTab.style.display    = 'none';
  document.querySelectorAll('#page-timesheets .edit-only').forEach(el => el.style.display = 'none');
  const auditBtn  = document.getElementById('audit-log-btn');      if (auditBtn)  auditBtn.style.display  = 'none';

  const footer = document.querySelector('.sidebar-footer');
  if (footer) footer.innerHTML = `<strong style="color:rgba(255,255,255,.7)">${esc(agencyName)}</strong><span style="display:block;margin-top:2px">Agency read-only access</span><button onclick="agencyLogout()" style="margin-top:8px;background:none;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.5);font-size:10px;padding:5px 12px;border-radius:6px;cursor:pointer;font-family:inherit;width:100%">Log Out</button>`;

  tsTab = 'lh';
  const lhTab = document.getElementById('ts-tab-lh');
  if (lhTab) { lhTab.classList.add('active'); lhTab.style.pointerEvents = 'none'; }
  showPage('timesheets');
  if (typeof mobileNav === 'function') mobileNav('timesheets');

  // Strip data agency users shouldn't see
  const agencyPeopleNames = new Set(STATE.people.filter(p => p.agency === agencyName).map(p => p.name));
  STATE.people     = STATE.people.filter(p => p.agency === agencyName);
  STATE.schedule   = STATE.schedule.filter(r => agencyPeopleNames.has(r.name));
  STATE.timesheets = (STATE.timesheets || []).filter(r => agencyPeopleNames.has(r.name));
  STATE.managers   = [];
  STATE.sites      = [];
  STATE.people.forEach(p => { p.phone = ''; }); // no direct contact details for agency
}

// ── Staff timesheet gate ──────────────────────────────────────

async function openStaffTsGate() {
  const sel = document.getElementById('staff-ts-name-select');
  sel.innerHTML = '<option value="">Loading…</option>';
  document.getElementById('staff-ts-pin').value      = '';
  document.getElementById('staff-ts-err').textContent = '';
  document.getElementById('staff-ts-gate').style.display = 'flex';

  let eligible = [];
  try {
    const rows = await sbFetch('people?select=id,name,group&order=name.asc');
    if (rows && rows.length) eligible = rows.filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire');
  } catch (e) {
    eligible = (STATE.people || []).filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire').sort((a, b) => a.name.localeCompare(b.name));
  }
  sel.innerHTML = '<option value="">— Select your name —</option>' +
    eligible.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

function closeStaffTsGate() {
  document.getElementById('staff-ts-gate').style.display = 'none';
}

async function checkStaffTsLogin() {
  const sel      = document.getElementById('staff-ts-name-select');
  const personId = sel.value;
  const pin      = document.getElementById('staff-ts-pin').value.trim();
  const errEl    = document.getElementById('staff-ts-err');
  const pinEl    = document.getElementById('staff-ts-pin');

  if (!personId) { errEl.textContent = 'Please select your name.'; return; }
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    errEl.textContent = 'PIN must be 4 digits.'; pinEl.style.borderColor = 'var(--red)'; pinEl.value = ''; return;
  }
  try {
    const rows = await sbFetch(`people?id=eq.${personId}&select=id,name,group,pin`);
    if (!rows || !rows.length) { errEl.textContent = 'Person not found. Contact your supervisor.'; return; }
    const person = rows[0];
    if (!person.pin)               { errEl.textContent = 'No PIN set for ' + person.name + '. Ask your supervisor.'; return; }
    if (String(person.pin) !== pin){ errEl.textContent = 'Incorrect PIN. Please try again.'; pinEl.style.borderColor = 'var(--red)'; pinEl.value = ''; pinEl.focus(); return; }

    staffTsMode   = true;
    staffTsPerson = { id: person.id, name: person.name, group: person.group };
    sessionStorage.setItem(STAFF_TS_SESSION, JSON.stringify(staffTsPerson));
    sessionStorage.setItem(ACCESS_KEY, '1');
    closeStaffTsGate();
    document.getElementById('access-gate').classList.add('hidden');
    initStaffTsApp();
  } catch (e) {
    errEl.textContent = 'Connection error — please try again.';
    console.error('Staff TS login error:', e);
  }
}

function staffTsLogout() {
  staffTsMode = false; staffTsPerson = null;
  sessionStorage.removeItem(STAFF_TS_SESSION);
  sessionStorage.removeItem(ACCESS_KEY);
  location.reload();
}

async function initStaffTsApp() {
  showLoadingOverlay('Loading your timesheet…');
  try { await loadFromSupabase(); } catch (e) { console.warn('Load error:', e); }
  hideLoadingOverlay();

  ['sidebar', 'mobile-nav', 'last-updated-bar', 'manager-lock-btn', 'legend-bar'].forEach(id => {
    const el = id === 'sidebar' ? document.querySelector('.sidebar') : document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Build week list
  const weekSet = new Set(STATE.schedule.map(r => r.week));
  const today   = new Date();
  for (let i = -4; i < 8; i++) {
    const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + i * 7);  // v3.10.94 ISO Monday (was - getDay() + 1; rolled a day early on Sundays)
    weekSet.add(String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getFullYear()).slice(-2));
  }
  const allWeeks = [...weekSet].sort((a, b) => {
    const [da,ma,ya]=a.split('.'); const [db,mb,yb]=b.split('.');
    return new Date(`20${ya}-${ma}-${da}`) - new Date(`20${yb}-${mb}-${db}`);
  });

  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const weekOpts = allWeeks.map(w => `<option value="${w}"${w === STATE.currentWeek ? ' selected' : ''}>${w}</option>`).join('');
    topbar.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;width:100%;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-size:16px;font-weight:700;color:var(--navy)">⏱ My Timesheet</div>
          <div style="font-size:11px;color:var(--ink-3)">${esc(staffTsPerson.name)} &nbsp;·&nbsp; ${staffTsPerson.group}</div>
        </div>
        <div class="topbar-week">
          <button onclick="stepWeek(-1)" style="background:none;border:none;cursor:pointer;color:var(--navy-2);font-size:15px;padding:0 2px;line-height:1;font-family:inherit">‹</button>
          <span id="week-label-text" style="font-size:12px;font-weight:600;color:var(--navy-2)">${formatWeekLabel(STATE.currentWeek)}</span>
          <select id="globalWeek" onchange="onWeekChange()" style="border:none;background:transparent;font-family:inherit;font-size:11px;color:var(--ink-3);outline:none;cursor:pointer;padding:0;max-width:80px">${weekOpts}</select>
          <button onclick="stepWeek(1)" style="background:none;border:none;cursor:pointer;color:var(--navy-2);font-size:15px;padding:0 2px;line-height:1;font-family:inherit">›</button>
        </div>
        <button onclick="staffTsLogout()" class="btn btn-secondary btn-sm">Log Out</button>
      </div>`;
  }

  await loadJobNumbers();
  const contentEl = document.querySelector('.content');
  if (contentEl) contentEl.style.marginLeft = '0';

  showPage('staff-ts');
  renderStaffTs();
  renderStaffJobsPanel();

  const jobsPanel = document.getElementById('staff-jobs-panel');
  if (jobsPanel) {
    jobsPanel.style.display = window.innerWidth > 768 ? '' : 'none';
  }
}

// ── Push notification opt-in ─────────────────────────────────
// v3.10.4: shown 3 s after login for staff who haven't been asked.
// Supervisors get the same prompt (they're staff too when on mobile).

function initPushOptIn(personName) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (localStorage.getItem('eq_push_declined') === '1') return;
  if (Notification.permission === 'granted') {
    _ensurePushSubscribed(personName); // already allowed — refresh subscription
    return;
  }
  if (Notification.permission === 'denied') return;
  // 'default' — show friendly banner (don't cold-call the browser permission dialog)
  setTimeout(() => _showPushBanner(personName), 3000);
}

function _showPushBanner(personName) {
  if (document.getElementById('eq-push-banner')) return;
  const el = document.createElement('div');
  el.id = 'eq-push-banner';
  el.style.cssText = [
    'position:fixed','bottom:80px','left:50%','transform:translateX(-50%)',
    'background:#1F335C','color:#fff','padding:12px 14px','border-radius:8px',
    'font-size:13px','font-family:inherit','z-index:9999',
    'display:flex','align-items:center','gap:10px',
    'box-shadow:0 4px 20px rgba(0,0,0,.35)',
    'max-width:calc(100vw - 32px)','white-space:nowrap'
  ].join(';');
  el.innerHTML = [
    '<span style="font-size:16px">🔔</span>',
    '<span>Get notified when your roster changes</span>',
    '<button id="eq-push-yes" style="background:#7C77B9;border:none;color:#fff;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;flex-shrink:0">Turn on</button>',
    '<button id="eq-push-no"  style="background:none;border:none;color:rgba(255,255,255,.5);padding:4px 6px;cursor:pointer;font-size:20px;line-height:1;flex-shrink:0">&times;</button>'
  ].join('');
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 12000);
  document.getElementById('eq-push-yes').addEventListener('click', async () => {
    el.remove();
    await _requestAndSubscribe(personName);
  });
  document.getElementById('eq-push-no').addEventListener('click', () => {
    el.remove();
    localStorage.setItem('eq_push_declined', '1');
  });
}

// Soft nudge for PIN users to set up their EQ Core account.
// Shown once per session until the user permanently dismisses it.
// Never shown for Shell-authenticated users (they already have Core).
function _showCoreNudge(name) {
  if ((TENANT.ORG_SLUG !== 'sks') && (TENANT.ORG_SLUG !== 'eq-field')) return;
  if (localStorage.getItem('eq_core_nudge_dismissed')) return;
  if (sessionStorage.getItem('eq_core_nudge_shown')) return;
  sessionStorage.setItem('eq_core_nudge_shown', '1');
  setTimeout(() => {
    if (document.getElementById('eq-core-nudge')) return;
    const el = document.createElement('div');
    el.id = 'eq-core-nudge';
    el.style.cssText = [
      'position:fixed','top:68px','left:50%','transform:translateX(-50%)',
      'background:#1F335C','color:#fff','padding:12px 16px','border-radius:10px',
      'font-size:13px','font-family:inherit','z-index:9998',
      'display:flex','align-items:center','gap:10px',
      'box-shadow:0 4px 20px rgba(0,0,0,.35)',
      'max-width:calc(100vw - 32px)'
    ].join(';');
    el.innerHTML = [
      '<span style="font-size:15px">🔑</span>',
      '<span>Set up your <strong>EQ Core</strong> account for one-tap login — ask your manager for the link</span>',
      '<button id="eq-core-nudge-dismiss" style="background:none;border:none;color:rgba(255,255,255,.5);padding:4px 8px;cursor:pointer;font-size:20px;line-height:1;flex-shrink:0" aria-label="Dismiss">&times;</button>'
    ].join('');
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 15000);
    document.getElementById('eq-core-nudge-dismiss').addEventListener('click', () => {
      el.remove();
      localStorage.setItem('eq_core_nudge_dismissed', '1');
    });
  }, 4500);
}

async function _requestAndSubscribe(personName) {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    await _ensurePushSubscribed(personName);
    if (typeof showToast === 'function') showToast('🔔 Roster notifications on');
  } catch (e) { /* non-blocking */ }
}

async function _ensurePushSubscribed(personName) {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: (typeof _urlBase64ToUint8 === 'function')
          ? _urlBase64ToUint8(typeof _VAPID_PUBLIC_KEY !== 'undefined' ? _VAPID_PUBLIC_KEY : '')
          : null
      });
    }
    if (sub && typeof sbSavePushSubscription === 'function') {
      await sbSavePushSubscription(personName, sub);
    }
  } catch (e) { /* non-blocking */ }
}