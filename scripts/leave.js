/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/leave.js  —  EQ Solves Field
// Leave requests: submit, approve/reject, calendar, email,
// CC list, print, clear, badge, schedule write-back.
// Depends on: app-state.js, utils.js, supabase.js, roster.js
// ─────────────────────────────────────────────────────────────

// ── Module state ─────────────────────────────────────────────
let leaveRequests = [];
let leaveMode     = 'range';
let pickedDays    = [];
let leaveCCList   = [];
let leaveViewMode = 'list';
let leaveCalMonth = new Date().getMonth();
let leaveCalYear  = new Date().getFullYear();

// v3.4.54: per-id inflight guard for leave mutations. Prevents
// double-tap on iPad / accidental double-click from firing
// archive/unarchive/respond twice — which had been producing
// duplicate audit-log entries (see BATTLE-TEST finding #24,
// confirmed in EQ Supabase audit_log) and would also send
// duplicate approval emails to the requester via respondLeave.
const _leaveInflight = new Set();

// ── Load / save CC list ───────────────────────────────────────

async function loadLeaveCCList() {
  try {
    const rows = await sbFetch('app_config?key=eq.leave_cc_list&select=value');
    if (rows && rows[0] && rows[0].value) {
      try {
        const parsed = JSON.parse(rows[0].value);
        leaveCCList = Array.isArray(parsed) ? parsed : [];
      } catch (pe) {
        console.warn('leave_cc_list in Supabase is malformed JSON — falling back');
        leaveCCList = [];
      }
    }
  } catch (e) {
    // v3.4.4 (L4): guard the localStorage fallback parse — malformed cache
    // used to crash the page. Now degrades to an empty list.
    try {
      const parsed = JSON.parse(localStorage.getItem('eq_leave_cc') || '[]');
      leaveCCList = Array.isArray(parsed) ? parsed : [];
    } catch (pe) {
      console.warn('eq_leave_cc localStorage malformed — resetting to empty list');
      leaveCCList = [];
    }
  }
}

async function saveLeaveCCList() {
  // v3.4.40: PATCH on a non-existent app_config row returns 204 No Content
  // (not an error) — the previous catch-only fallback meant the save
  // silently no-op'd and the CC list reset on next page load. Mirror the
  // PATCH-then-POST pattern from scripts/tafe.js saveTafeHolidays.
  // NOTE: stored key is the literal 'leave_cc_list' — the 'eq.' in the
  // PATCH query string is a PostgREST filter operator, not a namespace.
  const payload = JSON.stringify(leaveCCList);
  try {
    const res = await sbFetch('app_config?key=eq.leave_cc_list', 'PATCH', { value: payload });
    if (!res || (Array.isArray(res) && res.length === 0)) {
      await sbFetch('app_config', 'POST', { key: 'leave_cc_list', value: payload });
    }
    try { localStorage.setItem('eq_leave_cc', payload); } catch (e) {}
  } catch (e) {
    try { localStorage.setItem('eq_leave_cc', payload); } catch (e2) {}
  }
}

function openLeaveCCConfig() {
  if (!isManager) { showToast('Supervision access required'); return; }
  renderLeaveCCList();
  renderLeaveCCSupervisors();
  openModal('modal-leave-cc');
}

// v3.4.5 (L10): quick-pick supervisors from the managers list — saves typing
// emails for the common case of CC'ing other supervisors on leave threads.
// Chips toggle in/out of the CC list; 'in' chips show a ✓ and highlight.
function renderLeaveCCSupervisors() {
  const el = document.getElementById('leave-cc-supervisors');
  if (!el) return;
  const mgrs = (STATE.managers || [])
    .filter(m => m && m.email)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!mgrs.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--ink-4);padding:4px 0">No supervisors with emails on file yet — add an email on the Supervisors tab.</div>';
    return;
  }
  el.innerHTML = mgrs.map(m => {
    const email  = m.email.toLowerCase();
    const inList = leaveCCList.includes(email);
    const bg     = inList ? 'var(--purple)'  : 'var(--surface-2)';
    const col    = inList ? '#fff'           : 'var(--ink-2)';
    const border = inList ? 'var(--purple)'  : 'var(--border)';
    const icon   = inList ? '✓' : '+';
    const safeEmail = email.replace(/'/g, '&#39;');
    const tip = `${m.name}${m.role ? ' — ' + m.role : ''} · ${m.email}`;
    return `<button onclick="toggleLeaveCCSupervisor('${safeEmail}')" title="${esc(tip)}" style="background:${bg};color:${col};border:1px solid ${border};padding:4px 10px;border-radius:14px;font-size:11px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px"><span style="font-weight:800">${icon}</span>${esc(m.name)}</button>`;
  }).join('');
}

function toggleLeaveCCSupervisor(email) {
  if (!email) return;
  const lower = String(email).toLowerCase();
  const idx   = leaveCCList.indexOf(lower);
  if (idx >= 0) {
    leaveCCList.splice(idx, 1);
    showToast(`${lower} removed from CC`);
  } else {
    leaveCCList.push(lower);
    showToast(`${lower} added to CC`);
  }
  saveLeaveCCList();
  renderLeaveCCList();
  renderLeaveCCSupervisors();
}

function renderLeaveCCList() {
  const el = document.getElementById('leave-cc-list');
  if (!leaveCCList.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:8px 0">No CC recipients configured yet.</div>';
    return;
  }
  el.innerHTML = leaveCCList.map((email, i) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
      <span style="flex:1;font-size:12px;color:var(--ink)">${esc(email)}</span>
      <button onclick="removeLeaveCC(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:0">✕</button>
    </div>`
  ).join('');
}

function addLeaveCC() {
  const input = document.getElementById('leave-cc-new');
  const email = input.value.trim().toLowerCase();
  if (!email || !email.includes('@')) { showToast('Enter a valid email'); return; }
  if (leaveCCList.includes(email)) { showToast('Already in the list'); return; }
  leaveCCList.push(email);
  saveLeaveCCList();
  input.value = '';
  renderLeaveCCList();
  renderLeaveCCSupervisors();
  showToast(`${email} added to CC list`);
}

function removeLeaveCC(idx) {
  const removed = leaveCCList.splice(idx, 1);
  saveLeaveCCList();
  renderLeaveCCList();
  renderLeaveCCSupervisors();
  showToast(`${removed} removed`);
}

// ── Load from Supabase ────────────────────────────────────────

let showArchivedLeave = false;

async function loadLeaveRequests() {
  try {
    const archiveFilter = showArchivedLeave ? '' : '&archived=eq.false';
    leaveRequests = await sbFetch('leave_requests?select=*&order=created_at.desc' + archiveFilter);
  } catch (e) {
    leaveRequests = [];
  }
  updateLeaveBadge();
}

function updateLeaveBadge() {
  const pending = leaveRequests.filter(r => r.status === 'Pending').length;
  const badge   = document.getElementById('badge-leave');
  if (badge) {
    badge.textContent    = pending;
    badge.style.display  = pending > 0 ? '' : 'none';
  }
}

// ── Date helpers ──────────────────────────────────────────────

function getWeekForDate(date) {
  const mon = new Date(date);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const dd = String(mon.getDate()).padStart(2, '0');
  const mm = String(mon.getMonth() + 1).padStart(2, '0');
  const yy = String(mon.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

// ── Submit ────────────────────────────────────────────────────

function setLeaveMode(mode) {
  leaveMode = mode;
  document.getElementById('leave-range-fields').style.display = mode === 'range' ? '' : 'none';
  document.getElementById('leave-pick-fields').style.display  = mode === 'pick'  ? '' : 'none';
  document.getElementById('leave-mode-range').className = mode === 'range' ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
  document.getElementById('leave-mode-pick').className  = mode === 'pick'  ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
}

function addPickedDay() {
  const val = document.getElementById('leave-pick-date').value;
  if (!val || pickedDays.includes(val)) return;
  pickedDays.push(val);
  pickedDays.sort();
  renderPickedDays();
  document.getElementById('leave-pick-date').value = '';
}

function removePickedDay(d) {
  pickedDays = pickedDays.filter(x => x !== d);
  renderPickedDays();
}

function renderPickedDays() {
  const el = document.getElementById('leave-picked-list');
  if (!pickedDays.length) { el.innerHTML = '<span style="font-size:11px;color:var(--ink-3)">No days selected</span>'; return; }
  el.innerHTML = pickedDays.map(d => {
    const dt    = new Date(d + 'T00:00:00');
    const label = dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--purple-lt);color:var(--navy);font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px">${label}<button onclick="removePickedDay('${d}')" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:12px;padding:0 0 0 2px">✕</button></span>`;
  }).join('');
}

function openLeaveRequest() {
  const pSel   = document.getElementById('leave-person');

  // Merge staff (STATE.people) + supervisors (STATE.managers) so
  // supervisors can also submit leave requests. Dedupe by name.
  const peopleList = (STATE.people || []).map(p => ({
    name:  p.name,
    group: p.group || ''
  }));
  const supervisorList = (STATE.managers || []).map(m => ({
    name:  m.name,
    group: 'Supervisor'
  }));
  const byName = new Map();
  [...peopleList, ...supervisorList].forEach(x => {
    if (!byName.has(x.name)) byName.set(x.name, x);
  });
  const combined = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  pSel.innerHTML = '<option value="">— Select your name —</option>' +
    combined.map(p => {
      const suffix = p.group === 'Supervisor' ? ' — Supervisor' : '';
      return `<option value="${esc(p.name)}">${esc(p.name)}${suffix}</option>`;
    }).join('');

  // v3.4.5 (L8): supervisor picker is rebuilt via _populateLeaveApprovers so
  // we can re-filter when the requester picks themselves (you can't approve
  // your own request, so don't list yourself as an option).
  _populateLeaveApprovers('');
  pSel.onchange = function () { _populateLeaveApprovers(this.value); };

  document.getElementById('leave-type').value  = 'A/L';
  document.getElementById('leave-start').value = '';
  document.getElementById('leave-end').value   = '';
  document.getElementById('leave-note').value  = '';
  // Clear any leftover red highlight from a prior failed submit
  const aSelClear = document.getElementById('leave-approver');
  if (aSelClear) aSelClear.style.borderColor = '';
  pickedDays = [];
  setLeaveMode('range');
  renderPickedDays();
  document.getElementById('leave-modal-title').textContent = 'New Leave Request';
  openModal('modal-leave-request');
}

// v3.4.5 (L8): rebuild the supervisor dropdown with optional self-exclusion.
// Preserves the current selection if it's still a valid manager.
function _populateLeaveApprovers(excludeName) {
  const aSel = document.getElementById('leave-approver');
  if (!aSel) return;
  const current = aSel.value;
  const mgrs = [...(STATE.managers || [])]
    .filter(m => m.name !== excludeName)
    .sort((a, b) => a.name.localeCompare(b.name));
  aSel.innerHTML = '<option value="">— Select your supervisor —</option>' +
    mgrs.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.role ? ' — ' + m.role : ''}</option>`).join('');
  if (current && mgrs.some(m => m.name === current)) aSel.value = current;
}

async function submitLeaveRequest() {
  const name     = document.getElementById('leave-person').value;
  const type     = document.getElementById('leave-type').value;
  const approver = document.getElementById('leave-approver').value;
  const note     = document.getElementById('leave-note').value.trim();

  if (!name) { showToast('Select your name'); return; }
  // v3.4.5 (L8): hard-stop with a visible red highlight when no supervisor is
  // chosen. The plain toast was being missed and people were submitting with
  // an unset approver — meaning the request reached no one for approval.
  if (!approver) {
    const aSel = document.getElementById('leave-approver');
    if (aSel) {
      aSel.style.borderColor = 'var(--red)';
      aSel.style.boxShadow   = '0 0 0 3px rgba(220,38,38,.15)';
      try { aSel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      try { aSel.focus(); } catch (e) {}
      setTimeout(() => { aSel.style.borderColor = ''; aSel.style.boxShadow = ''; }, 4000);
    }
    showToast('⚠ Choose your supervisor — they need to approve this request');
    return;
  }

  let dateStart, dateEnd, individualDays = null;
  if (leaveMode === 'range') {
    dateStart = document.getElementById('leave-start').value;
    dateEnd   = document.getElementById('leave-end').value;
    if (!dateStart || !dateEnd) { showToast('Select start and end dates'); return; }
    if (dateEnd < dateStart)    { showToast('End date must be after start date'); return; }
  } else {
    if (!pickedDays.length) { showToast('Pick at least one day'); return; }
    dateStart     = pickedDays[0];
    dateEnd       = pickedDays[pickedDays.length - 1];
    individualDays = pickedDays;
  }

  // LEV-002: Overlap check
  const newStart = new Date(dateStart + 'T00:00:00');
  const newEnd   = new Date(dateEnd   + 'T00:00:00');
  const overlap  = leaveRequests.find(r => {
    if (r.requester_name !== name) return false;
    if (r.status !== 'Pending' && r.status !== 'Approved') return false;
    const rS = new Date(r.date_start + 'T00:00:00');
    const rE = new Date(r.date_end   + 'T00:00:00');
    return newStart <= rE && newEnd >= rS;
  });
  if (overlap) {
    showToast(`⚠ ${name} already has ${overlap.status.toLowerCase()} leave for ${overlap.date_start} to ${overlap.date_end}`);
    return;
  }

  const row = {
    requester_name:  name,
    leave_type:      type,
    date_start:      dateStart,
    date_end:        dateEnd,
    individual_days: individualDays,
    note:            note || null,
    approver_name:   approver,
    status:          'Pending'
  };

  // v3.4.5 (L13): Backdated-leave guard — if the start date is earlier than
  // today, ask for confirmation before inserting. Prevents accidental submits
  // when the date picker was left on a stale value.
  // v3.4.15 (L16): local date, not UTC — see _toLocalIso note.
  const todayIso = _toLocalIso(new Date());
  if (dateStart < todayIso) {
    document.getElementById('confirm-title').textContent = 'Backdated Leave Request';
    document.getElementById('confirm-msg').textContent =
      `This leave starts on ${dateStart}, which is in the past. Continue submitting a backdated request?`;
    document.getElementById('confirm-action').textContent = 'Submit Anyway';
    document.getElementById('confirm-action').onclick = async () => {
      closeModal('modal-confirm');
      await _performLeaveSubmit(row);
    };
    openModal('modal-confirm');
    return;
  }

  await _performLeaveSubmit(row);
}

// v3.4.5 (L13): extracted so the backdated-leave confirm path and the normal
// path share a single submit implementation.
async function _performLeaveSubmit(row) {
  try {
    const res = await sbFetch('leave_requests', 'POST', row, 'return=representation');
    closeModal('modal-leave-request');
    showToast('Leave request submitted');
    auditLog(`Leave request: ${row.requester_name} ${row.leave_type} ${row.date_start} to ${row.date_end}`, 'Leave', row.approver_name, null);
    const saved = res[0] || row;
    // v3.4.4 (L2): no longer swallow email failures — approver needs to know
    // notification didn't reach them.
    triggerLeaveEmail('new_request', saved).catch(e => {
      console.error('Leave email trigger failed:', e);
      showToast('⚠ Request saved but approver email failed — tap 📧 Resend');
    });
    // v3.4.5 (L15): confirmation email to requester so they have a receipt.
    triggerLeaveEmail('submit_confirmation', saved).catch(e => {
      console.error('Leave confirmation email failed:', e);
    });
    await loadLeaveRequests();
    renderLeave();

    // Analytics — fire after successful submit so failed submits don't
    // pollute the funnel. days_requested covers both the range path
    // (inclusive day count) and the picked-days path (array length).
    try {
      if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
        var daysRequested;
        if (Array.isArray(row.individual_days)) {
          daysRequested = row.individual_days.length;
        } else {
          var _s = new Date(row.date_start + 'T00:00:00');
          var _e = new Date(row.date_end   + 'T00:00:00');
          daysRequested = Math.floor((_e - _s) / 86400000) + 1;
        }
        window.EQ_ANALYTICS.events.leaveRequestSubmitted({
          leave_type:     row.leave_type,
          days_requested: daysRequested,
        });
      }
    } catch (e) { /* never break app */ }
  } catch (e) {
    showToast('Failed to submit — check connection');
  }
}

// ── Review / respond ──────────────────────────────────────────

function openLeaveRespond(id) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const req = leaveRequests.find(r => String(r.id) === String(id));
  if (!req) return;

  document.getElementById('leave-respond-id').value    = id;
  document.getElementById('leave-response-note').value = '';

  const ds  = new Date(req.date_start + 'T00:00:00');
  const de  = new Date(req.date_end   + 'T00:00:00');
  const fmt = d => d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  let datesHtml;
  if (req.individual_days && req.individual_days.length) {
    datesHtml = req.individual_days
      .map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }))
      .join(', ');
  } else {
    datesHtml = `${fmt(ds)} → ${fmt(de)}`;
  }

  let bizDays = 0;
  if (req.individual_days && req.individual_days.length) {
    bizDays = req.individual_days.length;
  } else {
    const d = new Date(ds);
    while (d <= de) { if (d.getDay() !== 0 && d.getDay() !== 6) bizDays++; d.setDate(d.getDate() + 1); }
  }

  const typeLabels = { 'A/L': 'Annual Leave', 'U/L': 'Unpaid Leave', 'RDO': 'RDO' };

  document.getElementById('leave-respond-detail').innerHTML = `
    <div style="background:var(--surface-2);border-radius:10px;padding:16px;border:1px solid var(--border)">
      <div style="font-size:16px;font-weight:700;color:var(--navy);margin-bottom:8px">${esc(req.requester_name)}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">
        <div><span style="font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px">Type</span><br><span style="font-weight:600">${typeLabels[req.leave_type] || req.leave_type}</span></div>
        <div><span style="font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px">Days</span><br><span style="font-weight:600">${bizDays} day${bizDays !== 1 ? 's' : ''}</span></div>
      </div>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:4px">${datesHtml}</div>
      ${req.note ? `<div style="font-size:12px;color:var(--ink-3);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">📝 ${esc(req.note)}</div>` : ''}
      <div style="font-size:10px;color:var(--ink-4);margin-top:8px">Requested: ${new Date(req.created_at).toLocaleString('en-AU')}</div>
    </div>`;

  openModal('modal-leave-respond');
}

async function respondLeave(status) {
  if (!isManager) { showToast('Supervision access required'); return; }
  // BUG-014 FIX: read id exactly once
  // v3.4.21: id is a uuid string — do NOT parseInt (was producing NaN on uuid, silent fail)
  const id   = document.getElementById('leave-respond-id').value;
  const note = document.getElementById('leave-response-note').value.trim();
  const req  = leaveRequests.find(r => String(r.id) === String(id));

  // A01-04: Block self-approval
  if (req && req.requester_name === currentManagerName && status === 'Approved') {
    showToast('⚠ You cannot approve your own leave request. Ask another supervisor.');
    return;
  }
  if (!req) return;

  // v3.4.5 (L12): Require a reason when rejecting so the requester gets context.
  if (status === 'Rejected' && !note) {
    const noteEl = document.getElementById('leave-response-note');
    if (noteEl) {
      noteEl.style.borderColor = 'var(--red)';
      noteEl.style.boxShadow   = '0 0 0 3px rgba(220,38,38,.15)';
      try { noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      try { noteEl.focus(); } catch (e) {}
      setTimeout(() => { noteEl.style.borderColor = ''; noteEl.style.boxShadow = ''; }, 4000);
    }
    showToast('⚠ Add a reason when rejecting — the requester will see this');
    return;
  }

  // v3.4.54: per-id inflight guard. Without this, an iPad double-tap on
  // Approve fires respondLeave twice — both PATCHes go through (idempotent
  // server-side after the first), but each one writes a separate audit-log
  // entry AND triggers a separate email to the requester. Confirmed in EQ
  // Supabase audit_log: duplicate "Archived leave" entries 686ms apart
  // (BATTLE-TEST finding #24).
  const lockKey = String(id);
  if (_leaveInflight.has(lockKey)) return;
  _leaveInflight.add(lockKey);

  try {
    await sbFetch(`leave_requests?id=eq.${id}`, 'PATCH', {
      status:         status,
      response_note:  note || null,
      responded_by:   currentManagerName,
      responded_at:   new Date().toISOString()
    });
    // v3.4.35: track approval / rejection for the weekly leave-flow read.
    if (window.EQ_ANALYTICS && EQ_ANALYTICS.events) {
      if (status === 'Approved') {
        const _days = (req.date_start && req.date_end)
          ? (Math.round((new Date(req.date_end) - new Date(req.date_start)) / 86400000) + 1)
          : null;
        EQ_ANALYTICS.events.leaveApproved({ leave_id: id, leave_type: req.leave_type, days: _days });
      } else if (status === 'Rejected') {
        EQ_ANALYTICS.events.leaveRejected({ leave_id: id, leave_type: req.leave_type });
      }
    }

    if (status === 'Approved') {
      // LEV-003: Warn about roster conflicts
      const leaveDates = _getLeaveDates(req);
      const conflicts  = [];
      leaveDates.forEach(ds => {
        const weekStr = getWeekForDate(new Date(ds + 'T00:00:00'));
        const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(ds + 'T00:00:00').getDay()];
        const sched   = STATE.schedule.find(r => r.name === req.requester_name && r.week === weekStr);
        if (sched && sched[dayName] && !isLeave(sched[dayName])) {
          conflicts.push(sched[dayName] + ' on ' + ds);
        }
      });
      if (conflicts.length) {
        showToast('⚠ Overwriting roster entries: ' + conflicts.slice(0, 3).join(', ') + (conflicts.length > 3 ? '…' : ''));
      }
      await writeLeaveToSchedule(req);
    }

    closeModal('modal-leave-respond');
    showToast(`Leave ${status.toLowerCase()} for ${req.requester_name}`);
    auditLog(`Leave ${status}: ${req.requester_name} ${req.leave_type}`, 'Leave', `${req.date_start} to ${req.date_end}`, null);
    const updatedReq = { ...req, status, response_note: note || null, responded_by: currentManagerName };
    // v3.4.4 (L2): surface email failure so staff notification gaps are visible.
    triggerLeaveEmail('status_update', updatedReq).catch(e => {
      console.error('Leave status email failed:', e);
      showToast(`⚠ ${status} recorded but requester email failed`);
    });
    await loadLeaveRequests();
    renderLeave();
  } catch (e) {
    showToast('Failed — check connection');
  } finally {
    _leaveInflight.delete(lockKey);            // v3.4.54: release per-id lock
  }
}

// v3.4.15 (L16, ported from SKS main v3.4.9): format as LOCAL YYYY-MM-DD,
// not UTC. The old `d.toISOString().slice(0,10)` shifted dates back one day
// in AEST/AEDT because midnight-local is still the previous calendar day in
// UTC. Symptom on SKS prod: an approved RDO for Friday 24/04 landed on
// Thursday 23/04 in the roster.
function _toLocalIso(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function _getLeaveDates(req) {
  if (req.individual_days && req.individual_days.length) return req.individual_days;
  const dates = [];
  const d     = new Date(req.date_start + 'T00:00:00');
  const end   = new Date(req.date_end   + 'T00:00:00');
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.push(_toLocalIso(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

async function writeLeaveToSchedule(req) {
  // Supervisors aren't on the roster — the leave request itself is
  // the record of record for them. Skip the schedule write-back.
  const isOnRoster = (STATE.people || []).some(p => p.name === req.requester_name);
  if (!isOnRoster) return;

  const dates = _getLeaveDates(req);
  const byWeek = {};
  dates.forEach(ds => {
    const dt     = new Date(ds + 'T00:00:00');
    const wk     = getWeekForDate(dt);
    const dayIdx = (dt.getDay() + 6) % 7;
    const dayKey = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][dayIdx];
    if (!byWeek[wk]) byWeek[wk] = [];
    byWeek[wk].push(dayKey);
  });

  for (const [week, dayKeys] of Object.entries(byWeek)) {
    // v3.4.20 (L18): pre-push a local schedule entry BEFORE the per-day save loop.
    // If the push is left until afterward, the first saveCellToSB call finds no
    // STATE.schedule row → takes the POST path and stamps id/updated_at onto a
    // local `existing` var that never makes it into STATE.schedule. Subsequent
    // day calls then look up STATE.schedule.find, get undefined, fall through
    // the `_sbPendingRows` await branch and silently return without patching.
    // Symptom on SKS prod: Ross requested 3 weekdays of leave on a week where
    // his schedule row didn't exist yet; only day 1 landed in the roster.
    let entry = STATE.schedule.find(r => r.name === req.requester_name && r.week === week);
    if (!entry) {
      entry = { name: req.requester_name, week, mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' };
      STATE.schedule.push(entry);
      if (STATE.scheduleIndex) STATE.scheduleIndex[`${req.requester_name}||${week}`] = entry;
    }

    for (const day of dayKeys) {
      await saveCellToSB(req.requester_name, week, day, req.leave_type);
    }

    dayKeys.forEach(d => { entry[d] = req.leave_type; });
    if (STATE.scheduleIndex) STATE.scheduleIndex[`${req.requester_name}||${week}`] = entry;
  }
}

// ── Archive ──────────────────────────────────────────────────
// Archiving hides leave requests from the default view but does
// NOT touch the roster/schedule — approved leave stays on the grid.

async function archiveLeaveRequest(id) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const req = leaveRequests.find(r => String(r.id) === String(id));
  if (!req) return;
  if (req.archived === true) return;          // v3.4.54: already archived
  const lockKey = String(id);
  if (_leaveInflight.has(lockKey)) return;    // v3.4.54: in-flight from prior click
  _leaveInflight.add(lockKey);
  try {
    await sbFetch(`leave_requests?id=eq.${id}`, 'PATCH', { archived: true });
    req.archived = true;
    if (!showArchivedLeave) leaveRequests = leaveRequests.filter(r => r.id !== id);
    updateLeaveBadge();
    renderLeave();
    showToast(`${req.requester_name} leave archived`);
    auditLog(`Archived leave: ${req.requester_name} ${req.leave_type}`, 'Leave', `${req.date_start} to ${req.date_end}`, null);
  } catch (e) {
    showToast('Archive failed — check connection');
  } finally {
    _leaveInflight.delete(lockKey);
  }
}

async function unarchiveLeaveRequest(id) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const req = leaveRequests.find(r => String(r.id) === String(id));
  if (!req) return;
  if (req.archived !== true) return;          // v3.4.54: already not archived
  const lockKey = String(id);
  if (_leaveInflight.has(lockKey)) return;    // v3.4.54
  _leaveInflight.add(lockKey);
  try {
    await sbFetch(`leave_requests?id=eq.${id}`, 'PATCH', { archived: false });
    req.archived = false;
    updateLeaveBadge();
    renderLeave();
    showToast(`${req.requester_name} leave restored`);
  } catch (e) {
    showToast('Restore failed — check connection');
  } finally {
    _leaveInflight.delete(lockKey);
  }
}

// v3.4.5 (L14): Withdraw a pending request. Available to the requester
// themselves (matched via the auth-set sessionStorage name) or any supervisor.
// Uses modal-confirm so people can't tap past it by accident on a small screen.
async function withdrawLeaveRequest(id) {
  const req = leaveRequests.find(r => String(r.id) === String(id));
  if (!req) return;
  if (req.status !== 'Pending') { showToast('Only pending requests can be withdrawn'); return; }
  const loggedInName = sessionStorage.getItem('eq_logged_in_name') || '';
  if (!(isManager || loggedInName === req.requester_name)) {
    showToast('Only the requester or a supervisor can withdraw this request');
    return;
  }

  document.getElementById('confirm-title').textContent = 'Withdraw Leave Request';
  document.getElementById('confirm-msg').textContent =
    `Withdraw ${req.requester_name}'s leave request for ${req.date_start} to ${req.date_end}? The approver will no longer see it as pending.`;
  document.getElementById('confirm-action').textContent = 'Withdraw';
  document.getElementById('confirm-action').onclick = async () => {
    closeModal('modal-confirm');
    try {
      await sbFetch(`leave_requests?id=eq.${id}`, 'PATCH', {
        status:        'Withdrawn',
        responded_by:  loggedInName || currentManagerName || req.requester_name,
        responded_at:  new Date().toISOString()
      });
      showToast(`Leave withdrawn for ${req.requester_name}`);
      auditLog(`Leave withdrawn: ${req.requester_name} ${req.leave_type}`, 'Leave', `${req.date_start} to ${req.date_end}`, null);
      await loadLeaveRequests();
      renderLeave();
    } catch (e) {
      showToast('Withdraw failed — check connection');
    }
  };
  openModal('modal-confirm');
}

function confirmArchiveAllResolved() {
  if (!isManager) { showToast('Supervision access required'); return; }
  // v3.4.5 (L14): Withdrawn joins Approved/Rejected as a "resolved" state for
  // the bulk-archive sweep — otherwise withdrawn requests linger in the list.
  const resolved = leaveRequests.filter(r => (r.status === 'Approved' || r.status === 'Rejected' || r.status === 'Withdrawn') && !r.archived);
  if (!resolved.length) { showToast('No resolved requests to archive'); return; }
  document.getElementById('confirm-title').textContent = 'Archive Resolved Requests';
  document.getElementById('confirm-msg').textContent =
    `Archive ${resolved.length} resolved request${resolved.length !== 1 ? 's' : ''} (Approved + Rejected + Withdrawn)? They'll be hidden from this view but preserved for records. The roster is not affected.`;
  document.getElementById('confirm-action').textContent = 'Archive';
  document.getElementById('confirm-action').onclick = async () => {
    // v3.4.4 (L5): track per-row success/failure so a single network blip
    // doesn't silently strand the rest of the batch.
    let ok = 0, failed = 0;
    for (const r of resolved) {
      try {
        await sbFetch(`leave_requests?id=eq.${r.id}`, 'PATCH', { archived: true });
        ok++;
      } catch (e) {
        failed++;
        console.error('Archive failed for id', r.id, e);
      }
    }
    closeModal('modal-confirm');
    await loadLeaveRequests();
    renderLeave();
    if (failed === 0) {
      showToast(`${ok} request${ok !== 1 ? 's' : ''} archived`);
      auditLog('Archived all resolved leave requests', 'Leave', `${ok} archived`, null);
    } else if (ok === 0) {
      showToast('Archive failed — check connection');
    } else {
      showToast(`⚠ ${ok} archived · ${failed} failed — check connection and retry`);
      auditLog('Archived resolved leave (partial)', 'Leave', `${ok} archived, ${failed} failed`, null);
    }
  };
  openModal('modal-confirm');
}

async function toggleShowArchived() {
  showArchivedLeave = !showArchivedLeave;
  const btn = document.getElementById('leave-archive-toggle');
  if (btn) {
    btn.textContent = showArchivedLeave ? '📦 Hide Archived' : '📦 Show Archived';
    btn.style.background = showArchivedLeave ? 'var(--purple-lt)' : '';
    btn.style.color = showArchivedLeave ? 'var(--purple)' : '';
  }
  await loadLeaveRequests();
  renderLeave();
}

// ── Resend email ──────────────────────────────────────────────

async function resendLeaveEmail(id) {
  const req = leaveRequests.find(r => String(r.id) === String(id));
  if (!req) { showToast('Request not found'); return; }
  showToast('Resending email…');
  await triggerLeaveEmail('new_request', req);
}

// ── Email via Netlify Function ────────────────────────────────

async function triggerLeaveEmail(type, record) {
  try {
    const typeLabels = { 'A/L': 'Annual Leave', 'U/L': 'Unpaid Leave', 'RDO': 'RDO' };
    // v3.4.51: defensive HTML escaping for user-controlled DB fields
    // that flow into the email body. typeLabels[...] returns hardcoded
    // strings (safe by construction); only the `|| raw` fallback path
    // and `record.status` need escaping. Subjects stay plaintext —
    // Resend handles MIME header encoding.
    const safeTypeFallback = escHtml(record.leave_type || '');
    const safeStatus       = escHtml(record.status || '');
    const safeStatusLower  = escHtml((record.status || '').toLowerCase());
    let to, cc = [], subject, html;

    if (type === 'new_request') {
      const mgr = (STATE.managers || []).find(m => m.name === record.approver_name);
      if (!mgr || !mgr.email) {
        showToast(`⚠ No email on file for approver ${record.approver_name} — notification not sent`);
        return;
      }
      to      = mgr.email;
      cc      = leaveCCList.filter(e => e && e !== to);
      subject = `Leave Request: ${record.requester_name} — ${typeLabels[record.leave_type] || record.leave_type} (${record.date_start} to ${record.date_end})`;
      html    = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto">
        <div style="background:#1F335C;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0;font-size:18px">Leave Request</h2>
          <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">EQ Solves — Field</p>
        </div>
        <div style="background:white;padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
          <p style="margin:0 0 16px;font-size:14px;color:#374151"><strong>${escHtml(record.requester_name)}</strong> has submitted a leave request for your approval.</p>
          <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6B7280;width:100px">Type</td><td style="padding:8px 0;font-weight:600">${typeLabels[record.leave_type] || safeTypeFallback}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Dates</td><td style="padding:8px 0;font-weight:600">${record.date_start} to ${record.date_end}</td></tr>
            ${record.note ? `<tr><td style="padding:8px 0;color:#6B7280">Note</td><td style="padding:8px 0">${escHtml(record.note)}</td></tr>` : ''}
          </table>
          <div style="margin-top:20px">
            <a href="${window.location.origin}" style="display:inline-block;background:#1F335C;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Review in App →</a>
          </div>
        </div>
      </div>`;
    } else if (type === 'status_update') {
      // v3.4.5 (L9): supervisors can submit leave too — when the requester is
      // a supervisor they're in STATE.managers, not STATE.people. Fall back
      // to the managers list so approval emails actually land.
      const person = (STATE.people   || []).find(p => p.name === record.requester_name)
                  || (STATE.managers || []).find(m => m.name === record.requester_name);
      if (!person || !person.email) {
        showToast(`⚠ No email on file for ${record.requester_name} — notification not sent`);
        return;
      }
      to      = person.email;
      // v3.4.5 (L11): CC the same supervisor group on status updates so the
      // whole chain sees approvals/rejections, not just the requester.
      cc      = leaveCCList.filter(e => e && e !== to);
      const statusColor = record.status === 'Approved' ? '#16A34A' : '#DC2626';
      subject = `Leave ${record.status}: ${typeLabels[record.leave_type] || record.leave_type} (${record.date_start} to ${record.date_end})`;
      html    = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto">
        <div style="background:#1F335C;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0;font-size:18px">Leave ${safeStatus}</h2>
          <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">EQ Solves — Field</p>
        </div>
        <div style="background:white;padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
          <p style="margin:0 0 16px;font-size:14px;color:#374151">Your leave request has been <strong style="color:${statusColor}">${safeStatusLower}</strong> by ${escHtml(record.responded_by)}.</p>
          <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6B7280;width:100px">Type</td><td style="padding:8px 0;font-weight:600">${typeLabels[record.leave_type] || safeTypeFallback}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Dates</td><td style="padding:8px 0;font-weight:600">${record.date_start} to ${record.date_end}</td></tr>
            ${record.response_note ? `<tr><td style="padding:8px 0;color:#6B7280">Note</td><td style="padding:8px 0">${escHtml(record.response_note)}</td></tr>` : ''}
          </table>
          <div style="margin-top:20px">
            <a href="${window.location.origin}" style="display:inline-block;background:#1F335C;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View in App →</a>
          </div>
        </div>
      </div>`;
    } else if (type === 'submit_confirmation') {
      // v3.4.5 (L15): receipt to the requester so they have proof of submission.
      const person = (STATE.people   || []).find(p => p.name === record.requester_name)
                  || (STATE.managers || []).find(m => m.name === record.requester_name);
      if (!person || !person.email) return; // silent — confirmation is nice-to-have, not critical
      to      = person.email;
      subject = `Leave Request Submitted: ${typeLabels[record.leave_type] || record.leave_type} (${record.date_start} to ${record.date_end})`;
      html    = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto">
        <div style="background:#1F335C;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0;font-size:18px">Leave Request Submitted</h2>
          <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">EQ Solves — Field</p>
        </div>
        <div style="background:white;padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
          <p style="margin:0 0 16px;font-size:14px;color:#374151">Hi ${escHtml(record.requester_name)} — your leave request has been submitted and is awaiting approval from <strong>${escHtml(record.approver_name)}</strong>.</p>
          <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6B7280;width:100px">Type</td><td style="padding:8px 0;font-weight:600">${typeLabels[record.leave_type] || safeTypeFallback}</td></tr>
            <tr><td style="padding:8px 0;color:#6B7280">Dates</td><td style="padding:8px 0;font-weight:600">${record.date_start} to ${record.date_end}</td></tr>
            ${record.note ? `<tr><td style="padding:8px 0;color:#6B7280">Note</td><td style="padding:8px 0">${escHtml(record.note)}</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#6B7280">Status</td><td style="padding:8px 0;font-weight:600;color:#D97706">Pending</td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#6B7280">You'll receive another email once your request is approved or rejected. You can also withdraw this request from the app while it's still pending.</p>
          <div style="margin-top:20px">
            <a href="${window.location.origin}" style="display:inline-block;background:#1F335C;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View in App →</a>
          </div>
        </div>
      </div>`;
    } else return;

    const eqToken = sessionStorage.getItem('eq_session_token') || localStorage.getItem('eq_agent_token') || '';
    // v3.4.59: BATTLE-TEST #18 — defensive CRLF strip on subjects. Resend
    // encodes MIME headers server-side, but stripping CR/LF here means a
    // requester_name containing newlines can't smuggle extra headers even
    // if a future provider doesn't encode robustly. Cheap insurance against
    // the SMTP header-injection class of bug.
    const safeSubject = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
    const resp = await fetch('/.netlify/functions/send-email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-eq-token': eqToken },
      body:    JSON.stringify({ to: [to], cc: cc.length ? cc : undefined, subject: safeSubject, html })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('📧 Email sent to ' + to);
    } else {
      console.error('Resend error:', data);
      showToast('Email failed: ' + (data.message || JSON.stringify(data)));
    }
  } catch (e) {
    console.error('Email error:', e);
    showToast('Email failed: ' + e.message);
  }
}

// ── List render ───────────────────────────────────────────────

function setLeaveView(mode) {
  leaveViewMode = mode;
  document.getElementById('leave-view-list').className = mode === 'list'     ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
  document.getElementById('leave-view-cal').className  = mode === 'calendar' ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
  document.getElementById('leave-calendar').style.display  = mode === 'calendar' ? '' : 'none';
  document.getElementById('leave-content').style.display   = mode === 'list'     ? '' : 'none';
  if (mode === 'calendar') renderLeaveCalendar();
}

function renderLeave() {
  const search       = (document.getElementById('leave-search').value || '').toLowerCase();
  const statusFilter = document.getElementById('leave-filter-status').value;

  let rows = leaveRequests;
  if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
  if (search)       rows = rows.filter(r =>
    r.requester_name.toLowerCase().includes(search) ||
    r.approver_name.toLowerCase().includes(search)
  );

  if (!rows.length) {
    document.getElementById('leave-content').innerHTML =
      '<div class="empty"><div class="empty-icon">🏖</div><p>No leave requests found</p></div>';
    return;
  }

  const statusStyle = {
    Pending:   'background:#FFFBEB;color:#D97706;border:1px solid #FCD34D',
    Approved:  'background:#F0FDF4;color:#16A34A;border:1px solid #86EFAC',
    Rejected:  'background:#FEF2F2;color:#DC2626;border:1px solid #FCA5A5',
    // v3.4.5 (L14): Withdrawn — neutral grey so it reads as "inactive" rather
    // than "denied".
    Withdrawn: 'background:#F3F4F6;color:#6B7280;border:1px solid #D1D5DB'
  };
  const typeLabels = { 'A/L': 'Annual Leave', 'U/L': 'Unpaid Leave', 'RDO': 'RDO' };

  let html = '<div class="roster-card" style="overflow:hidden">';
  rows.forEach(r => {
    const ds  = new Date(r.date_start + 'T00:00:00');
    const de  = new Date(r.date_end   + 'T00:00:00');
    const fmt = d => d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    let datesStr;
    if (r.individual_days && r.individual_days.length) {
      datesStr = r.individual_days.map(d => fmt(new Date(d + 'T00:00:00'))).join(', ');
    } else {
      datesStr = ds.getTime() === de.getTime() ? fmt(ds) : `${fmt(ds)} → ${fmt(de)}`;
    }
    let bizDays = 0;
    if (r.individual_days && r.individual_days.length) {
      bizDays = r.individual_days.length;
    } else {
      const d = new Date(ds);
      while (d <= de) { if (d.getDay() !== 0 && d.getDay() !== 6) bizDays++; d.setDate(d.getDate() + 1); }
    }
    const canRespond = isManager && r.status === 'Pending';
    const isResolved = r.status === 'Approved' || r.status === 'Rejected' || r.status === 'Withdrawn';
    const isArchived = !!r.archived;
    // v3.4.5 (L14): requester (or a supervisor) can withdraw while pending.
    const loggedInName = sessionStorage.getItem('eq_logged_in_name') || '';
    const canWithdraw  = r.status === 'Pending' && (isManager || loggedInName === r.requester_name);
    const rowBg = isArchived ? 'background:var(--surface-2);opacity:.7' : (r.status === 'Pending' ? 'background:#FFFDF5' : '');
    html += `<div style="display:flex;align-items:flex-start;gap:14px;padding:14px 18px;border-bottom:1px solid var(--border);${rowBg}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-weight:700;color:var(--navy);font-size:14px">${esc(r.requester_name)}</span>
          <span style="padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;${statusStyle[r.status] || ''}">${r.status}</span>
          <span style="padding:2px 8px;border-radius:5px;font-size:10px;font-weight:600;background:var(--purple-lt);color:var(--purple)">${typeLabels[r.leave_type] || r.leave_type}</span>
          ${isArchived ? '<span style="padding:2px 8px;border-radius:5px;font-size:10px;font-weight:600;background:var(--surface-2);color:var(--ink-4);border:1px solid var(--border)">📦 Archived</span>' : ''}
        </div>
        <div style="font-size:12px;color:var(--ink-2);margin-bottom:2px">${datesStr} — <strong>${bizDays} day${bizDays !== 1 ? 's' : ''}</strong></div>
        <div style="font-size:11px;color:var(--ink-3)">Approver: ${esc(r.approver_name)}</div>
        ${r.note          ? `<div style="font-size:11px;color:var(--ink-3);margin-top:2px">📝 ${escHtml(r.note)}</div>` : ''}
        ${r.response_note ? `<div style="font-size:11px;color:var(--ink-3);margin-top:2px">💬 ${escHtml(r.response_note)} <span style="opacity:.6">— ${esc(r.responded_by || '')}</span></div>` : ''}
        <div style="font-size:10px;color:var(--ink-4);margin-top:4px">${new Date(r.created_at).toLocaleString('en-AU')}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
        ${canRespond ? `<button class="btn btn-primary btn-sm" onclick="openLeaveRespond('${r.id}')">Review</button>` : ''}
        ${r.status === 'Pending' ? `<button class="btn btn-secondary btn-sm" onclick="resendLeaveEmail('${r.id}')" style="font-size:10px">📧 Resend</button>` : ''}
        ${canWithdraw ? `<button class="btn btn-secondary btn-sm" onclick="withdrawLeaveRequest('${r.id}')" style="font-size:10px;color:var(--red);border-color:var(--red)">✕ Withdraw</button>` : ''}
        ${isResolved && !isArchived && isManager ? `<button class="btn btn-secondary btn-sm" onclick="archiveLeaveRequest('${r.id}')" style="font-size:10px">📦 Archive</button>` : ''}
        ${isArchived && isManager ? `<button class="btn btn-secondary btn-sm" onclick="unarchiveLeaveRequest('${r.id}')" style="font-size:10px">↩ Restore</button>` : ''}
      </div>
    </div>`;
  });
  html += '</div>';
  document.getElementById('leave-content').innerHTML = html;
}

// ── Print ─────────────────────────────────────────────────────

function printLeaveRequests() {
  const statusFilter = document.getElementById('leave-filter-status').value;
  const search       = (document.getElementById('leave-search').value || '').toLowerCase();
  let rows = leaveRequests;
  if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
  if (search)       rows = rows.filter(r => r.requester_name.toLowerCase().includes(search) || r.approver_name.toLowerCase().includes(search));
  if (!rows.length) { showToast('No requests to print'); return; }

  const typeLabels = { 'A/L': 'Annual Leave', 'U/L': 'Unpaid Leave', 'RDO': 'RDO' };
  const fmt        = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const tableRows = rows.map(r => {
    let datesStr;
    if (r.individual_days && r.individual_days.length) {
      datesStr = r.individual_days.map(d => fmt(d)).join(', ');
    } else {
      datesStr = r.date_start === r.date_end ? fmt(r.date_start) : `${fmt(r.date_start)} → ${fmt(r.date_end)}`;
    }
    let bizDays = 0;
    if (r.individual_days && r.individual_days.length) { bizDays = r.individual_days.length; }
    else { const d = new Date(r.date_start + 'T00:00:00'); const e = new Date(r.date_end + 'T00:00:00'); while (d <= e) { if (d.getDay() !== 0 && d.getDay() !== 6) bizDays++; d.setDate(d.getDate() + 1); } }

    return `<tr>
      <td>${esc(r.requester_name)}</td>
      <td>${typeLabels[r.leave_type] || r.leave_type}</td>
      <td>${datesStr}</td>
      <td style="text-align:center">${bizDays}</td>
      <td>${esc(r.approver_name)}</td>
      <td style="font-weight:700;color:${r.status === 'Approved' ? '#16A34A' : r.status === 'Rejected' ? '#DC2626' : '#D97706'}">${r.status}</td>
      <td>${r.note || '—'}</td>
    </tr>`;
  }).join('');

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>EQ Leave Requests</title>
    <style>
      body{font-family:-apple-system,sans-serif;margin:24px;color:#1a1a1a}
      h1{font-size:18px;color:#1F335C;margin-bottom:4px}
      .sub{font-size:12px;color:#666;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th{background:#1F335C;color:white;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
      td{padding:7px 10px;border-bottom:1px solid #e5e5e5}
      tr:nth-child(even){background:#f8f9fa}
      @media print{body{margin:12px}}
    </style></head><body>
    <h1>EQ Solves — Field · Leave Requests</h1>
    <div class="sub">${statusFilter || 'All'} requests · Printed ${new Date().toLocaleString('en-AU')} · ${rows.length} record${rows.length !== 1 ? 's' : ''}</div>
    <table><thead><tr><th>Name</th><th>Type</th><th>Dates</th><th>Days</th><th>Approver</th><th>Status</th><th>Note</th></tr></thead>
    <tbody>${tableRows}</tbody></table>
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
}

// ── Leave calendar ────────────────────────────────────────────

function stepLeaveMonth(dir) {
  leaveCalMonth += dir;
  if (leaveCalMonth > 11) { leaveCalMonth = 0; leaveCalYear++; }
  if (leaveCalMonth < 0)  { leaveCalMonth = 11; leaveCalYear--; }
  renderLeaveCalendar();
}

function renderLeaveCalendar() {
  const months   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('leave-cal-month').textContent = `${months[leaveCalMonth]} ${leaveCalYear}`;

  // v3.4.4 (L6): calendar shows Approved only — Pending hasn't committed to
  // the roster yet and was causing ghost entries after rejection until the
  // page was refreshed. Pending requests remain visible in the list view.
  const approved = leaveRequests.filter(r => r.status === 'Approved');
  const dayMap   = {};

  approved.forEach(r => {
    const dates = _getLeaveDates(r);
    dates.forEach(ds => {
      const dt = new Date(ds + 'T00:00:00');
      if (dt.getMonth() !== leaveCalMonth || dt.getFullYear() !== leaveCalYear) return;
      if (!dayMap[ds]) dayMap[ds] = [];
      dayMap[ds].push({ name: r.requester_name, type: r.leave_type, status: r.status });
    });
  });

  const firstDay  = new Date(leaveCalYear, leaveCalMonth, 1);
  const lastDay   = new Date(leaveCalYear, leaveCalMonth + 1, 0);
  const startDow  = (firstDay.getDay() + 6) % 7;
  const totalDays = lastDay.getDate();
  const todayStr  = _toLocalIso(new Date()); // v3.4.15 (L16): local, not UTC

  const typeColors = { 'A/L': 'var(--blue)', 'U/L': 'var(--amber)', 'RDO': 'var(--green)' };
  const typeBg     = { 'A/L': 'var(--blue-lt)', 'U/L': 'var(--amber-lt)', 'RDO': 'var(--green-lt)' };

  let html = '<div class="roster-card" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr>';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach((d, i) => {
    const we = i >= 5;
    html += `<th style="padding:6px 4px;text-align:center;font-size:10px;font-weight:700;color:${we ? 'var(--ink-4)' : 'var(--ink-3)'};text-transform:uppercase;letter-spacing:.5px">${d}</th>`;
  });
  html += '</tr></thead><tbody><tr>';
  for (let i = 0; i < startDow; i++) html += '<td style="padding:4px;vertical-align:top;border:1px solid var(--border);background:var(--surface-2)"></td>';

  for (let day = 1; day <= totalDays; day++) {
    const dow     = (startDow + day - 1) % 7;
    const ds      = `${leaveCalYear}-${String(leaveCalMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isToday = ds === todayStr;
    const isWe    = dow >= 5;
    const entries = dayMap[ds] || [];
    html += `<td style="padding:4px;vertical-align:top;border:1px solid var(--border);min-height:60px;height:70px;${isWe ? 'background:var(--surface-2);' : ''}${isToday ? 'outline:2px solid var(--purple);outline-offset:-2px;' : ''}">`;
    html += `<div style="font-size:11px;font-weight:${isToday ? '800' : '600'};color:${isToday ? 'var(--purple)' : isWe ? 'var(--ink-4)' : 'var(--ink-2)'};margin-bottom:2px">${day}</div>`;
    entries.forEach(e => {
      const bg  = typeBg[e.type]    || 'var(--surface-2)';
      const col = typeColors[e.type] || 'var(--ink-2)';
      html += `<div style="background:${bg};color:${col};font-size:9px;font-weight:600;padding:1px 4px;border-radius:3px;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(e.name)} — ${e.type}">${esc(e.name.split(' ')[0])} <span style="opacity:.7">${e.type}</span></div>`;
    });
    html += '</td>';
    if (dow === 6 && day < totalDays) html += '</tr><tr>';
  }

  const lastDow = (startDow + totalDays - 1) % 7;
  for (let i = lastDow + 1; i < 7; i++) html += '<td style="padding:4px;vertical-align:top;border:1px solid var(--border);background:var(--surface-2)"></td>';
  html += '</tr></tbody></table></div>';

  html += '<div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">';
  [['A/L', 'Annual Leave'], ['U/L', 'Unpaid Leave'], ['RDO', 'RDO']].forEach(([code, label]) => {
    html += `<span style="font-size:10px;color:var(--ink-3);display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${typeBg[code]}"></span>${label}</span>`;
  });
  html += '</div>';
  document.getElementById('leave-cal-grid').innerHTML = html;
}