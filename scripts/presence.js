/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/presence.js  —  EQ Solves Field
// "X is editing cell Y" indicators on the roster editor.
// v3.4.47 — first cut.
//
// Lifecycle:
//   • renderEditor() attaches focus/blur handlers via inline
//     onfocus/onblur on the cell <input>s. Those call
//     presenceFocus(name, week, day) and presenceBlur(name, week, day).
//   • presenceFocus upserts a row into roster_presence and starts
//     a 10s heartbeat to refresh focused_at while the cell is held.
//   • presenceBlur deletes the row and stops the heartbeat.
//   • Postgres realtime delivers INSERT/UPDATE/DELETE events on
//     roster_presence to scripts/realtime.js, which forwards them
//     to _presenceApplyChange below.
//   • _presenceApplyChange maintains _activePresence (Map keyed
//     by `week||name||day`) and calls _presenceRender to outline
//     affected cells.
//   • Stale rows (focused_at < now - 15s) are filtered visually
//     so a tab close before blur fires doesn't leave a phantom.
//
// Depends on: app-state.js (TENANT, currentManagerName), supabase.js (sbFetch)
// ─────────────────────────────────────────────────────────────

const _activePresence = new Map();    // `${week}||${name}||${day}` -> { manager, focused_at, ts }
let _presenceHeartbeat = null;
let _presenceCurrent   = null;        // { name, week, day } currently held by THIS client
let _presenceInflight  = Promise.resolve();  // v3.4.48: latest focus/heartbeat POST so blur can await before deleting
const _PRESENCE_FRESH_MS = 15000;     // outline shown only while focused_at is within last 15s

function _presenceKey(week, name, day) {
  return `${week}||${name}||${day}`;
}

function _isOwnPresence(record) {
  if (!record) return false;
  if (typeof currentManagerName === 'undefined' || !currentManagerName) return false;
  return String(record.manager_name) === String(currentManagerName);
}

// ── Outbound: track THIS client's focus ──────────────────────
async function presenceFocus(name, week, day) {
  if (typeof TENANT === 'undefined' || !TENANT.ORG_UUID) return;
  if (!currentManagerName) return;                  // require an unlocked supervisor
  if (typeof sbFetch !== 'function') return;
  if (typeof SB_URL !== 'undefined' && !SB_URL) return; // demo tenant — no DB

  _presenceCurrent = { name, week, day };
  // Upsert via POST with merge-duplicates so a focus → blur → focus on
  // the same cell refreshes focused_at instead of conflicting.
  // v3.4.48: track the latest in-flight POST so presenceBlur can await
  // it before issuing DELETE — without that ordering guarantee, a fast
  // focus→blur could let DELETE arrive first (no-op, no row to delete)
  // and the POST then leaves an orphan row.
  const row = {
    manager_name: currentManagerName,
    week, cell_name: name, cell_day: day,
    focused_at: new Date().toISOString()
  };
  _presenceInflight = sbFetch(
    'roster_presence?on_conflict=org_id,manager_name,week,cell_name,cell_day',
    'POST', row, 'resolution=merge-duplicates,return=minimal'
  ).catch(() => { /* non-blocking */ });
  await _presenceInflight;

  // Heartbeat: refresh focused_at every 10s while held so a slow editor
  // doesn't drop below the 15s freshness threshold on other clients.
  clearInterval(_presenceHeartbeat);
  _presenceHeartbeat = setInterval(() => {
    if (!_presenceCurrent) return;
    const heartbeat = {
      manager_name: currentManagerName,
      week:         _presenceCurrent.week,
      cell_name:    _presenceCurrent.name,
      cell_day:     _presenceCurrent.day,
      focused_at:   new Date().toISOString()
    };
    _presenceInflight = sbFetch(
      'roster_presence?on_conflict=org_id,manager_name,week,cell_name,cell_day',
      'POST', heartbeat, 'resolution=merge-duplicates,return=minimal'
    ).catch(() => { /* non-blocking */ });
  }, 10000);
}

async function presenceBlur(name, week, day) {
  if (typeof TENANT === 'undefined' || !TENANT.ORG_UUID) return;
  if (!currentManagerName) return;
  if (typeof sbFetch !== 'function') return;
  if (typeof SB_URL !== 'undefined' && !SB_URL) return;

  clearInterval(_presenceHeartbeat); _presenceHeartbeat = null;
  _presenceCurrent = null;

  // v3.4.48: wait for any in-flight focus/heartbeat POST to land before
  // issuing DELETE. See _presenceInflight comment in presenceFocus.
  try { await _presenceInflight; } catch (e) {}

  const m = encodeURIComponent(currentManagerName);
  const w = encodeURIComponent(week);
  const n = encodeURIComponent(name);
  const d = encodeURIComponent(day);
  try {
    await sbFetch(
      `roster_presence?manager_name=eq.${m}&week=eq.${w}&cell_name=eq.${n}&cell_day=eq.${d}`,
      'DELETE'
    );
  } catch (e) { /* non-blocking */ }
}

// v3.4.48: removed the beforeunload sendBeacon block. sendBeacon only
// supports POST and the request had no PostgREST auth headers, so it
// was a confidently-named no-op. Unclean tab closes are handled by:
//   1. The hourly pg_cron job in migrations/2026-04-29_roster_presence.sql
//      which DELETEs rows older than 5 minutes.
//   2. The client-side `focused_at > now-15s` filter in _presenceRender,
//      which hides visually-stale presence within 15 seconds on every
//      other client even before the cron sweeps.

// ── Inbound: realtime → maintain _activePresence + render ────
function _presenceApplyChange(evType, record, oldRec) {
  if (evType === 'DELETE') {
    if (oldRec) {
      const k = _presenceKey(oldRec.week, oldRec.cell_name, oldRec.cell_day);
      const v = _activePresence.get(k);
      if (v && v.manager === oldRec.manager_name) _activePresence.delete(k);
    }
    _presenceRender();
    return;
  }
  if (!record) return;
  // v3.4.60: keep own presence too, tagged with isSelf, so we render a
  // dimmer "you-are-here" outline. Was previously hard-skipped here,
  // which left single-user testing with no visual feedback that the
  // feature was wired up. Other supervisors still get the bold purple
  // outline + tooltip (different CSS class).
  const isSelf = _isOwnPresence(record);

  const k = _presenceKey(record.week, record.cell_name, record.cell_day);
  _activePresence.set(k, {
    manager:    record.manager_name,
    focused_at: record.focused_at,
    ts:         Date.now(),
    isSelf
  });
  _presenceRender();
}
window._presenceApplyChange = _presenceApplyChange;

// ── Render: outline cells with active presence ───────────────
function _presenceRender() {
  // Only run on pages with editor cells visible.
  if (typeof currentPage === 'undefined' || currentPage !== 'editor') return;

  // v3.4.60: clear BOTH outline variants — other-supervisor (bold purple
  // with tooltip) AND self (thin dashed, no tooltip).
  document.querySelectorAll('#editor-content .presence-outline, #editor-content .presence-outline-self').forEach(el => {
    el.classList.remove('presence-outline', 'presence-outline-self');
    el.removeAttribute('data-presence-by');
  });

  // Apply outlines for fresh presence rows.
  const week = (typeof STATE !== 'undefined' && STATE.currentWeek) || '';
  for (const [key, v] of _activePresence) {
    // Stale ones get reaped at next render or when realtime delivers
    // a fresh update; for now we simply don't render them.
    const ageMs = Date.now() - new Date(v.focused_at).getTime();
    if (ageMs > _PRESENCE_FRESH_MS) continue;

    const [pWeek, pName, pDay] = key.split('||');
    if (pWeek !== week) continue;   // viewing a different week — ignore
    const sel = `#editor-content input[data-name="${CSS.escape(pName)}"][data-week="${CSS.escape(pWeek)}"][data-day="${pDay}"]`;
    const inp = document.querySelector(sel);
    if (!inp) continue;
    const wrapper = inp.closest('.editor-day') || inp.parentElement;
    if (!wrapper) continue;
    // v3.4.60: self gets a different class — thin/dashed, no tooltip
    // ("you-are-here" marker). Multi-user keeps the bold purple
    // "X is editing" outline.
    if (v.isSelf) {
      wrapper.classList.add('presence-outline-self');
    } else {
      wrapper.classList.add('presence-outline');
      wrapper.setAttribute('data-presence-by', v.manager + ' is editing');
    }
  }
}
window._presenceRender = _presenceRender;

// Re-render on a low-frequency tick so stale rows fade out without
// requiring a fresh realtime delivery.
setInterval(_presenceRender, 5000);
