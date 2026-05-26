/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/realtime.js — Supabase Realtime over WebSocket
// Listens for postgres_changes on `schedule` and merges remote
// edits into STATE.schedule / STATE.scheduleIndex live, so two
// supervisors editing the same roster see each other within ~1s
// instead of waiting for the 30s poll.
//
// No SDK — speaks Phoenix channel protocol directly.
// Depends on: app-state.js (SB_URL, SB_KEY, TENANT, STATE)
// ─────────────────────────────────────────────────────────────

let _rtSocket      = null;
let _rtRef         = 0;
let _rtHeartbeat   = null;
let _rtReconnectT  = null;
let _rtBackoffMs   = 1000;
const _RT_MAX_BACKOFF = 30000;
// v3.4.4: track multiple topics keyed by table name — schedule stays
// primary, leave_requests added so leave list updates live across
// supervisors. Each entry: { topic, joinRef, joined }
const _rtChannels  = {};
let _rtEnabled     = false;
let _rtLastEventAt = 0;

// Remote-origin edit marker — when our OWN write comes back as a postgres
// change, we don't need to re-render (UI is already up to date). We keep a
// short-lived cache of row ids we just wrote so we can skip the echo.
const _rtRecentLocalWrites = new Map();   // id -> timestamp
const _RT_ECHO_WINDOW_MS   = 2000;

function _rtMarkLocalWrite(id) {
  if (!id) return;
  _rtRecentLocalWrites.set(String(id), Date.now());
  // Trim old entries opportunistically.
  if (_rtRecentLocalWrites.size > 200) {
    const cutoff = Date.now() - _RT_ECHO_WINDOW_MS;
    for (const [k, t] of _rtRecentLocalWrites) {
      if (t < cutoff) _rtRecentLocalWrites.delete(k);
    }
  }
}

function _rtIsEchoOfLocal(id) {
  if (!id) return false;
  const t = _rtRecentLocalWrites.get(String(id));
  if (!t) return false;
  if (Date.now() - t > _RT_ECHO_WINDOW_MS) {
    _rtRecentLocalWrites.delete(String(id));
    return false;
  }
  return true;
}

function _rtLog(level, msg) {
  const prefix = 'EQ[rt]';
  if (level === 'error')     console.error(prefix, msg);
  else if (level === 'warn') console.warn(prefix, msg);
  else                       console.info(prefix, msg);
}

// ── Connection lifecycle ─────────────────────────────────────
function startRealtime() {
  // Gate on tenant — no-op for the in-memory demo, no-op if no Supabase
  // config. v3.4.47: 'eq' lifted from the gate so the EQ tenant gets
  // realtime + roster presence too. Demo (in-memory) still skips.
  if (typeof TENANT === 'undefined' || !TENANT || !TENANT.ORG_UUID) return;
  if (TENANT.ORG_SLUG === 'demo') return;
  if (!SB_URL || !SB_KEY) return;
  if (_rtSocket && (_rtSocket.readyState === WebSocket.OPEN || _rtSocket.readyState === WebSocket.CONNECTING)) return;

  _rtEnabled = true;
  _rtConnect();
}

function isRealtimeConnected() {
  return !!(_rtSocket && _rtSocket.readyState === WebSocket.OPEN);
}

function stopRealtime() {
  _rtEnabled = false;
  clearTimeout(_rtReconnectT); _rtReconnectT = null;
  clearInterval(_rtHeartbeat); _rtHeartbeat = null;
  for (const k of Object.keys(_rtChannels)) delete _rtChannels[k];
  if (_rtSocket) {
    try { _rtSocket.close(); } catch (e) {}
    _rtSocket = null;
  }
}

function _rtConnect() {
  if (!_rtEnabled) return;

  // Build WS URL from REST URL. Supabase Realtime lives at /realtime/v1/websocket.
  const wsUrl = SB_URL.replace(/^http/, 'ws')
              + '/realtime/v1/websocket?apikey=' + encodeURIComponent(SB_KEY)
              + '&vsn=1.0.0';

  try {
    _rtSocket = new WebSocket(wsUrl);
  } catch (e) {
    _rtLog('error', 'WebSocket constructor failed: ' + e.message);
    _rtScheduleReconnect();
    return;
  }

  _rtSocket.onopen    = _rtOnOpen;
  _rtSocket.onmessage = _rtOnMessage;
  _rtSocket.onclose   = _rtOnClose;
  _rtSocket.onerror   = (e) => _rtLog('warn', 'WebSocket error');
}

function _rtOnOpen() {
  _rtLog('info', 'connected');
  _rtBackoffMs = 1000;
  _rtJoinChannel('schedule');
  _rtJoinChannel('leave_requests');
  _rtJoinChannel('roster_presence');  // v3.4.47 — editor cell presence
  _rtHeartbeat = setInterval(_rtSendHeartbeat, 25000);
}

function _rtOnClose(e) {
  clearInterval(_rtHeartbeat); _rtHeartbeat = null;
  _rtSocket = null;
  _rtLog('warn', 'closed (' + e.code + ')');
  if (_rtEnabled) _rtScheduleReconnect();
}

function _rtScheduleReconnect() {
  clearTimeout(_rtReconnectT);
  const delay = _rtBackoffMs;
  _rtBackoffMs = Math.min(_rtBackoffMs * 2, _RT_MAX_BACKOFF);
  _rtLog('info', 'reconnect in ' + delay + 'ms');
  _rtReconnectT = setTimeout(_rtConnect, delay);
}

// ── Channel join ─────────────────────────────────────────────
// Phoenix topic format for Supabase Realtime v1:
//   realtime:<schema>:<table>:<col>=eq.<value>
function _rtJoinChannel(table) {
  const topic   = 'realtime:public:' + table + ':org_id=eq.' + TENANT.ORG_UUID;
  const joinRef = String(++_rtRef);
  _rtChannels[table] = { topic, joinRef, joined: false };
  _rtSend({
    topic,
    event:   'phx_join',
    payload: {
      // Supabase Realtime v1 understands { user_token } for RLS; we pass the
      // anon key so RLS policies that check auth.role() = 'anon' apply.
      user_token: SB_KEY
    },
    ref: joinRef
  });
}

function _rtLookupChannel(topic) {
  for (const table of Object.keys(_rtChannels)) {
    if (_rtChannels[table].topic === topic) return { table, chan: _rtChannels[table] };
  }
  return null;
}

function _rtSendHeartbeat() {
  _rtSend({
    topic:   'phoenix',
    event:   'heartbeat',
    payload: {},
    ref:     String(++_rtRef)
  });
}

function _rtSend(obj) {
  if (!_rtSocket || _rtSocket.readyState !== WebSocket.OPEN) return;
  try { _rtSocket.send(JSON.stringify(obj)); } catch (e) {}
}

// ── Message dispatch ─────────────────────────────────────────
function _rtOnMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (!msg) return;

  const found = _rtLookupChannel(msg.topic);
  if (!found) return;
  const { table, chan } = found;

  // Channel join ack
  if (msg.event === 'phx_reply' && msg.ref === chan.joinRef) {
    if (msg.payload && msg.payload.status === 'ok') {
      chan.joined = true;
      _rtLog('info', 'joined ' + table + ' channel');
    } else {
      _rtLog('error', 'join failed (' + table + '): ' + JSON.stringify(msg.payload));
    }
    return;
  }

  // Error frames
  if (msg.event === 'phx_error' || msg.event === 'phx_close') {
    _rtLog('warn', 'channel ' + msg.event + ' (' + table + ')');
    return;
  }

  // INSERT / UPDATE / DELETE events
  // Supabase Realtime v1 sends events named 'INSERT', 'UPDATE', 'DELETE'
  // (or wrapped in a postgres_changes envelope on v2). Handle both.
  const payload = msg.payload || {};
  let evType = msg.event;
  let record = payload.record || payload.new || null;
  let oldRec = payload.old_record || payload.old || null;

  if (evType === 'postgres_changes') {
    // v2 envelope
    const d = payload.data || {};
    evType  = d.type || d.eventType;
    record  = d.record || d.new || null;
    oldRec  = d.old_record || d.old || null;
  }

  if (evType !== 'INSERT' && evType !== 'UPDATE' && evType !== 'DELETE') return;
  _rtLastEventAt = Date.now();

  if (table === 'schedule') {
    _rtApplyChange(evType, record, oldRec);
  } else if (table === 'leave_requests') {
    _rtApplyLeaveChange(evType, record, oldRec);
  } else if (table === 'roster_presence') {
    if (typeof _presenceApplyChange === 'function') {
      _presenceApplyChange(evType, record, oldRec);
    }
  }
}

// ── Merge leave_requests changes into in-memory list ─────────
// v3.4.4: when another supervisor approves / rejects / archives a leave
// request, reflect it live so stale state doesn't block decisions.
function _rtApplyLeaveChange(type, record, oldRec) {
  if (typeof leaveRequests === 'undefined') return;

  const id = (record && record.id) || (oldRec && oldRec.id);
  if (!id) return;

  if (type === 'DELETE') {
    const idx = leaveRequests.findIndex(r => String(r.id) === String(id));
    if (idx >= 0) leaveRequests.splice(idx, 1);
  } else {
    if (!record) return;
    // Honour the current Show Archived toggle — if hidden and this row became
    // archived, drop it; if visible and a new row arrives, append.
    const showArchived = typeof showArchivedLeave !== 'undefined' && showArchivedLeave;
    const idx = leaveRequests.findIndex(r => String(r.id) === String(id));
    if (idx >= 0) {
      if (!showArchived && record.archived) {
        leaveRequests.splice(idx, 1);
      } else {
        leaveRequests[idx] = Object.assign({}, leaveRequests[idx], record);
      }
    } else {
      if (showArchived || !record.archived) {
        leaveRequests.push(record);
        leaveRequests.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
    }
  }

  if (typeof updateLeaveBadge === 'function') updateLeaveBadge();

  // Re-render Leave page if it's currently open; otherwise just leave the
  // in-memory list fresh for next open.
  if (typeof currentPage !== 'undefined' && currentPage === 'leave') {
    if (typeof renderLeave === 'function') renderLeave();
    if (typeof leaveViewMode !== 'undefined' && leaveViewMode === 'calendar' &&
        typeof renderLeaveCalendar === 'function') renderLeaveCalendar();
  }

  const cue = document.getElementById('sync-status');
  if (cue) {
    cue.textContent = '⇣ Live update';
    cue.style.display = '';
    cue.style.background = 'var(--blue-lt)';
    cue.style.color      = 'var(--blue)';
    clearTimeout(cue._rtTimer);
    cue._rtTimer = setTimeout(() => { cue.style.display = 'none'; }, 2000);
  }
}

// ── Merge into STATE ─────────────────────────────────────────
function _rtApplyChange(type, record, oldRec) {
  if (!STATE) return;
  if (!STATE.scheduleIndex) STATE.scheduleIndex = {};

  if (type === 'DELETE') {
    const id = (oldRec && oldRec.id) || (record && record.id);
    if (!id) return;
    const idx = STATE.schedule.findIndex(r => String(r.id) === String(id));
    if (idx >= 0) {
      const gone = STATE.schedule.splice(idx, 1)[0];
      if (gone) delete STATE.scheduleIndex[`${gone.name}||${gone.week}`];
      _rtMaybeRender(gone ? gone.week : null);
    }
    return;
  }

  if (!record) return;
  if (_rtIsEchoOfLocal(record.id)) return; // our own write coming back

  const key = `${record.name}||${record.week}`;
  const existing = STATE.scheduleIndex[key];

  if (existing) {
    // Merge server fields into the in-memory row.
    Object.assign(existing, {
      id:         record.id,
      updated_at: record.updated_at,
      mon: record.mon, tue: record.tue, wed: record.wed, thu: record.thu,
      fri: record.fri, sat: record.sat, sun: record.sun
    });
  } else {
    STATE.schedule.push(record);
    STATE.scheduleIndex[key] = record;
  }

  _rtMaybeRender(record.week);
}

// ── Conflict resolution dialog ───────────────────────────────
// Called from saveCellToSB when a compare-and-swap returns zero rows,
// meaning someone else updated the same row between our load and write.
// `ctx` = { name, week, day, mine, theirs, server, local }
function showCellConflict(ctx) {
  const fmt = (v) => (v == null || v === '') ? '—' : String(v);
  const dayName = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday' }[ctx.day] || ctx.day;

  // Always merge the server row into local state first so the UI shows the
  // truth regardless of which button they pick.
  if (ctx.server && ctx.local) {
    Object.assign(ctx.local, ctx.server);
  }
  if (typeof renderCurrentPage === 'function') renderCurrentPage();

  const meta = document.getElementById('conflict-meta');
  if (meta) {
    meta.innerHTML =
      '<div><b>' + (ctx.name || '') + '</b> — ' + dayName + ' (' + (ctx.week || '') + ')</div>' +
      '<div style="margin-top:4px">Server was just updated by another user.</div>';
  }
  const mineEl   = document.getElementById('conflict-mine-val');
  const theirsEl = document.getElementById('conflict-theirs-val');
  if (mineEl)   mineEl.textContent   = fmt(ctx.mine);
  if (theirsEl) theirsEl.textContent = fmt(ctx.theirs);

  const keepBtn = document.getElementById('conflict-keep-mine');
  const useBtn  = document.getElementById('conflict-use-theirs');

  // Rebind (fresh closures per open — easier than tracking state).
  const close = () => { if (typeof closeModal === 'function') closeModal('modal-cell-conflict'); };

  if (keepBtn) {
    keepBtn.onclick = async () => {
      close();
      // Re-try the write, now using the fresh updated_at from the server
      // copy we just merged in. This is a second CAS — if someone's edited
      // it AGAIN in the interim, we'll come right back here. Intentional.
      if (typeof saveCellToSB === 'function') {
        try { await saveCellToSB(ctx.name, ctx.week, ctx.day, ctx.mine); }
        catch (e) { if (typeof showToast === 'function') showToast('⚠ Retry failed: ' + (e && e.message || e)); }
      }
    };
  }

  if (useBtn) {
    useBtn.onclick = () => {
      close();
      // No-op on the server — their value already wins. The merge above
      // already updated local state; a render refresh is enough.
      if (typeof renderCurrentPage === 'function') renderCurrentPage();
      if (typeof showToast === 'function') showToast('Kept their value.');
    };
  }

  if (typeof openModal === 'function') openModal('modal-cell-conflict');
}

// Re-render the current page if the affected week is visible.
function _rtMaybeRender(week) {
  if (!week) return;
  if (typeof currentPage === 'undefined') return;
  // Don't stomp on an active editor — the user is typing.
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  if (typeof _pendingWriteCount !== 'undefined' && _pendingWriteCount > 0) return;

  // Only re-render if the visible week matches.
  if (typeof STATE !== 'undefined' && STATE.currentWeek && STATE.currentWeek !== week) {
    // Still update stats + dashboards that aggregate across weeks.
    if (typeof updateTopStats === 'function') updateTopStats();
    return;
  }

  if (typeof renderCurrentPage === 'function') renderCurrentPage();
  if (typeof updateTopStats     === 'function') updateTopStats();

  // Tiny visual cue so users know it was a remote update.
  const cue = document.getElementById('sync-status');
  if (cue) {
    cue.textContent = '⇣ Live update';
    cue.style.display = '';
    cue.style.background = 'var(--blue-lt)';
    cue.style.color      = 'var(--blue)';
    clearTimeout(cue._rtTimer);
    cue._rtTimer = setTimeout(() => { cue.style.display = 'none'; }, 2000);
  }
}