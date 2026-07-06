/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/tafe.js  —  EQ Solves Field
// TAFE day handling for apprentices.
// - Holiday ranges config (NSW school holidays by default)
// - "Apply TAFE Day" button: fills empty cells only, skips
//   weeks that fall inside a TAFE holiday range.
// - Never overwrites existing cell content.
// Depends on: app-state.js, utils.js, supabase.js, roster.js
// ─────────────────────────────────────────────────────────────

let tafeHolidays = []; // array of { start:'YYYY-MM-DD', end:'YYYY-MM-DD', label:'' }

// ── Load / save holidays ──────────────────────────────────────

async function loadTafeHolidays() {
  try {
    const rows = await sbFetch('app_config?key=eq.tafe_holidays&select=value');
    if (rows && rows[0] && rows[0].value) {
      tafeHolidays = JSON.parse(rows[0].value) || [];
      return;
    }
  } catch (e) { /* fall through to localStorage */ }
  try {
    tafeHolidays = JSON.parse(localStorage.getItem('eq_tafe_holidays') || '[]');
  } catch (e) { tafeHolidays = []; }
}

async function saveTafeHolidays() {
  const payload = JSON.stringify(tafeHolidays);
  try {
    // Try update first (row exists)
    const res = await sbFetch('app_config?key=eq.tafe_holidays', 'PATCH', { value: payload });
    // If PATCH returns [] (no row), create it
    if (!res || (Array.isArray(res) && res.length === 0)) {
      // NOTE: key stored as literal 'tafe_holidays' — 'eq.' is a Supabase
      // filter operator used in the PATCH query string above, not part of
      // the stored key value. (Fixed v3.4.5.)
      await sbFetch('app_config', 'POST', { key: 'tafe_holidays', value: payload });
    }
  } catch (e) {
    // Fall back to localStorage
    try { localStorage.setItem('eq_tafe_holidays', payload); } catch (e2) {}
  }
}

// ── Date helpers ──────────────────────────────────────────────

// Parse the app's "DD.MM.YY" week key into a Date for Monday.
function tafeWeekKeyToMonday(weekKey) {
  const parts = (weekKey || '').split('.');
  if (parts.length !== 3) return null;
  const [dd, mm, yy] = parts.map(x => parseInt(x, 10));
  if (!dd || !mm || isNaN(yy)) return null;
  const year = 2000 + yy;
  return new Date(year, mm - 1, dd);
}

// True if the given day of that week falls inside any TAFE holiday range.
// v3.4.59: BATTLE-TEST #48 — was using `.toISOString().slice(0,10)` which
// is the UTC date. tafeWeekKeyToMonday() above constructs a LOCAL midnight
// (`new Date(year, month, day)`) — in any Australian timezone (+8 to +11)
// the corresponding UTC instant is the PREVIOUS calendar day. So a TAFE
// day of Monday 2026-04-27 (local) would convert to UTC "2026-04-26" and
// the holiday-range comparison against the plaintext YYYY-MM-DD config
// would always miss by one day. The server-side Edge Function does the
// same work using all-UTC operations, so server-side was always correct;
// this fix brings the client into agreement so the manual "🎓 Apply TAFE
// Day" button respects holiday config the same way the Sunday cron does.
function tafeIsHolidayForDay(monday, dayIdx /* 0=Mon..4=Fri */) {
  if (!monday) return false;
  const d = new Date(monday);
  d.setDate(d.getDate() + dayIdx);
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  const iso  = `${yyyy}-${mm}-${dd}`;
  return tafeHolidays.some(h => iso >= h.start && iso <= h.end);
}

// v3.10.82: Shared holiday check keyed by the app's "DD.MM.YY" week + day
// string. Consumed by the timesheet reader (scripts/timesheets.js) so it can
// honour the SAME tafe_holidays config the "Apply TAFE Day" button and the
// tafe-weekly-fill Edge Function already use — during a configured TAFE break
// there is no class, so an apprentice's rostered TAFE cell must not mute the
// timesheet day (grey it out / auto-count 8h / block real hours).
function isTafeHolidayCell(weekKey, dayKey) {
  const idx = ['mon','tue','wed','thu','fri','sat','sun']
    .indexOf(String(dayKey || '').toLowerCase());
  if (idx < 0) return false;
  const monday = tafeWeekKeyToMonday(weekKey);
  if (!monday) return false;
  return tafeIsHolidayForDay(monday, idx);
}

// ── Apply TAFE day for current week ───────────────────────────
// Only touches EMPTY cells for apprentices who have a nominated
// TAFE day. Skips the day entirely if the date lands in a holiday
// range. Never overwrites existing roster content.

async function applyTafeDayForWeek() {
  if (!isManager) { showToast('Supervision access required'); return; }

  const week = STATE.currentWeek;
  if (!week) { showToast('No active week'); return; }

  const monday = tafeWeekKeyToMonday(week);
  if (!monday) { showToast('Could not parse week'); return; }

  const dayKeys = ['mon','tue','wed','thu','fri'];
  const apprentices = (STATE.people || []).filter(p =>
    p.group === 'Apprentice' && p.tafe_day && dayKeys.includes(p.tafe_day)
  );

  if (!apprentices.length) {
    showToast('No apprentices have a TAFE day nominated');
    return;
  }

  let filled = 0, skippedHoliday = 0, skippedOccupied = 0;
  const writes = [];

  for (const p of apprentices) {
    const dayIdx = dayKeys.indexOf(p.tafe_day);

    // Skip if that date is inside a TAFE holiday range
    if (tafeIsHolidayForDay(monday, dayIdx)) {
      skippedHoliday++;
      continue;
    }

    // Find or create the schedule entry for this person/week
    let entry = STATE.schedule.find(r => r.name === p.name && r.week === week);
    if (!entry) {
      entry = { name: p.name, week, mon:'', tue:'', wed:'', thu:'', fri:'', sat:'', sun:'' };
      STATE.schedule.push(entry);
      if (STATE.scheduleIndex) STATE.scheduleIndex[`${p.name}||${week}`] = entry;
    }

    const existing = (entry[p.tafe_day] || '').trim();
    if (existing) { skippedOccupied++; continue; }

    entry[p.tafe_day] = 'TAFE';
    writes.push(saveCellToSB(p.name, week, p.tafe_day, 'TAFE'));
    filled++;
  }

  try {
    await Promise.all(writes);
  } catch (e) {
    showToast('⚠ Some TAFE days failed to save — check connection');
  }

  const parts = [];
  parts.push(`🎓 ${filled} TAFE day${filled === 1 ? '' : 's'} filled`);
  if (skippedOccupied) parts.push(`${skippedOccupied} skipped (cell not empty)`);
  if (skippedHoliday)  parts.push(`${skippedHoliday} skipped (holiday)`);
  showToast(parts.join(' · '));
  auditLog(`Applied TAFE day — ${filled} filled, ${skippedOccupied} skipped (occupied), ${skippedHoliday} skipped (holiday)`, 'TAFE', null, week);

  if (currentPage === 'editor') renderEditor();
  if (currentPage === 'roster') renderRoster();
  if (currentPage === 'dashboard') renderDashboard();
  updateLastUpdated();
}

// ── Holidays modal ────────────────────────────────────────────

function openTafeHolidaysConfig() {
  if (!isManager) { showToast('Supervision access required'); return; }
  renderTafeHolidaysList();
  // Clear inputs
  const s = document.getElementById('tafe-holiday-start');
  const e = document.getElementById('tafe-holiday-end');
  const l = document.getElementById('tafe-holiday-label');
  if (s) s.value = '';
  if (e) e.value = '';
  if (l) l.value = '';
  openModal('modal-tafe-holidays');
}

function renderTafeHolidaysList() {
  const el = document.getElementById('tafe-holidays-list');
  if (!el) return;
  if (!tafeHolidays.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:8px 0">No TAFE holiday ranges configured yet.</div>';
    return;
  }
  // Sort by start date asc
  const sorted = [...tafeHolidays].map((h, i) => ({ ...h, _i: i }))
    .sort((a, b) => a.start.localeCompare(b.start));

  el.innerHTML = sorted.map(h => {
    const label = h.label ? esc(h.label) : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
      <span style="flex:1;font-size:12px;color:var(--ink)">
        <strong>${esc(h.start)}</strong> &rarr; <strong>${esc(h.end)}</strong>
        ${label ? `<span style="color:var(--ink-3);margin-left:8px">· ${label}</span>` : ''}
      </span>
      <button onclick="removeTafeHoliday(${h._i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:0">✕</button>
    </div>`;
  }).join('');
}

async function addTafeHoliday() {
  const start = document.getElementById('tafe-holiday-start').value;
  const end   = document.getElementById('tafe-holiday-end').value;
  const label = (document.getElementById('tafe-holiday-label').value || '').trim();

  if (!start || !end) { showToast('Enter both start and end dates'); return; }
  if (end < start)   { showToast('End date must be on or after start'); return; }

  tafeHolidays.push({ start, end, label });
  await saveTafeHolidays();
  document.getElementById('tafe-holiday-start').value = '';
  document.getElementById('tafe-holiday-end').value   = '';
  document.getElementById('tafe-holiday-label').value = '';
  renderTafeHolidaysList();
  showToast('TAFE holiday range added');
}

async function removeTafeHoliday(idx) {
  if (idx < 0 || idx >= tafeHolidays.length) return;
  tafeHolidays.splice(idx, 1);
  await saveTafeHolidays();
  renderTafeHolidaysList();
  showToast('TAFE holiday range removed');
}