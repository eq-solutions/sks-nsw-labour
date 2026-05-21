/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/import-export.js  —  EQ Solves Field
// Full backup/restore, CSV import/export for all entities,
// reset, import UI helpers (showImportConfirm, etc).
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

// ── CSV utilities ─────────────────────────────────────────────

// BUG-016 FIX: toCSV defined here — also safe if utils.js defines it first (last-wins on window)
function toCSV(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }).join(',')).join('\n');
}

function downloadCSV(csv, filename) {
  const a   = document.createElement('a');
  a.href    = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  return lines.map(line => {
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

// ── Import UI helpers ─────────────────────────────────────────

let _importConfirmCb = null;
let _importCancelCb  = null;
function _runImportConfirm() { if (_importConfirmCb) { _importConfirmCb(); _importConfirmCb = null; _importCancelCb = null; } }
function _runImportCancel()  { if (_importCancelCb)  { _importCancelCb();  _importConfirmCb = null; _importCancelCb = null; } }

function showImportConfirm(elId, summary, onConfirm, onCancel) {
  _importConfirmCb = onConfirm;
  _importCancelCb  = onCancel;
  const el = document.getElementById(elId);
  el.style.display = 'block';
  // BUG-013 FIX: escape summary
  el.innerHTML = `<div style="background:var(--blue-lt);border:1px solid #BFDBFE;border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-size:12px;color:var(--ink-2);flex:1">Ready to import <strong>${esc(String(summary))}</strong>. This will replace existing data. Confirm?</span>
    <button class="btn btn-primary btn-sm" onclick="_runImportConfirm()">Confirm Import</button>
    <button class="btn btn-secondary btn-sm" onclick="_runImportCancel()">Cancel</button>
  </div>`;
}

function showPreviewError(elId, msg) {
  const el = document.getElementById(elId);
  el.style.display = 'block';
  el.innerHTML     = `<div style="background:var(--red-lt);border:1px solid #FECACA;border-radius:8px;padding:10px 14px;font-size:11.5px;color:var(--red)">${esc(msg)}</div>`;
}

function hidePreview(elId) {
  const el = document.getElementById(elId);
  el.style.display = 'none';
  el.innerHTML     = '';
}

// ── People export / import ────────────────────────────────────

// v3.4.10: resolve apprentice year for CSV export.
// Reads people.year_level first, falls back to parsing the Licence
// string for rows saved before year_level was wired up.
function _resolveApprenticeYear(p) {
  if (!p || p.group !== 'Apprentice') return '';
  if (p.year_level) return p.year_level;
  const m = String(p.licence || '').trim().match(/^([1-4])(?:st|nd|rd|th)\s+Year$/i);
  return m ? parseInt(m[1], 10) : '';
}

// v3.4.16: DOB + start date helpers for CSV round-trip.
// Birthday column format is "DD-MMM" (e.g. "05-Mar"); empty if unset.
// Start Date column is ISO YYYY-MM-DD; empty if unset.
function _fmtCsvBirthday(p) {
  if (!p || !p.dob_day || !p.dob_month) return '';
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(p.dob_day).padStart(2, '0');
  return dd + '-' + months[p.dob_month];
}
function _parseCsvBirthday(raw) {
  if (!raw) return { dob_day: null, dob_month: null };
  const s = String(raw).trim();
  if (!s) return { dob_day: null, dob_month: null };
  // Accept: "DD-MMM", "DD/MM", "D Mon", "5-Mar", "5 March",
  //         "DD/MM/YYYY" (Excel AU default — v3.4.70), "DD-MM-YYYY"
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
                   january:1, february:2, march:3, april:4, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
  // v3.4.70: DD/MM/YYYY or DD-MM-YYYY (year ignored — we store day+month only).
  // Royce's SKS Contacts.xlsx exports Birthday as "25/12/1997" — the
  // previous regex (^DD/MM$ with no year) silently dropped it.
  let m = s.match(/^(\d{1,2})[\s\-\/](\d{1,2})[\s\-\/]\d{2,4}$/);
  if (m) {
    const d = parseInt(m[1],10), mo = parseInt(m[2],10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return { dob_day: d, dob_month: mo };
  }
  m = s.match(/^(\d{1,2})[\s\-\/](\d{1,2})$/);
  if (m) {
    const d = parseInt(m[1],10), mo = parseInt(m[2],10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return { dob_day: d, dob_month: mo };
  }
  m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]+)$/);
  if (m) {
    const d = parseInt(m[1],10); const mo = months[m[2].toLowerCase()];
    if (d >= 1 && d <= 31 && mo) return { dob_day: d, dob_month: mo };
  }
  return { dob_day: null, dob_month: null };
}

// v3.4.70: Robust ISO-date extractor for start-date columns. Accepts:
//   • "2025-05-13"           (already ISO — passthrough)
//   • "13/05/2025" / "13-05-2025"  (Excel AU default DD/MM/YYYY)
//   • 45932                  (Excel serial: days since 1900-01-01 with
//                             the 1900-as-leap-year bug — offset via
//                             the 1899-12-30 epoch trick)
//
// AU vs US locale: we treat the first slot as day (DD/MM/YYYY) since
// this app's tenants are AU. Returns ISO "YYYY-MM-DD" or null.
function _parseStartDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // ISO passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY (AU default)
  let m = s.match(/^(\d{1,2})[\s\-\/](\d{1,2})[\s\-\/](\d{2,4})$/);
  if (m) {
    const d  = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y    = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }
  // Excel serial (positive integer or float). Convert via the
  // 1899-12-30 epoch which absorbs the 1900-as-leap-year bug.
  if (/^\d{4,6}(?:\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 0 && serial < 80000) {
      const ms = (serial - 25569) * 86400 * 1000;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      }
    }
  }
  return null;
}

function exportPeopleCSV() {
  const header = 'Name,Group,Year,Phone,Email,Licence,Agency,Birthday,StartDate';
  const rows   = STATE.people.map(p =>
    [csvEscape(p.name), csvEscape(p.group), csvEscape(_resolveApprenticeYear(p)), csvPhone(p.phone), csvEscape(p.email), csvEscape(p.licence), csvEscape(p.agency), csvEscape(_fmtCsvBirthday(p)), csvEscape(p.start_date || '')].join(',')
  );
  downloadCSV(header + '\n' + rows.join('\n'), 'EQ_People.csv');
  showToast('People exported — ' + STATE.people.length + ' contacts');
  try {
    if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
      window.EQ_ANALYTICS.events.csvExported({ export_type: 'people' });
    }
  } catch (e) {}
}

function exportContactsCSV() {
  const search = (document.getElementById('contacts-search').value || '').toLowerCase();
  const group  = document.getElementById('contacts-group').value;
  let people   = STATE.people;
  if (search) people = people.filter(p =>
    p.name.toLowerCase().includes(search) ||
    (p.phone && p.phone.includes(search)) ||
    (p.email && p.email.toLowerCase().includes(search))
  );
  if (group) people = people.filter(p => p.group === group);
  people = [...people].sort((a, b) => a.name.localeCompare(b.name));

  const header = 'Name,Group,Year,Phone,Email,Licence,Agency,Birthday,StartDate';
  const rows   = people.map(p =>
    [csvEscape(p.name), csvEscape(p.group), csvEscape(_resolveApprenticeYear(p)), csvPhone(p.phone), csvEscape(p.email), csvEscape(p.licence), csvEscape(p.agency), csvEscape(_fmtCsvBirthday(p)), csvEscape(p.start_date || '')].join(',')
  );
  const suffix = group ? '_' + group.replace(/\s/g, '') : '';
  downloadCSV(header + '\n' + rows.join('\n'), `EQ_Contacts${suffix}.csv`);
  showToast(`Contacts exported — ${people.length} records`);
  try {
    if (window.EQ_ANALYTICS && window.EQ_ANALYTICS.events) {
      window.EQ_ANALYTICS.events.csvExported({ export_type: group ? ('contacts_' + group) : 'contacts' });
    }
  } catch (e) {}
}

function importPeopleCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rows   = parseCSV(e.target.result);
      if (!rows.length) { showToast('Empty file'); return; }
      const header = rows[0].map(h => h.toLowerCase().trim());
      const iName  = header.indexOf('name');
      const iGroup = header.indexOf('group');
      const iPhone = header.indexOf('phone');
      const iEmail = header.indexOf('email');
      const iLic   = header.indexOf('licence');
      const iAgency = header.indexOf('agency');
      // v3.4.16: optional Birthday and StartDate columns (round-trip of export)
      const iBday   = header.indexOf('birthday');
      const iStart  = (header.indexOf('startdate') >= 0) ? header.indexOf('startdate') : header.indexOf('start date');
      if (iName < 0 || iGroup < 0) { showPreviewError('import-people-preview', 'Missing required columns: Name, Group'); return; }

      const valid   = PEOPLE_GROUPS;
      const people  = [];
      const errors  = [];
      rows.slice(1).forEach((r, i) => {
        const name  = (r[iName]  || '').trim();
        const group = (r[iGroup] || '').trim();
        if (!name) return;
        if (!valid.includes(group)) { errors.push(`Row ${i + 2}: unknown group "${group}" for ${name}`); return; }
        const bday = iBday >= 0 ? _parseCsvBirthday(r[iBday]) : { dob_day: null, dob_month: null };
        // v3.4.70: route start-date through _parseStartDate which handles
        // DD/MM/YYYY (AU Excel), Excel serial numbers, and ISO.
        const startDate = iStart >= 0 ? _parseStartDate(r[iStart]) : null;
        people.push({
          id:     i + 1, name, group,
          phone:  iPhone  >= 0 ? cleanPhone(r[iPhone])                    : '',
          email:  iEmail  >= 0 ? (r[iEmail]  || '').trim().toLowerCase()  : '',
          licence: iLic   >= 0 ? (r[iLic]    || '').trim()                : '',
          agency: iAgency >= 0 ? (r[iAgency] || '').trim()                : '',
          dob_day:    bday.dob_day,
          dob_month:  bday.dob_month,
          start_date: startDate
        });
      });
      if (errors.length) { showPreviewError('import-people-preview', errors.join('<br>')); input.value = ''; return; }

      showImportConfirm('import-people-preview', people.length + ' contacts', () => {
        STATE.people = people;
        refreshPersonSelects();
        document.getElementById('badge-contacts').textContent = STATE.people.filter(p => !p.archived).length;
        updateTopStats();
        showToast('Importing ' + people.length + ' contacts…');
        importPeopleToSB(people)
          .then(() => { hidePreview('import-people-preview'); input.value = ''; showToast(people.length + ' contacts imported'); auditLog('Imported people list', 'Import', people.length + ' contacts', null); loadFromSupabase().then(() => renderCurrentPage()); })
          .catch(e => showToast('Import failed: ' + e.message));
      }, () => { hidePreview('import-people-preview'); input.value = ''; });
    } catch (err) { showPreviewError('import-people-preview', 'Parse error: ' + err.message); input.value = ''; }
  };
  reader.readAsText(file);
}

// ── Sites export / import ─────────────────────────────────────

function exportSitesCSV() {
  const rows = [['Abbreviation', 'Name', 'Address', 'Site Lead']];
  STATE.sites.forEach(s => rows.push([s.abbr, s.name, s.address || '', s.site_lead || '']));
  downloadCSV(toCSV(rows), 'EQ_Sites.csv');
  showToast('Sites exported — ' + STATE.sites.length + ' sites');
}

function importSitesCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rows   = parseCSV(e.target.result);
      if (!rows.length) { showToast('Empty file'); return; }
      const header = rows[0].map(h => h.toLowerCase().trim());
      const iAbbr  = header.indexOf('abbreviation');
      const iName  = header.indexOf('name');
      const iAddr  = header.indexOf('address');
      const iLead  = header.indexOf('site lead');
      if (iAbbr < 0 || iName < 0) { showPreviewError('import-sites-preview', 'Missing required columns: Abbreviation, Name'); return; }

      const sites = [];
      rows.slice(1).forEach((r, i) => {
        const abbr = (r[iAbbr] || '').trim().toUpperCase();
        const name = (r[iName] || '').trim();
        if (!abbr || !name) return;
        sites.push({ id: i + 1, abbr, name, address: iAddr >= 0 ? (r[iAddr] || '').trim() : '', site_lead: iLead >= 0 ? (r[iLead] || '').trim() : '' });
      });

      showImportConfirm('import-sites-preview', sites.length + ' sites', () => {
        STATE.sites = sites;
        showToast('Importing ' + sites.length + ' sites…');
        importSitesToSB(sites)
          .then(() => { hidePreview('import-sites-preview'); input.value = ''; showToast(sites.length + ' sites imported'); loadFromSupabase().then(() => renderCurrentPage()); })
          .catch(e => showToast('Import failed: ' + e.message));
      }, () => { hidePreview('import-sites-preview'); input.value = ''; });
    } catch (err) { showPreviewError('import-sites-preview', 'Parse error: ' + err.message); input.value = ''; }
  };
  reader.readAsText(file);
}

// ── Schedule export / import ──────────────────────────────────

function exportScheduleCSV() {
  const days     = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const rows     = [['Name', 'Group', 'Week', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']];
  const allWeeks = [...new Set(STATE.schedule.map(r => r.week))].sort((a, b) => {
    const [da, ma, ya] = a.split('.'); const [db, mb, yb] = b.split('.');
    return new Date(`20${ya}-${ma}-${da}`) - new Date(`20${yb}-${mb}-${db}`);
  });
  STATE.people.forEach(p => {
    allWeeks.forEach(w => {
      const s = getPersonSchedule(p.name, w);
      if (days.some(d => s[d] && s[d].trim()))
        rows.push([p.name, p.group, w, ...days.map(d => s[d] || '')]);
    });
  });
  downloadCSV(toCSV(rows), 'EQ_Schedule_All_Weeks.csv');
  showToast(`Schedule exported — ${rows.length - 1} entries`);
}

function importScheduleCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rows   = parseCSV(e.target.result);
      if (!rows.length) { showToast('Empty file'); return; }
      const header = rows[0].map(h => h.toLowerCase().trim());
      const iName  = header.indexOf('name');
      const iWeek  = header.indexOf('week');
      if (iName < 0 || iWeek < 0) { showPreviewError('import-schedule-preview', 'Missing required columns: Name, Week'); return; }
      const idx    = (col) => header.indexOf(col);
      const incoming = [];
      rows.slice(1).forEach((r, i) => {
        const name = (r[iName] || '').trim();
        const week = (r[iWeek] || '').trim();
        if (!name || !week) return;
        incoming.push({
          id: i + 1, name, week,
          mon: idx('mon') >= 0 ? (r[idx('mon')] || '').trim().toUpperCase() : '',
          tue: idx('tue') >= 0 ? (r[idx('tue')] || '').trim().toUpperCase() : '',
          wed: idx('wed') >= 0 ? (r[idx('wed')] || '').trim().toUpperCase() : '',
          thu: idx('thu') >= 0 ? (r[idx('thu')] || '').trim().toUpperCase() : '',
          fri: idx('fri') >= 0 ? (r[idx('fri')] || '').trim().toUpperCase() : '',
          sat: idx('sat') >= 0 ? (r[idx('sat')] || '').trim().toUpperCase() : '',
          sun: idx('sun') >= 0 ? (r[idx('sun')] || '').trim().toUpperCase() : '',
        });
      });
      showImportConfirm('import-schedule-preview', incoming.length + ' schedule entries', () => {
        STATE.schedule = incoming;
        STATE.scheduleIndex = {};
        STATE.schedule.forEach(r => { STATE.scheduleIndex[`${r.name}||${r.week}`] = r; });
        updateTopStats();
        showToast('Importing schedule…');
        const importedWeeks = [...new Set(incoming.map(r => r.week))];
        importScheduleToSB(incoming, importedWeeks)
          .then(() => { hidePreview('import-schedule-preview'); input.value = ''; showToast(incoming.length + ' entries imported'); auditLog('Imported schedule', 'Import', incoming.length + ' entries', null); loadFromSupabase().then(() => renderCurrentPage()); })
          .catch(e => showToast('Import failed: ' + e.message));
      }, () => { hidePreview('import-schedule-preview'); input.value = ''; });
    } catch (err) { showPreviewError('import-schedule-preview', 'Parse error: ' + err.message); input.value = ''; }
  };
  reader.readAsText(file);
}

// ── Week CSV export (current week) ───────────────────────────

function exportCSV() {
  const week = STATE.currentWeek;
  const days = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const rows = [['Name', 'Group', 'Licence', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']];
  STATE.people.forEach(p => {
    const s = getPersonSchedule(p.name, week);
    rows.push([p.name, p.group, p.licence || '', ...days.map(d => s[d] || '')]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCSV(csv, `EQ_Roster_${week}.csv`);
  showToast(`Exported w/c ${week}`);
}

// ── Full backup / restore ─────────────────────────────────────

async function exportFullBackup() {
  const backup = {
    version:     '3.0.0',
    exported:    new Date().toISOString(),
    exported_by: currentManagerName || 'Unknown',
    people:       STATE.people,
    sites:        STATE.sites,
    schedule:     STATE.schedule,
    managers:     STATE.managers,
    timesheets:   STATE.timesheets  || [],
    leave_requests: (typeof leaveRequests !== 'undefined' ? leaveRequests : [])
  };

  // A08-03: Checksum for tamper detection
  const jsonData   = JSON.stringify(backup);
  const checksum   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonData));
  const checksumHex = Array.from(new Uint8Array(checksum)).map(b => b.toString(16).padStart(2, '0')).join('');
  backup._checksum = checksumHex;

  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `EQ_FieldOps_Backup_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Full backup downloaded');
  auditLog('Full backup exported', 'Import', `${STATE.people.length} people, ${STATE.sites.length} sites, ${STATE.schedule.length} schedule entries`, null);
}

async function importFullBackup(input) {
  if (!isManager) { showToast('Supervision access required'); input.value = ''; return; }
  const file = input.files[0];
  if (!file) return;
  try {
    const text   = await file.text();
    const backup = JSON.parse(text);

    // Verify checksum
    if (backup._checksum) {
      const stored = backup._checksum;
      delete backup._checksum;
      const verifyData = JSON.stringify(backup);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifyData));
      const hex  = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      backup._checksum = stored;
      if (hex !== stored) showToast('⚠ Backup file may have been modified — checksum mismatch');
    }

    if (!backup.people || !backup.sites || !backup.schedule) {
      showToast('Invalid backup file — missing required data');
      input.value = '';
      return;
    }

    const preview = document.getElementById('backup-restore-preview');
    preview.style.display = 'block';
    preview.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:8px">Backup from ${new Date(backup.exported).toLocaleString('en-AU')}${backup.exported_by ? ' by ' + backup.exported_by : ''}</div>
        <div style="font-size:11px;color:var(--ink-2);line-height:1.8">
          👤 ${backup.people.length} people &nbsp;|&nbsp; 🏗 ${backup.sites.length} sites &nbsp;|&nbsp;
          📅 ${backup.schedule.length} schedule entries &nbsp;|&nbsp; ☎ ${(backup.managers || []).length} supervision contacts &nbsp;|&nbsp;
          ⏱ ${(backup.timesheets || []).length} timesheet entries &nbsp;|&nbsp; 🏖 ${(backup.leave_requests || []).length} leave requests
        </div>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--red);font-weight:600">⚠ This will REPLACE all current data. This cannot be undone.</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('backup-restore-preview').style.display='none';document.getElementById('import-backup-file').value=''">Cancel</button>
          <button class="btn btn-sm" style="background:var(--red);color:white" onclick="confirmRestoreBackup()">Restore All Data</button>
        </div>
      </div>`;
    window._pendingBackup = backup;
  } catch (e) {
    showToast('Failed to read backup file');
    input.value = '';
  }
}

async function confirmRestoreBackup() {
  // SUP-005: Auto-backup current data before overwriting
  try { await exportFullBackup(); await new Promise(r => setTimeout(r, 500)); } catch (e) {}
  const backup = window._pendingBackup;
  if (!backup) return;
  showLoadingOverlay('Restoring backup…');
  try {
    if (backup.people.length)   await importPeopleToSB(backup.people);
    if (backup.sites.length)    await importSitesToSB(backup.sites);
    if (backup.schedule.length) {
      const weeks = [...new Set(backup.schedule.map(r => r.week))];
      await importScheduleToSB(backup.schedule, weeks);
    }
    if (backup.managers && backup.managers.length) await importManagersToSB(backup.managers);

    if (backup.timesheets && backup.timesheets.length) {
      try { await sbFetch(`timesheets?org_id=eq.${TENANT.ORG_UUID}`, 'DELETE'); } catch (e) {}
      const tsRows = backup.timesheets.map(r => { const row = { ...r }; delete row.id; return row; });
      if (tsRows.length) await sbFetch('timesheets', 'POST', tsRows);
    }
    if (backup.leave_requests && backup.leave_requests.length) {
      try { await sbFetch(`leave_requests?org_id=eq.${TENANT.ORG_UUID}`, 'DELETE'); } catch (e) {}
      const lrRows = backup.leave_requests.map(r => { const row = { ...r }; delete row.id; return row; });
      if (lrRows.length) await sbFetch('leave_requests', 'POST', lrRows);
    }

    await loadFromSupabase();
    if (typeof loadLeaveRequests === 'function') await loadLeaveRequests();
    hideLoadingOverlay();
    document.getElementById('backup-restore-preview').style.display = 'none';
    document.getElementById('import-backup-file').value = '';
    window._pendingBackup = null;
    renderCurrentPage();
    updateTopStats();
    showToast('Backup restored successfully');
    auditLog('Full backup restored', 'Import', `From ${backup.exported}`, null);
  } catch (e) {
    hideLoadingOverlay();
    showToast('Restore failed: ' + e.message);
  }
}

// ── Reset ─────────────────────────────────────────────────────

function confirmReset() {
  document.getElementById('confirm-title').textContent = 'Reset All Data';
  document.getElementById('confirm-msg').textContent   =
    'This will delete all your saved changes and reload the original seed data. This cannot be undone.';
  document.getElementById('confirm-action').textContent = 'Reset';
  document.getElementById('confirm-action').onclick     = () => {
    localStorage.removeItem('eq_roster_v2');
    location.reload();
  };
  openModal('modal-confirm');
}