/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/people.js  —  EQ Solves Field
// People CRUD: add, edit, remove, contacts list render.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

// ── DOB / start-date helpers (v3.4.16) ────────────────────────
// DOB is stored as day + month only (no year) to avoid age-based
// signals. Anniversaries come from start_date (ISO). All helpers
// are null-safe so legacy rows missing these columns just return
// empty strings / false.
const MONTH_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function personHasDob(p) {
  return !!(p && p.dob_day && p.dob_month);
}

// Today's month/day in local (Australian) time.
function _todayMD() {
  const d = new Date();
  return { m: d.getMonth() + 1, d: d.getDate() };
}

// Days until the next occurrence of month/day starting from today.
// 0 = today, 1 = tomorrow, …, never > 365.
function _daysUntilMD(month, day) {
  if (!month || !day) return null;
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target  = new Date(now.getFullYear(), month - 1, day);
  if (target < today) target = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((target - today) / 86400000);
}

function personBirthdayLabel(p) {
  if (!personHasDob(p)) return '';
  return p.dob_day + ' ' + MONTH_SHORT[p.dob_month];
}

function personIsBirthdayToday(p) {
  if (!personHasDob(p)) return false;
  const t = _todayMD();
  return t.m === p.dob_month && t.d === p.dob_day;
}

// Returns anniversary-year number on matching date (1, 2, 3 …) or 0.
// Only fires on the exact day; returns 0 on year-0 (start day).
function personAnniversaryYearsToday(p) {
  if (!p || !p.start_date) return 0;
  const s = new Date(p.start_date + 'T00:00:00');
  if (isNaN(s.getTime())) return 0;
  const now = new Date();
  if (s.getMonth() !== now.getMonth() || s.getDate() !== now.getDate()) return 0;
  const years = now.getFullYear() - s.getFullYear();
  return years > 0 ? years : 0;
}

// ── Year helpers (v3.4.10) ────────────────────────────────────
// Apprentice year is captured as a free-text-shaped string in
// people.licence ('1st Year', '2nd Year', …) but the Apprentices
// page reads people.year_level (int 1..4). yearFromLicence keeps
// the two in sync — we derive the int on save so apprentices.js
// can render the year badge without a second click into the
// Apprentice Profile modal.
function yearFromLicence(licence) {
  if (!licence) return null;
  const m = String(licence).trim().match(/^([1-4])(?:st|nd|rd|th)\s+Year$/i);
  return m ? parseInt(m[1], 10) : null;
}

// Compact year pill for the contacts table — matches the colour
// scheme used by yearBadge() in apprentices.js so the visual
// language stays consistent across pages.
function contactsYearBadge(year) {
  if (!year) return '';
  const labels = { 1: '1st Yr', 2: '2nd Yr', 3: '3rd Yr', 4: '4th Yr' };
  const palette = {
    1: 'background:#EFF4FF;color:#2563EB',
    2: 'background:#F0FDF4;color:#16A34A',
    3: 'background:#FFFBEB;color:#D97706',
    4: 'background:#EEEDF8;color:#7C77B9'
  };
  const style = palette[year] || 'background:#F8FAFC;color:#64748B';
  const label = labels[year] || (year + 'th Yr');
  return '<span title="Apprentice year" style="' + style + ';border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px">🎓 ' + label + '</span>';
}

// ── Licence / Year field swap (v3.4.6) ────────────────────────
// When group=Apprentice we show a year dropdown. Other groups get
// a free-text input. Field id stays 'person-licence' in both cases
// so save/read code is unchanged.
function refreshPersonLicenceField(group, value) {
  const slot = document.getElementById('person-licence-slot');
  const label = document.getElementById('person-licence-label');
  if (!slot) return;

  if (group === 'Apprentice') {
    if (label) label.textContent = 'Year';
    const years = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
    // If incoming value doesn't match a known year, default to 1st Year.
    const sel = years.includes(value) ? value : '1st Year';
    let html = '<select class="form-select" id="person-licence">';
    years.forEach(y => {
      html += '<option value="' + y + '"' + (y === sel ? ' selected' : '') + '>' + y + '</option>';
    });
    html += '</select>';
    slot.innerHTML = html;
  } else {
    if (label) label.textContent = 'Licence';
    slot.innerHTML = '<input class="form-input" id="person-licence" placeholder="e.g. Licensed" value="' + (value ? String(value).replace(/"/g, '&quot;') : '') + '">';
  }
}

function openAddPerson() {
  if (!isManager) { showToast('Supervision access required'); return; }
  document.getElementById('modal-person-title').textContent = 'Add Person';
  document.getElementById('person-edit-id').value = '';
  document.getElementById('person-name').value    = '';
  document.getElementById('person-phone').value   = '';
  document.getElementById('person-group').value   = 'Direct';
  refreshPersonLicenceField('Direct', '');
  document.getElementById('person-agency').value  = '';
  document.getElementById('person-email').value   = '';
  const tafeEl = document.getElementById('person-tafe-day');
  if (tafeEl) tafeEl.value = '';
  const pinEl = document.getElementById('person-pin');
  if (pinEl) pinEl.value = '';
  // v3.4.16: DOB (day + month) and start date
  const dobDayEl   = document.getElementById('person-dob-day');
  const dobMonthEl = document.getElementById('person-dob-month');
  const startEl    = document.getElementById('person-start-date');
  if (dobDayEl)   dobDayEl.value   = '';
  if (dobMonthEl) dobMonthEl.value = '';
  if (startEl)    startEl.value    = '';
  openModal('modal-person');
  try {
    if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
      window.EQ_ANALYTICS.events.peopleModalOpened({ mode: 'add' });
    }
  } catch (e) {}
}

function editPerson(id) {
  if (!isManager) { showToast('Supervision access required'); return; }
  // v3.4.22: coerce both sides to string so uuid (eq) AND bigint (sks) match
  const p = STATE.people.find(x => String(x.id) === String(id));
  if (!p) return;
  document.getElementById('modal-person-title').textContent = 'Edit Person';
  document.getElementById('person-edit-id').value = id;
  document.getElementById('person-name').value    = p.name;
  document.getElementById('person-phone').value   = p.phone   || '';
  document.getElementById('person-group').value   = p.group;
  refreshPersonLicenceField(p.group, p.licence || '');
  document.getElementById('person-agency').value  = p.agency  || '';
  document.getElementById('person-email').value   = p.email   || '';
  const tafeEl = document.getElementById('person-tafe-day');
  if (tafeEl) tafeEl.value = p.tafe_day || '';
  const pinEl = document.getElementById('person-pin');
  if (pinEl) pinEl.value = ''; // never pre-fill PIN
  // v3.4.16: DOB (day + month) and start date
  const dobDayEl   = document.getElementById('person-dob-day');
  const dobMonthEl = document.getElementById('person-dob-month');
  const startEl    = document.getElementById('person-start-date');
  if (dobDayEl)   dobDayEl.value   = p.dob_day   || '';
  if (dobMonthEl) dobMonthEl.value = p.dob_month || '';
  if (startEl)    startEl.value    = p.start_date || '';
  openModal('modal-person');
  try {
    if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
      window.EQ_ANALYTICS.events.peopleModalOpened({ mode: 'edit' });
    }
  } catch (e) {}
}

// Called when group select changes while the modal is open.
function onPersonGroupChange() {
  const group = document.getElementById('person-group').value;
  // Carry over current value so typed text isn't lost when toggling back.
  const current = (document.getElementById('person-licence') || {}).value || '';
  refreshPersonLicenceField(group, current);
}

function savePerson() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const id      = document.getElementById('person-edit-id').value;
  const name    = document.getElementById('person-name').value.trim();
  const phone   = document.getElementById('person-phone').value.trim();
  const group   = document.getElementById('person-group').value;
  const licence = document.getElementById('person-licence').value.trim();
  const agency  = document.getElementById('person-agency').value.trim();
  const email   = document.getElementById('person-email').value.trim().toLowerCase();
  const tafeEl  = document.getElementById('person-tafe-day');
  const tafeDay = tafeEl ? (tafeEl.value || null) : null;
  const pinRaw  = (document.getElementById('person-pin') || { value: '' }).value.trim();
  const newPin  = (isManager && /^\d{4}$/.test(pinRaw)) ? pinRaw : null;

  // v3.4.16: DOB + start date. Empty fields store as null; partial
  // DOB (day without month or vice versa) is cleared so the dashboard
  // widget never tries to render a half-entered birthday.
  const dobDayRaw   = (document.getElementById('person-dob-day')   || { value: '' }).value.trim();
  const dobMonthRaw = (document.getElementById('person-dob-month') || { value: '' }).value.trim();
  const startRaw    = (document.getElementById('person-start-date') || { value: '' }).value.trim();
  let   dobDay     = dobDayRaw   ? parseInt(dobDayRaw,   10) : null;
  let   dobMonth   = dobMonthRaw ? parseInt(dobMonthRaw, 10) : null;
  if (!dobDay || !dobMonth || dobDay < 1 || dobDay > 31 || dobMonth < 1 || dobMonth > 12) {
    dobDay = null; dobMonth = null;
  }
  const startDate  = (startRaw && /^\d{4}-\d{2}-\d{2}$/.test(startRaw)) ? startRaw : null;

  if (!name) { showToast('Name is required'); return; }

  // v3.4.10: derive year_level from licence so the Apprentices page
  // (which keys on year_level) stays in sync with the Add Person form.
  // Non-apprentices get year_level wiped to keep stale values from
  // bleeding through if the group is changed later.
  const yearLevel = group === 'Apprentice' ? yearFromLicence(licence) : null;

  let person;
  if (id) {
    // v3.4.22: id is uuid (eq) or bigint-as-string (sks); coerce both sides
    person = STATE.people.find(x => String(x.id) === String(id));
    if (person) {
      person.name       = name;
      person.phone      = phone;
      person.group      = group;
      person.licence    = licence;
      person.year_level = yearLevel;
      person.agency     = agency;
      person.email      = email;
      person.tafe_day   = tafeDay;
      // v3.4.16
      person.dob_day    = dobDay;
      person.dob_month  = dobMonth;
      person.start_date = startDate;
      if (newPin) person.pin = newPin;
    }
    showToast(`${name} updated`);
  } else {
    const newId = Math.max(0, ...STATE.people.map(p => p.id)) + 1;
    person = {
      id: newId, name, phone, group, licence, year_level: yearLevel,
      agency, email, tafe_day: tafeDay,
      dob_day: dobDay, dob_month: dobMonth, start_date: startDate,
      pin: newPin || null
    };
    STATE.people.push(person);
    showToast(`${name} added`);
  }

  closeModal('modal-person');
  refreshPersonSelects();
  document.getElementById('badge-contacts').textContent = STATE.people.filter(p => !p.archived).length;
  updateTopStats();
  renderCurrentPage();
  auditLog(id ? `Updated: ${name}` : `Added: ${name}`, 'People', `Group: ${group}`, null);
  savePersonToSB(person).catch(() => showToast('Save failed — check connection'));

  try {
    if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
      window.EQ_ANALYTICS.events.peopleModalSaved({
        mode: id ? 'edit' : 'add',
        has_apprentice_year: yearLevel != null,
      });
    }
  } catch (e) {}
}

function confirmRemove(id, name) {
  if (!isManager) { showToast('Supervision access required'); return; }
  document.getElementById('confirm-title').textContent = 'Remove Person';
  document.getElementById('confirm-msg').textContent =
    `Remove ${name} from the roster? Their schedule entries will also be cleared.`;
  document.getElementById('confirm-action').textContent = 'Remove';
  document.getElementById('confirm-action').onclick = () => removePerson(id, name);
  openModal('modal-confirm');
}

function removePerson(id, name) {
  if (!isManager) { showToast('Supervision access required'); return; }
  // v3.4.55: idempotency + id-coercion fix.
  // — Early-return if the person is already gone from STATE.people. This
  //   makes a double-tap on ✕ a no-op for the second click instead of firing
  //   duplicate auditLog / showToast / deletePersonFromSB. Same bug class
  //   as the leave-handlers in v3.4.54 (#24) and managers.removeManager in
  //   v3.4.53 (#22).
  // — String() coercion on both sides of the filter — managers.js had the
  //   same bug pre-v3.4.53 where SKS bigint ids returned as strings made
  //   the strict `!==` always true and the row lingered locally.
  if (!STATE.people.some(p => String(p.id) === String(id))) return;
  STATE.people   = STATE.people.filter(p => String(p.id) !== String(id));
  STATE.schedule = STATE.schedule.filter(s => s.name !== name);

  // BUG-003 FIX: Clear schedule index for this person
  if (STATE.scheduleIndex) {
    Object.keys(STATE.scheduleIndex)
      .filter(k => k.startsWith(name + '||'))
      .forEach(k => delete STATE.scheduleIndex[k]);
  }

  closeModal('modal-confirm');
  refreshPersonSelects();
  document.getElementById('badge-contacts').textContent = STATE.people.filter(p => !p.archived).length;
  updateTopStats();
  renderCurrentPage();
  showToast(`${name} removed`);
  auditLog(`Removed: ${name}`, 'People', null, null);

  // BUG-003 FIX: These were missing — person reappeared on next sync without them
  deletePersonFromSB(id).catch(() => showToast('Removed locally — server delete failed'));
  sbFetch('schedule?name=eq.' + encodeURIComponent(name), 'DELETE').catch(() => {});
}

// v3.4.70: archive — reversible soft-hide. Sets archived=true, keeps row +
// schedule entries intact. Different from the delete path (which wipes the
// person + clears schedule entries permanently).
function archivePerson(id, name) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const p = STATE.people.find(x => String(x.id) === String(id));
  if (!p) return;
  p.archived = true;
  document.getElementById('badge-contacts').textContent =
    STATE.people.filter(x => !x.archived).length;
  renderCurrentPage();
  archivePersonInSB(id, true).catch(() => {
    p.archived = false;
    document.getElementById('badge-contacts').textContent =
      STATE.people.filter(x => !x.archived).length;
    renderCurrentPage();
    showToast('Archive failed — check connection');
  });
  showToast(`${name} archived`);
  auditLog(`Archived: ${name}`, 'People', null, null);
}

function restorePerson(id, name) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const p = STATE.people.find(x => String(x.id) === String(id));
  if (!p) return;
  p.archived = false;
  document.getElementById('badge-contacts').textContent =
    STATE.people.filter(x => !x.archived).length;
  renderCurrentPage();
  archivePersonInSB(id, false).catch(() => {
    p.archived = true;
    document.getElementById('badge-contacts').textContent =
      STATE.people.filter(x => !x.archived).length;
    renderCurrentPage();
    showToast('Restore failed — check connection');
  });
  showToast(`${name} restored`);
  auditLog(`Restored: ${name}`, 'People', null, null);
}

// ── Contacts render ───────────────────────────────────────────

// v3.4.46: shared cell helpers used by both renderContacts() branches
// (mobile cards + desktop table). Adding/changing an action button or
// the no-phone fallback styling now updates one place instead of two.
function _personActions(p) {
  // v3.4.70: archived rows show Restore + Delete (no edit). Active rows show
  // Edit + Archive + Delete. Archive = reversible; Delete = permanent.
  if (p.archived) {
    return `<button class="btn-icon" title="Restore from archive"
        data-pid="${p.id}" data-pname="${esc(p.name)}"
        onclick="restorePerson(this.dataset.pid, this.dataset.pname)" style="color:var(--green)">↺</button>
      <button class="btn-icon" style="color:var(--red)" title="Delete permanently"
        data-pid="${p.id}" data-pname="${esc(p.name)}"
        onclick="confirmRemove(this.dataset.pid, this.dataset.pname)">✕</button>`;
  }
  return `<button class="btn-icon" title="Edit" onclick="editPerson('${p.id}')">✎</button>
    <button class="btn-icon" title="Archive (reversible)"
      data-pid="${p.id}" data-pname="${esc(p.name)}"
      onclick="archivePerson(this.dataset.pid, this.dataset.pname)" style="color:var(--ink-3)">📦</button>
    <button class="btn-icon" style="color:var(--red)" title="Delete permanently"
      data-pid="${p.id}" data-pname="${esc(p.name)}"
      onclick="confirmRemove(this.dataset.pid, this.dataset.pname)">✕</button>`;
}
function _personPhone(p, size) {
  if (!p.phone) {
    return size === 'mobile'
      ? '<span style="color:#EF4444;font-size:12px">No phone</span>'
      : '<span style="color:#EF4444;font-size:11px">No phone</span>';
  }
  return size === 'mobile'
    ? `<a href="tel:${esc(p.phone)}" style="color:var(--purple);font-weight:600;text-decoration:none;font-size:14px">${esc(p.phone)}</a>`
    : `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`;
}
function _personEmail(p, size) {
  if (!p.email) return size === 'mobile' ? '' : '—';
  return size === 'mobile'
    ? `<a href="mailto:${esc(p.email)}" style="color:var(--purple);font-size:11px;text-decoration:none">${esc(p.email)}</a>`
    : `<a href="mailto:${esc(p.email)}" style="color:var(--purple);text-decoration:none">${esc(p.email)}</a>`;
}

function setContactsSort(col) {
  if (contactsSort.col === col) {
    contactsSort.dir = contactsSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    contactsSort.col = col;
    contactsSort.dir = 'asc';
  }
  renderContacts();
}

function renderContacts() {
  const search = document.getElementById('contacts-search').value.toLowerCase();
  const group  = document.getElementById('contacts-group').value;
  // v3.4.70: archive filter — checkbox toggles inclusion of archived rows.
  const showArchived = !!(document.getElementById('contacts-show-archived') || {}).checked;
  let people   = STATE.people;

  if (!showArchived) people = people.filter(p => !p.archived);
  if (search) people = people.filter(p =>
    p.name.toLowerCase().includes(search) ||
    (p.phone && p.phone.includes(search)) ||
    (p.email && p.email.toLowerCase().includes(search))
  );
  if (group) people = people.filter(p => p.group === group);
  // v3.4.78: apply the topbar team filter to the contacts page too.
  // Same pill row drives both — no extra UI, just consistent behaviour.
  if (typeof personInActiveTeam === 'function') {
    people = people.filter(p => personInActiveTeam(p.id));
  }

  const { col, dir } = contactsSort;
  const mult = dir === 'asc' ? 1 : -1;
  people = [...people].sort((a, b) => {
    const av = (a[col] || 'zzz').toLowerCase();
    const bv = (b[col] || 'zzz').toLowerCase();
    return av < bv ? -mult : av > bv ? mult : 0;
  });

  if (!people.length) {
    document.getElementById('contacts-content').innerHTML =
      '<div class="empty"><div class="empty-icon">🔍</div><p>No contacts found</p></div>';
    return;
  }

  const groupBadge = {
    'Direct':      '<span style="background:var(--navy);color:white;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">Direct</span>',
    'Apprentice':  '<span style="background:var(--purple);color:white;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">App</span>',
    'Labour Hire': '<span style="background:var(--navy-3);color:white;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">LH</span>'
  };

  const tafeDayLabel = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri' };
  const tafeBadge = (p) => p.tafe_day && tafeDayLabel[p.tafe_day]
    ? `<span title="TAFE day" style="background:#EEEDF8;color:#7C77B9;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px">🎓 ${tafeDayLabel[p.tafe_day]}</span>`
    : '';

  // v3.4.16: today-only chips — birthday cake + anniversary
  const todayBadges = (p) => {
    let out = '';
    if (personIsBirthdayToday(p)) {
      out += '<span title="Birthday today" style="background:#FFF1F2;color:#E11D48;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px">🎂 Today</span>';
    }
    const years = personAnniversaryYearsToday(p);
    if (years > 0) {
      out += '<span title="Work anniversary today" style="background:#FEF3C7;color:#B45309;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px">🎉 ' + years + ' yr' + (years !== 1 ? 's' : '') + '</span>';
    }
    return out;
  };

  // v3.4.10: apprentice year badge. Prefer year_level (int);
  // fall back to parsing licence so legacy rows render correctly
  // before the backfill reaches them.
  const apprenticeYear = (p) => {
    if (p.group !== 'Apprentice') return null;
    return p.year_level || yearFromLicence(p.licence);
  };
  const yearPill = (p) => contactsYearBadge(apprenticeYear(p));

  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    const groups   = PEOPLE_GROUPS;
    const gColors  = { 'Direct': 'var(--navy)', 'Apprentice': 'var(--purple)', 'Labour Hire': 'var(--navy-3)' };
    let html = '';
    groups.forEach(g => {
      const gp = people.filter(p => p.group === g);
      if (!gp.length) return;
      html += `<div style="font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${gColors[g]};padding:10px 4px 6px">${g} (${gp.length})</div>`;
      gp.forEach(p => {
        // v3.4.70: archived rows visually distinct (faint tint + chip).
        const archStyle = p.archived ? 'background:#F8FAFC;opacity:.7' : 'background:white';
        const archChip  = p.archived
          ? '<span style="background:#E5E7EB;color:#6B7280;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700;margin-left:6px">ARCHIVED</span>'
          : '';
        html += `<div style="${archStyle};border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px;color:var(--navy);margin-bottom:4px">${esc(p.name)}${yearPill(p)}${todayBadges(p)}${archChip}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${_personPhone(p, 'mobile')}
              ${_personEmail(p, 'mobile')}
              ${p.agency ? `<span style="color:var(--ink-3);font-size:11px">· ${esc(p.agency)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${_personActions(p)}
          </div>
        </div>`;
      });
    });
    document.getElementById('contacts-content').innerHTML = html;
    return;
  }

  // Desktop table
  const cSort = contactsSort;
  const th = (c, label) => `<th class="sortable${cSort.col === c ? ' sort-' + cSort.dir : ''}" onclick="setContactsSort('${c}')" style="cursor:pointer;user-select:none">${label}</th>`;
  const html = `<div class="roster-card"><div class="table-scroll"><table style="width:100%">
    <thead><tr>
      ${th('name', 'Name')}${th('group', 'Group')}${th('phone', 'Phone')}${th('email', 'Email')}${th('agency', 'Agency')}
      <th class="center" style="width:90px">Actions</th>
    </tr></thead>
    <tbody>${people.map(p => {
      // v3.4.70: archived rows get faint tint + chip in desktop table too.
      const rowStyle = p.archived ? 'background:#F8FAFC;opacity:.7' : '';
      const archChip = p.archived
        ? '<span style="background:#E5E7EB;color:#6B7280;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700;margin-left:6px">ARCHIVED</span>'
        : '';
      return `
      <tr style="${rowStyle}">
        <td class="name-col">${esc(p.name)}${archChip}</td>
        <td style="white-space:nowrap">${groupBadge[p.group] || p.group}${yearPill(p)}${tafeBadge(p)}${todayBadges(p)}</td>
        <td class="phone-col">${_personPhone(p, 'desktop')}</td>
        <td class="meta-col">${_personEmail(p, 'desktop')}</td>
        <td class="meta-col">${p.agency || '—'}</td>
        <td class="center" style="white-space:nowrap">${_personActions(p)}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div></div>`;
  document.getElementById('contacts-content').innerHTML = html;
}

// ── PIN Management ────────────────────────────────────────────

function openPinManagement() {
  if (!isManager) { showToast('Supervision access required'); return; }
  renderPinList();
  openModal('modal-pin-mgmt');
}

function renderPinList() {
  const search = (document.getElementById('pin-search').value || '').toLowerCase();
  const el     = document.getElementById('pin-list');
  if (!el) return;

  let people = STATE.people
    .filter(p => p.group === 'Apprentice' || p.group === 'Labour Hire')
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  if (search) people = people.filter(p => p.name.toLowerCase().includes(search));

  if (!people.length) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px">No staff found</div>';
    return;
  }

  const groupColors = { Apprentice: 'var(--purple)', 'Labour Hire': 'var(--navy-3)' };
  const groupBadge  = { Apprentice: 'App', 'Labour Hire': 'LH' };

  let html = '';
  let lastGroup = '';
  people.forEach(p => {
    if (p.group !== lastGroup) {
      lastGroup = p.group;
      html += `<div style="padding:6px 12px;background:${groupColors[p.group]};color:white;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase">${p.group}</div>`;
    }
    const hasPin    = p.pin ? true : false;
    const pinStatus = hasPin
      ? `<span style="color:var(--green);font-size:10px;font-weight:700">✓ PIN set</span>`
      : `<span style="color:var(--ink-4);font-size:10px">No PIN</span>`;

    html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)">
      <input type="checkbox" class="pin-cb" data-id="${p.id}" data-name="${esc(p.name)}" style="width:15px;height:15px;accent-color:var(--navy);flex-shrink:0" onchange="updatePinCount()">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--navy)">${esc(p.name)}</div>
        <div style="font-size:11px;margin-top:2px">${pinStatus}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="number" placeholder="PIN" min="1000" max="9999"
          style="width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius);font-family:inherit;font-size:13px;text-align:center;letter-spacing:2px"
          onchange="saveIndividualPin(${p.id}, this.value, '${esc(p.name)}')">
      </div>
    </div>`;
  });

  el.innerHTML = html;
}

function updatePinCount() {
  const count  = document.querySelectorAll('.pin-cb:checked').length;
  const btn    = document.querySelector('[onclick="applyBulkPin()"]');
  if (btn) btn.textContent = `Apply to ${count} Selected`;
}

function pinSelectAll() {
  document.querySelectorAll('.pin-cb').forEach(cb => cb.checked = true);
  updatePinCount();
}

function pinClearAll() {
  document.querySelectorAll('.pin-cb').forEach(cb => cb.checked = false);
  updatePinCount();
}

async function saveIndividualPin(id, pinVal, name) {
  if (!isManager) return;
  const pin = parseInt(pinVal);
  if (!pin || pin < 1000 || pin > 9999) { showToast('PIN must be 4 digits'); return; }

  try {
    await sbFetch(`people?id=eq.${id}`, 'PATCH', { pin: String(pin) });
    const p = STATE.people.find(x => String(x.id) === String(id));
    if (p) p.pin = String(pin);
    showToast(`✓ PIN set for ${name}`);
    auditLog(`PIN set for ${name}`, 'People', null, null);
    renderPinList();
  } catch (e) {
    showToast('Failed to save PIN');
  }
}

async function applyBulkPin() {
  if (!isManager) return;
  const pinVal = parseInt(document.getElementById('pin-bulk-value').value);
  if (!pinVal || pinVal < 1000 || pinVal > 9999) { showToast('Enter a valid 4-digit PIN'); return; }

  const selected = [...document.querySelectorAll('.pin-cb:checked')].map(cb => ({
    id:   cb.dataset.id,
    name: cb.dataset.name
  }));
  if (!selected.length) { showToast('No staff selected'); return; }

  let count = 0;
  for (const person of selected) {
    try {
      await sbFetch(`people?id=eq.${person.id}`, 'PATCH', { pin: String(pinVal) });
      const p = STATE.people.find(x => String(x.id) === String(person.id));
      if (p) p.pin = String(pinVal);
      count++;
    } catch (e) { console.error('PIN save failed for', person.name, e); }
  }

  showToast(`✓ PIN set for ${count} staff member${count !== 1 ? 's' : ''}`);
  auditLog(`Bulk PIN set for ${count} staff`, 'People', null, null);
  document.getElementById('pin-bulk-value').value = '';
  renderPinList();
  pinClearAll();
}

async function clearBulkPin() {
  if (!isManager) return;
  const selected = [...document.querySelectorAll('.pin-cb:checked')].map(cb => ({
    id:   cb.dataset.id,
    name: cb.dataset.name
  }));
  if (!selected.length) { showToast('No staff selected'); return; }

  for (const person of selected) {
    try {
      await sbFetch(`people?id=eq.${person.id}`, 'PATCH', { pin: null });
      const p = STATE.people.find(x => String(x.id) === String(person.id));
      if (p) p.pin = null;
    } catch (e) {}
  }

  showToast(`PINs cleared for ${selected.length} staff`);
  auditLog(`PINs cleared for ${selected.length} staff`, 'People', null, null);
  renderPinList();
  pinClearAll();
}