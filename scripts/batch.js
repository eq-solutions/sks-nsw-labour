/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/batch.js  —  EQ Solves Field
// Batch fill, copy last week, clean up codes, editor helpers.
// Depends on: app-state.js, utils.js, supabase.js, roster.js
// ─────────────────────────────────────────────────────────────

// ── Batch fill ───────────────────────────────────────────────

function openBatchFill() {
  document.getElementById('batch-code').value = '';
  document.querySelectorAll('#batch-days input[type=checkbox]').forEach(cb => cb.checked = false);
  document.getElementById('batch-days-all-btn').textContent = 'All';
  buildBatchPeopleList();
  updateBatchCount();
  openModal('modal-batch');
}

function buildBatchPeopleList() {
  const groups = PEOPLE_GROUPS;
  const gClass = { 'Direct': 'direct', 'Apprentice': 'apprentice', 'Labour Hire': 'labour' };
  const gIcon  = { 'Direct': '⚡',     'Apprentice': '🎓',         'Labour Hire': '🔧' };
  let html = '';
  groups.forEach(g => {
    const people = [...STATE.people.filter(p => p.group === g && !p.archived)].sort((a, b) => a.name.localeCompare(b.name));
    if (!people.length) return;
    html += `<div class="batch-group-hdr ${gClass[g]}">${gIcon[g]} ${g} <span style="opacity:.6;font-weight:500">(${people.length})</span></div>`;
    people.forEach(p => {
      html += `<label class="batch-person-row">
        <input type="checkbox" value="${p.id}" onchange="updateBatchCount()">
        <span style="font-size:12.5px;font-weight:500;color:var(--ink)">${esc(p.name)}</span>
        <span style="font-size:10.5px;color:var(--ink-3);margin-left:auto">${p.phone || ''}</span>
      </label>`;
    });
  });
  document.getElementById('batch-people-list').innerHTML = html;
}

function updateBatchCount() {
  const n = document.querySelectorAll('#batch-people-list input:checked').length;
  document.getElementById('batch-selection-count').textContent =
    n === 0 ? '0 people selected' : `${n} person${n > 1 ? 's' : ''} selected`;
}

function batchSelectAll()  { document.querySelectorAll('#batch-people-list input[type=checkbox]').forEach(cb => cb.checked = true);  updateBatchCount(); }
function batchClearAll()   { document.querySelectorAll('#batch-people-list input[type=checkbox]').forEach(cb => cb.checked = false); updateBatchCount(); }

function batchToggleGroup(group) {
  const rows     = [...document.querySelectorAll('#batch-people-list input[type=checkbox]')];
  const groupIds = STATE.people.filter(p => p.group === group).map(p => String(p.id));
  const groupRows = rows.filter(cb => groupIds.includes(cb.value));
  const allChecked = groupRows.every(cb => cb.checked);
  groupRows.forEach(cb => cb.checked = !allChecked);
  updateBatchCount();
}

function batchSelectWeekdays() {
  document.querySelectorAll('#batch-days input[type=checkbox]').forEach(cb => {
    cb.checked = ['mon', 'tue', 'wed', 'thu', 'fri'].includes(cb.value);
  });
  document.getElementById('batch-days-all-btn').textContent = 'All';
}

function batchSelectAllDays() {
  const cbs = document.querySelectorAll('#batch-days input[type=checkbox]');
  const allChecked = [...cbs].every(cb => cb.checked);
  cbs.forEach(cb => cb.checked = !allChecked);
  document.getElementById('batch-days-all-btn').textContent = allChecked ? 'All' : 'None';
}

function runBatchFill() {
  const code = document.getElementById('batch-code').value.trim().toUpperCase();
  if (!code) { showToast('Enter a site or status code first'); return; }

  const selectedDays = [...document.querySelectorAll('#batch-days input:checked')].map(cb => cb.value);
  if (!selectedDays.length) { showToast('Select at least one day'); return; }

  const selectedIds = new Set(
    [...document.querySelectorAll('#batch-people-list input:checked')].map(cb => cb.value)
  );
  if (!selectedIds.size) { showToast('Select at least one person'); return; }

  const week   = STATE.currentWeek;
  const people = STATE.people.filter(p => selectedIds.has(String(p.id)));

  // Check for conflicts
  const conflicts = [];
  people.forEach(p => {
    const s = getPersonSchedule(p.name, week);
    selectedDays.forEach(d => { if (s[d] && s[d].trim()) conflicts.push({ name: p.name, day: d, val: s[d] }); });
  });

  const totalCells = people.length * selectedDays.length;
  const confirmBtn = document.getElementById('confirm-action');
  const cancelBtn  = document.querySelector('#modal-confirm .btn-secondary');

  if (!conflicts.length && totalCells >= 10) {
    document.getElementById('confirm-title').textContent = 'Apply Batch Fill?';
    document.getElementById('confirm-msg').textContent =
      `This will fill ${totalCells} cells (${people.length} people × ${selectedDays.length} day${selectedDays.length > 1 ? 's' : ''}) with "${code}". Continue?`;
    confirmBtn.textContent = 'Apply';
    confirmBtn.onclick = () => { closeModal('modal-confirm'); applyBatch(people, selectedDays, code, week, false); };
    openModal('modal-confirm');
    return;
  }

  if (conflicts.length) {
    const preview = conflicts.slice(0, 5).map(x => `${x.name} (${x.day.toUpperCase()}: ${x.val})`).join(', ');
    const more    = conflicts.length > 5 ? ` +${conflicts.length - 5} more` : '';
    document.getElementById('confirm-title').textContent = 'Overwrite existing values?';
    document.getElementById('confirm-msg').textContent =
      `${conflicts.length} cell${conflicts.length > 1 ? 's' : ''} already have values: ${preview}${more}. Overwrite with "${code}"?`;
    const origCancelOnclick = cancelBtn.onclick;
    confirmBtn.textContent = 'Overwrite';
    confirmBtn.onclick = () => { closeModal('modal-confirm'); cancelBtn.onclick = origCancelOnclick; applyBatch(people, selectedDays, code, week, false); };
    cancelBtn.textContent = 'Skip existing';
    cancelBtn.onclick = () => {
      closeModal('modal-confirm');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = origCancelOnclick;
      applyBatch(people, selectedDays, code, week, true);
    };
    openModal('modal-confirm');
  } else {
    applyBatch(people, selectedDays, code, week, false);
  }
}

async function applyBatch(people, days, code, week, skipExisting) {
  if (!isManager) { showToast('Supervision access required'); return; }
  let changed = 0;
  people.forEach(p => {
    let entry = STATE.schedule.find(r => r.name === p.name && r.week === week);
    if (!entry) {
      entry = { name: p.name, week, mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' };
      STATE.schedule.push(entry);
      if (STATE.scheduleIndex) STATE.scheduleIndex[`${p.name}||${week}`] = entry;
    }
    days.forEach(d => {
      if (skipExisting && entry[d] && entry[d].trim()) return;
      entry[d] = code;
      changed++;
    });
  });

  updateTopStats();
  renderEditor();
  if (currentPage === 'roster') renderRoster();
  closeModal('modal-batch');
  showToast(`Applied "${code}" to ${changed} cell${changed !== 1 ? 's' : ''}. Saving…`);
  auditLog(`Batch fill: ${code}`, 'Roster', `${changed} cells updated`, STATE.currentWeek);

  const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const saves = people.map(async p => {
    const entry = STATE.schedule.find(r => r.name === p.name && r.week === week);
    if (!entry) return;
    if (_isRealDbId(entry.id)) {
      const patch = {};
      days.forEach(d => { patch[d] = entry[d] || null; });
      await sbFetch(`schedule?id=eq.${entry.id}`, 'PATCH', patch);
    } else {
      const row = { name: p.name, week };
      allDays.forEach(d => { row[d] = entry[d] || null; });
      const res = await sbFetch('schedule', 'POST', row, 'return=representation');
      if (res && res[0]) {
        entry.id         = res[0].id;
        entry.updated_at = res[0].updated_at;
        if (STATE.scheduleIndex) STATE.scheduleIndex[`${p.name}||${week}`] = entry;
      }
    }
  });

  try {
    await Promise.all(saves);
    showToast(`"${code}" applied to ${changed} cell${changed !== 1 ? 's' : ''} — saved ✓`);
  } catch (e) {
    if (TENANT.ORG_SLUG !== 'eq' && TENANT.ORG_SLUG !== 'demo') {
      showToast('Batch applied locally but sync failed — check connection'); // DEMO_FLAG
    }
  }
}

// ── Copy last week ────────────────────────────────────────────

// Track freshly-copied cells for yellow highlight. Cleared on next manual renderEditor().
let _copiedCells = new Set();

function isCopiedCell(name, day) {
  return _copiedCells.has(`${name}||${day}`);
}

function clearCopiedCells() {
  _copiedCells.clear();
}

async function copyLastWeek() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const week = STATE.currentWeek;
  const sel  = document.getElementById('globalWeek');
  const opts = [...sel.options].map(o => o.value);
  const idx  = opts.indexOf(week);
  if (idx <= 0) { showToast('No previous week to copy from'); return; }

  const prevWeek  = opts[idx - 1];
  const prevSched = getWeekSchedule(prevWeek);
  const currSched = getWeekSchedule(week);
  if (!prevSched.length) { showToast(`No data in week ${prevWeek}`); return; }

  // BUG-009 FIX: use modal instead of confirm() — broken in iOS PWA standalone
  const currHasData = currSched.some(r =>
    ['mon', 'tue', 'wed', 'thu', 'fri'].some(d => r[d] && r[d].trim())
  );
  if (currHasData) {
    const proceed = await new Promise(resolve => {
      document.getElementById('confirm-title').textContent = 'Copy Last Week';
      document.getElementById('confirm-msg').textContent =
        `This week already has roster data. Copy from ${prevWeek} will only fill empty cells \u2014 existing entries won\u2019t be overwritten. Continue?`;
      const cb = document.getElementById('confirm-action');
      const xb = document.querySelector('#modal-confirm .btn-secondary');
      const origX = xb.onclick;
      cb.textContent = 'Copy';
      cb.onclick = () => { closeModal('modal-confirm'); cb.onclick = null; xb.onclick = origX; resolve(true); };
      xb.onclick  = () => { closeModal('modal-confirm'); cb.onclick = null; xb.onclick = origX; resolve(false); };
      openModal('modal-confirm');
    });
    if (!proceed) return;
  }

  showLoadingOverlay('Copying last week\u2026');
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  let copied = 0;
  _copiedCells.clear();

  // \u2500\u2500 Phase 1: Build all local state changes in memory (no awaits) \u2500\u2500
  const saveTasks = [];

  for (const prev of prevSched) {
    let entry = STATE.schedule.find(r => r.name === prev.name && r.week === week);
    if (!entry) {
      entry = { name: prev.name, week, mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' };
      STATE.schedule.push(entry);
      if (STATE.scheduleIndex) STATE.scheduleIndex[`${prev.name}||${week}`] = entry;
    }
    const cellsChanged = [];
    for (const d of days) {
      if (!entry[d] || !entry[d].trim()) {
        const val = prev[d] || '';
        if (val && val.trim()) {
          entry[d] = val;
          cellsChanged.push(d);
          _copiedCells.add(`${prev.name}||${d}`);
          copied++;
        }
      }
    }

    // Build a save task for this person (one request per person, not per cell)
    if (cellsChanged.length) {
      saveTasks.push({ entry, cellsChanged });
    }
  }

  // Render immediately with highlights before network requests
  renderEditor();
  if (currentPage === 'roster') renderRoster();

  // \u2500\u2500 Phase 2: Save to Supabase in parallel \u2500\u2500
  const savePromises = saveTasks.map(async ({ entry, cellsChanged }) => {
    if (_isRealDbId(entry.id)) {
      // Existing row \u2014 PATCH only changed days in a single request
      const patch = {};
      cellsChanged.forEach(d => { patch[d] = entry[d] || null; });
      try {
        const res = await sbFetch(
          `schedule?id=eq.${entry.id}`,
          'PATCH', patch, 'return=representation'
        );
        if (Array.isArray(res) && res[0]) {
          entry.updated_at = res[0].updated_at;
          if (typeof _rtMarkLocalWrite === 'function') _rtMarkLocalWrite(entry.id);
        }
      } catch (e) { /* individual failure is non-fatal */ }
    } else {
      // New row \u2014 POST full row
      const row = { name: entry.name, week: entry.week };
      allDays.forEach(d => { row[d] = entry[d] || null; });
      try {
        const res = await sbFetch('schedule', 'POST', row, 'return=representation');
        if (res && res[0]) {
          entry.id         = res[0].id;
          entry.updated_at = res[0].updated_at;
          if (STATE.scheduleIndex) STATE.scheduleIndex[`${entry.name}||${entry.week}`] = entry;
        }
      } catch (e) { /* individual failure is non-fatal */ }
    }
  });

  try {
    await Promise.all(savePromises);
    hideLoadingOverlay();
    showToast(`Copied ${copied} cells from ${prevWeek} \u2014 saved \u2713`);
  } catch (e) {
    hideLoadingOverlay();
    showToast(`Copied ${copied} cells locally but some saves failed`);
  }

  auditLog(`Copy last week: ${prevWeek} \u2192 ${week}`, 'Roster', `${copied} cells`, week);
}

// ── Clean up unknown codes ────────────────────────────────────

function openCleanupCodes() {
  const days       = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const knownAbbrs = new Set(STATE.sites.map(s => s.abbr));
  const codeMap    = {};

  STATE.schedule.forEach(r => {
    days.forEach(d => {
      const s = (r[d] || '').trim().toUpperCase();
      if (!s || isLeave(s) || knownAbbrs.has(s)) return;
      if (!codeMap[s]) codeMap[s] = { weeks: new Set(), cells: 0 };
      codeMap[s].weeks.add(r.week);
      codeMap[s].cells++;
    });
  });

  const unknown = Object.entries(codeMap).sort((a, b) => a[0].localeCompare(b[0]));
  if (!unknown.length) { showToast('No unknown codes found — all clean ✓'); return; }

  let html = '';
  unknown.forEach(([code, info]) => {
    const weekList = [...info.weeks].sort().join(', ');
    html += `<label class="cleanup-row">
      <input type="checkbox" value="${code}" onchange="updateCleanupCount()">
      <span class="cleanup-code">${code}</span>
      <span class="cleanup-weeks">${info.weeks.size} week${info.weeks.size !== 1 ? 's' : ''} &nbsp;·&nbsp; ${weekList}</span>
      <span class="cleanup-cells">${info.cells} cell${info.cells !== 1 ? 's' : ''}</span>
    </label>`;
  });

  document.getElementById('cleanup-list').innerHTML = html;
  updateCleanupCount();
  openModal('modal-cleanup');
}

function updateCleanupCount() {
  const n = document.querySelectorAll('#cleanup-list input:checked').length;
  document.getElementById('cleanup-count').textContent =
    n === 0 ? '0 selected' : `${n} code${n !== 1 ? 's' : ''} selected`;
}

function cleanupSelectAll() { document.querySelectorAll('#cleanup-list input[type=checkbox]').forEach(cb => cb.checked = true);  updateCleanupCount(); }
function cleanupClearAll()  { document.querySelectorAll('#cleanup-list input[type=checkbox]').forEach(cb => cb.checked = false); updateCleanupCount(); }

function runCleanup(scope) {
  const selected = new Set(
    [...document.querySelectorAll('#cleanup-list input:checked')].map(cb => cb.value)
  );
  if (!selected.size) { showToast('Select at least one code'); return; }

  const days        = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const currentWeek = STATE.currentWeek;
  let cleared = 0;

  STATE.schedule.forEach(r => {
    if (scope === 'current' && r.week !== currentWeek) return;
    days.forEach(d => {
      const s = (r[d] || '').trim().toUpperCase();
      if (selected.has(s)) { r[d] = ''; cleared++; }
    });
  });

  // Rebuild schedule index after bulk clear
  if (STATE.scheduleIndex) {
    STATE.scheduleIndex = {};
    STATE.schedule.forEach(r => { STATE.scheduleIndex[`${r.name}||${r.week}`] = r; });
  }

  updateTopStats();
  refreshPersonSelects();
  renderCurrentPage();
  closeModal('modal-cleanup');

  const scopeLabel = scope === 'current' ? 'current week' : 'all weeks';
  showToast(`Cleared ${cleared} cell${cleared !== 1 ? 's' : ''} across ${scopeLabel}. Saving…`);

  const weeksToSave = scope === 'current'
    ? [currentWeek]
    : [...new Set(STATE.schedule.map(r => r.week))];
  importScheduleToSB(STATE.schedule, weeksToSave)
    .then(() => showToast(`Cleared ${cleared} cell${cleared !== 1 ? 's' : ''} — saved`))
    .catch(() => showToast('Cleared locally but sync failed — check connection'));
}