/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/timesheets.js  —  EQ Solves Field
// Timesheets: render, cell save, batch fill, export,
// staff self-entry (renderStaffTs, onStaffTsCellChange).
// Depends on: app-state.js, utils.js, supabase.js, roster.js
// ─────────────────────────────────────────────────────────────

// v3.4.26: ensure .ts-total-red class exists even if base.css hasn't been
// updated. Idempotent — only injects once per page load.
(function injectTsTotalRedStyle(){
  if (typeof document === 'undefined') return;
  if (document.getElementById('eq-ts-total-red-style')) return;
  const s = document.createElement('style');
  s.id = 'eq-ts-total-red-style';
  s.textContent = '.ts-total-red{color:var(--red,#EF4444);font-weight:700}';
  document.head.appendChild(s);
})();

const TS_DAYS   = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TS_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Job Combobox ─────────────────────────────────────────────
// Custom dropdown for job number inputs. Shows filtered active
// job numbers with description. Allows manual free-text entry.

let _activeCombobox = null;

function _getActiveJobs() {
  return (typeof jobNumbers !== 'undefined' ? jobNumbers : []).filter(j => j.status === 'Active');
}

function openJobCombobox(inputEl) {
  closeJobCombobox();
  const jobs = _getActiveJobs();
  if (!jobs.length) return;

  const rect = inputEl.getBoundingClientRect();
  const drop = document.createElement('div');
  drop.id = 'job-combobox-dropdown';
  drop.className = 'job-combobox-dropdown';

  // Position below the input, flip above if near bottom of viewport
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const flipAbove = spaceBelow < 240 && spaceAbove > spaceBelow;

  drop.style.position = 'fixed';
  drop.style.left   = rect.left + 'px';
  drop.style.width  = Math.max(rect.width, 260) + 'px';
  drop.style.zIndex = '9999';

  if (flipAbove) {
    drop.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
    drop.style.top    = 'auto';
  } else {
    drop.style.top    = (rect.bottom + 2) + 'px';
    drop.style.bottom = 'auto';
  }

  // Prevent scroll inside dropdown from closing it
  drop.addEventListener('mousedown', function(e) { e.preventDefault(); });
  drop.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });

  _activeCombobox = { input: inputEl, dropdown: drop };
  document.body.appendChild(drop);
  _renderComboboxOptions(inputEl.value);
}

function _renderComboboxOptions(filter) {
  if (!_activeCombobox) return;
  const drop  = _activeCombobox.dropdown;
  const input = _activeCombobox.input;
  const q     = (filter || '').toLowerCase().trim();
  // v3.4.81 — relevance-sorted suggestions. Personal history first,
  // site history second, alpha-everything-else last. Falls back to
  // a plain active-jobs list if dataset names aren't on the input.
  const personName = input && input.dataset ? input.dataset.name : null;
  const weekStr    = input && input.dataset ? input.dataset.week : null;
  const jobs       = personName
    ? _jobsSortedForCell(personName, weekStr)
    : _getActiveJobs();

  const filtered = q
    ? jobs.filter(j =>
        (j.number || '').toLowerCase().includes(q) ||
        (j.description || '').toLowerCase().includes(q) ||
        (j.client || '').toLowerCase().includes(q))
    : jobs;

  if (!filtered.length) {
    drop.innerHTML = '<div class="jcb-empty">No matches</div>';
    return;
  }

  drop.innerHTML = filtered.map(j => {
    const desc = j.description ? ' \u2014 ' + esc(j.description) : '';
    const client = j.client ? '<span class="jcb-client">' + esc(j.client) + '</span>' : '';
    return `<div class="jcb-option" data-value="${esc(j.number)}"
      onmousedown="selectComboboxOption(event, '${esc(j.number)}')"
      ontouchend="selectComboboxOption(event, '${esc(j.number)}')">
      <span class="jcb-number">${esc(j.number)}</span>
      <span class="jcb-desc">${desc}</span>
      ${client}
    </div>`;
  }).join('');
}

function selectComboboxOption(e, value) {
  e.preventDefault(); // prevent blur before we set the value
  if (!_activeCombobox) return;
  const input = _activeCombobox.input;
  input.value = value;
  input.dispatchEvent(new Event('change'));
  closeJobCombobox();
  // Move focus to the hours input next to it
  const hrsInput = input.closest('.ts-cell, div')
    ?.querySelector('input[data-type="hrs"], input[type="number"]');
  if (hrsInput) hrsInput.focus();
}

function closeJobCombobox() {
  if (_activeCombobox && _activeCombobox.dropdown) {
    _activeCombobox.dropdown.remove();
  }
  _activeCombobox = null;
}

function _onComboboxInput(el) {
  el.value = el.value.toUpperCase();
  if (_activeCombobox && _activeCombobox.input === el) {
    _renderComboboxOptions(el.value);
  } else {
    openJobCombobox(el);
  }
}

function _onComboboxFocus(el) {
  openJobCombobox(el);
}

function _onComboboxBlur() {
  // Longer delay to allow scrolling and touch interactions on the dropdown
  setTimeout(closeJobCombobox, 300);
}

// Close combobox on scroll OUTSIDE the dropdown, or on resize
document.addEventListener('scroll', function(e) {
  if (_activeCombobox && _activeCombobox.dropdown && _activeCombobox.dropdown.contains(e.target)) return;
  closeJobCombobox();
}, true);
window.addEventListener('resize', closeJobCombobox);

// ── Load ──────────────────────────────────────────────────────

async function loadTimesheets() {
  try {
    const rows = await sbFetch('timesheets?select=*');
    STATE.timesheets = rows;
  } catch (e) {
    STATE.timesheets = [];
    console.warn('Timesheets load failed:', e);
  }
}

// ── Helpers ───────────────────────────────────────────────────

function getTsEntry(name, week) {
  return (STATE.timesheets || []).find(r => r.name === name && r.week === week) || null;
}

function tsTotalHrs(entry) {
  if (!entry) return 0;
  return TS_DAYS.reduce((s, d) => {
    const jobStr = entry[d + '_job'] || '';
    if (jobStr.includes('|')) {
      return s + jobStr.split('|').reduce((sum, part) => {
        return sum + (parseFloat(part.split(':')[1]) || 0);
      }, 0);
    }
    const h = parseFloat(entry[d + '_hrs']) || 0;
    return s + (jobStr && h ? h : 0);
  }, 0);
}

// Adds rostered TAFE days (8h each) to the work total for apprentices.
// TAFE days are muted in the timesheet and not entered as hours — but
// they count toward the 40h weekly target on the employer portal.
function _tsApprenticeTotal(personName, week, entry) {
  const workHrs = tsTotalHrs(entry);
  let tafeHrs   = 0;
  ['mon','tue','wed','thu','fri'].forEach(d => {
    if (_tsDayStatus(personName, week, d).tafeLabel) tafeHrs += 8;
  });
  return workHrs + tafeHrs;
}

function updateTsRowTotal(name, week) {
  const entry  = getTsEntry(name, week);
  const person = (STATE.people || []).find(p => p.name === name);
  const total  = (person && person.group === 'Apprentice')
    ? _tsApprenticeTotal(name, week, entry)
    : tsTotalHrs(entry);
  const id = 'tst-' + name.replace(/\W/g, '_');
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = total > 0 ? total + 'h' : '—';
  // v3.4.26: red if any hours but week incomplete, else green/empty.
  el.className   = 'ts-total-col ' + (total >= 40 ? 'ts-total-green' : total > 0 ? 'ts-total-red' : 'ts-total-empty');
}

// ── Save cell ─────────────────────────────────────────────────

async function saveTsCell(name, grp, week, day, job, hrs) {
  if (!isManager) { showToast('Supervision access required'); return; }
  // v3.4.82 — refuse writes into a locked week. Quiet toast pointing
  // at the banner which has the "Request unlock" affordance.
  if (typeof isTsWeekLocked === 'function' && isTsWeekLocked(week)) {
    showToast('🔒 Week ' + week + ' is locked. Use the banner above to request unlock.');
    return;
  }
  if (!STATE.timesheets) STATE.timesheets = [];
  let entry = STATE.timesheets.find(r => r.name === name && r.week === week);
  if (!entry) {
    entry = {
      name, group: grp, week,
      mon_job: null, mon_hrs: null, tue_job: null, tue_hrs: null,
      wed_job: null, wed_hrs: null, thu_job: null, thu_hrs: null,
      fri_job: null, fri_hrs: null, sat_job: null, sat_hrs: null,
      sun_job: null, sun_hrs: null
    };
    STATE.timesheets.push(entry);
  }
  // BUG-002 FIX: single assignment (was duplicated)
  entry[day + '_job'] = job || null;
  entry[day + '_hrs'] = hrs || null;
  updateTsRowTotal(name, week);

  const row = { name, group: grp, week };
  TS_DAYS.forEach(d => {
    row[d + '_job'] = entry[d + '_job'] || null;
    const hVal = entry[d + '_hrs'];
    if (hVal != null && String(hVal).includes('|')) {
      row[d + '_hrs'] = String(hVal).split('|').reduce((s, x) => s + (parseFloat(x) || 0), 0);
    } else {
      row[d + '_hrs'] = parseFloat(hVal) || null;
    }
  });
  sbFetch('timesheets?on_conflict=name,week,org_id', 'POST', row, 'resolution=merge-duplicates,return=minimal')
    .catch(() => showToast('Timesheet save failed — check connection'));
  // v3.4.35: track per-cell saves so Royce can see timesheet activity volume.
  if (window.EQ_ANALYTICS && EQ_ANALYTICS.events) {
    EQ_ANALYTICS.events.timesheetSaved({ week_of: week, day: day, has_job: !!job });
  }
}

// ── Cell change handler ───────────────────────────────────────

function onTsCellChange(el) {
  // TS-003: Validate hours
  if (el.dataset.type === 'hrs') {
    const val = parseFloat(el.value);
    if (val > 24) { showToast('⚠ Hours cannot exceed 24 per day'); el.value = 24; }
    if (val > 12 && val <= 24) showToast(`⚠ ${el.dataset.name}: ${val}h entered for ${el.dataset.day.toUpperCase()}`);
  }
  if (!isManager) { showToast('Supervision access required'); el.value = ''; return; }

  const { name, group, week, day } = el.dataset;
  // v3.4.83.1: also accept the mobile `.ts-mday` container so saves
  // work in the supervisor phone view (mobile inputs aren't in a <tr>).
  const row = el.closest('tr, .ts-mday');

  const job0El = row.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="job"][data-slot="0"]`);
  const hrs0El = row.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="hrs"][data-slot="0"]`);
  const job1El = row.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="job"][data-slot="1"]`);
  const hrs1El = row.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="hrs"][data-slot="1"]`);

  const job0 = job0El ? job0El.value.trim() : '';
  const hrs0 = hrs0El ? parseFloat(hrs0El.value) || 0 : 0;
  const job1 = job1El ? job1El.value.trim() : '';
  const hrs1 = hrs1El ? parseFloat(hrs1El.value) || 0 : 0;

  let combinedJob, combinedHrs;
  if (job1) {
    combinedJob = `${job0}:${hrs0}|${job1}:${hrs1}`;
    combinedHrs = hrs0 + hrs1;
  } else {
    combinedJob = job0 || null;
    combinedHrs = hrs0 || null;
  }

  saveTsCell(name, group, week, day, combinedJob, combinedHrs);
  updateLastUpdated();
  auditLog(`${day.toUpperCase()} → ${combinedJob || 'cleared'} / ${combinedHrs || '—'}h`, 'Timesheet', name, week);

  renderTimesheets();
}

// ── Split row toggle ──────────────────────────────────────────

function toggleTsSplit(pid, btn) {
  const row = document.getElementById('split-' + pid);
  if (!row) return;
  const show = row.style.display === 'none';
  row.style.display = show ? 'flex' : 'none';
  btn.classList.toggle('active', show);
  if (!show) {
    row.querySelectorAll('input').forEach(el => { el.value = ''; onTsCellChange(el); });
  }
}

// ── Fill week from Monday ─────────────────────────────────────
// Copies the current Monday cell (job + hours) for one person into
// the workable Tue–Fri days of the same week. v3.4.83.2: skips
// roster-muted days (leave/TAFE) — was a quiet bug before. Honours
// split-day entries: the raw `mon_job` string (e.g. "D5384:4|D5385:4")
// and numeric `mon_hrs` copy through saveTsCell unchanged.
//
// Safety model (no modal prompts — fully reversible):
//  1. Two-tap arming on the banner button (see _armFillWeek)
//  2. Undo toast for 5s after the fill (see _showFillWeekUndoToast)
//  3. Audit log entry — recoverable via the v3.4.76 revert button
async function fillTsWeekFromMon(name, grp) {
  if (!isManager) { showToast('Supervision access required'); return; }
  if (!name) return;
  const week  = STATE.currentWeek;
  const entry = (STATE.timesheets || []).find(r => r.name === name && r.week === week);
  if (!entry || !entry.mon_job) { showToast('Fill Monday first'); return; }

  const monJob = entry.mon_job;
  const monHrs = entry.mon_hrs;
  const days   = ['tue', 'wed', 'thu', 'fri'];
  const workableDays = days.filter(d => _tsDayStatus(name, week, d).workable);
  if (!workableDays.length) {
    showToast('No workable days to fill — Tue–Fri all on leave/TAFE');
    return;
  }

  // Capture per-day before-state so the undo toast can restore.
  const before = {};
  workableDays.forEach(d => {
    before[d] = { job: entry[d + '_job'], hrs: entry[d + '_hrs'] };
  });

  for (const d of workableDays) {
    await saveTsCell(name, grp, week, d, monJob, monHrs);
  }
  renderTimesheets();

  const jobNum = String(monJob).split(':')[0];
  _showFillWeekUndoToast(
    `Filled Mon → Fri (${jobNum})`,
    async () => {
      for (const d of workableDays) {
        await saveTsCell(name, grp, week, d, before[d].job, before[d].hrs);
      }
      renderTimesheets();
      showToast('↩ Undone — Tue–Fri restored');
      auditLog('Undid Fill Week from Mon', 'Timesheet', name, week);
    }
  );

  auditLog(
    `Fill week from Mon: ${jobNum} / ${monHrs || 0}h`,
    'Timesheet', name, week
  );
}

// v3.4.83.2 — Two-tap arming on the Fill Week banner button. First
// tap arms (label changes, amber pulse). Second tap within 3s
// fires fillTsWeekFromMon. Auto-disarms after the timeout so a
// forgotten arm doesn't fire on the next tap of any other button.
function _armFillWeek(btn) {
  if (!btn) return;
  if (btn.dataset.armed === '1') {
    if (btn.dataset.timeoutId) clearTimeout(Number(btn.dataset.timeoutId));
    delete btn.dataset.timeoutId;
    btn.dataset.armed = '';
    btn.classList.remove('ts-mfillweek-btn-armed');
    fillTsWeekFromMon(btn.dataset.n, btn.dataset.g);
    return;
  }
  btn.dataset.armed   = '1';
  btn.dataset.origText = btn.textContent;
  btn.classList.add('ts-mfillweek-btn-armed');
  btn.textContent = 'Tap again — confirm';
  const timeout = setTimeout(() => {
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = '';
    btn.classList.remove('ts-mfillweek-btn-armed');
    btn.textContent = btn.dataset.origText || 'Fill Week';
    delete btn.dataset.timeoutId;
    delete btn.dataset.origText;
  }, 3000);
  btn.dataset.timeoutId = String(timeout);
}

// v3.4.83.2 — Undo toast with a 5s window. Tapping Undo calls the
// supplied function to restore the pre-fill state.
function _showFillWeekUndoToast(msg, undoFn) {
  document.querySelectorAll('.ts-fillweek-undo-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'ts-fillweek-undo-toast';
  toast.innerHTML = '<span class="ts-fillweek-undo-msg">' + esc(msg) + '</span>' +
                    '<button class="ts-fillweek-undo-btn" type="button">Undo</button>';
  document.body.appendChild(toast);
  const cleanup = () => { if (toast.parentNode) toast.parentNode.removeChild(toast); };
  toast.querySelector('.ts-fillweek-undo-btn').addEventListener('pointerdown', e => {
    e.preventDefault();
    cleanup();
    undoFn();
  });
  setTimeout(cleanup, 5000);
}

// ── Render grid ───────────────────────────────────────────────

function _getTsFilteredPeople() {
  const grpFilter = (document.getElementById('ts-group-filter') || {}).value || '';
  const searchRaw = (document.getElementById('ts-search') || {}).value || '';
  const search    = searchRaw.toLowerCase().trim();

  let people = [...STATE.people]
    .filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire');

  if (typeof agencyMode !== 'undefined' && agencyMode && typeof agencyName !== 'undefined') {
    people = people.filter(p => p.agency === agencyName);
  }
  if (grpFilter) people = people.filter(p => p.group === grpFilter);
  if (search)    people = people.filter(p => p.name.toLowerCase().includes(search));

  return people.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

// v3.4.82 — Phase 3: Accounts Review mode
// ─────────────────────────────────────────────────────────────
// Per-week lock state, filter chips, variance flagging, by-job CSV.
// Lock state is one row per (week, org) in public.timesheet_locks;
// loaded into STATE.timesheetLocks alongside the rest in
// loadFromSupabase. The lock itself is workflow UX, not RLS.

const TS_FILTER_LS_KEY = 'eq.ts.currentFilter';
// Restored synchronously so the first renderTimesheets call picks up
// the persisted filter. null/'all' means show everything.
let _tsCurrentFilter = (function() {
  try {
    const v = localStorage.getItem(TS_FILTER_LS_KEY);
    if (v && ['all','incomplete','over40','under30'].includes(v)) return v;
  } catch (e) {}
  return 'all';
})();

function setTsFilter(name) {
  _tsCurrentFilter = name || 'all';
  try { localStorage.setItem(TS_FILTER_LS_KEY, _tsCurrentFilter); } catch (e) {}
  renderTimesheets();
}

// Lock-state lookup. Empty array == no locks; matches the absence-
// means-open convention. Returns the lock row or null.
function _getTsLock(weekKey) {
  if (!Array.isArray(STATE.timesheetLocks)) return null;
  return STATE.timesheetLocks.find(l => l.week_key === weekKey) || null;
}
function isTsWeekLocked(weekKey) { return !!_getTsLock(weekKey); }

// Variance flag — compare this week's filled hours to the same
// person's 4-week rolling average. Returns one of:
//   null   — not enough history (< 2 prior weeks with any hours)
//   'low'  — this week is ≤ 60% of avg
//   'high' — this week is ≥ 140% of avg
// Anything in-between is normal. The 4-week window matches the
// smart-fill autocomplete scoring so users see consistent maths.
function _tsRowVariance(personName, weekStr) {
  const entry = (STATE.timesheets || []).find(r => r.name === personName && r.week === weekStr);
  const thisHrs = entry ? tsTotalHrs(entry) : 0;
  const samples = [];
  let cursor = weekStr;
  for (let i = 0; i < 4; i++) {
    cursor = _previousWeekKey(cursor);
    if (!cursor) break;
    const e = (STATE.timesheets || []).find(r => r.name === personName && r.week === cursor);
    if (e) {
      const h = tsTotalHrs(e);
      if (h > 0) samples.push(h);
    }
  }
  if (samples.length < 2) return null;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  if (avg <= 0) return null;
  if (thisHrs === 0) return null;     // empty rows already flagged by left-stripe
  const ratio = thisHrs / avg;
  if (ratio <= 0.60) return { tone: 'low',  ratio, avg: Math.round(avg), thisHrs };
  if (ratio >= 1.40) return { tone: 'high', ratio, avg: Math.round(avg), thisHrs };
  return null;
}

// ── Lock / unlock actions ───────────────────────────────────
async function lockCurrentWeek() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week = STATE.currentWeek;
  if (!week) return;
  if (isTsWeekLocked(week)) { showToast('Week ' + week + ' is already locked'); return; }
  const reason = window.prompt(
    `Lock week ${week}?\n\nThis stops supervisors editing this week's timesheets until it's unlocked. ` +
    `Optional reason (e.g. "Approved by accounts"):`,
    ''
  );
  if (reason === null) return;  // Cancel
  try {
    const row = {
      week_key:  week,
      locked_at: new Date().toISOString(),
      locked_by: (typeof currentManagerName !== 'undefined' && currentManagerName) || 'Supervisor',
      reason:    (reason || '').trim() || null
    };
    await sbFetch('timesheet_locks', 'POST', row, 'return=minimal');
    STATE.timesheetLocks = STATE.timesheetLocks || [];
    STATE.timesheetLocks.push(row);
    auditLog('Locked week ' + week, 'Timesheet', row.reason || '', week);
    showToast('🔒 Week ' + week + ' locked');
    renderTimesheets();
  } catch (e) {
    showToast('Lock failed: ' + (e && e.message || e));
  }
}

async function unlockCurrentWeek() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week = STATE.currentWeek;
  if (!week) return;
  const lock = _getTsLock(week);
  if (!lock) { showToast('Week ' + week + ' is not locked'); return; }
  if (!window.confirm(
    `Unlock week ${week}?\n\nThis was locked by ${lock.locked_by || 'someone'}` +
    (lock.reason ? ` (${lock.reason})` : '') + '.\n\nSupervisors will be able to edit again.'
  )) return;
  try {
    await sbFetch('timesheet_locks?week_key=eq.' + encodeURIComponent(week), 'DELETE');
    STATE.timesheetLocks = (STATE.timesheetLocks || []).filter(l => l.week_key !== week);
    auditLog('Unlocked week ' + week, 'Timesheet', null, week);
    showToast('🔓 Week ' + week + ' unlocked');
    renderTimesheets();
  } catch (e) {
    showToast('Unlock failed: ' + (e && e.message || e));
  }
}

// "Request unlock" affordance shown to any supervisor on a locked
// week. Drops an audit row so whoever can unlock sees the request.
// No email/notification — just an audit trail entry.
function requestTsUnlock() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week = STATE.currentWeek;
  const lock = _getTsLock(week);
  if (!lock) { showToast('Week ' + week + ' is not locked'); return; }
  const reason = window.prompt(
    `Request that week ${week} be unlocked?\n\n` +
    `Locked by: ${lock.locked_by || 'unknown'}\n` +
    `Why do you need to edit? (optional):`,
    ''
  );
  if (reason === null) return;
  auditLog('Unlock requested for week ' + week, 'Timesheet', (reason || '').trim() || null, week);
  showToast('✓ Unlock request logged — ' + (lock.locked_by || 'a supervisor') + ' will see it in the audit log');
}

// ── CSV export grouped by job number ────────────────────────
// Companion to exportTsCSV. Same data, different shape — one row
// per (job_number, person, day) with grouping headers + subtotals.
// Useful for accounts when reconciling against a specific job's
// labour cost. Splits "J1:4|J2:4"-style cells into separate rows.
function exportTsByJob() {
  const week = STATE.currentWeek;
  const rows = (STATE.timesheets || []).filter(r => r.week === week);
  if (!rows.length) { showToast('No entries to export for ' + week); return; }
  // Flatten into per-(job, person, day) tuples
  const flat = [];
  rows.forEach(r => {
    TS_DAYS.forEach(d => {
      const jobRaw = r[d + '_job'];
      const hrsRaw = r[d + '_hrs'];
      if (!jobRaw) return;
      if (String(jobRaw).includes('|')) {
        String(jobRaw).split('|').forEach(part => {
          const seg = part.split(':');
          const code = (seg[0] || '').trim();
          const hrs  = parseFloat(seg[1]) || 0;
          if (code) flat.push({ job: code, name: r.name, group: r.group, day: d, hrs });
        });
      } else {
        const hrs = parseFloat(hrsRaw) || 0;
        flat.push({ job: String(jobRaw).trim(), name: r.name, group: r.group, day: d, hrs });
      }
    });
  });
  if (!flat.length) { showToast('No entries to export for ' + week); return; }
  // Group by job number
  const byJob = {};
  flat.forEach(f => { (byJob[f.job] = byJob[f.job] || []).push(f); });
  const sortedJobs = Object.keys(byJob).sort();

  const lines = ['Week,Job Number,Job Description,Person,Group,Day,Hours'];
  sortedJobs.forEach(j => {
    const jobMeta = (typeof jobNumbers !== 'undefined' ? jobNumbers : []).find(x => x.number === j);
    const jobDesc = jobMeta && jobMeta.description ? jobMeta.description : '';
    let jobTotal = 0;
    byJob[j].sort((a, b) => a.name.localeCompare(b.name) || TS_DAYS.indexOf(a.day) - TS_DAYS.indexOf(b.day));
    byJob[j].forEach(f => {
      jobTotal += f.hrs;
      lines.push([
        week, j, jobDesc, f.name, f.group, f.day.toUpperCase(), f.hrs
      ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    });
    // Subtotal row
    lines.push([week, j, jobDesc, '', '', 'TOTAL', jobTotal]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    lines.push('');  // blank row between jobs
  });
  downloadCSV(lines.join('\n'), 'EQ_Timesheets_by_Job_' + week.replace(/\./g, '-') + '.csv');
  showToast('Exported ' + sortedJobs.length + ' job' + (sortedJobs.length === 1 ? '' : 's'));
  auditLog('Export timesheets by job (' + sortedJobs.length + ' jobs)', 'Timesheet', null, week);
}

// v3.4.81 — Smart-fill helpers (Phase 2)
// ─────────────────────────────────────────────────────────────
// Compute the previous Monday's week-key in the same "DD.MM.YY"
// format the rest of the app uses. Pure function; no STATE access.
function _previousWeekKey(weekStr) {
  if (!weekStr) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(weekStr);
  if (!m) return null;
  const date = new Date(Number('20' + m[3]), Number(m[2]) - 1, Number(m[1]));
  date.setDate(date.getDate() - 7);
  return String(date.getDate()).padStart(2,'0') + '.' +
         String(date.getMonth() + 1).padStart(2,'0') + '.' +
         String(date.getFullYear()).slice(-2);
}

// Walk back week by week looking for the most recent week that had
// any entry for this person. Returns the entry, or null. Used by
// Copy-Last-Week so a supervisor returning from leave doesn't get
// blocked by an empty "previous week".
function _findMostRecentEntry(name, beforeWeek, maxWeeksBack) {
  maxWeeksBack = maxWeeksBack || 4;
  let cursor = beforeWeek;
  for (let i = 0; i < maxWeeksBack; i++) {
    cursor = _previousWeekKey(cursor);
    if (!cursor) return null;
    const e = (STATE.timesheets || []).find(r => r.name === name && r.week === cursor);
    if (e && TS_DAYS.some(d => e[d + '_job'] || e[d + '_hrs'])) {
      return { entry: e, week: cursor };
    }
  }
  return null;
}

// Copy a previous week's timesheet entry to this week. Honours
// roster mute (leave/TAFE days don't get overwritten with a job
// even if the source week had one). Asks for confirmation if the
// target week already has any entries — silent clobbering of a
// supervisor's existing work is the kind of bug that loses trust.
async function copyLastWeekTs(name, group) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week = STATE.currentWeek;
  const found = _findMostRecentEntry(name, week, 4);
  if (!found) { showToast('No recent week to copy from'); return; }
  const source = found.entry;
  const target = getTsEntry(name, week);

  const hasExisting = target && TS_DAYS.some(d => target[d + '_job'] || target[d + '_hrs']);
  if (hasExisting) {
    if (!window.confirm(
      `${name} already has timesheet data for this week.\n\nOverwrite with ${found.week} entries?`
    )) return;
  }

  for (const d of TS_DAYS) {
    const status = _tsDayStatus(name, week, d);
    if (!status.workable) continue;            // leave / TAFE day — skip
    const srcJob = source[d + '_job'];
    const srcHrs = source[d + '_hrs'];
    if (srcJob == null && srcHrs == null) continue;
    await saveTsCell(name, group, week, d, srcJob, srcHrs);
  }
  renderTimesheets();
  showToast('✓ Copied ' + found.week + ' → ' + week);
  auditLog('Copy last week (' + found.week + ')', 'Timesheet', name, week);
}

// Repeat one day's job + hours across every other workable day in
// the row. Replaces v3.4.79's "fill week →" link which only fired
// from Monday — supervisors often nail Wednesday first and want
// to fan it out, not the other way around. Skips leave/TAFE days
// via _tsDayStatus.
async function repeatDayAcrossTs(name, group, sourceDay) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week  = STATE.currentWeek;
  const entry = getTsEntry(name, week);
  if (!entry) { showToast('Fill ' + sourceDay.toUpperCase() + ' first'); return; }
  const srcJob = entry[sourceDay + '_job'];
  const srcHrs = entry[sourceDay + '_hrs'];
  if (!srcJob && (srcHrs == null || srcHrs === '')) {
    showToast('No ' + sourceDay.toUpperCase() + ' value to repeat');
    return;
  }
  // Target every workable day OTHER than the source day. Default
  // pool is Mon–Fri; Sat/Sun are excluded — repeating a regular
  // week's job into the weekend is almost always wrong.
  const targets = ['mon','tue','wed','thu','fri'].filter(d => {
    if (d === sourceDay) return false;
    const st = _tsDayStatus(name, week, d);
    return st.workable;
  });
  if (!targets.length) { showToast('No other workable days to fill'); return; }

  // Quiet overwrite warning — supervisors expect a repeat-day to
  // overwrite, so only ask when the differences are substantive
  // (different job number in another cell).
  const conflict = targets.some(d => {
    const j = entry[d + '_job'];
    return j && j !== srcJob;
  });
  if (conflict) {
    if (!window.confirm(
      `Other days have different job numbers. Overwrite with ${String(srcJob).split(':')[0]}?`
    )) return;
  }
  for (const d of targets) {
    await saveTsCell(name, group, week, d, srcJob, srcHrs);
  }
  renderTimesheets();
  showToast('✓ Repeated ' + sourceDay.toUpperCase() + ' → ' + targets.map(d => d.toUpperCase()).join(' · '));
  auditLog('Repeat day: ' + sourceDay.toUpperCase(), 'Timesheet', name, week);
}

// Returns active jobs sorted by relevance for a specific cell:
//   1. Jobs THIS person used in the last 4 weeks (personal history)
//   2. Jobs anyone used at this person's rostered site this week,
//      within the last 4 weeks (site history)
//   3. All remaining active jobs, alphabetical
// Falls back to plain alpha order if STATE.timesheets/schedule
// aren't loaded yet. Used by _renderComboboxOptions below.
function _jobsSortedForCell(personName, weekStr) {
  const jobs = _getActiveJobs();
  if (!jobs.length) return jobs;

  // Tier 1 — personal history (last 4 weeks)
  const personalSet = new Set();
  let cursor = weekStr;
  for (let i = 0; i < 4; i++) {
    if (!cursor) break;
    const e = (STATE.timesheets || []).find(r => r.name === personName && r.week === cursor);
    if (e) {
      TS_DAYS.forEach(d => {
        const j = e[d + '_job'];
        if (j) String(j).split('|').forEach(part => {
          const code = (part.split(':')[0] || '').trim();
          if (code) personalSet.add(code.toUpperCase());
        });
      });
    }
    cursor = _previousWeekKey(cursor);
  }

  // Tier 2 — site history. Use the person's rostered site this week
  // (if any) and find jobs other supervisors used at that site recently.
  const siteSet = new Set();
  try {
    if (typeof getPersonSchedule === 'function') {
      const s = getPersonSchedule(personName, weekStr);
      const rosteredSites = ['mon','tue','wed','thu','fri']
        .map(d => (s && s[d] ? String(s[d]).trim().toUpperCase() : ''))
        .filter(v => v && !(typeof isLeave === 'function' && isLeave(v)) && !(typeof isEducation === 'function' && isEducation(v)));
      const sitesUsed = new Set(rosteredSites);
      if (sitesUsed.size) {
        let c = weekStr;
        for (let i = 0; i < 4; i++) {
          if (!c) break;
          (STATE.timesheets || []).filter(r => r.week === c).forEach(e => {
            // Cross-reference each day's job with the same day's roster site
            const eSchedule = typeof getPersonSchedule === 'function'
              ? getPersonSchedule(e.name, c) : null;
            TS_DAYS.forEach(d => {
              if (!eSchedule) return;
              const dSite = (eSchedule[d] || '').trim().toUpperCase();
              if (!sitesUsed.has(dSite)) return;
              const j = e[d + '_job'];
              if (j) String(j).split('|').forEach(part => {
                const code = (part.split(':')[0] || '').trim();
                if (code) siteSet.add(code.toUpperCase());
              });
            });
          });
          c = _previousWeekKey(c);
        }
      }
    }
  } catch (_) { /* never break the picker on a sort-helper error */ }

  // Score + sort
  return jobs.slice().sort((a, b) => {
    const aPersonal = personalSet.has(String(a.number).toUpperCase()) ? 1000 : 0;
    const bPersonal = personalSet.has(String(b.number).toUpperCase()) ? 1000 : 0;
    const aSite     = siteSet.has(String(a.number).toUpperCase())     ?  500 : 0;
    const bSite     = siteSet.has(String(b.number).toUpperCase())     ?  500 : 0;
    const diff = (bPersonal + bSite) - (aPersonal + aSite);
    if (diff !== 0) return diff;
    return String(a.number).localeCompare(String(b.number));
  });
}

// v3.4.81 — Hours quick-select chip popover. Lazy-created on first
// focus of a `.ts-hrs` input. Singleton — only one open at a time.
// Tap a chip → fills the input + fires change → closes popover.
// v3.4.83.1 — dropped 7.6 chip per Royce; 8 is the standard SKS day.
const TS_HOURS_CHIPS = [8, 4, 0];
let _tsHoursPopoverEl = null;
let _tsHoursPopoverInput = null;
function _showTsHoursChips(input) {
  if (!input) return;
  if (!_tsHoursPopoverEl) {
    _tsHoursPopoverEl = document.createElement('div');
    _tsHoursPopoverEl.id = 'ts-hours-chips';
    _tsHoursPopoverEl.className = 'ts-hours-chips';
    document.body.appendChild(_tsHoursPopoverEl);
  }
  _tsHoursPopoverInput = input;
  // v3.4.83.2: use pointerdown — fires for both mouse + touch BEFORE
  // blur/focus changes, so the chip's action runs cleanly. Previous
  // touchstart preventDefault was suppressing the synthesized click on
  // iOS so the 8/4/0 chips appeared to do nothing on phone.
  _tsHoursPopoverEl.innerHTML = TS_HOURS_CHIPS.map(h =>
    '<button type="button" class="ts-hours-chip" data-h="' + h + '" ' +
    'onpointerdown="event.preventDefault();_pickTsHoursChip(' + h + ');">' + h + '</button>'
  ).join('');
  // Position below the input, clamped to viewport so the popover
  // never overflows the right edge on narrow phones. v3.4.83.1.
  const rect = input.getBoundingClientRect();
  _tsHoursPopoverEl.style.position = 'fixed';
  _tsHoursPopoverEl.style.top      = (rect.bottom + 4) + 'px';
  _tsHoursPopoverEl.style.left     = '0px';
  _tsHoursPopoverEl.style.display  = 'flex';
  // Measure now that it's laid out, then clamp horizontally.
  const margin   = 8;
  const popW     = _tsHoursPopoverEl.offsetWidth || (TS_HOURS_CHIPS.length * 48);
  let   left     = rect.left;
  if (left + popW > window.innerWidth - margin) {
    // Right-align to the input's right edge if a left-aligned popover
    // would clip; falls through to the viewport-margin clamp below.
    left = rect.right - popW;
  }
  if (left < margin) left = margin;
  if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
  _tsHoursPopoverEl.style.left = left + 'px';
}
function _hideTsHoursChips() {
  if (_tsHoursPopoverEl) _tsHoursPopoverEl.style.display = 'none';
  _tsHoursPopoverInput = null;
}
function _pickTsHoursChip(h) {
  const input = _tsHoursPopoverInput;
  if (!input) return;
  input.value = String(h);
  input.dispatchEvent(new Event('change'));
  _hideTsHoursChips();
}

// v3.4.81 — Enter-key navigation. Inside a `.ts-job` or `.ts-hrs`
// input, Enter moves down to the SAME day on the next person's row.
// Tab keeps its default behaviour (right within the row). Listener
// is attached once via delegation in renderTimesheets.
function _onTsKeydown(e) {
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (!el || !el.classList) return;
  if (!el.classList.contains('ts-job') && !el.classList.contains('ts-hrs')) return;
  e.preventDefault();
  const day  = el.dataset.day;
  const type = el.dataset.type;
  const slot = el.dataset.slot || '0';
  const row  = el.closest('tr, .ts-mday');
  if (!row) return;
  let next = row.nextElementSibling;
  // Skip group separator rows
  while (next && (next.classList.contains('ts-group-row') || next.classList.contains('ts-fillweek-row'))) next = next.nextElementSibling;
  if (!next) return;
  const target = next.querySelector(
    `input[data-day="${day}"][data-type="${type}"][data-slot="${slot}"]`
  );
  if (target) {
    target.focus();
    if (typeof target.select === 'function') target.select();
  }
}

// v3.4.79 — Day-status helper. Returns the per-day "should this cell
// accept input?" verdict by checking the roster (not the timesheet).
//   workable: true if the person is rostered to work on this day
//   leaveLabel: 'A/L', 'P/L', 'PH' etc — the actual roster code
//   tafeLabel:  'TAFE' if the person is at TAFE that day
// Falls back gracefully if scripts/roster.js helpers aren't loaded.
function _tsDayStatus(name, week, day) {
  if (typeof getPersonSchedule !== 'function') return { workable: true };
  const s = getPersonSchedule(name, week);
  const code = (s && s[day] ? s[day] : '').trim().toUpperCase();
  if (!code) return { workable: true };
  if (typeof isEducation === 'function' && isEducation(code)) {
    return { workable: false, tafeLabel: code };
  }
  if (typeof isLeave === 'function' && isLeave(code)) {
    return { workable: false, leaveLabel: code };
  }
  return { workable: true };
}

// ── Apprentice approval ───────────────────────────────────────
// Subtle chip shown in the APP badge cell. Managers can tap to
// toggle — approved/unapproved state saves to the timesheets row.
function _tsApprovalChip(name, week, entry) {
  const approved = entry && entry.approved;
  const safeName = esc(name);
  if (approved) {
    const who   = (entry.approved_by || '').trim();
    const title = who ? `Approved by ${who}` : 'Approved';
    const cursor = isManager ? 'pointer' : 'default';
    return `<span style="margin-left:5px;font-size:10px;font-weight:700;color:#16A34A;cursor:${cursor}" title="${esc(title)}" onclick="event.stopPropagation();toggleTsApproval('${safeName}','${week}')">✓</span>`;
  }
  if (!isManager) return '';
  return `<span style="margin-left:5px;font-size:11px;color:var(--ink-4);cursor:pointer;opacity:.45" title="Mark as approved" onclick="event.stopPropagation();toggleTsApproval('${safeName}','${week}')">○</span>`;
}

async function toggleTsApproval(name, week) {
  if (!isManager) return;
  const entry = getTsEntry(name, week);
  if (!entry) { showToast('No timesheet entry to approve yet'); return; }
  const nowApproved = !entry.approved;
  const who         = sessionStorage.getItem('eq_logged_in_name') || currentManagerName || '';
  entry.approved    = nowApproved;
  entry.approved_by = nowApproved ? who : null;
  entry.approved_at = nowApproved ? new Date().toISOString() : null;
  try {
    await sbFetch(
      `timesheets?name=eq.${encodeURIComponent(name)}&week=eq.${encodeURIComponent(week)}`,
      'PATCH',
      { approved: nowApproved, approved_by: entry.approved_by, approved_at: entry.approved_at },
      'return=minimal'
    );
    showToast(nowApproved ? `✓ ${name} approved` : `${name} approval removed`);
  } catch (e) {
    showToast('⚠ Approval save failed — check connection');
    entry.approved = !nowApproved;
    entry.approved_by = null;
    entry.approved_at = null;
  }
  renderTimesheets();
}

// v3.4.79 — Row status pill state. Returns an object describing what
// pill to render in the name column. Driven by the ROSTER (expected
// work days) compared against the TIMESHEET (filled hours), not just
// the count of filled cells. So someone on A/L all week reads
// "On Leave" (complete by definition — nothing to fill) instead of
// "Empty" or "Incomplete".
function _tsRowStatus(person, week, entry) {
  const workDays = ['mon','tue','wed','thu','fri'];
  let expectedCount = 0;
  let filledCount   = 0;
  let leaveCount    = 0;
  let tafeCount     = 0;
  workDays.forEach(d => {
    const st = _tsDayStatus(person.name, week, d);
    if (st.leaveLabel)         leaveCount++;
    if (st.tafeLabel)          tafeCount++;
    if (st.workable) {
      expectedCount++;
      const hrs = entry && entry[d + '_hrs'];
      const job = entry && entry[d + '_job'];
      if (job && Number(hrs) > 0) filledCount++;
    }
  });
  // All five rostered days are leave → "On Leave" (complete, nothing to do)
  if (expectedCount === 0 && leaveCount === 5) {
    return { kind: 'on-leave', icon: '🌴', label: 'On Leave', tone: 'leave' };
  }
  // All five rostered days are TAFE → unusual but handle it
  if (expectedCount === 0 && tafeCount === 5) {
    return { kind: 'tafe', icon: '🎓', label: 'TAFE Week', tone: 'tafe' };
  }
  // Some rostered days are leave/TAFE, others are workable — show partial-leave
  if (expectedCount === 0) {
    return { kind: 'on-leave', icon: '🌴', label: 'On Leave', tone: 'leave' };
  }
  if (filledCount === 0) {
    return { kind: 'empty', icon: '—', label: 'Empty', tone: 'empty' };
  }
  if (filledCount === expectedCount) {
    return { kind: 'complete', icon: '✓', label: 'Complete', tone: 'complete' };
  }
  return {
    kind: 'partial',
    icon: '⚠',
    label: filledCount + ' of ' + expectedCount,
    tone: 'partial'
  };
}

function renderTimesheets() {
  const allPeople = _getTsFilteredPeople();

  if (!allPeople.length) {
    document.getElementById('ts-content').innerHTML =
      `<div class="empty"><div class="empty-icon">👤</div><p>No matching staff found</p></div>`;
    updateTsStats();
    return;
  }

  // v3.4.82: apply the Accounts Review filter chip (All/Incomplete/
  // Over40/Under30). Filtering happens AFTER the existing search +
  // group filter (_getTsFilteredPeople), so composes cleanly.
  const _week = STATE.currentWeek;
  const _passesChip = (p) => {
    if (_tsCurrentFilter === 'all' || !_tsCurrentFilter) return true;
    const e = (STATE.timesheets || []).find(r => r.name === p.name && r.week === _week);
    const total = e ? tsTotalHrs(e) : 0;
    const hrs = ['mon','tue','wed','thu','fri'].map(d => Number((e && e[d + '_hrs']) || 0));
    const allDaysAt8Plus = hrs.every(h => h >= 8);
    const hasAnyHrs = hrs.some(h => h > 0);
    const isComplete = hasAnyHrs && allDaysAt8Plus && total >= 40;
    if (_tsCurrentFilter === 'incomplete') return !isComplete;
    if (_tsCurrentFilter === 'over40')     return total > 40;
    if (_tsCurrentFilter === 'under30')    return total < 30 && hasAnyHrs;
    return true;
  };
  const people = allPeople.filter(_passesChip);

  const week        = STATE.currentWeek;
  const weekEntries = (STATE.timesheets || []).filter(r => r.week === week);
  const hasSat      = weekEntries.some(r => r.sat_job || r.sat_hrs);
  const hasSun      = weekEntries.some(r => r.sun_job || r.sun_hrs);
  const days        = TS_DAYS.filter((_, i) =>
    i < 5 || (i === 5 && (hasSat || isManager)) || (i === 6 && (hasSun || isManager))
  );
  const dlabels = TS_LABELS.filter((_, i) =>
    i < 5 || (i === 5 && (hasSat || isManager)) || (i === 6 && (hasSun || isManager))
  );

  const disabled    = isManager ? '' : ' disabled';
  const weekDatesTs = getWeekDates(week);

  // v3.4.79: figure out which column is "today" so we can subtly
  // highlight it in the header + the column cells. Only fires when
  // viewing the current calendar week — STATE.currentWeek string
  // matches the Monday of this week.
  const _todayDayKey = (function() {
    const d   = new Date();
    const dow = d.getDay(); // 0 Sun … 6 Sat
    const map = { 1:'mon', 2:'tue', 3:'wed', 4:'thu', 5:'fri', 6:'sat', 0:'sun' };
    return map[dow];
  })();
  const _thisMondayStr = (function() {
    const d = new Date(), mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return String(mon.getDate()).padStart(2,'0') + '.' + String(mon.getMonth()+1).padStart(2,'0') + '.' + String(mon.getFullYear()).slice(-2);
  })();
  const _isThisWeek = (week === _thisMondayStr);

  // v3.4.82 — Lock banner + filter chips + by-job CSV + lock action.
  // All Accounts Review mode affordances live above the data table.
  // Filter chips persist their state per browser via localStorage.
  const _lock = _getTsLock(_week);
  let lockBannerHtml = '';
  if (_lock) {
    const _lockedAt = _lock.locked_at ? new Date(_lock.locked_at) : null;
    const _whenStr  = _lockedAt
      ? _lockedAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) +
        ' ' + _lockedAt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
      : '';
    const _reasonStr = _lock.reason ? ' — ' + esc(_lock.reason) : '';
    lockBannerHtml = `<div class="ts-lock-banner">
      <span class="ts-lock-banner-icon">🔒</span>
      <div class="ts-lock-banner-text">
        <strong>Week ${esc(_week)} is locked.</strong>
        Locked by ${esc(_lock.locked_by || 'a supervisor')}${_whenStr ? ' on ' + _whenStr : ''}${_reasonStr}.
      </div>
      ${isManager ? `
        <button class="btn btn-secondary btn-sm ts-lock-banner-action" onclick="requestTsUnlock()">Request unlock</button>
        <button class="btn btn-primary btn-sm ts-lock-banner-action" onclick="unlockCurrentWeek()" title="Unlock for editing">🔓 Unlock</button>
      ` : ''}
    </div>`;
  }

  // Filter chip row + accounts-mode action buttons. Each chip
  // updates _tsCurrentFilter and re-renders. The lock button is
  // supervisor-only and swaps label/handler depending on state.
  const _chip = (id, label, n) => {
    const active = (_tsCurrentFilter || 'all') === id;
    const cls    = 'ts-fchip' + (active ? ' ts-fchip-active' : '');
    const count  = n != null ? ` <span class="ts-fchip-count">(${n})</span>` : '';
    return `<button type="button" class="${cls}" onclick="setTsFilter('${id}')">${label}${count}</button>`;
  };
  // Counts for the chip badges (cheap — single pass).
  const _now = { all: allPeople.length, incomplete: 0, over40: 0, under30: 0 };
  allPeople.forEach(p => {
    const e = (STATE.timesheets || []).find(r => r.name === p.name && r.week === _week);
    const total = e ? tsTotalHrs(e) : 0;
    const hrs = ['mon','tue','wed','thu','fri'].map(d => Number((e && e[d + '_hrs']) || 0));
    const hasAnyHrs = hrs.some(h => h > 0);
    const allDaysAt8Plus = hrs.every(h => h >= 8);
    const isComplete = hasAnyHrs && allDaysAt8Plus && total >= 40;
    if (!isComplete)                 _now.incomplete++;
    if (total > 40)                  _now.over40++;
    if (total < 30 && hasAnyHrs)     _now.under30++;
  });

  const filterChipHtml = `<div class="ts-chip-row">
    <div class="ts-chips">
      <span class="ts-chip-label">Show</span>
      ${_chip('all',        'All',         _now.all)}
      ${_chip('incomplete', '⚠ Incomplete',_now.incomplete)}
      ${_chip('over40',     '> 40h',       _now.over40)}
      ${_chip('under30',    '< 30h',       _now.under30)}
    </div>
    <div class="ts-chip-actions">
      ${isManager
        ? (_lock
            ? '<button class="btn btn-secondary btn-sm" onclick="unlockCurrentWeek()" title="Unlock this week for editing">🔓 Unlock week</button>'
            : '<button class="btn btn-secondary btn-sm" onclick="lockCurrentWeek()" title="Lock this week from edits (accounts sign-off)">🔒 Lock week</button>')
        : ''}
      <button class="btn btn-secondary btn-sm" onclick="exportTsByJob()" title="Grouped by job number with subtotals">↓ By Job</button>
    </div>
  </div>`;

  // Empty-state when the filter chip excluded everyone. Distinct
  // from "no matching staff" (that's the search/group filter).
  if (!people.length) {
    document.getElementById('ts-content').innerHTML = lockBannerHtml + filterChipHtml +
      `<div class="empty" style="padding:40px 16px"><div class="empty-icon">${_tsCurrentFilter === 'all' ? '👤' : '🔍'}</div>
        <p>No rows match the "${esc(_tsCurrentFilter)}" filter</p>
        <button class="btn btn-secondary btn-sm" onclick="setTsFilter('all')" style="margin-top:10px">Show all</button>
      </div>`;
    updateTsStats();
    return;
  }

  // v3.4.83 — Phone view branch. At ≤768px viewport the supervisor
  // Timesheets page renders as a card-stack (one per person, days
  // nested) instead of the wide table. Same data, same handlers —
  // just a different DOM. See _renderTimesheetsMobile at end of file.
  _hookTsResizeOnce();
  if (_isPhoneViewport()) {
    _renderTimesheetsMobile({ people, week, weekDatesTs, days, dlabels, lockBannerHtml, filterChipHtml, disabled, _isThisWeek, _todayDayKey });
    updateTsStats();
    return;
  }

  // v3.4.80: Status column removed per Royce's feedback — the 4px
  // left-stripe on each row already carries the green/red/grey/purple
  // completion signal. A whole column of "— Empty" pills was redundant
  // and stole horizontal space the data inputs needed back.
  // Day-column min-width compressed 170 → 124 (job 64 + hrs 38 + plus
  // 22 + gaps + padding ≈ 130). Compact, scannable, more days fit on
  // one screen.
  let html = lockBannerHtml + filterChipHtml +
    `<div class="roster-card"><div class="ts-table-scroll"><table class="ts-table" style="width:100%">
    <thead><tr>
      <th class="ts-name-col-head">Name</th>
      <th style="min-width:46px">Group</th>
      ${dlabels.map(d => {
        const dayKey = d.toLowerCase();
        const isToday = _isThisWeek && dayKey === _todayDayKey;
        const dateIdx = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(d);
        return `<th class="center ts-day-head${isToday ? ' ts-day-today' : ''}" style="min-width:124px">${d}${isToday ? ' <span class="ts-today-dot" title="Today"></span>' : ''}<br><span style="font-size:9px;opacity:.6;font-weight:400">${weekDatesTs[dateIdx]} — Job / Hrs</span></th>`;
      }).join('')}
      <th class="center" style="min-width:54px">Total</th>
    </tr></thead><tbody>`;

  // ── Data rows ───────────────────────────────────────────────
  let lastGroup = '';
  people.forEach(p => {
    // v3.4.79: more prominent group separator — wider band, brand
    // colour stripe, larger label. Matches the Roster page's group
    // strip treatment so the two pages feel consistent.
    if (p.group !== lastGroup) {
      lastGroup = p.group;
      const icon = p.group === 'Apprentice' ? '🎓' : '🔧';
      const stripeColor = p.group === 'Apprentice' ? 'var(--purple)' : 'var(--navy-3)';
      html += `<tr class="ts-group-row"><td colspan="${days.length + 3}" style="background:var(--surface-2);border-left:5px solid ${stripeColor};font-size:12px;font-weight:700;color:var(--navy);padding:10px 14px;text-transform:uppercase;letter-spacing:.6px">${icon} ${p.group}</td></tr>`;
    }

    const entry      = getTsEntry(p.name, week);
    // Completion rule: every workable day ≥ 8h AND total ≥ 40h.
    // For apprentices, rostered TAFE days count as 8h each toward the
    // total (they're logged on the employer portal, not in this timesheet).
    const _workDays        = ['mon','tue','wed','thu','fri'];
    const _dayStats        = _workDays.map(d => _tsDayStatus(p.name, week, d));
    const _workableDays    = _workDays.filter((_, i) => _dayStats[i].workable);
    const _workableHrs     = _workableDays.map(d => Number((entry && entry[d + '_hrs']) || 0));
    const _tafeHrs         = p.group === 'Apprentice'
      ? _dayStats.filter(st => st.tafeLabel).length * 8
      : 0;
    const total            = tsTotalHrs(entry) + _tafeHrs;
    const _hasAnyHrs       = _workableHrs.some(h => h > 0);
    const _allDaysAt8Plus  = _workableHrs.every(h => h >= 8);
    const _isComplete      = _hasAnyHrs && _allDaysAt8Plus && total >= 40;
    // v3.4.79: roster-aware row status (drives the pill in the name col).
    const rowStatus       = _tsRowStatus(p, week, entry);
    const totalClass      = _isComplete ? 'ts-total-green' : (_hasAnyHrs ? 'ts-total-red' : 'ts-total-empty');
    // v3.4.79: thinner left-stripe instead of full red-background.
    // The full bg was the loudest thing on the page; users had to
    // scan around it. A 4px coloured stripe carries the same signal
    // without drowning the actual data.
    let rowStripeStyle;
    if (rowStatus.kind === 'complete') {
      rowStripeStyle = 'box-shadow:inset 4px 0 0 0 var(--green);';
    } else if (rowStatus.kind === 'on-leave' || rowStatus.kind === 'tafe') {
      rowStripeStyle = 'box-shadow:inset 4px 0 0 0 var(--purple);background:rgba(124,119,185,.04);';
    } else if (rowStatus.kind === 'empty') {
      rowStripeStyle = 'box-shadow:inset 4px 0 0 0 var(--ink-4);';
    } else {
      // partial — still attention-getting but no full-red wash
      rowStripeStyle = 'box-shadow:inset 4px 0 0 0 var(--red);background:rgba(220,38,38,.025);';
    }
    const pid        = p.name.replace(/\W/g, '_');
    const grpBadge   = p.group === 'Apprentice'
      ? '<span style="font-size:9px;font-weight:700;color:var(--purple);background:var(--purple-lt);padding:1px 5px;border-radius:3px">APP</span>'
      : '<span style="font-size:9px;font-weight:700;color:var(--navy-3);background:var(--slate-lt);padding:1px 5px;border-radius:3px">LH</span>';
    const approvalChip = p.group === 'Apprentice'
      ? _tsApprovalChip(p.name, week, entry)
      : '';
    // v3.4.80: status pill dropped — the 4px row left-stripe is the
    // signal. rowStatus.kind is still used above to pick stripe colour;
    // _tsRowStatus is otherwise unread now (kept as a public hook for
    // any future page that wants the same classification).

    // v3.4.81: per-row "Copy last week" affordance.
    const _lastWkSource = _findMostRecentEntry(p.name, week, 4);
    const _copyDisabled = !_lastWkSource || !isManager;
    const copyLastWkLink = `<button class="ts-copylastwk-btn" title="${_copyDisabled ? 'No recent week to copy from' : 'Copy from ' + _lastWkSource.week}"
        data-n="${esc(p.name)}" data-g="${p.group}"
        onclick="copyLastWeekTs(this.dataset.n, this.dataset.g)"
        ${_copyDisabled ? 'disabled' : ''}>↺ last wk</button>`;
    // v3.4.82: variance chip — small ⚠ when this week's total is
    // ≥40% above or ≤60% below the 4-week rolling average. Skipped
    // when there's not enough history. Tooltip shows the maths.
    const _variance = _tsRowVariance(p.name, week);
    const varianceChip = _variance
      ? `<span class="ts-variance-chip ts-variance-${_variance.tone}" title="This week ${_variance.thisHrs}h vs 4-week avg ${_variance.avg}h">⚠</span>`
      : '';

    html += `<tr class="ts-data-row" style="${rowStripeStyle}">
      <td class="ts-name-col" style="font-weight:600;color:var(--navy)">
        <div class="ts-name-line">
          <span class="ts-name-text">${esc(p.name)}${varianceChip}</span>
          ${copyLastWkLink}
        </div>
      </td>
      <td style="white-space:nowrap">${grpBadge}${approvalChip}</td>
      ${days.map(d => {
        // v3.4.79: mute the cell if the roster says the person is on
        // leave or at TAFE this day. Reads the existing schedule data
        // — no extra DB calls. View-only users get the same mute.
        const dayStatus = _tsDayStatus(p.name, week, d);
        if (!dayStatus.workable) {
          const muteLabel = dayStatus.tafeLabel ? '🎓 TAFE' : '🌴 ' + (dayStatus.leaveLabel || 'Leave');
          const muteTone  = dayStatus.tafeLabel ? 'ts-cell-tafe' : 'ts-cell-leave';
          return `<td class="ts-cell-muted ${muteTone}" style="padding:5px 6px;text-align:center" title="From roster — no timesheet entry needed">
            <div class="ts-mute-label">${muteLabel}</div>
          </td>`;
        }
        // v3.4.79: highlight today's column when viewing the current week.
        const isTodayCol = _isThisWeek && d === _todayDayKey;
        const todayClass = isTodayCol ? ' ts-cell-today' : '';
        const rawJob = entry && entry[d + '_job'] ? entry[d + '_job'] : '';
        const rawHrs = entry && entry[d + '_hrs'] != null ? entry[d + '_hrs'] : '';
        let job1 = '', hrs1 = '', job2 = '', hrs2 = '', isSplit = false;
        if (rawJob.includes('|')) {
          const parts = rawJob.split('|');
          const p0 = parts[0].split(':'); const p1 = parts[1].split(':');
          job1 = p0[0] || ''; hrs1 = p0[1] || ''; job2 = p1[0] || ''; hrs2 = p1[1] || ''; isSplit = true;
        } else {
          job1 = rawJob; hrs1 = rawHrs;
        }
        const pid2 = p.name.replace(/\W/g, '_') + '_' + d;
        // v3.4.81: per-day "↻ repeat" chip replaces the v3.4.80
        // "fill week →" link. Works on ANY day (not just Mon), so
        // supervisors who nail Wednesday first can fan it across the
        // rest of the row. Only shows when this cell has a job
        // number AND there's at least one other workable day to
        // repeat into. Hidden in view-only mode.
        const _hasJobThisDay = !!job1;
        const _otherWorkableExists = ['mon','tue','wed','thu','fri']
          .filter(d2 => d2 !== d)
          .some(d2 => _tsDayStatus(p.name, week, d2).workable);
        const repeatChip = (isManager && _hasJobThisDay && _otherWorkableExists)
          ? `<button class="ts-repeatday-btn" title="Repeat ${d.toUpperCase()} across the rest of the week"
                data-n="${esc(p.name)}" data-g="${p.group}" data-d="${d}"
                onclick="repeatDayAcrossTs(this.dataset.n, this.dataset.g, this.dataset.d)">↻</button>`
          : '';
        return `<td class="ts-input-cell${todayClass}" style="padding:5px 6px">
          <div class="ts-cell">
            <input class="ts-job" type="text" value="${esc(String(job1))}" placeholder="Job no."${disabled}
              data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="0"
              oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this)" onblur="_onComboboxBlur()" onchange="onTsCellChange(this)">
            <input class="ts-hrs" type="number" value="${hrs1}" placeholder="8" min="0" max="24" step="0.5"${disabled}
              data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="0"
              onfocus="_showTsHoursChips(this)" onblur="setTimeout(_hideTsHoursChips,250)"
              onchange="onTsCellChange(this)">
            <button class="ts-split-btn${isSplit ? ' active' : ''}" title="Split: add second job" aria-label="Split day into two jobs" onclick="toggleTsSplit('${pid2}',this)"${disabled ? ' disabled' : ''}>＋</button>
            ${repeatChip}
          </div>
          <div class="ts-cell ts-split-row" id="split-${pid2}" style="display:${isSplit ? 'flex' : 'none'};margin-top:3px">
            <input class="ts-job" type="text" value="${esc(String(job2))}" placeholder="Job 2"${disabled}
              data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="1"
              oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this)" onblur="_onComboboxBlur()" onchange="onTsCellChange(this)">
            <input class="ts-hrs" type="number" value="${hrs2}" placeholder="8" min="0" max="24" step="0.5"${disabled}
              data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="1"
              onfocus="_showTsHoursChips(this)" onblur="setTimeout(_hideTsHoursChips,250)"
              onchange="onTsCellChange(this)">
          </div>
        </td>`;
      }).join('')}
      <td class="ts-total-col ${totalClass}" id="tst-${pid}">${total > 0 ? total + 'h' : '—'}</td>
    </tr>`;
    // Fill-week-from-Monday banner row — shows on desktop when Mon is
    // filled and at least one workable Tue–Fri is still empty.
    const monFilled = entry && entry.mon_job && Number(entry.mon_hrs) > 0;
    const monRestEmpty = monFilled && ['tue','wed','thu','fri'].some(d2 => {
      const ds = _tsDayStatus(p.name, week, d2);
      if (!ds.workable) return false;
      return !(entry[d2 + '_job'] && Number(entry[d2 + '_hrs']) > 0);
    });
    if (isManager && monFilled && monRestEmpty) {
      html += `<tr class="ts-fillweek-row">
        <td colspan="${days.length + 3}">
          <div class="ts-fillweek-td">
            <span class="ts-fillweek-text"><span class="ts-mfillweek-icon">↻</span> Same job all week? Fill Tue–Fri with Mon (<span class="ts-mfillweek-job">${esc(String(entry.mon_job).split(':')[0])}</span>)</span>
            <button class="ts-mfillweek-btn" data-n="${esc(p.name)}" data-g="${p.group}" onclick="_armFillWeek(this)">Fill Week</button>
          </div>
        </td>
      </tr>`;
    }
  });

  html += '</tbody></table></div></div>';
  const root = document.getElementById('ts-content');
  root.innerHTML = html;
  // v3.4.81: Enter-key navigation — wire once per render via
  // delegation on the table. Tab still uses default browser behaviour
  // (right within row); Enter moves DOWN to the next person's same
  // day. Replacing the listener on each render is safe — removeEventListener
  // would need the same fn reference; cheaper just to re-set onkeydown.
  const tbl = root.querySelector('.ts-table');
  if (tbl) tbl.onkeydown = _onTsKeydown;
  updateTsStats();
}

// ── Quick fill ───────────────────────────────────────────────
// Legacy tab function — kept for backward compat, now a no-op
function setTsTab(tab) { renderTimesheets(); }

// v3.4.17: toggle the "N pending" popover above the timesheet grid.
function _togglePendingPopover() {
  const pop = document.getElementById('ts-pending-popover');
  const btn = document.getElementById('ts-pending-toggle');
  if (!pop) return;
  const open = pop.style.display !== 'none';
  pop.style.display = open ? 'none' : 'block';
  if (btn) btn.setAttribute('aria-expanded', String(!open));
}

// v3.4.18: per-row "Send reminder" button on the pending popover. Calls
// the ts-reminder edge function, which handles email transport + cooldown
// rate-limit (default 12h per person+week). Demo tenant is rejected
// before the call so we don't get a confusing edge-function error.
async function sendTsReminder(personName, week, btn) {
  if (!isManager) { showToast('Supervision access required'); return; }
  if (!personName || !week) return;

  // Demo tenant has no Supabase backend — surface this clearly.
  if (typeof TENANT === 'undefined' || !TENANT.ORG_SLUG || TENANT.ORG_SLUG === 'demo' || !SB_URL || !SB_KEY) {
    showToast('Reminder emails need a live tenant — demo mode is local-only');
    return;
  }

  const person = (STATE.people || []).find(p => p.name === personName);
  if (!person) { showToast('Person not found'); return; }
  if (!person.email) { showToast(`${personName} has no email on file`); return; }

  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const url  = SB_URL.replace(/\/$/, '') + '/functions/v1/ts-reminder';
    const sentBy = (typeof currentManagerName === 'string' && currentManagerName) ? currentManagerName : 'Supervisor';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + SB_KEY,
        'apikey':        SB_KEY,
      },
      body: JSON.stringify({
        orgSlug:    TENANT.ORG_SLUG,
        personName: personName,
        week:       week,
        sentBy:     sentBy,
      }),
    });
    let body = {};
    try { body = await resp.json(); } catch (_) { /* non-JSON */ }

    if (resp.ok && body && body.ok) {
      if (body.rateLimited) {
        const when = body.lastSentAt ? new Date(body.lastSentAt).toLocaleString() : 'recently';
        showToast(`Already reminded · last sent ${when}`);
        if (btn) { btn.disabled = true; btn.textContent = '✓ Reminded'; }
        auditLog(`Reminder skipped (cooldown ${body.cooldownHours || 12}h) — ${personName}`, 'Timesheet', personName, week);
        return;
      }
      showToast(`✓ Reminder sent to ${person.email}`);
      if (btn) { btn.disabled = true; btn.textContent = '✓ Sent'; }
      auditLog(`Sent timesheet reminder → ${person.email}`, 'Timesheet', personName, week);
      return;
    }
    const errMsg = (body && (body.error || body.detail)) || ('HTTP ' + resp.status);
    showToast('Reminder failed — ' + String(errMsg).slice(0, 120));
    if (btn) { btn.disabled = false; btn.textContent = original || 'Retry'; }
  } catch (e) {
    showToast('Reminder failed — check connection');
    if (btn) { btn.disabled = false; btn.textContent = original || 'Retry'; }
    console.warn('ts-reminder error:', e);
  }
}

// ── Stats ─────────────────────────────────────────────────────

function updateTsStats() {
  const allTs = [...STATE.people].filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire');
  const week  = STATE.currentWeek;
  let complete = 0, partial = 0, empty = 0;
  const pending = []; // v3.4.17: names of staff whose timesheets aren't complete for this week

  allTs.forEach(p => {
    const entry   = getTsEntry(p.name, week);
    const hasAny  = entry && TS_DAYS.some(d => entry[d + '_job']);
    const hasFull = entry && ['mon','tue','wed','thu','fri'].every(d => entry[d + '_job']);
    if (!hasAny)        { empty++;   pending.push({ name: p.name, status: 'empty'   }); }
    else if (hasFull)   { complete++; }
    else                { partial++; pending.push({ name: p.name, status: 'partial' }); }
  });

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('ts-stat-total',    allTs.length);
  setEl('ts-stat-complete', complete);
  setEl('ts-stat-partial',  partial);
  setEl('ts-stat-empty',    empty);

  // v3.4.17: sticky-ish progress bar above the grid
  const pb = document.getElementById('ts-progress-bar');
  if (pb) {
    const total = allTs.length;
    const pct   = total ? Math.round((complete / total) * 100) : 0;
    const barColor = pct === 100 ? 'var(--green)' : pct >= 60 ? '#F59E0B' : 'var(--red)';
    // v3.4.18: each pending row gets a "Send reminder" button. The button
    // is disabled if the person has no email on file — surfaces the gap
    // before the supervisor clicks, instead of after the edge function
    // 422s. Safe in demo mode — sendTsReminder() short-circuits.
    const _peopleByName = (STATE.people || []).reduce((m, p) => { m[p.name] = p; return m; }, {});
    const _btnStyle = (enabled) => `padding:3px 9px;border:1px solid ${enabled ? 'var(--navy)' : 'var(--ink-4)'};background:${enabled ? 'var(--navy)' : 'var(--surface-2)'};color:${enabled ? '#fff' : 'var(--ink-4)'};border-radius:6px;font-size:10px;font-weight:700;cursor:${enabled ? 'pointer' : 'not-allowed'};font-family:inherit;letter-spacing:.2px`;

    const pendingChip = pending.length
      ? `<button type="button" onclick="_togglePendingPopover()" aria-expanded="false" id="ts-pending-toggle"
            style="margin-left:10px;padding:4px 10px;border:1px solid #FECACA;background:#FEF2F2;color:var(--red);border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">
            ${pending.length} pending ▾
         </button>
         <div id="ts-pending-popover" style="display:none;margin-top:8px;padding:10px 12px;background:white;border:1px solid var(--border);border-radius:8px;max-height:320px;overflow:auto">
           <div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Timesheets pending this week</div>
           ${pending.map(x => {
             const _pp      = _peopleByName[x.name];
             const _hasMail = !!(_pp && _pp.email);
             const _btn     = _hasMail
               ? `<button type="button" onclick="sendTsReminder('${esc(x.name)}','${esc(week)}',this)" title="Email ${esc(_pp.email)}" style="${_btnStyle(true)}">Send reminder</button>`
               : `<button type="button" disabled title="No email on file" style="${_btnStyle(false)}">No email</button>`;
             return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12px">
               <span style="color:var(--ink);font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span>
               <span style="font-size:10px;font-weight:700;color:${x.status === 'empty' ? 'var(--red)' : 'var(--amber)'}">${x.status === 'empty' ? 'No data' : 'Partial'}</span>
               ${_btn}
             </div>`;
           }).join('')}
         </div>`
      : '';
    pb.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
            <span style="font-size:11px;font-weight:700;color:var(--ink-2);text-transform:uppercase;letter-spacing:.5px">This week — ${esc(week || '—')}</span>
            <span style="font-size:13px;font-weight:800;color:${barColor}">${complete} of ${total} complete (${pct}%)</span>
          </div>
          <div style="height:10px;background:var(--surface-2);border-radius:999px;overflow:hidden;border:1px solid var(--border)">
            <div style="height:100%;width:${pct}%;background:${barColor};transition:width .25s ease"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center">${pendingChip}</div>
      </div>`;
  }

  // Completion tracker — last 6 weeks
  const tracker = document.getElementById('ts-completion-tracker');
  if (!tracker || !allTs.length) return;
  const sel        = document.getElementById('globalWeek');
  const allWeeks   = [...sel.options].map(o => o.value);
  const currIdx    = allWeeks.indexOf(week);
  const startIdx   = Math.max(0, currIdx - 5);
  const trackWeeks = allWeeks.slice(startIdx, currIdx + 1);

  let html = '<div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Timesheet Completion — Recent Weeks</div>';
  html += '<div style="display:flex;gap:4px;flex-wrap:wrap">';
  trackWeeks.forEach(w => {
    let wComplete = 0;
    allTs.forEach(p => {
      const entry   = (STATE.timesheets || []).find(r => r.name === p.name && r.week === w);
      const hasFull = entry && ['mon','tue','wed','thu','fri'].every(d => entry[d + '_job']);
      if (hasFull) wComplete++;
    });
    const total = allTs.length;
    const pct   = total ? Math.round((wComplete / total) * 100) : 0;
    const isCur = w === week;
    let bg, color, border;
    if (pct === 100)   { bg = '#F0FDF4'; color = 'var(--green)'; border = '1px solid #86EFAC'; }
    else if (pct >= 50){ bg = '#FFFBEB'; color = 'var(--amber)'; border = '1px solid #FDE68A'; }
    else               { bg = '#FEF2F2'; color = 'var(--red)';   border = '1px solid #FECACA'; }
    html += `<div style="flex:1;min-width:80px;padding:8px 10px;border-radius:8px;background:${bg};border:${border};text-align:center;${isCur ? 'outline:2px solid var(--navy);outline-offset:-1px' : ''}">
      <div style="font-size:9px;color:var(--ink-3);font-weight:600">${w}</div>
      <div style="font-size:18px;font-weight:800;color:${color};margin:2px 0">${pct}%</div>
      <div style="font-size:9px;color:var(--ink-3)">${wComplete}/${total}</div>
    </div>`;
  });
  html += '</div>';
  tracker.innerHTML = html;
}

// ── Batch fill ────────────────────────────────────────────────

function openTsBatch() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const days = TS_DAYS.map((d, i) =>
    `<button class="batch-day-btn ${i < 5 ? 'on' : ''}" data-day="${d}" onclick="this.classList.toggle('on')">${TS_LABELS[i]}</button>`
  ).join('');
  document.getElementById('ts-batch-days').innerHTML = days;
  document.getElementById('ts-batch-job').value      = '';
  document.getElementById('ts-batch-hrs').value      = '8';
  document.getElementById('ts-batch-skip').checked   = true;

  // Use current filter (or all if no filter)
  const people = _getTsFilteredPeople();
  document.getElementById('ts-batch-people').innerHTML = people.map(p =>
    `<label class="batch-person-row">
      <input type="checkbox" value="${p.id}" data-name="${esc(p.name)}" data-group="${p.group}" checked onchange="updateTsBatchCount()">
      <span style="font-size:12px;font-weight:500">${esc(p.name)}</span>
      <span style="font-size:9px;color:var(--ink-3);margin-left:auto">${p.group === 'Apprentice' ? 'APP' : 'LH'}</span>
    </label>`
  ).join('');
  updateTsBatchCount();
  openModal('modal-ts-batch');
}

function updateTsBatchCount() {
  const n = document.querySelectorAll('#ts-batch-people input:checked').length;
  document.getElementById('ts-batch-count').textContent = n + ' person' + (n !== 1 ? 's' : '') + ' selected';
}
function tsBatchSelectAll()  { document.querySelectorAll('#ts-batch-people input').forEach(cb => cb.checked = true);  updateTsBatchCount(); }
function tsBatchClearAll()   { document.querySelectorAll('#ts-batch-people input').forEach(cb => cb.checked = false); updateTsBatchCount(); }

async function runTsBatch() {
  const job  = document.getElementById('ts-batch-job').value.trim().toUpperCase();
  const hrs  = parseFloat(document.getElementById('ts-batch-hrs').value) || 0;
  if (!job) { showToast('Enter a job number'); return; }
  if (!hrs) { showToast('Enter hours per day'); return; }
  const skip   = document.getElementById('ts-batch-skip').checked;
  const days   = [...document.querySelectorAll('#ts-batch-days .batch-day-btn.on')].map(b => b.dataset.day);
  if (!days.length) { showToast('Select at least one day'); return; }
  const people = [...document.querySelectorAll('#ts-batch-people input:checked')]
    .map(cb => ({ name: cb.dataset.name, group: cb.dataset.group }));
  if (!people.length) { showToast('Select at least one person'); return; }

  closeModal('modal-ts-batch');
  if (!STATE.timesheets) STATE.timesheets = [];
  const week     = STATE.currentWeek;
  let changed    = 0;
  const promises = [];

  for (const p of people) {
    let entry = STATE.timesheets.find(r => r.name === p.name && r.week === week);
    if (!entry) {
      entry = {
        name: p.name, group: p.group, week,
        mon_job: null, mon_hrs: null, tue_job: null, tue_hrs: null,
        wed_job: null, wed_hrs: null, thu_job: null, thu_hrs: null,
        fri_job: null, fri_hrs: null, sat_job: null, sat_hrs: null, sun_job: null, sun_hrs: null
      };
      STATE.timesheets.push(entry);
    }
    days.forEach(d => {
      if (skip && entry[d + '_job']) return;
      entry[d + '_job'] = job; entry[d + '_hrs'] = hrs; changed++;
    });
    const row = { name: p.name, group: p.group, week };
    TS_DAYS.forEach(d => { row[d + '_job'] = entry[d + '_job'] || null; row[d + '_hrs'] = parseFloat(entry[d + '_hrs']) || null; });
    promises.push(sbFetch('timesheets?on_conflict=name,week,org_id', 'POST', row, 'resolution=merge-duplicates,return=minimal'));
  }

  await Promise.all(promises);
  showToast('Applied to ' + changed + ' cells');
  auditLog(`Timesheet batch: ${job} / ${hrs}h`, 'Timesheet', `${changed} cells, ${people.length} staff`, STATE.currentWeek);
  renderTimesheets();
}

// ── Exports ───────────────────────────────────────────────────

function exportTsCSV() {
  const people = [...STATE.people]
    .filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire')
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const week   = STATE.currentWeek;
  const header = 'Name,Group,Week,Mon Job,Mon Hrs,Tue Job,Tue Hrs,Wed Job,Wed Hrs,Thu Job,Thu Hrs,Fri Job,Fri Hrs,Sat Job,Sat Hrs,Sun Job,Sun Hrs,Total Hrs';
  const rows   = people.map(p => {
    const e     = getTsEntry(p.name, week);
    const total = tsTotalHrs(e);
    return [p.name, p.group, week,
      e?.mon_job || '', e?.mon_hrs || '', e?.tue_job || '', e?.tue_hrs || '',
      e?.wed_job || '', e?.wed_hrs || '', e?.thu_job || '', e?.thu_hrs || '',
      e?.fri_job || '', e?.fri_hrs || '', e?.sat_job || '', e?.sat_hrs || '',
      e?.sun_job || '', e?.sun_hrs || '', total || ''
    ].map(v => `"${v}"`).join(',');
  });
  downloadCSV(header + '\n' + rows.join('\n'), 'EQ_Timesheets_' + week.replace(/\./g, '-') + '.csv');
  showToast('CSV exported');
}

function exportTsPayroll() {
  const people = [...STATE.people]
    .filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire')
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const week   = STATE.currentWeek;
  const rows   = [
    ['"EQ Solves — Field · Timesheet Report"'],
    [`"Week: ${formatWeekLabel(week)}"`], [''],
    ['"Name"', '"Group"', '"Day"', '"Job / Docket No."', '"Hours"']
  ];
  people.forEach(p => {
    const e      = getTsEntry(p.name, week);
    let hasData  = false;
    TS_DAYS.forEach((d, i) => {
      const job = e?.[d + '_job']; const hrs = e?.[d + '_hrs'];
      if (job || hrs) { rows.push([`"${p.name}"`, `"${p.group}"`, `"${TS_LABELS[i]}"`, `"${job || ''}"`, `"${hrs || ''}"`]); hasData = true; }
    });
    if (!hasData) rows.push([`"${p.name}"`, `"${p.group}"`, '"—"', '"No data"', '""']);
    rows.push(['']);
  });
  downloadCSV(rows.map(r => r.join(',')).join('\n'), 'EQ_Payroll_' + week.replace(/\./g, '-') + '.csv');
  showToast('Payroll report exported');
}

// ── Import CSV ────────────────────────────────────────────────
// Accepts the format written by exportTsCSV():
//   Name,Group,Week,Mon Job,Mon Hrs,Tue Job,Tue Hrs, ... ,Sun Hrs,Total Hrs
// Matches people by exact name, ignores unknown names, upserts per-day via saveTsCell.
// The Week column in the CSV is authoritative (can import for a week other than currentWeek).

function _parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map(v => v.trim());
}

async function importTsCSV(evt) {
  if (!isManager) { showToast('Supervision access required'); evt.target.value = ''; return; }
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;

  let text;
  try { text = await file.text(); }
  catch (e) { showToast('Could not read file'); evt.target.value = ''; return; }

  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length);
  if (lines.length < 2) { showToast('CSV is empty'); evt.target.value = ''; return; }

  const header = _parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const iName = col('name'), iGroup = col('group'), iWeek = col('week');
  if (iName < 0 || iWeek < 0) {
    showToast('CSV missing Name / Week columns');
    evt.target.value = '';
    return;
  }

  const dayCols = TS_DAYS.map((d, i) => ({
    day:  d,
    label: TS_LABELS[i],
    job:  col(TS_LABELS[i] + ' Job'),
    hrs:  col(TS_LABELS[i] + ' Hrs')
  }));

  // Summarise for confirm dialog
  const rows = lines.slice(1).map(_parseCsvLine);
  const byWeek = {};
  rows.forEach(r => {
    const w = (r[iWeek] || '').trim();
    if (!w) return;
    byWeek[w] = (byWeek[w] || 0) + 1;
  });
  const weekSummary = Object.entries(byWeek).map(([w, n]) => `${w} (${n} staff)`).join(', ');

  const proceed = window.confirm(
    'Import timesheets from CSV?\n\n' +
    rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' — ' + weekSummary + '\n\n' +
    'Existing entries for the same name+week+day will be overwritten.'
  );
  if (!proceed) { evt.target.value = ''; return; }

  const peopleByName = {};
  STATE.people.forEach(p => { peopleByName[p.name] = p; });

  let updated = 0, unknown = 0, cells = 0;
  for (const r of rows) {
    const name = (r[iName] || '').trim();
    const week = (r[iWeek] || '').trim();
    if (!name || !week) continue;
    const person = peopleByName[name];
    if (!person) { unknown++; continue; }
    const group = (iGroup >= 0 ? r[iGroup] : '') || person.group;

    let rowTouched = false;
    for (const dc of dayCols) {
      const jobRaw = dc.job >= 0 ? (r[dc.job] || '').trim() : '';
      const hrsRaw = dc.hrs >= 0 ? (r[dc.hrs] || '').trim() : '';
      if (!jobRaw && !hrsRaw) continue;
      const hrs = parseFloat(hrsRaw) || null;
      await saveTsCell(name, group, week, dc.day, jobRaw || null, hrs);
      cells++;
      rowTouched = true;
    }
    if (rowTouched) updated++;
  }

  renderTimesheets();
  const bits = [updated + ' staff updated', cells + ' cells'];
  if (unknown) bits.push(unknown + ' unknown names skipped');
  showToast('✓ Imported — ' + bits.join(', '));
  auditLog('Imported timesheet CSV — ' + bits.join(', '), 'Timesheet', '', STATE.currentWeek);

  evt.target.value = '';
}

// ── Staff self-entry ──────────────────────────────────────────

function renderStaffTs() {
  if (!staffTsMode || !staffTsPerson) return;
  const name   = staffTsPerson.name;
  const group  = staffTsPerson.group;
  const week   = STATE.currentWeek;
  const entry  = getTsEntry(name, week);
  const days   = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const labels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const weekDates = getWeekDates(week);
  const total  = tsTotalHrs(entry);
  const totalColor = total >= 38 ? 'var(--green)' : total > 0 ? 'var(--amber)' : 'var(--ink-3)';

  let html = `
    <div style="background:linear-gradient(135deg,var(--navy),var(--navy-2));border-radius:12px;padding:18px 20px;margin-bottom:20px">
      <div style="font-size:18px;font-weight:700;color:white;margin-bottom:2px">${esc(name)}</div>
      <div style="font-size:12px;color:rgba(255,255,255,.5)">${group} &nbsp;·&nbsp; ${formatWeekLabel(week)}</div>
      <div id="staff-ts-total-display" style="margin-top:10px;font-size:28px;font-weight:800;color:${totalColor}">${total > 0 ? total + 'h' : '—'} <span style="font-size:13px;font-weight:500;color:rgba(255,255,255,.6)">recorded this week</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">`;

  days.forEach((d, i) => {
    const rawJob = entry && entry[d + '_job'] ? entry[d + '_job'] : '';
    const rawHrs = entry && entry[d + '_hrs'] != null ? entry[d + '_hrs'] : '';
    let job1 = '', hrs1 = '', job2 = '', hrs2 = '', isSplit = false;
    if (rawJob.includes('|')) {
      const parts = rawJob.split('|');
      const p0 = parts[0].split(':'); const p1 = parts[1].split(':');
      job1 = p0[0] || ''; hrs1 = p0[1] || ''; job2 = p1[0] || ''; hrs2 = p1[1] || ''; isSplit = true;
    } else { job1 = rawJob; hrs1 = rawHrs; }

    const hasData = !!(job1 || hrs1);
    html += `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow-sm)">
        <div style="background:${hasData ? 'var(--navy)' : 'var(--surface-2)'};padding:10px 16px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-size:13px;font-weight:700;color:${hasData ? 'white' : 'var(--ink-2)'}">${labels[i]}</span>
            <span style="font-size:11px;color:${hasData ? 'rgba(255,255,255,.5)' : 'var(--ink-3)'};margin-left:8px">${weekDates[i]}</span>
          </div>
          <span style="font-size:11px;font-weight:700;color:${hasData ? 'rgba(255,255,255,.8)' : 'var(--ink-3)'}">${hasData ? (hrs1 || 0) + 'h recorded' : 'Not recorded'}</span>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px;align-items:flex-end">
            <div style="flex:1">
              <label style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Job / Docket No.</label>
              <input type="text" value="${esc(String(job1))}" placeholder="e.g. D5384"
                data-name="${esc(name)}" data-group="${group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="0"
                oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this);this.style.borderColor='var(--purple)'" onblur="_onComboboxBlur();this.style.borderColor='var(--border)'" onchange="onStaffTsCellChange(this)"
                style="width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:8px;font-family:monospace;font-size:13px;color:var(--ink);outline:none;transition:border-color .15s">>
            </div>
            <div style="width:80px">
              <label style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Hours</label>
              <input type="number" value="${hrs1}" placeholder="8" min="0" max="24" step="0.5"
                data-name="${esc(name)}" data-group="${group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="0"
                onchange="onStaffTsCellChange(this)"
                style="width:100%;padding:9px 8px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;text-align:center;color:var(--ink);outline:none;transition:border-color .15s"
                onfocus="this.style.borderColor='var(--purple)'" onblur="this.style.borderColor='var(--border)'">
            </div>
          </div>
          <div id="staff-split-${d}" style="display:${isSplit ? 'flex' : 'none'};gap:8px;align-items:flex-end">
            <div style="flex:1">
              <label style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Job 2</label>
              <input type="text" value="${esc(String(job2))}" placeholder="Second job"
                data-name="${esc(name)}" data-group="${group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="1"
                oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this);this.style.borderColor='var(--purple)'" onblur="_onComboboxBlur();this.style.borderColor='var(--border)'" onchange="onStaffTsCellChange(this)"
                style="width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:8px;font-family:monospace;font-size:13px;color:var(--ink);outline:none;transition:border-color .15s">>
            </div>
            <div style="width:80px">
              <label style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Hrs 2</label>
              <input type="number" value="${hrs2}" placeholder="h" min="0" max="24" step="0.5"
                data-name="${esc(name)}" data-group="${group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="1"
                onchange="onStaffTsCellChange(this)"
                style="width:100%;padding:9px 8px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;text-align:center;color:var(--ink);outline:none;transition:border-color .15s"
                onfocus="this.style.borderColor='var(--purple)'" onblur="this.style.borderColor='var(--border)'">
            </div>
          </div>
          <button onclick="toggleStaffSplit('${d}', this)"
            style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;color:var(--ink-3);cursor:pointer;font-family:inherit;align-self:flex-start;transition:all .15s"
            onmouseover="this.style.borderColor='var(--purple)';this.style.color='var(--purple)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--ink-3)'">
            ${isSplit ? '✕ Remove second job' : '＋ Split — add second job'}
          </button>
        </div>
      </div>`;
  });

  html += `</div>
    <div style="margin-top:14px;padding:12px 16px;background:var(--surface-2);border-radius:8px;border:1px solid var(--border);font-size:11px;color:var(--ink-3);line-height:1.6">
      💡 Your entries save automatically. Contact your supervisor to correct a previous week or reset your PIN.
    </div>`;
  document.getElementById('staff-ts-content').innerHTML = html;
}

function toggleStaffSplit(day, btn) {
  const row = document.getElementById('staff-split-' + day);
  if (!row) return;
  const show       = row.style.display === 'none';
  row.style.display = show ? 'flex' : 'none';
  btn.textContent  = show ? '✕ Remove second job' : '＋ Split — add second job';
  if (!show) row.querySelectorAll('input').forEach(el => { el.value = ''; onStaffTsCellChange(el); });
}

async function onStaffTsCellChange(el) {
  const { name, group, week, day } = el.dataset;
  if (!name || !day) return;
  const root  = document.getElementById('staff-ts-content');
  if (!root) return;

  const job0El = root.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="job"][data-slot="0"]`);
  const hrs0El = root.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="hrs"][data-slot="0"]`);
  const job1El = root.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="job"][data-slot="1"]`);
  const hrs1El = root.querySelector(`[data-name="${name}"][data-day="${day}"][data-type="hrs"][data-slot="1"]`);

  const job0 = job0El ? job0El.value.trim() : '';
  const hrs0 = hrs0El ? parseFloat(hrs0El.value) || 0 : 0;
  const job1 = job1El ? job1El.value.trim() : '';
  const hrs1 = hrs1El ? parseFloat(hrs1El.value) || 0 : 0;

  let combinedJob, combinedHrs;
  if (job1) { combinedJob = `${job0}:${hrs0}|${job1}:${hrs1}`; combinedHrs = hrs0 + hrs1; }
  else       { combinedJob = job0 || null;                       combinedHrs = hrs0 || null; }

  if (!STATE.timesheets) STATE.timesheets = [];
  let entry = STATE.timesheets.find(r => r.name === name && r.week === week);
  if (!entry) {
    entry = { name, group, week,
      mon_job: null, mon_hrs: null, tue_job: null, tue_hrs: null,
      wed_job: null, wed_hrs: null, thu_job: null, thu_hrs: null,
      fri_job: null, fri_hrs: null, sat_job: null, sat_hrs: null, sun_job: null, sun_hrs: null };
    STATE.timesheets.push(entry);
  }
  entry[day + '_job'] = combinedJob;
  entry[day + '_hrs'] = combinedHrs;

  const row = { name, group, week };
  TS_DAYS.forEach(d => {
    row[d + '_job'] = entry[d + '_job'] || null;
    row[d + '_hrs'] = entry[d + '_hrs'] != null ? parseFloat(entry[d + '_hrs']) || null : null;
  });
  // Only report "save failed" when sbFetch itself rejects. UI updates run in a
  // separate try so a cosmetic exception never masquerades as a failed save.
  let saveOk = true;
  try {
    await sbFetch('timesheets?on_conflict=name,week,org_id', 'POST', row, 'resolution=merge-duplicates,return=minimal');
  } catch (err) {
    saveOk = false;
    console.error('EQ[ts] staff save failed:', err);
    showToast('Save failed — check connection');
  }
  if (!saveOk) return;
  try {
    const newTotal = tsTotalHrs(entry);
    const totalEl  = document.getElementById('staff-ts-total-display');
    if (totalEl) {
      const c = newTotal >= 38 ? 'var(--green)' : newTotal > 0 ? 'var(--amber)' : 'var(--ink-3)';
      totalEl.style.color = c;
      totalEl.innerHTML   = `${newTotal > 0 ? newTotal + 'h' : '—'} <span style="font-size:13px;font-weight:500;color:rgba(255,255,255,.6)">recorded this week</span>`;
    }
  } catch (uiErr) {
    console.warn('EQ[ts] staff UI update skipped:', uiErr);
  }
}

// ── Job Numbers side panel (supervisor timesheet view) ────────

let _jobPanelOpen = false;

function toggleTsJobPanel() {
  _jobPanelOpen = !_jobPanelOpen;
  const panel = document.getElementById('ts-job-panel');
  const btn   = document.getElementById('ts-job-panel-btn');
  if (!panel) return;

  if (_jobPanelOpen) {
    panel.style.display = '';
    if (btn) { btn.textContent = '🔢 Hide Jobs'; btn.style.background = 'var(--purple-lt)'; btn.style.color = 'var(--purple)'; btn.style.borderColor = 'var(--purple)'; }
    renderTsJobPanel();
  } else {
    panel.style.display = 'none';
    if (btn) { btn.textContent = '🔢 Job Numbers'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }
  }
}

function renderTsJobPanel() {
  const container = document.getElementById('ts-job-panel-list');
  if (!container) return;

  const jobs   = (typeof jobNumbers !== 'undefined' ? jobNumbers : []).filter(j => j.status === 'Active');
  const search = (document.getElementById('ts-job-panel-search') ? document.getElementById('ts-job-panel-search').value : '').toLowerCase();
  const filtered = search ? jobs.filter(j =>
    (j.number || '').toLowerCase().includes(search) ||
    (j.description || '').toLowerCase().includes(search) ||
    (j.client || '').toLowerCase().includes(search)
  ) : jobs;

  if (!filtered.length) {
    container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-4);font-size:12px">${search ? 'No matches' : 'No active job numbers'}</div>`;
    return;
  }

  // Group by site
  const bySite = {};
  filtered.forEach(j => {
    const site = j.site_name || 'No Site';
    if (!bySite[site]) bySite[site] = [];
    bySite[site].push(j);
  });

  const siteOrder = Object.keys(bySite).sort((a, b) => a === 'No Site' ? 1 : b === 'No Site' ? -1 : a.localeCompare(b));

  let html = '';
  siteOrder.forEach(site => {
    html += `<div style="padding:6px 12px 4px;font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;background:var(--surface-2);border-bottom:1px solid var(--border)">${esc(site)}</div>`;
    bySite[site].forEach(j => {
      html += `<div style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer" onclick="copyTsJobRef('${esc(j.number)}')" onmouseover="this.style.background='var(--purple-lt)'" onmouseout="this.style.background=''">
        <div style="font-size:12px;font-weight:700;color:var(--navy);font-family:monospace">${esc(j.number)}</div>
        ${j.description ? `<div style="font-size:11px;color:var(--ink-2);margin-top:1px">${esc(j.description)}</div>` : ''}
        ${j.client ? `<div style="font-size:10px;color:var(--ink-4)">${esc(j.client)}</div>` : ''}
      </div>`;
    });
  });

  container.innerHTML = html;
}

function filterTsJobPanel() {
  renderTsJobPanel();
}

function copyTsJobRef(num) {
  // Try to fill the focused job input, fallback to clipboard
  const focused = document.activeElement;
  if (focused && focused.classList.contains('ts-job')) {
    focused.value = num;
    focused.dispatchEvent(new Event('change'));
    showToast(`✓ ${num} filled`);
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(num).then(() => showToast(`📋 Copied ${num}`));
  } else {
    showToast(`Job: ${num} — tap a job field first to fill directly`);
  }
}

// ── v3.4.83 — Phone view (supervisor) ─────────────────────────
// Below 768px viewport, renderTimesheets() delegates here. Same
// data path (getTsEntry / onTsCellChange / _onComboboxInput etc.) —
// the only difference is DOM shape: one card per person, days
// nested inside, list-then-expand interaction. Read-only schedule
// bubble (📍 known site / 📝 free-text) sits in each day header.
// Phase 4b (tappable autofill) intentionally NOT in this cut.

const TS_MOBILE_BREAKPOINT = 768;
function _isPhoneViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= TS_MOBILE_BREAKPOINT;
}

// Returns { html, isKnown, code } for a workable day's roster bubble.
// "isKnown" = the roster cell (uppercase + trim) matches an active
// job's site_name. Informational only in 4a; reserved as the gate
// for Phase 4b autofill behaviour. Leave/TAFE days return empty
// html — the parent renders the mute pill instead.
function _tsScheduleBubble(name, week, day) {
  if (typeof getPersonSchedule !== 'function') return { html: '', isKnown: false, code: '' };
  const s = getPersonSchedule(name, week);
  const raw = (s && s[day] ? String(s[day]) : '').trim();
  if (!raw) return { html: '', isKnown: false, code: '' };
  if (typeof isLeave === 'function' && isLeave(raw))     return { html: '', isKnown: false, code: raw };
  if (typeof isEducation === 'function' && isEducation(raw)) return { html: '', isKnown: false, code: raw };
  const upper = raw.toUpperCase();
  const sites = new Set(
    (typeof jobNumbers !== 'undefined' ? jobNumbers : [])
      .filter(j => j.status === 'Active' && j.site_name)
      .map(j => String(j.site_name).trim().toUpperCase())
  );
  const isKnown = sites.has(upper);
  const cls  = 'sched-bubble' + (isKnown ? '' : ' sched-bubble-freetext');
  const icon = isKnown ? '📍' : '📝';
  const html = `<span class="${cls}" data-site="${esc(upper)}" title="${isKnown ? 'Rostered site' : 'Roster cell'}"><span class="sched-bubble-icon">${icon}</span><span class="sched-bubble-text">${esc(raw)}</span></span>`;
  return { html, isKnown, code: raw };
}

// v3.4.83.1: remember which cards the user has expanded so that a
// re-render (e.g. after fillTsWeekFromMon → renderTimesheets) doesn't
// snap everyone back to collapsed.
const _tsExpandedCards = new Set();
function toggleTsCard(pid) {
  const card = document.getElementById('ts-mcard-' + pid);
  if (!card) return;
  const wasCollapsed = card.classList.contains('ts-mcard-collapsed');
  card.classList.toggle('ts-mcard-collapsed');
  if (wasCollapsed) _tsExpandedCards.add(pid);
  else              _tsExpandedCards.delete(pid);
}
function toggleTsDay(rid) {
  const row = document.getElementById('ts-mday-' + rid);
  if (row) row.classList.toggle('ts-mday-collapsed');
}
function toggleMTsSplit(rid, btn) {
  const row = document.getElementById('msplit-' + rid);
  if (!row) return;
  const show = row.style.display === 'none';
  row.style.display = show ? 'flex' : 'none';
  btn.textContent  = show ? '✕ Remove second job' : '＋ Split — add second job';
  if (show) btn.classList.add('active'); else btn.classList.remove('active');
  if (!show) row.querySelectorAll('input').forEach(el => { el.value = ''; onTsCellChange(el); });
}

function _renderTimesheetsMobile(opts) {
  const { people, week, weekDatesTs, days, dlabels, lockBannerHtml, filterChipHtml, disabled, _isThisWeek, _todayDayKey } = opts;

  let html = lockBannerHtml + filterChipHtml + '<div class="ts-mlist">';
  let lastGroup = '';

  people.forEach(p => {
    if (p.group !== lastGroup) {
      lastGroup = p.group;
      const gIcon  = p.group === 'Apprentice' ? '🎓' : '🔧';
      const stripe = p.group === 'Apprentice' ? 'var(--purple)' : 'var(--navy-3)';
      html += `<div class="ts-mgroup" style="border-left-color:${stripe}">${gIcon} ${esc(p.group)}</div>`;
    }

    const pid    = p.name.replace(/\W/g, '_');
    const entry  = getTsEntry(p.name, week);
    const _mTafeHrs = p.group === 'Apprentice'
      ? ['mon','tue','wed','thu','fri'].filter(d => _tsDayStatus(p.name, week, d).tafeLabel).length * 8
      : 0;
    const total  = tsTotalHrs(entry) + _mTafeHrs;
    const rowStatus = _tsRowStatus(p, week, entry);

    let statusIcon, statusCls, totalCls;
    if (rowStatus.kind === 'complete')        { statusIcon = '✓'; statusCls = 'complete'; totalCls = 'green'; }
    else if (rowStatus.kind === 'on-leave' || rowStatus.kind === 'tafe') { statusIcon = '🌴'; statusCls = 'leave'; totalCls = 'empty'; }
    else if (rowStatus.kind === 'empty')      { statusIcon = '—'; statusCls = 'empty';    totalCls = 'empty'; }
    else                                      { statusIcon = '⚠'; statusCls = 'partial';  totalCls = 'red'; }

    const grpBadgeCls = p.group === 'Apprentice' ? 'ts-mbadge-app' : 'ts-mbadge-lh';
    const grpBadge    = p.group === 'Apprentice' ? 'APP' : 'LH';

    const _variance    = _tsRowVariance(p.name, week);
    const varianceChip = _variance
      ? `<span class="ts-variance-chip ts-variance-${_variance.tone}" title="This week ${_variance.thisHrs}h vs 4-week avg ${_variance.avg}h">⚠</span>`
      : '';

    const _lastWkSource = _findMostRecentEntry(p.name, week, 4);
    const _copyDisabled = !_lastWkSource || !isManager;
    const copyLastWkBtn = `<button class="ts-mcard-copylast" title="${_copyDisabled ? 'No recent week to copy from' : 'Copy from ' + _lastWkSource.week}"
        data-n="${esc(p.name)}" data-g="${p.group}"
        onclick="event.stopPropagation();copyLastWeekTs(this.dataset.n, this.dataset.g)"
        ${_copyDisabled ? 'disabled' : ''}>↺ last wk</button>`;

    // v3.4.83.1: card stays expanded across re-renders if the user
    // had opened it (e.g. after Fill Week triggers a renderTimesheets).
    const cardClass = _tsExpandedCards.has(pid) ? '' : ' ts-mcard-collapsed';

    // Fill-week-from-Monday banner (v3.4.83.1). Shows when Mon is
    // fully filled and at least one workable Tue–Fri is empty.
    // Reuses the existing fillTsWeekFromMon(name, group) function
    // which handles the overwrite confirmation prompt.
    const monFilled = entry && entry.mon_job && Number(entry.mon_hrs) > 0;
    const monRestEmpty = monFilled && ['tue','wed','thu','fri'].some(d2 => {
      const ds = _tsDayStatus(p.name, week, d2);
      if (!ds.workable) return false;
      return !(entry[d2 + '_job'] && Number(entry[d2 + '_hrs']) > 0);
    });
    const fillWeekBanner = (isManager && monFilled && monRestEmpty)
      ? `<div class="ts-mfillweek">
          <div class="ts-mfillweek-text"><span class="ts-mfillweek-icon">↻</span> Same job all week? Fill Tue–Fri with Mon (<span class="ts-mfillweek-job">${esc(String(entry.mon_job).split(':')[0])}</span>)</div>
          <button class="ts-mfillweek-btn" data-n="${esc(p.name)}" data-g="${p.group}" onclick="event.stopPropagation();_armFillWeek(this)">Fill Week</button>
        </div>`
      : '';

    html += `<div class="ts-mcard${cardClass} ts-mcard-status-${statusCls}" id="ts-mcard-${pid}">
      <div class="ts-mcard-head" onclick="toggleTsCard('${pid}')">
        <span class="ts-mcard-chev">▸</span>
        <span class="ts-mcard-icon">${p.group === 'Apprentice' ? '🎓' : '🔧'}</span>
        <span class="ts-mcard-name">${esc(p.name)}${varianceChip}</span>
        <span class="ts-mcard-badge ${grpBadgeCls}">${grpBadge}</span>
        ${p.group === 'Apprentice' ? _tsApprovalChip(p.name, week, entry) : ''}
        <span class="ts-mcard-statusicon ${statusCls}">${statusIcon}</span>
        <span class="ts-mcard-total ${totalCls}">${total > 0 ? total + 'h' : '—'}</span>
      </div>
      <div class="ts-mcard-body">
        <div class="ts-mcard-meta">${copyLastWkBtn}</div>
        ${fillWeekBanner}`;

    days.forEach((d, i) => {
      const rid        = pid + '_' + d;
      const dayStatus  = _tsDayStatus(p.name, week, d);
      const isTodayCol = _isThisWeek && d === _todayDayKey;

      if (!dayStatus.workable) {
        const muteLabel = dayStatus.tafeLabel ? '🎓 TAFE' : '🌴 ' + (dayStatus.leaveLabel || 'Leave');
        const muteCls   = dayStatus.tafeLabel ? 'ts-mday-tafe' : 'ts-mday-leave';
        html += `<div class="ts-mday ts-mday-muted ${muteCls}">
          <div class="ts-mday-head">
            <span class="ts-mday-label">${dlabels[i]}</span>
            <span class="ts-mday-date">${weekDatesTs[i]}</span>
            <span class="ts-mday-spacer"></span>
            <span class="ts-mday-mutepill">${muteLabel}</span>
          </div>
        </div>`;
        return;
      }

      const rawJob = entry && entry[d + '_job'] ? entry[d + '_job'] : '';
      const rawHrs = entry && entry[d + '_hrs'] != null ? entry[d + '_hrs'] : '';
      let job1 = '', hrs1 = '', job2 = '', hrs2 = '', isSplit = false;
      if (rawJob.includes('|')) {
        const parts = rawJob.split('|');
        const p0 = parts[0].split(':'); const p1 = parts[1].split(':');
        job1 = p0[0] || ''; hrs1 = p0[1] || ''; job2 = p1[0] || ''; hrs2 = p1[1] || ''; isSplit = true;
      } else { job1 = rawJob; hrs1 = rawHrs; }

      const bubble    = _tsScheduleBubble(p.name, week, d);
      const filled    = !!(job1 && Number(hrs1) > 0);
      const collapsed = filled ? ' ts-mday-collapsed' : '';
      const statusPill = filled
        ? `<span class="ts-mday-status done">✓ ${hrs1}h</span>`
        : `<span class="ts-mday-status empty">— missing</span>`;

      const _otherWorkableExists = ['mon','tue','wed','thu','fri']
        .filter(d2 => d2 !== d)
        .some(d2 => _tsDayStatus(p.name, week, d2).workable);
      const repeatChip = (isManager && filled && _otherWorkableExists)
        ? `<button class="ts-mrepeat-btn" title="Repeat ${d.toUpperCase()} across the week"
              data-n="${esc(p.name)}" data-g="${p.group}" data-d="${d}"
              onclick="event.stopPropagation();repeatDayAcrossTs(this.dataset.n, this.dataset.g, this.dataset.d)">↻ repeat</button>`
        : '';

      const summary = filled
        ? `<div class="ts-mday-summary"><span class="ts-mday-summary-job">${esc(job1)}</span><span class="ts-mday-summary-hint"> — tap to edit</span></div>`
        : '';

      html += `<div class="ts-mday${collapsed}${isTodayCol ? ' ts-mday-today' : ''}" id="ts-mday-${rid}">
        <div class="ts-mday-head" onclick="toggleTsDay('${rid}')">
          <span class="ts-mday-label">${dlabels[i]}</span>
          <span class="ts-mday-date">${weekDatesTs[i]}</span>
          ${bubble.html}
          <span class="ts-mday-spacer"></span>
          ${statusPill}
        </div>
        ${summary}
        <div class="ts-mday-body">
          <div class="ts-minput-row">
            <div class="ts-minput-jobwrap">
              <label class="ts-minput-label">Job / Docket No.</label>
              <input class="ts-job ts-minput-field" type="text" value="${esc(String(job1))}" placeholder="Job no."${disabled}
                data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="0"
                oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this)" onblur="_onComboboxBlur()" onchange="onTsCellChange(this)">
            </div>
            <div class="ts-minput-hrswrap">
              <label class="ts-minput-label">Hours</label>
              <input class="ts-hrs ts-minput-field ts-minput-hrs" type="number" value="${hrs1}" placeholder="8" min="0" max="24" step="0.5"${disabled}
                data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="0"
                onfocus="_showTsHoursChips(this)" onblur="setTimeout(_hideTsHoursChips,250)"
                onchange="onTsCellChange(this)">
            </div>
          </div>
          <div class="ts-minput-row ts-msplit-row" id="msplit-${rid}" style="display:${isSplit ? 'flex' : 'none'}">
            <div class="ts-minput-jobwrap">
              <label class="ts-minput-label">Job 2</label>
              <input class="ts-job ts-minput-field" type="text" value="${esc(String(job2))}" placeholder="Second job"${disabled}
                data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="job" data-slot="1"
                oninput="_onComboboxInput(this)" onfocus="_onComboboxFocus(this)" onblur="_onComboboxBlur()" onchange="onTsCellChange(this)">
            </div>
            <div class="ts-minput-hrswrap">
              <label class="ts-minput-label">Hrs 2</label>
              <input class="ts-hrs ts-minput-field ts-minput-hrs" type="number" value="${hrs2}" placeholder="h" min="0" max="24" step="0.5"${disabled}
                data-name="${esc(p.name)}" data-group="${p.group}" data-week="${week}" data-day="${d}" data-type="hrs" data-slot="1"
                onfocus="_showTsHoursChips(this)" onblur="setTimeout(_hideTsHoursChips,250)"
                onchange="onTsCellChange(this)">
            </div>
          </div>
          <div class="ts-mday-actions">
            <button class="ts-msplit-btn${isSplit ? ' active' : ''}" title="Split: add second job"
              onclick="toggleMTsSplit('${rid}',this)"${disabled ? ' disabled' : ''}>${isSplit ? '✕ Remove second job' : '＋ Split — add second job'}</button>
            ${repeatChip}
          </div>
        </div>
      </div>`;
    });

    html += '</div></div>';
  });

  html += '</div>';
  const root = document.getElementById('ts-content');
  if (root) root.innerHTML = html;
}

// Single resize listener — re-renders the Timesheets page when the
// viewport crosses the phone breakpoint (rotation, window resize on
// browser dev tools). Attached once, idempotent.
let _tsResizeHooked = false;
let _tsLastViewportPhone = null;
function _hookTsResizeOnce() {
  if (_tsResizeHooked) return;
  _tsResizeHooked = true;
  _tsLastViewportPhone = _isPhoneViewport();
  window.addEventListener('resize', () => {
    const nowPhone = _isPhoneViewport();
    if (nowPhone === _tsLastViewportPhone) return;
    _tsLastViewportPhone = nowPhone;
    if (document.getElementById('ts-content')) renderTimesheets();
  });
}