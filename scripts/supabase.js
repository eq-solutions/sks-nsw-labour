/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/supabase.js  —  EQ Solves Field
// Supabase REST wrapper, write queue, health monitoring,
// and all per-table save/delete helpers.
// Depends on: app-state.js (TENANT, SB_URL, SB_KEY, ORG_TABLES, STATE)
// ─────────────────────────────────────────────────────────────

// ── Internals ────────────────────────────────────────────────
let _sbOnline = true;
let _sbHealthFails = 0;                 // consecutive health-check failures
const _SB_HEALTH_FAIL_THRESHOLD = 5;    // require N misses before flipping offline
                                        // (raised from 3 — Brave iOS shields can
                                        //  block cross-origin fetches transiently)
let _sbWriteFails = 0;                  // consecutive network-level write failures
const _SB_WRITE_FAIL_THRESHOLD = 3;     // same, for writes in sbFetch()
let _sbHealthRetryTimer = null;         // quick-retry after first health miss
const _writeQueue = [];
const _sbPendingRows = {}; // lock: concurrent POSTs for same name+week
const MAX_WRITE_RETRIES = 5;

function _baseTable(path) {
  return path.split('?')[0];
}

function _isOrgTable(path) {
  const base = _baseTable(path);
  return (typeof ORG_TABLES !== 'undefined') && ORG_TABLES.includes(base);
}

function _isDemoTenant() {
  return (typeof TENANT !== 'undefined') && (TENANT.ORG_SLUG === 'demo');
}

// v3.4.29: tables disabled on the active tenant. Skip the network round-trip
// for these — postgrest would 404 anyway, but the browser logs each as a
// failed request. Returning [] silently keeps DevTools clean and saves ~50ms
// of useless fetches on every page load.
function _isDisabledTable(path) {
  if (typeof TENANT === 'undefined' || typeof TENANT_DISABLED_TABLES === 'undefined') return false;
  const list = TENANT_DISABLED_TABLES[TENANT.ORG_SLUG] || [];
  if (!list.length) return false;
  return list.includes(_baseTable(path));
}

// ── DB ID validator ───────────────────────────────────────────
// Returns true for ids that came from Postgres (PATCH/DELETE-safe).
// Rejects:
//   - null / undefined
//   - temp IDs minted locally for offline writes (e.g. 'temp_abc123')
//   - integer IDs from SEED demo data on the 'eq' tenant (e.g. 101, 306 ...)
//
// EQ tenants use uuid PKs everywhere (schedule/people/sites/managers).
// SKS tenant uses bigint PKs on the same tables. The validator must accept
// the right shape per tenant — otherwise on SKS every PATCH falls through to
// POST and we duplicate rows on every edit.
//
// v3.4.22: tenant-gated. Pre-v3.4.22 was uuid-only and would have broken
// SKS prod the moment this code landed there.
const _UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _BIGINT_RE = /^[1-9][0-9]{0,18}$/;
function _isRealDbId(id) {
  if (id === null || id === undefined) return false;
  const s = String(id);
  // SKS (and any future bigint tenant) — accept positive integer strings.
  // Important: the 'eq' demo tenant must NOT take this branch, or SEED ids
  // (101..318) would be treated as real and PATCH calls would 400 with
  // `invalid input syntax for type uuid: "306"`.
  if (typeof TENANT !== 'undefined' && TENANT.ORG_SLUG === 'sks') {
    return _BIGINT_RE.test(s);
  }
  // EQ + other uuid tenants — accept only uuids
  return _UUID_RE.test(s);
}

function _sbLog(level, stage, details) {
  // Central logger so errors can be surfaced consistently.
  // level: 'warn' | 'error' | 'info'
  const prefix = 'EQ[sb:' + stage + ']';
  if (level === 'error')       console.error(prefix, details);
  else if (level === 'warn')   console.warn(prefix, details);
  else                         console.info(prefix, details);
}

// ── Write queue indicator ────────────────────────────────────
let _pendingWriteCount = 0;
let _saveIndicatorTimer = null;

function _setSaveIndicator(state) {
  // state: 'saving' | 'saved' | 'error' | 'clear'
  const el = document.getElementById('sync-status');
  if (!el) return;
  clearTimeout(_saveIndicatorTimer);
  if (state === 'saving') {
    el.textContent = '↑ Saving…';
    el.style.display = '';
    el.style.background = 'var(--amber-lt)';
    el.style.color      = 'var(--amber)';
  } else if (state === 'saved') {
    el.textContent = '✓ Saved';
    el.style.display = '';
    el.style.background = 'var(--green-lt)';
    el.style.color      = 'var(--green)';
    _saveIndicatorTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
  } else if (state === 'error') {
    el.textContent = '⚠ Unsaved';
    el.style.display = '';
    el.style.background = 'var(--red-lt)';
    el.style.color      = 'var(--red)';
  } else {
    el.style.display = 'none';
  }
}

// ── Core fetch wrapper ────────────────────────────────────────
async function sbFetch(path, method = 'GET', body = null, prefer = 'return=minimal') {
  // Demo / EQ tenant short-circuit — no network, in-memory only.
  // Returns mocked success so callers (saveTsCell, batch fill, etc.) don't
  // surface "save failed" toasts when we never intended to hit a DB.
  if (_isDemoTenant() || !SB_URL) {
    if (method === 'POST' && prefer && prefer.indexOf('return=representation') !== -1) {
      // Mint a fake id so _upsertById can write it back to the entity.
      const mk = () => 'demo-' + Math.random().toString(36).slice(2, 10);
      if (Array.isArray(body)) return body.map(r => ({ ...r, id: mk() }));
      if (body && typeof body === 'object') return [{ ...body, id: mk() }];
      return [{ id: mk() }];
    }
    return [];
  }

  // v3.4.29: known-disabled table on this tenant — skip the fetch entirely.
  if (method === 'GET' && _isDisabledTable(path)) {
    return [];
  }

  let resolvedPath = path;

  // Auto-filter GET/DELETE by org_id
  if ((method === 'GET' || method === 'DELETE') && _isOrgTable(path)) {
    const sep = path.includes('?') ? '&' : '?';
    resolvedPath = path + sep + 'org_id=eq.' + TENANT.ORG_UUID;
  }

  // Auto-stamp POST body with org_id
  let resolvedBody = body;
  if (method === 'POST' && body && _isOrgTable(path)) {
    if (Array.isArray(body)) {
      resolvedBody = body.map(r => ({ ...r, org_id: TENANT.ORG_UUID }));
    } else if (typeof body === 'object') {
      resolvedBody = { ...body, org_id: TENANT.ORG_UUID };
    }
  }

  const headers = {
    'apikey':        SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type':  'application/json',
    'Prefer':        prefer
  };
  const fetchOpts = { method, headers, credentials: 'omit' };
  if (resolvedBody) {
    fetchOpts.body = typeof resolvedBody === 'string'
      ? resolvedBody
      : JSON.stringify(resolvedBody);
  }

  // Show saving indicator for writes (not in demo mode)
  const isDemo = _isDemoTenant();
  if (method !== 'GET' && !isDemo) {
    _pendingWriteCount++;
    _setSaveIndicator('saving');
  }

  try {
    const res = await fetch(SB_URL + '/rest/v1/' + resolvedPath, fetchOpts);
    if (!res.ok) {
      const err = await res.text();
      _sbLog('error', method + ' ' + resolvedPath, res.status + ' ' + err);
      throw new Error(res.status + ': ' + err);
    }
    _sbOnline = true;
    _sbHealthFails = 0;
    _sbWriteFails = 0;
    if (method !== 'GET' && !isDemo) {
      _pendingWriteCount = Math.max(0, _pendingWriteCount - 1);
      if (_pendingWriteCount === 0) _setSaveIndicator('saved');
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch (err) {
    // Distinguish a genuine network failure (fetch threw — TypeError / AbortError /
    // DNS / CORS / offline) from an HTTP error response (throw above, msg like
    // "500: …"). HTTP errors should NOT trip the offline banner — the server is
    // clearly reachable, the request was just rejected. Only network-level
    // failures count toward flipping `_sbOnline = false`, and only after N
    // consecutive strikes so a single blip never shows the banner.
    const msg           = String(err && err.message || err);
    const isClientError = /^4\d\d:/.test(msg);
    const isHttpError   = /^\d{3}:/.test(msg);           // any 3xx/4xx/5xx from server
    const isNetworkFail = !isHttpError;                  // fetch itself threw

    if (method !== 'GET' && !isClientError) {
      // Queue non-GETs so we don't lose user edits — this is safe for both
      // network blips AND transient 5xx.
      _writeQueue.push({ path, method, body, prefer, retries: 0 });
      try { localStorage.setItem('eq_write_queue', JSON.stringify(_writeQueue)); } catch (e) {}
      if (!isDemo) {
        _pendingWriteCount = Math.max(0, _pendingWriteCount - 1);
        _setSaveIndicator('error');
      }
      if (isNetworkFail) {
        _sbWriteFails++;
        if (_sbWriteFails >= _SB_WRITE_FAIL_THRESHOLD) _sbOnline = false;
      }
      updateOnlineStatus();
      _sbLog('warn', 'queued', method + ' ' + path + ' (' + msg + ')');
      return [];
    }
    throw err;
  }
}

// ── Write queue ───────────────────────────────────────────────
// Restore queued writes from a previous session
try {
  const saved = localStorage.getItem('eq_write_queue');
  if (saved) {
    const arr = JSON.parse(saved);
    if (Array.isArray(arr)) _writeQueue.push(...arr);
    localStorage.removeItem('eq_write_queue');
  }
} catch (e) {}

async function flushWriteQueue() {
  if (!_writeQueue.length) return;
  const pending = [..._writeQueue];
  _writeQueue.length = 0;
  for (const item of pending) {
    try {
      await sbFetch(item.path, item.method, item.body, item.prefer);
    } catch (e) {
      // BUG-011 FIX: 5-retry limit prevents infinite loop on invalid requests.
      // Exponential backoff between retries: 0.5s, 1s, 2s, 4s, 8s.
      const retries = (item.retries || 0) + 1;
      if (retries <= MAX_WRITE_RETRIES) {
        _writeQueue.push({ ...item, retries });
        const delay = 500 * Math.pow(2, retries - 1);
        await new Promise(r => setTimeout(r, delay));
      } else {
        _sbLog('warn', 'drop', 'after ' + MAX_WRITE_RETRIES + ' retries: ' + item.method + ' ' + item.path);
      }
    }
  }
  updateOnlineStatus();
  try { localStorage.setItem('eq_write_queue', JSON.stringify(_writeQueue)); } catch (e) {}
}

// ── Connection monitoring ─────────────────────────────────────
function updateOnlineStatus(forceOffline) {
  const banner    = document.getElementById('offline-banner');
  const syncBadge = document.getElementById('sync-status');
  if (!banner) return;
  const offline = forceOffline === true || !navigator.onLine || !_sbOnline;
  if (offline) {
    // v3.4.50 — 'eq' lifted from this gate. The 'demo' tenant
    // legitimately has no Supabase to be offline FROM (in-memory
    // tenant short-circuits in loadTenantConfig), but the EQ tenant
    // DOES write to Supabase (audit log, presence, schedule, leave
    // requests) — those writes silently failing without a banner is
    // the same class of bug as v3.4.49's polling gate. EQ users
    // editing offline now see "⚠ No internet connection — changes
    // are queued locally" so they know their edits will sync once
    // the connection's back.
    if (TENANT.ORG_SLUG === 'demo') {
      banner.classList.remove('show');
      return;
    }
    banner.classList.add('show');
    banner.textContent = !navigator.onLine
      ? '⚠ No internet connection — changes are queued locally.'
      : '⚠ Cannot reach server — tap to retry.';
    // Make banner tappable — force an immediate health check + flush
    banner.onclick = banner.onclick || function () {
      banner.textContent = '⟳ Checking connection…';
      _sbHealthFails = 0;
      _sbOnline = true;
      checkSupabaseHealth().then(() => flushWriteQueue());
    };
  } else {
    banner.classList.remove('show');
  }
  if (syncBadge) {
    if (_writeQueue.length > 0) {
      syncBadge.textContent = _writeQueue.length + ' pending';
      syncBadge.style.display = 'inline-block';
    } else {
      syncBadge.style.display = 'none';
    }
  }
}

async function checkSupabaseHealth() {
  // Skip polling entirely when the browser reports offline — no point hammering.
  if (!navigator.onLine) { updateOnlineStatus(); return; }
  // Skip in demo / eq tenants — no DB configured, banner stays hidden.
  if (_isDemoTenant() || !SB_URL) { return; }

  // Use a real PostgREST endpoint that ALWAYS responds — `people?select=id&limit=1`
  // is cheap, cache-busted, and returns 200 even for empty tables.
  // (HEAD on /rest/v1/ can return non-2xx depending on PostgREST build.)
  const url = SB_URL + '/rest/v1/people?select=id&limit=1';
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey':        SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Accept':        'application/json',
        'Range-Unit':    'items',
        'Range':         '0-0'
      },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      credentials: 'omit'        // reduces Brave-shield cross-origin heuristics
    });
    // Any response (200, 206 partial-content, even 401/403 auth) means the
    // server is REACHABLE. The banner is about network reachability, not
    // authorization. Only a thrown fetch counts as "cannot reach".
    _sbHealthFails = 0;
    clearTimeout(_sbHealthRetryTimer);
    if (!_sbOnline) {
      _sbOnline = true;
      flushWriteQueue();
    }
  } catch (e) {
    // Network-level failure only (TypeError, AbortError, DNS, etc.)
    _sbHealthFails++;
    _sbLog('warn', 'health', 'strike ' + _sbHealthFails + '/' + _SB_HEALTH_FAIL_THRESHOLD + ' — ' + (e && e.message || e));
    if (_sbHealthFails >= _SB_HEALTH_FAIL_THRESHOLD) _sbOnline = false;
    // Quick retry after first failure — catches transient Brave/iOS blocks
    // without waiting the full 30s poll interval.
    if (_sbHealthFails <= 2) {
      clearTimeout(_sbHealthRetryTimer);
      _sbHealthRetryTimer = setTimeout(checkSupabaseHealth, 5000);
    }
  }
  updateOnlineStatus();
}

window.addEventListener('online',  () => { _sbOnline = true; flushWriteQueue(); updateOnlineStatus(); });
window.addEventListener('offline', () => updateOnlineStatus());

setInterval(checkSupabaseHealth, 30000);
setInterval(() => refreshData(true), 5 * 60 * 1000);

// ── Generic upsert-by-id ──────────────────────────────────────
// Matches the legacy pattern: if entity.id exists in the DB, PATCH it;
// otherwise POST a new row and write the generated id back onto `entity`.
// `temp*` ids (client-side placeholders) always POST.
async function _upsertById(table, entity, row) {
  const isTempId = !_isRealDbId(entity.id);
  try {
    if (!isTempId) {
      const existing = await sbFetch(`${table}?id=eq.${entity.id}&select=id`);
      if (existing && existing.length > 0) {
        await sbFetch(`${table}?id=eq.${entity.id}`, 'PATCH', row);
        return;
      }
    }
    const res = await sbFetch(table, 'POST', row, 'return=representation');
    if (res && res[0]) entity.id = res[0].id;
  } catch (e) {
    // Fallback: if PATCH path failed (e.g. id no longer exists), POST a fresh row.
    _sbLog('warn', 'upsert-fallback', table + ' id=' + entity.id);
    const res = await sbFetch(table, 'POST', row, 'return=representation');
    if (res && res[0]) entity.id = res[0].id;
  }
}

// ── Per-table save helpers ────────────────────────────────────

async function savePersonToSB(person) {
  return _upsertById('people', person, {
    name:     person.name,
    phone:    person.phone   || null,
    group:    (typeof denormaliseGroupForDb === 'function' ? denormaliseGroupForDb(person.group) : person.group),
    licence:  person.licence || null,
    agency:   person.agency  || null,
    email:    person.email   || null,
    tafe_day: person.tafe_day || null,
    // v3.4.16: birthdays + start date
    dob_day:    person.dob_day    || null,
    dob_month:  person.dob_month  || null,
    start_date: person.start_date || null,
    pin:      person.pin     || null,
    // v3.4.70: archived flag — reversible soft-hide alongside deleted_at.
    archived: !!person.archived
  });
}

async function deletePersonFromSB(id) {
  await sbFetch(`people?id=eq.${id}`, 'DELETE');
}

async function saveSiteToSB(site) {
  return _upsertById('sites', site, {
    name:            site.name,
    abbr:            site.abbr,
    address:         site.address         || null,
    site_lead:       site.site_lead       || null,
    site_lead_phone: site.site_lead_phone || null
  });
}

async function deleteSiteFromSB(id) {
  await sbFetch(`sites?id=eq.${id}`, 'DELETE');
}

async function saveCellToSB(name, week, day, val) {
  const existing = STATE.schedule.find(r => r.name === name && r.week === week);

  if (existing && _isRealDbId(existing.id)) {
    // ── TRUE COMPARE-AND-SWAP ──────────────────────────────────
    // PATCH with both id=eq.<id> AND updated_at=eq.<stamp>. PostgREST
    // returns the updated rows only if the WHERE clause matched — so an
    // empty array means someone else beat us to it. No TOCTOU window.
    const patch = {}; patch[day] = val || null;
    let res;
    try {
      if (existing.updated_at) {
        const enc = encodeURIComponent(existing.updated_at);
        res = await sbFetch(
          `schedule?id=eq.${existing.id}&updated_at=eq.${enc}`,
          'PATCH', patch, 'return=representation'
        );
      } else {
        // First write for this row in this session — no stamp to match on yet.
        res = await sbFetch(
          `schedule?id=eq.${existing.id}`,
          'PATCH', patch, 'return=representation'
        );
      }
    } catch (e) {
      // Network/queue path already handled by sbFetch; bail out.
      return;
    }

    if (Array.isArray(res) && res.length === 0 && existing.updated_at) {
      // Lost the race — fetch the latest server state and ask the user.
      try {
        const latest = await sbFetch('schedule?id=eq.' + existing.id + '&select=*');
        const server = latest && latest[0];
        if (server && typeof showCellConflict === 'function') {
          showCellConflict({
            name, week, day,
            mine:   val || null,
            theirs: server[day] || null,
            server, local: existing
          });
        } else if (typeof refreshData === 'function') {
          if (typeof showToast === 'function') showToast('⚠ Row updated elsewhere — syncing latest.');
          await refreshData();
        }
      } catch (e) { /* non-blocking */ }
      return;
    }

    // Success — stamp local row from the returned representation.
    if (Array.isArray(res) && res[0]) {
      existing.updated_at = res[0].updated_at;
      if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(existing.id);
    }
    return;
  }

  // No DB row yet — lock to prevent duplicate POSTs for same name+week.
  // Cross-device safety is provided by the UNIQUE (name, week, org_id)
  // constraint; this lock handles same-tab double-submits.
  const lockKey = `${name}||${week}`;
  if (_sbPendingRows[lockKey]) {
    await _sbPendingRows[lockKey];
    const entry = STATE.schedule.find(r => r.name === name && r.week === week);
    if (entry && entry.id) {
      const patch = {}; patch[day] = val || null;
      await sbFetch(`schedule?id=eq.${entry.id}`, 'PATCH', patch, 'return=representation');
    }
    return;
  }
  const row = {
    name, week,
    mon: null, tue: null, wed: null, thu: null,
    fri: null, sat: null, sun: null
  };
  if (existing) {
    Object.assign(row, {
      mon: existing.mon || null, tue: existing.tue || null,
      wed: existing.wed || null, thu: existing.thu || null,
      fri: existing.fri || null, sat: existing.sat || null,
      sun: existing.sun || null
    });
  }
  row[day] = val || null;
  const postPromise = sbFetch('schedule', 'POST', row, 'return=representation');
  _sbPendingRows[lockKey] = postPromise;
  try {
    const res = await postPromise;
    if (existing && res && res[0]) {
      existing.id         = res[0].id;
      existing.updated_at = res[0].updated_at;
      if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(existing.id);
    }
    if (STATE.scheduleIndex) STATE.scheduleIndex[`${name}||${week}`] = existing || res[0];
  } finally {
    delete _sbPendingRows[lockKey];
  }
}

// ── Bulk day save (single CAS) ────────────────────────────────
// Patches multiple days on the same schedule row in one request,
// avoiding the CAS race that fires false conflicts when fillWeek /
// clearWeek call saveCellToSB per-day in parallel.
async function saveRowToSB(name, week, dayVals) {
  const existing = STATE.schedule.find(r => r.name === name && r.week === week);
  if (!existing) return;

  const patch = {};
  Object.entries(dayVals).forEach(([d, v]) => { patch[d] = v || null; });

  if (_isRealDbId(existing.id)) {
    let res;
    try {
      if (existing.updated_at) {
        const enc = encodeURIComponent(existing.updated_at);
        res = await sbFetch(
          `schedule?id=eq.${existing.id}&updated_at=eq.${enc}`,
          'PATCH', patch, 'return=representation'
        );
      } else {
        res = await sbFetch(
          `schedule?id=eq.${existing.id}`,
          'PATCH', patch, 'return=representation'
        );
      }
    } catch (e) { return; }

    if (Array.isArray(res) && res.length === 0 && existing.updated_at) {
      // Lost CAS — fall back to unconditional PATCH (batch-fill style).
      // Multi-day bulk ops (clear/fill) are user-intentional, so overwrite wins.
      try {
        const retry = await sbFetch(
          `schedule?id=eq.${existing.id}`,
          'PATCH', patch, 'return=representation'
        );
        if (Array.isArray(retry) && retry[0]) {
          existing.updated_at = retry[0].updated_at;
          if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(existing.id);
        }
      } catch (e) { /* non-blocking */ }
      return;
    }

    if (Array.isArray(res) && res[0]) {
      existing.updated_at = res[0].updated_at;
      if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(existing.id);
    }
  } else {
    // No server row — POST the full row
    const row = { name, week, mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
    Object.assign(row, dayVals);
    const lockKey = `${name}||${week}`;
    const res = await sbFetch('schedule', 'POST', row, 'return=representation');
    if (existing && res && res[0]) {
      existing.id = res[0].id;
      existing.updated_at = res[0].updated_at;
      if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(existing.id);
    }
    if (STATE.scheduleIndex) STATE.scheduleIndex[`${name}||${week}`] = existing || res[0];
  }
}

async function saveManagerToSB(mgr) {
  // v3.4.70: include dob_day/dob_month/start_date + archived so supervisor
  // birthdays/anniversaries persist and archive state survives reload.
  // Columns added via 2026-05-13 migration.
  return _upsertById('managers', mgr, {
    name:       mgr.name,
    role:       mgr.role     || null,
    category:   mgr.category || null,
    phone:      mgr.phone    || null,
    email:      mgr.email    || null,
    dob_day:    (mgr.dob_day   != null && !isNaN(mgr.dob_day))   ? mgr.dob_day   : null,
    dob_month:  (mgr.dob_month != null && !isNaN(mgr.dob_month)) ? mgr.dob_month : null,
    start_date: mgr.start_date || null,
    archived:   !!mgr.archived
  });
}

async function deleteManagerFromSB(id) {
  await sbFetch(`managers?id=eq.${id}`, 'DELETE');
}

// v3.4.70: soft-archive (reversible) — sets archived=true rather than DELETE.
async function archiveManagerInSB(id, archived = true) {
  await sbFetch(`managers?id=eq.${id}`, 'PATCH', { archived: !!archived });
}

// v3.4.70: same pattern for people. Archive vs the existing deleted_at soft-delete.
async function archivePersonInSB(id, archived = true) {
  await sbFetch(`people?id=eq.${id}`, 'PATCH', { archived: !!archived });
}

// ── Bulk import helpers ───────────────────────────────────────

// Bulk import helpers — wipe-and-replace the tenant's rows for a table.
// DELETE errors are logged (not silently swallowed) so we can catch bad
// policy/schema drift early instead of ending up with duplicated rows.

async function _purgeTenantRows(table) {
  try {
    await sbFetch(`${table}?org_id=eq.${TENANT.ORG_UUID}`, 'DELETE');
  } catch (e) {
    _sbLog('warn', 'purge', table + ': ' + (e && e.message || e));
    throw e; // let caller decide whether to continue
  }
}

async function importPeopleToSB(people) {
  try { await _purgeTenantRows('people'); } catch (e) { return; }
  if (!people.length) return;
  const rows = people.map(p => ({
    name:     p.name,
    phone:    p.phone   || null,
    group:    (typeof denormaliseGroupForDb === 'function' ? denormaliseGroupForDb(p.group) : p.group),
    email:    p.email   || null,
    licence:  p.licence || null,
    agency:   p.agency  || null,
    tafe_day: p.tafe_day || null,
    // v3.4.16: birthdays + start date (pass through when present)
    dob_day:    p.dob_day    || null,
    dob_month:  p.dob_month  || null,
    start_date: p.start_date || null
  }));
  await sbFetch('people', 'POST', rows);
}

async function importSitesToSB(sites) {
  if (!sites.length) return;
  try { await _purgeTenantRows('sites'); } catch (e) { return; }
  await new Promise(r => setTimeout(r, 300));
  const rows = sites.map(s => ({ name: s.name, abbr: s.abbr, address: s.address || null }));
  await sbFetch('sites', 'POST', rows);
}

async function importScheduleToSB(schedule, weeks) {
  if (!schedule.length) return;
  const weeksToDelete = weeks && weeks.length
    ? weeks
    : [...new Set(schedule.map(r => r.week))];
  for (const w of weeksToDelete) {
    try {
      await sbFetch('schedule?week=eq.' + encodeURIComponent(w), 'DELETE');
    } catch (e) {
      _sbLog('warn', 'delete-week', w + ': ' + (e && e.message || e));
    }
  }
  await new Promise(r => setTimeout(r, 500));
  const rows = schedule.map(r => ({
    name: r.name, week: r.week,
    mon: r.mon || null, tue: r.tue || null, wed: r.wed || null,
    thu: r.thu || null, fri: r.fri || null, sat: r.sat || null, sun: r.sun || null
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await sbFetch('schedule', 'POST', rows.slice(i, i + 100));
    await new Promise(r => setTimeout(r, 300));
  }
}

async function importManagersToSB(managers) {
  try { await _purgeTenantRows('managers'); } catch (e) { return; }
  if (!managers.length) return;
  const rows = managers.map(m => ({
    name:     m.name,
    role:     m.role     || null,
    category: m.category || null,
    phone:    m.phone    || null,
    email:    m.email    || null
  }));
  await sbFetch('managers', 'POST', rows);
}