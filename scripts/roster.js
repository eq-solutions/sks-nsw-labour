/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/roster.js  —  EQ Solves Field
// Roster render, schedule helpers, chip generation,
// site colour, editor render, My Schedule render.
// Depends on: app-state.js, utils.js
// ─────────────────────────────────────────────────────────────

// ── Site colour ───────────────────────────────────────────────
function siteColor(code) {
  if (!code || !code.trim()) return 'empty';
  const u = code.toUpperCase().trim();
  if (SITE_COLOR_MAP[u]) return SITE_COLOR_MAP[u];
  if (isEducation(u)) return 'purple';
  if (isLeave(u)) return 'amber';
  // Hash the code to a colour
  let hash = 0;
  for (let i = 0; i < u.length; i++) hash = u.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['blue','green','purple','red','grey'];
  return colors[Math.abs(hash) % colors.length];
}

function isLeave(code) {
  if (!code || !code.trim()) return false;
  const u = code.toUpperCase().trim();
  return LEAVE_TERMS.some(t => u === t || u.startsWith(t));
}

// TAFE / TRAINING — education is a scheduled work activity,
// not leave. Kept separate so dashboards don't miscount it.
function isEducation(code) {
  if (!code || !code.trim()) return false;
  const u = code.toUpperCase().trim();
  return EDUCATION_TERMS.some(t => u === t || u.startsWith(t));
}

// Used by the "Leave & Absences" panels — excludes Public Holidays
// and education. PH is a site-wide closure; TAFE is scheduled learning.
function isAbsence(code) {
  if (!code || !code.trim()) return false;
  const u = code.toUpperCase().trim();
  if (u === 'PH') return false;
  if (isEducation(u)) return false;
  return isLeave(code);
}

// ── Schedule access ───────────────────────────────────────────
function getWeekSchedule(week) {
  return STATE.schedule.filter(r => r.week === week);
}

function getPersonSchedule(name, week) {
  const entry = STATE.scheduleIndex
    ? STATE.scheduleIndex[`${name}||${week}`]
    : STATE.schedule.find(r => r.name === name && r.week === week);
  return entry || { mon:'', tue:'', wed:'', thu:'', fri:'', sat:'', sun:'' };
}

function getAllSiteCodes() {
  const codes = new Set();
  STATE.schedule.forEach(r => {
    ['mon','tue','wed','thu','fri','sat','sun'].forEach(d => {
      if (r[d] && r[d].trim() && !isLeave(r[d])) codes.add(r[d].toUpperCase().trim());
    });
  });
  STATE.sites.forEach(s => codes.add(s.abbr));
  return [...codes].sort();
}

function getSiteName(abbr) {
  if (!abbr) return '';
  const site = STATE.sites.find(s => s.abbr === abbr);
  return site ? site.name : abbr;
}

function getSiteAddress(abbr) {
  if (!abbr) return '';
  const site = STATE.sites.find(s => s.abbr === abbr);
  return site ? (site.address || '') : '';
}

function isKnownSite(code) {
  if (!code) return false;
  if (isLeave(code)) return true;
  return STATE.sites.some(s => s.abbr === code.toUpperCase().trim());
}

// ── Chip ──────────────────────────────────────────────────────
function chip(code, small) {
  if (!code || !code.trim()) return '<span class="chip chip-empty">—</span>';
  const col   = siteColor(code);
  const label = isLeave(code) ? code : (getSiteName(code) !== code ? getSiteName(code) : code);
  const size  = small ? ' chip-sm' : '';
  return `<span class="chip chip-${col}${size}" title="${esc(label)}">${esc(code)}</span>`;
}

// ── Legend ────────────────────────────────────────────────────
function renderRosterLegend() {
  const week  = STATE.currentWeek;
  const sched = getWeekSchedule(week);
  const codes = new Set();
  sched.forEach(r => ['mon','tue','wed','thu','fri','sat','sun'].forEach(d => {
    if (r[d] && r[d].trim() && !isLeave(r[d])) codes.add(r[d].toUpperCase().trim());
  }));
  const bar = document.getElementById('legend-bar');
  if (!bar) return;
  if (!codes.size) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = [...codes].sort().map(c => {
    const col  = siteColor(c);
    const name = getSiteName(c);
    return `<span class="legend-item"><span class="legend-dot legend-${col}"></span>${esc(name !== c ? name : c)}</span>`;
  }).join('');
}

// ── Sort helpers ──────────────────────────────────────────────
function setSortCol(col) {
  if (rosterSort.col === col) rosterSort.dir = rosterSort.dir === 'asc' ? 'desc' : 'asc';
  else { rosterSort.col = col; rosterSort.dir = 'asc'; }
  renderRoster();
}

function sortPeople(people, col, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...people].sort((a, b) => {
    const week = STATE.currentWeek;
    if (col === 'name') return a.name.localeCompare(b.name) * mult;
    const days = ['mon','tue','wed','thu','fri','sat','sun'];
    if (days.includes(col)) {
      const sa = getPersonSchedule(a.name, week)[col] || '';
      const sb = getPersonSchedule(b.name, week)[col] || '';
      return sa.localeCompare(sb) * mult;
    }
    return 0;
  });
}

// ── Roster day view (mobile) ──────────────────────────────────
function getVisibleRosterDays() {
  const week  = STATE.currentWeek;
  const sched = getWeekSchedule(week);
  const hasSat = sched.some(r => r.sat && r.sat.trim());
  const hasSun = sched.some(r => r.sun && r.sun.trim());
  const days   = ['mon','tue','wed','thu','fri'];
  if (hasSat) days.push('sat');
  if (hasSun) days.push('sun');
  return days;
}

function getVisibleRosterDayLabels() {
  const map = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
  return getVisibleRosterDays().map(d => map[d]);
}

function syncRosterActiveDay() {
  const days = getVisibleRosterDays();
  if (rosterActiveDay >= days.length) rosterActiveDay = days.length - 1;
}

function setRosterDay(idx) {
  rosterActiveDay     = idx;
  rosterHasInteracted = true;
  renderRoster();
}

function stepRosterDay(dir) {
  const days = getVisibleRosterDays();
  rosterActiveDay = Math.max(0, Math.min(days.length - 1, rosterActiveDay + dir));
  rosterHasInteracted = true;
  renderRoster();
}

// ── Roster render ─────────────────────────────────────────────
function getRosterPeopleForGroup(group) {
  const people = STATE.people.filter(p => p.group === group);
  const siteFilter   = document.getElementById('roster-site')   ? document.getElementById('roster-site').value   : '';
  const searchFilter = document.getElementById('roster-search') ? document.getElementById('roster-search').value.toLowerCase() : '';
  const week = STATE.currentWeek;

  let filtered = people;
  if (searchFilter) filtered = filtered.filter(p => p.name.toLowerCase().includes(searchFilter));
  if (siteFilter) {
    filtered = filtered.filter(p => {
      const s = getPersonSchedule(p.name, week);
      return Object.values(s).some(v => v === siteFilter);
    });
  }
  // v3.4.78: team filter from the topbar pill row. personInActiveTeam
  // lives in scripts/teams.js and returns true when the current filter
  // is null (no team selected) — so this is a no-op until a team is
  // picked.
  if (typeof personInActiveTeam === 'function') {
    filtered = filtered.filter(p => personInActiveTeam(p.id));
  }
  return sortPeople(filtered, rosterSort.col, rosterSort.dir);
}

// Legacy single-day mobile view — superseded by the unified table view that
// scrolls horizontally on phones. Kept as a stub so any stale call sites from
// older bundles still return null and fall through to the desktop renderer.
function renderRosterDayView(people, days, dayLabels, weekDates) {
  return null;

  // Full-week compact view: one row per person, chip per day (Mon–Fri + sat/sun if used).
  let html = `<div class="roster-week-hdr">
    <div class="rwh-day rwh-name">Name</div>
    ${days.map((d, i) => `<div class="rwh-day"><span class="rwh-lbl">${dayLabels[i]}</span><span class="rwh-date">${weekDates[i]}</span></div>`).join('')}
  </div>`;

  const groups = ['Direct', 'Apprentice', 'Labour Hire'];
  groups.forEach(g => {
    const gp = people.filter(p => p.group === g);
    if (!gp.length) return;
    const gClass = g === 'Apprentice' ? 'apprentice' : g === 'Labour Hire' ? 'labour' : 'direct';
    const gIcon  = g === 'Apprentice' ? '🎓' : g === 'Labour Hire' ? '🔧' : '⚡';
    html += `<div class="group-strip ${gClass}"><span>${gIcon}</span><span>${g}</span><span class="group-strip-count">${gp.length}</span></div>`;
    gp.forEach(p => {
      const s = getPersonSchedule(p.name, STATE.currentWeek);
      html += `<div class="roster-week-row">
        <div class="rwr-name">${esc(p.name)}</div>
        ${days.map(d => {
          const code = s[d] || '';
          const col  = siteColor(code);
          return `<div class="rwr-cell"><span class="rwr-chip chip-${col}">${code ? esc(code) : '·'}</span></div>`;
        }).join('')}
      </div>`;
    });
  });
  return html;
}

function renderRoster() {
  const week       = STATE.currentWeek;
  const sched      = getWeekSchedule(week);
  const groupFilter = document.getElementById('roster-group') ? document.getElementById('roster-group').value : '';
  const days        = getVisibleRosterDays();
  const dayLabels   = getVisibleRosterDayLabels();
  const weekDates   = getWeekDates(week);
  // v3.4.46: removed dead `const isMobile` — the comment 5 lines below
  // already notes the renderer is unified, the const had no readers.

  renderRosterLegend();

  // Update print header
  const printWeek = document.getElementById('roster-print-week');
  if (printWeek) printWeek.textContent = formatWeekLabel(week);

  const groups = PEOPLE_GROUPS.filter(g => !groupFilter || g === groupFilter);
  const allPeople = groups.flatMap(g => getRosterPeopleForGroup(g));

  // Unified table view — desktop and mobile both render the same table,
  // mobile gets horizontal scroll via .table-scroll overflow-x:auto.
  // Hide the stale swipe hint if present (kept only for old markup compat).
  const hint = document.getElementById('roster-swipe-hint');
  if (hint) hint.style.display = 'none';
  const colMap = { blue:'var(--blue)', green:'var(--green)', amber:'var(--amber)', red:'var(--red)', purple:'var(--purple)', grey:'var(--ink-3)', empty:'var(--ink-4)' };
  const bgMap  = { blue:'var(--blue-lt)', green:'var(--green-lt)', amber:'var(--amber-lt)', red:'var(--red-lt)', purple:'var(--purple-lt)', grey:'var(--surface-2)', empty:'transparent' };

  let html = '';
  groups.forEach(group => {
    const people = getRosterPeopleForGroup(group);
    if (!people.length) return;
    const gClass = group === 'Apprentice' ? 'apprentice' : group === 'Labour Hire' ? 'labour' : 'direct';
    const gIcon  = group === 'Apprentice' ? '🎓' : group === 'Labour Hire' ? '🔧' : '⚡';

    html += `<div class="group-section" style="margin-bottom:14px">
      <div class="group-strip ${gClass}"><span>${gIcon}</span><span>${group}</span><span class="group-strip-count">${people.length}</span></div>
      <div class="roster-card"><div class="table-scroll"><table>
        <thead><tr>
          <th class="name-col sortable${rosterSort.col==='name'?' sort-'+rosterSort.dir:''}" onclick="setSortCol('name')">Name</th>
          ${days.map((d, i) => `<th class="center sortable${rosterSort.col===d?' sort-'+rosterSort.dir:''}" onclick="setSortCol('${d}')">${dayLabels[i]}<br><span style="font-size:11px;font-weight:600;color:#fff">${weekDates[i]}</span></th>`).join('')}
        </tr></thead>
        <tbody>`;

    people.forEach(p => {
      const s = getPersonSchedule(p.name, week);
      const isOnLeaveAllWeek = ['mon','tue','wed','thu','fri'].every(d2 => isLeave(s[d2] || ''));
      // v3.4.78: 4px left-border in the person's team colour. When a
      // specific team is filtered, all visible rows wear that team's
      // colour. When 'All' is shown, the first team a person belongs
      // to alphabetically wins. People in no team get no stripe.
      const _stripe = (typeof colorForPerson === 'function') ? colorForPerson(p.id) : null;
      const _rowStyle = _stripe ? `style="box-shadow:inset 4px 0 0 0 ${_stripe}"` : '';
      html += `<tr ${_rowStyle}>
        <td class="name-col">${esc(p.name)}</td>
        ${days.map(d => {
          const code = s[d] || '';
          const col  = siteColor(code);
          const bg   = bgMap[col] || 'transparent';
          const fg   = colMap[col] || 'var(--ink)';
          const title = code && !isLeave(code) ? getSiteName(code) : '';
          const isWeekday = ['mon','tue','wed','thu','fri'].includes(d);
          const isEmpty = !code || !code.trim();
          const needsAttention = isWeekday && isEmpty && !isOnLeaveAllWeek;
          const cellBg = needsAttention ? '#FBBF24' : bg;
          return `<td class="center" style="background:${cellBg}" title="${esc(title)}">
            ${code ? `<span style="color:${fg};font-weight:600;font-size:11px">${esc(code)}</span>` : (needsAttention ? '<span style="color:#D97706;font-size:10px">—</span>' : '<span style="color:var(--ink-4)">—</span>')}
          </td>`;
        }).join('')}
      </tr>`;
    });

    html += `</tbody></table></div></div></div>`;
  });

  if (!html) html = '<div class="empty"><div class="empty-icon">🔍</div><p>No staff match your filters</p></div>';
  document.getElementById('roster-content').innerHTML = html;
}

// ── Fill week ─────────────────────────────────────────────────
function fillWeek(name, week) {
  if (!isManager) { showToast('Supervision access required'); return; }
  let entry = STATE.schedule.find(r => r.name === name && r.week === week);
  // v3.4.52: when creating a new entry, also seed scheduleIndex so
  // O(1) lookups elsewhere in the code can find it. Matches updateCell.
  if (!entry) {
    entry = { name, week, mon:'', tue:'', wed:'', thu:'', fri:'', sat:'', sun:'' };
    STATE.schedule.push(entry);
    if (STATE.scheduleIndex) STATE.scheduleIndex[`${name}||${week}`] = entry;
  }
  const val = entry.mon;
  if (!val) { showToast('No Monday value to fill from'); return; }
  // v3.4.76: capture per-day before-values before mutating so undo can
  // restore the exact pre-fill state cell-by-cell.
  const fillDays  = ['tue','wed','thu','fri'];
  const undoChanges = fillDays
    .map(d => ({ table: 'schedule', recordId: entry.id, field: d, before: entry[d] || '', after: val, name }))
    .filter(c => c.before !== c.after);
  fillDays.forEach(d => { entry[d] = val; });
  // v3.4.52: refresh stats + cross-page renders so top-of-page badges
  // and dashboard widgets don't go stale after a Fill. Matches updateCell.
  renderEditor();
  updateTopStats();
  if (currentPage === 'roster') renderRoster();
  if (currentPage === 'dashboard') renderDashboard();
  saveRowToSB(name, week, { tue: val, wed: val, thu: val, fri: val }).catch(() => {});
  showToast(`Filled Mon–Fri with ${val}`);
  auditLog(`Filled Mon–Fri with "${val}"`, 'Roster', name, week);
  updateLastUpdated();
  // v3.4.76: undoable as a single action — Ctrl-Z reverses all four
  // cells at once. Only the cells that actually changed are recorded.
  if (typeof _pushUndo === 'function' && currentManagerName && undoChanges.length) {
    _pushUndo({
      type: 'fill-week',
      ts:   Date.now(),
      who:  currentManagerName,
      week,
      changes:   undoChanges,
      navTarget: { week }
    });
  }
}

// ── Clear week ──────────────────────────────────────────────
function confirmClearWeek(name, week) {
  if (!isManager) { showToast('Supervision access required'); return; }
  document.getElementById('confirm-title').textContent = 'Clear Week';
  document.getElementById('confirm-msg').textContent =
    `Clear all roster entries for ${name} for w/c ${week}? This will blank Mon–Sun.`;
  document.getElementById('confirm-action').textContent = 'Clear';
  document.getElementById('confirm-action').onclick = () => clearWeek(name, week);
  openModal('modal-confirm');
}

function clearWeek(name, week) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const days = ['mon','tue','wed','thu','fri','sat','sun'];
  let entry = STATE.schedule.find(r => r.name === name && r.week === week);
  if (!entry) { closeModal('modal-confirm'); showToast('Nothing to clear'); return; }
  // v3.4.76: capture per-day before-values pre-mutation so undo can
  // restore the entire week verbatim from a single Ctrl-Z.
  const undoChanges = days
    .map(d => ({ table: 'schedule', recordId: entry.id, field: d, before: entry[d] || '', after: '', name }))
    .filter(c => c.before !== '');
  days.forEach(d => { entry[d] = ''; });
  closeModal('modal-confirm');
  renderEditor();
  saveCurrentWeek();
  updateTopStats();
  if (currentPage === 'roster') renderRoster();
  if (currentPage === 'dashboard') renderDashboard();
  saveRowToSB(name, week, { mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' }).catch(() => {});
  showToast(`${name} — week cleared`);
  auditLog('Week cleared', 'Roster', name, week);
  updateLastUpdated();
  if (typeof _pushUndo === 'function' && currentManagerName && undoChanges.length) {
    _pushUndo({
      type: 'clear-week',
      ts:   Date.now(),
      who:  currentManagerName,
      week,
      changes:   undoChanges,
      navTarget: { week }
    });
  }
}

// ── Editor helpers ────────────────────────────────────────────
function handleCellInput(el) {
  const pos = el.selectionStart;
  el.value  = el.value.toUpperCase();
  el.setSelectionRange(pos, pos);
  inputColor(el);
}

function inputColor(el) {
  const s   = el.value.trim().toUpperCase();
  el.value  = s;
  const col = siteColor(s);
  const bgMap2 = { blue:'#EFF4FF', green:'#F0FDF4', amber:'#FFFBEB', red:'#FEF2F2', grey:'#F8FAFC', purple:'#EEEDF8', empty:'transparent' };
  const fgMap2 = { blue:'#2563EB', green:'#16A34A', amber:'#D97706', red:'#DC2626', grey:'#64748B', purple:'#7C77B9', empty:'var(--ink)' };

  // If the cell is empty and inside an .empty-cell wrapper, keep the yellow highlight
  const wrapper = el.closest('.editor-day');
  if (!s && wrapper && wrapper.classList.contains('empty-cell')) {
    el.style.background = '#FBBF24';
    el.style.color      = '#92400E';
  } else {
    el.style.background = bgMap2[col] || 'transparent';
    el.style.color      = fgMap2[col] || 'var(--ink)';
  }
  if (s && !isKnownSite(s)) { el.style.outline = '2px solid #F59E0B'; el.style.outlineOffset = '-2px'; el.title = '⚠ Unknown site'; }
  else { el.style.outline = ''; el.title = ''; }
}

function updateCell(el) {
  if (!isManager) { showToast('Supervision access required to edit'); return; }
  const { name, week, day } = el.dataset;
  const val = el.value.trim().toUpperCase();
  el.value  = val;
  inputColor(el);
  let entry = STATE.schedule.find(r => r.name === name && r.week === week);
  if (!entry) { entry = { name, week, mon:'', tue:'', wed:'', thu:'', fri:'', sat:'', sun:'' }; STATE.schedule.push(entry); if (STATE.scheduleIndex) STATE.scheduleIndex[`${name}||${week}`] = entry; }
  // v3.4.76: capture before-value BEFORE the STATE mutation so the undo
  // stack + audit row record the pre-edit state. Bail on no-op edits to
  // avoid spamming the undo stack with empty entries.
  const beforeVal = entry[day] || '';
  if (entry[day] === val) return;
  entry[day] = val;
  saveCurrentWeek();
  updateTopStats();
  if (currentPage === 'roster') renderRoster();
  if (currentPage === 'dashboard') renderDashboard();
  showToast(`${name} → ${day.toUpperCase()}: ${val || 'cleared'}`);
  auditLog(`${day.toUpperCase()} → ${val || 'cleared'}`, 'Roster', name, STATE.currentWeek, {
    before:       beforeVal,
    after:        val,
    target_table: 'schedule',
    target_id:    entry.id,
    target_field: day
  });
  updateLastUpdated();
  // v3.4.76: record the action on the local undo stack. _pushUndo guards
  // against missing currentManagerName and empty change lists; it's a
  // no-op when called outside a supervisor session.
  if (typeof _pushUndo === 'function' && currentManagerName) {
    _pushUndo({
      type: 'cell',
      ts:   Date.now(),
      who:  currentManagerName,
      week,
      changes: [{ table: 'schedule', recordId: entry.id, field: day, before: beforeVal, after: val, name }],
      navTarget: { week }
    });
  }
  saveCellToSB(name, week, day, val)
    .then(() => { if (typeof triggerRosterPush === 'function') triggerRosterPush(name, week, day, val); })
    .catch(() => showToast('Save failed — check connection'));
}

function toggleEditorSort() {
  editorSort = editorSort === 'asc' ? 'desc' : 'asc';
  const btn  = document.getElementById('editor-sort-btn');
  if (btn) btn.textContent = editorSort === 'asc' ? 'A–Z ▲' : 'Z–A ▼';
  renderEditor();
}

function renderEditor() {
  const week      = STATE.currentWeek;
  const edLabel   = document.getElementById('editor-week-label');
  if (edLabel) edLabel.textContent = formatWeekLabel(week);

  const groups    = PEOPLE_GROUPS;
  const gIcon     = { 'Direct':'⚡', 'Apprentice':'🎓', 'Labour Hire':'🔧' };
  const days      = ['mon','tue','wed','thu','fri','sat','sun'];
  const dayLabels = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
  const weekDatesE = getWeekDates(week);

  // Rebuild datalist
  const dl = document.getElementById('site-datalist');
  if (dl) {
    const codes       = getAllSiteCodes();
    const statusCodes = ['A/L','U/L','RDO','PH','TAFE','OFF','JURY'];
    const all         = [...new Set([...codes, ...statusCodes])].sort();
    dl.innerHTML = all.map(s => {
      const site  = STATE.sites.find(x => x.abbr === s);
      const label = site ? `${s}  |  ${esc(site.name)}` : s;
      return `<option value="${s}" label="${label}">`;
    }).join('');
  }

  const dayHeaderHtml = '<div style="display:flex;align-items:center;margin-bottom:2px">'
    + '<div style="min-width:160px;flex-shrink:0"></div>'
    + '<div style="flex:1;display:flex">'
    + days.map((d, i) => `<div style="flex:1;text-align:center;font-size:9px;font-weight:700;color:var(--ink-3);letter-spacing:.6px;text-transform:uppercase;padding:4px 0;border-right:1px solid var(--border)">${dayLabels[d]}<br><span style="font-weight:400;letter-spacing:0">${weekDatesE[i]}</span></div>`).join('')
    + '</div>'
    + '<div style="width:80px;flex-shrink:0"></div>'
    + '</div>';

  let html = dayHeaderHtml;
  groups.forEach(g => {
    let people = STATE.people.filter(p => p.group === g);
    // v3.4.78: apply the team filter from the topbar pill row.
    if (typeof personInActiveTeam === 'function') {
      people = people.filter(p => personInActiveTeam(p.id));
    }
    if (!people.length) return;
    people = [...people].sort((a, b) => editorSort === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    const gClass = g === 'Apprentice' ? 'apprentice' : g === 'Labour Hire' ? 'labour' : 'direct';

    html += `<div style="margin-bottom:14px">
      <div class="group-strip ${gClass}" style="border-radius:8px 8px 0 0;margin-bottom:3px">
        <span>${gIcon[g]}</span><span>${g}</span>
      </div>`;

    people.forEach(p => {
      const s = getPersonSchedule(p.name, week);
      const isOnLeaveAllWeek = ['mon','tue','wed','thu','fri'].every(d2 => isLeave(s[d2] || ''));
      html += `<div class="roster-editor-row">
        <div class="editor-name">${esc(p.name)}${!p.phone ? '<span class="flag" title="No phone recorded">📵</span>' : ''}</div>
        <div class="editor-days">
          ${days.map(d => {
            const val = (s[d] || '').toUpperCase();
            const isWeekday = ['mon','tue','wed','thu','fri'].includes(d);
            const isEmpty = !val || !val.trim();
            const needsAttention = isWeekday && isEmpty && !isOnLeaveAllWeek;
            const copied = typeof isCopiedCell === 'function' && isCopiedCell(p.name, d);
            let cellClass = 'editor-day';
            if (copied) cellClass += ' copied-cell';
            if (needsAttention) cellClass += ' empty-cell';
            return `<div class="${cellClass}">
            <input type="text" list="site-datalist"
              value="${val}"
              placeholder="${d.toUpperCase()}"
              data-name="${esc(p.name)}" data-week="${week}" data-day="${d}"
              oninput="handleCellInput(this)"
              onchange="updateCell(this)"
              onfocus="if (typeof presenceFocus==='function') presenceFocus(this.dataset.name, this.dataset.week, this.dataset.day)"
              onblur="if (typeof presenceBlur==='function') presenceBlur(this.dataset.name, this.dataset.week, this.dataset.day)"
              autocomplete="off" spellcheck="false">
          </div>`;
          }).join('')}
        </div>
        <div class="editor-actions">
          <button class="btn-icon" title="Fill Mon\u2013Fri" onclick="fillWeek('${p.name.replace(/'/g,"\\'")}','${week}')" style="font-size:10px;color:var(--navy-3)">\u21D2wk</button>
          <button class="btn-icon" title="Edit" onclick="editPerson('${p.id}')">✎</button>
          <button class="btn-icon" style="color:var(--red)" title="Clear week"
            data-pname="${esc(p.name)}" data-week="${week}"
            onclick="confirmClearWeek(this.dataset.pname, this.dataset.week)">⌫</button>
        </div>
      </div>`;
    });
    html += '</div>';
  });

  document.getElementById('editor-content').innerHTML = html;
  document.querySelectorAll('#editor-content input[type=text]').forEach(inputColor);
  // v3.4.47: re-apply presence outlines after each editor render so a
  // remote-driven re-render (e.g. live update from another supervisor)
  // doesn't drop the indicators.
  if (typeof _presenceRender === 'function') _presenceRender();
  const sb = document.getElementById('editor-sort-btn');
  if (sb) sb.textContent = editorSort === 'asc' ? 'A–Z ▲' : 'Z–A ▼';
}

// ── My Schedule ───────────────────────────────────────────────
function renderSchedule() {
  const name = document.getElementById('schedule-person').value;
  const week = STATE.currentWeek;
  const days = ['mon','tue','wed','thu','fri'];
  const dayLabels = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const colorMap = { blue:'#2563EB', green:'#16A34A', amber:'#D97706', red:'#DC2626', grey:'#94A3B8', purple:'#7C77B9', empty:'#CBD5E1' };

  if (!name) {
    document.getElementById('schedule-content').innerHTML =
      '<div class="empty" style="margin-top:40px"><div class="empty-icon">👤</div><p>Select your name above to see your schedule</p></div>';
    return;
  }

  const person = STATE.people.find(p => p.name === name);
  const sched  = getPersonSchedule(name, week);
  const weekDates = getWeekDates(week);

  // ── Today / past awareness ────────────────────────────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [wd, wm, wy] = week.split('.').map(Number);
  const weekStart = new Date(2000 + wy, wm - 1, wd); weekStart.setHours(0, 0, 0, 0);

  const dayRows = days.map((d, i) => {
    const dayDate = new Date(weekStart.getTime() + i * 86400000);
    const isToday = dayDate.getTime() === today.getTime();
    const isPast  = dayDate < today;

    const s     = sched[d] || '';
    const col   = siteColor(s);
    const color = colorMap[col] || '#94A3B8';
    const fullN = getSiteName(s);
    const addr  = getSiteAddress(s);
    const isOff = !s || isLeave(s);
    const st    = STATE.sites.find(x => x.abbr === s);

    const wrapExtra = isToday ? 'border-left:3px solid #1F335C;' : isPast ? 'opacity:0.5;' : '';

    return `<div style="display:flex;align-items:stretch;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm);${wrapExtra}">
      <div style="width:90px;flex-shrink:0;background:${isToday ? 'rgba(31,51,92,0.07)' : 'var(--surface-2)'};border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 10px;gap:4px">
        <div style="font-size:10px;font-weight:700;color:${isToday ? '#1F335C' : 'var(--ink-3)'};text-transform:uppercase;letter-spacing:.6px">${dayLabels[i]}</div>
        <div style="font-size:10px;color:${isToday ? '#1F335C' : 'var(--ink-4)'};font-weight:${isToday ? '700' : 'normal'}">${weekDates[i]}</div>
        ${isToday ? '<div style="font-size:8px;font-weight:700;color:#7C77B9;letter-spacing:.05em;margin-top:1px">TODAY</div>' : ''}
        <div style="width:8px;height:8px;border-radius:50%;background:${isOff ? 'var(--ink-4)' : color}"></div>
      </div>
      <div style="flex:1;padding:14px 16px;display:flex;flex-direction:column;justify-content:center;gap:3px">
        ${isOff
          ? `<div style="font-size:13px;font-weight:600;color:var(--ink-3)">${s || '—'}</div>`
          : `<div style="font-size:13.5px;font-weight:700;color:${color}">${esc(fullN)}</div>
             ${addr ? `<div style="font-size:11px;color:var(--ink-3);display:flex;align-items:center;gap:5px"><span>📍</span>${esc(addr)}</div>` : ''}
             ${fullN !== s && s ? `<div style="font-size:10px;color:var(--ink-4);font-family:monospace;margin-top:1px">${esc(s)}</div>` : ''}
             ${st && st.site_lead ? `<div style="font-size:11px;color:var(--navy);margin-top:3px;display:flex;align-items:center;gap:5px"><span>👤</span><strong>${esc(st.site_lead)}</strong>${st.site_lead_phone ? ` — <a href="tel:${st.site_lead_phone}" style="color:var(--blue);text-decoration:none">${st.site_lead_phone}</a>` : ''}</div>` : ''}`
        }
      </div>
      ${!isOff && addr
        ? `<a href="https://maps.google.com/?q=${encodeURIComponent(addr)}" target="_blank" style="display:flex;align-items:center;padding:0 14px;color:var(--ink-4);text-decoration:none;border-left:1px solid var(--border);font-size:18px;flex-shrink:0" title="Open in Google Maps">↗</a>`
        : ''}
    </div>`;
  }).join('');

  document.getElementById('schedule-content').innerHTML = `
    <div class="schedule-hero" style="max-width:600px">
      <div class="schedule-hero-name">${esc(name)}</div>
      <div class="schedule-hero-meta">${person ? person.group : ''}${person && person.licence ? ' · ' + person.licence : ''}${person && person.agency ? ' · ' + person.agency : ''} &nbsp;·&nbsp; w/c ${week}</div>
    </div>
    <div style="max-width:600px;display:flex;flex-direction:column;gap:8px">${dayRows}</div>
    ${person && person.phone ? `<div style="margin-top:14px;max-width:600px"><a class="contact-phone" href="tel:${person.phone}" style="display:inline-flex">📞 ${person.phone}</a></div>` : ''}`;
}

// ── Staff jobs panel (for staff TS self-entry) ─────────────────
function renderStaffJobsPanel() {
  const container = document.getElementById('staff-jobs-list');
  if (!container) return;
  const activeJobs = (typeof jobNumbers !== 'undefined' ? jobNumbers : []).filter(j => j.status === 'Active');
  if (!activeJobs.length) { container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-4);font-size:12px">No job numbers added yet</div>'; return; }

  const groups = {};
  activeJobs.forEach(j => { const site = j.site_name || 'No Site'; if (!groups[site]) groups[site] = []; groups[site].push(j); });
  const siteNames = Object.keys(groups).sort((a, b) => a === 'No Site' ? 1 : b === 'No Site' ? -1 : a.localeCompare(b));

  let html = '';
  siteNames.forEach(site => {
    const jobs   = groups[site];
    const siteId = 'sjg-' + site.replace(/[^a-zA-Z0-9]/g, '_');
    html += `<div style="border-bottom:1px solid var(--border)">
      <div onclick="toggleStaffJobGroup('${siteId}', this)" style="padding:8px 12px;background:var(--surface-2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none">
        <span style="font-size:11px;font-weight:700;color:var(--navy)">${esc(site)}</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;color:var(--ink-3)">${jobs.length}</span><span class="sjg-arrow" style="font-size:9px;color:var(--ink-4);transition:transform .2s">▼</span></span>
      </div>
      <div id="${siteId}" style="display:none">
        ${jobs.map(j => `
          <div onclick="copyJobNumber('${esc(j.number)}')" style="padding:7px 12px 7px 16px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:8px" onmouseover="this.style.background='#F0EEFA'" onmouseout="this.style.background=''">
            <div style="flex:1;min-width:0">
              <span style="font-size:12px;font-weight:700;color:var(--navy)">${esc(j.number)}</span>
              ${j.description ? ` <span style="font-size:11px;color:var(--ink-3)">${esc(j.description)}</span>` : ''}
              ${j.client ? `<div style="font-size:9px;color:var(--ink-4)">${esc(j.client)}</div>` : ''}
            </div>
            <span style="font-size:10px;color:var(--purple);flex-shrink:0">TAP</span>
          </div>`).join('')}
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

function toggleStaffJobGroup(id, headerEl) {
  const el = document.getElementById(id);
  if (!el) return;
  const show = el.style.display === 'none';
  el.style.display = show ? '' : 'none';
  const arrow = headerEl.querySelector('.sjg-arrow');
  if (arrow) arrow.style.transform = show ? 'rotate(0deg)' : 'rotate(-90deg)';
}

let lastFocusedJobInput = null;
document.addEventListener('focusin', function(e) {
  if (e.target && e.target.dataset && e.target.dataset.type === 'job') lastFocusedJobInput = e.target;
});

function copyJobNumber(num) {
  if (lastFocusedJobInput) {
    lastFocusedJobInput.value = num;
    lastFocusedJobInput.dispatchEvent(new Event('change'));
    showToast('✓ ' + num + ' filled into ' + (lastFocusedJobInput.dataset.day || '').toUpperCase());
    const hrsInput = lastFocusedJobInput.parentElement.parentElement.querySelector('input[data-type="hrs"]');
    if (hrsInput) hrsInput.focus();
  } else {
    if (navigator.clipboard) { navigator.clipboard.writeText(num).then(() => showToast('📋 Copied ' + num)); }
    else showToast('Tap a Job No. field first, then tap ' + num);
  }
}

function filterStaffJobs(query) {
  const q         = query.toLowerCase();
  const container = document.getElementById('staff-jobs-list');
  if (!container) return;
  if (q) {
    container.querySelectorAll('[id^="sjg-"]').forEach(el => el.style.display = '');
    container.querySelectorAll('.sjg-arrow').forEach(el => el.style.transform = 'rotate(0deg)');
    container.querySelectorAll('div[onclick^="copyJobNumber"]').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    container.querySelectorAll('[id^="sjg-"]').forEach(group => {
      const visible = group.querySelectorAll('div[onclick^="copyJobNumber"]:not([style*="display: none"])');
      group.parentElement.style.display = visible.length ? '' : 'none';
    });
  } else {
    container.querySelectorAll('[id^="sjg-"]').forEach(el => el.style.display = 'none');
    container.querySelectorAll('.sjg-arrow').forEach(el => el.style.transform = 'rotate(-90deg)');
    container.querySelectorAll('div[onclick^="copyJobNumber"]').forEach(row => row.style.display = '');
    container.querySelectorAll('[id^="sjg-"]').forEach(g => g.parentElement.style.display = '');
  }
}

function showStaffTab(tab) {
  const tabTs   = document.getElementById('staff-tab-ts');
  const tabJobs = document.getElementById('staff-tab-jobs');
  if (tabTs)   tabTs.className   = tab === 'ts'   ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
  if (tabJobs) tabJobs.className = tab === 'jobs' ? 'btn btn-sm' : 'btn btn-secondary btn-sm';
  const tsContent = document.getElementById('staff-ts-content');
  const jp        = document.getElementById('staff-jobs-panel');
  if (tab === 'ts') {
    if (tsContent) tsContent.style.display = '';
    if (jp) jp.style.display = 'none';
    renderStaffTs();
  } else {
    if (tsContent) tsContent.style.display = 'none';
    if (jp) { jp.style.display = ''; jp.style.width = '100%'; jp.style.borderLeft = 'none'; jp.style.paddingLeft = '0'; }
    renderStaffJobsPanel();
  }
}

// ── Roster week navigation ────────────────────────────────────
// Renders prev/next week arrows on the roster page with
// adjacent week pre-loading and a slide transition.

let _rosterWeekTransitioning = false;

function renderRosterWeekNav() {
  const container = document.getElementById('roster-week-nav');
  if (!container) return;

  const sel      = document.getElementById('globalWeek');
  const opts     = sel ? [...sel.options].map(o => o.value) : [];
  const currIdx  = opts.indexOf(STATE.currentWeek);
  const prevWeek = currIdx > 0 ? opts[currIdx - 1] : null;
  const nextWeek = currIdx < opts.length - 1 ? opts[currIdx + 1] : null;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button
        onclick="slideRosterWeek(-1)"
        ${!prevWeek ? 'disabled' : ''}
        style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);border-radius:var(--radius);background:${prevWeek ? 'white' : 'var(--surface-2)'};color:${prevWeek ? 'var(--navy)' : 'var(--ink-4)'};font-family:inherit;font-size:12px;font-weight:600;cursor:${prevWeek ? 'pointer' : 'default'};transition:all .12s"
        title="${prevWeek ? 'Week of ' + prevWeek : 'No earlier weeks'}"
      >
        ‹ ${prevWeek ? '<span style="font-size:11px;color:var(--ink-3)">' + prevWeek + '</span>' : 'No earlier weeks'}
      </button>

      <div style="flex:1;text-align:center;min-width:180px">
        <div style="font-size:13px;font-weight:700;color:var(--navy)">${formatWeekLabel(STATE.currentWeek)}</div>
        <div style="font-size:10px;color:var(--ink-3);margin-top:1px">${STATE.currentWeek}</div>
      </div>

      <button
        onclick="slideRosterWeek(1)"
        ${!nextWeek ? 'disabled' : ''}
        style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);border-radius:var(--radius);background:${nextWeek ? 'white' : 'var(--surface-2)'};color:${nextWeek ? 'var(--navy)' : 'var(--ink-4)'};font-family:inherit;font-size:12px;font-weight:600;cursor:${nextWeek ? 'pointer' : 'default'};transition:all .12s"
        title="${nextWeek ? 'Week of ' + nextWeek : 'No future weeks'}"
      >
        ${nextWeek ? '<span style="font-size:11px;color:var(--ink-3)">' + nextWeek + '</span>' : 'No future weeks'} ›
      </button>
    </div>`;
}

async function slideRosterWeek(dir) {
  if (_rosterWeekTransitioning) return;

  const sel     = document.getElementById('globalWeek');
  const opts    = sel ? [...sel.options].map(o => o.value) : [];
  const currIdx = opts.indexOf(STATE.currentWeek);
  const nextIdx = currIdx + dir;
  if (nextIdx < 0 || nextIdx >= opts.length) return;

  _rosterWeekTransitioning = true;

  const content = document.getElementById('roster-content');
  if (content) {
    content.style.transition  = 'opacity .15s, transform .15s';
    content.style.opacity     = '0';
    content.style.transform   = `translateX(${dir > 0 ? '-20px' : '20px'})`;
  }

  await new Promise(r => setTimeout(r, 150));

  // Switch week
  STATE.currentWeek = opts[nextIdx];
  sel.value         = STATE.currentWeek;
  saveCurrentWeek();
  updateWeekLabel();
  updateTopStats();

  // Re-render
  renderRosterWeekNav();
  renderRoster();

  // Animate in
  if (content) {
    content.style.transform = `translateX(${dir > 0 ? '20px' : '-20px'})`;
    content.style.opacity   = '0';
    await new Promise(r => setTimeout(r, 10));
    content.style.transition  = 'opacity .2s, transform .2s';
    content.style.opacity     = '1';
    content.style.transform   = 'translateX(0)';
  }

  // Reset
  await new Promise(r => setTimeout(r, 210));
  if (content) { content.style.transition = ''; content.style.transform = ''; content.style.opacity = ''; }
  _rosterWeekTransitioning = false;

  // Pre-load adjacent weeks' data silently
  _preloadAdjacentWeeks(opts, nextIdx);
}

function _preloadAdjacentWeeks(opts, currIdx) {
  // Just ensures schedule entries for adjacent weeks are in STATE.schedule
  // For demo tenant this is a no-op. For live tenants, data is already loaded globally.
  // Future: could lazy-load specific weeks here.
}