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

  const groupOrder  = ['Supervision', 'Direct', 'Apprentice', 'Labour Hire'];
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
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
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
      // Mint a server-side session token so demo can call protected
      // endpoints (send-email etc). Demo only — eq tenant has no backend.
      // v3.4.59: BATTLE-TEST #45 — await (was IIFE fire-and-forget).
      if (TENANT.ORG_SLUG === 'demo') {
        await _mintAndStoreEqToken(val, name);
      }
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
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
      if (data.token) localStorage.setItem('eq_remember_token', data.token);
      if (data.sessionToken) {
        sessionStorage.setItem('eq_session_token', data.sessionToken);
        localStorage.setItem('eq_agent_token',     data.sessionToken);
      }
      document.getElementById('access-gate').classList.add('hidden');
      document.getElementById('gate-pin').value = '';
      initApp();
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
  if (sessionStorage.getItem(ACCESS_KEY) === '1') return true;

  // Local "remember me" restore for tenant-code gate (no server).
  try {
    const rawLocal = localStorage.getItem('eq_local_remember_' + TENANT.ORG_SLUG);
    if (rawLocal) {
      const p = JSON.parse(rawLocal);
      if (p && p.exp && Date.now() < p.exp && p.slug === TENANT.ORG_SLUG) {
        sessionStorage.setItem(ACCESS_KEY, '1');
        sessionStorage.setItem('eq_logged_in_name', p.name || '');
        if (p.role === 'supervisor') sessionStorage.setItem('eq_auto_admin', '1');
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
  sessionStorage.removeItem('eq_auto_admin');
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
    applyManagerMode();
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
  const SUPERVISOR_CATEGORIES = ['Executive','Operations','Project Management','Construction','Supervisor','Internal','Other'];
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
    applyManagerMode();
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
    const d = new Date(today); d.setDate(d.getDate() - d.getDay() + 1 + i * 7);
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