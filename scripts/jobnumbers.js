/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/jobnumbers.js  —  EQ Solves Field
// Job Numbers (BETA): CRUD, search, CSV import/export,
// datalist population for timesheets.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

let jobNumbers = [];
let jnSort     = { col: 'number', dir: 'asc' };
let jnSelected = new Set();
let _jnArmTimer = null;

// ── Load ──────────────────────────────────────────────────────

async function loadJobNumbers() {
  try {
    const rows = await sbFetch('job_numbers?order=number.asc');
    if (rows && rows.length) jobNumbers = rows;
  } catch (e) {
    console.warn('EQ[jobnumbers] load failed (table may not exist yet):', e && e.message || e);
  }
}

function populateJobNumberDatalist() {
  const dl = document.getElementById('ts-job-list');
  if (!dl) return;
  dl.innerHTML = (jobNumbers || [])
    .filter(j => j.status === 'Active')
    .map(j => `<option value="${esc(j.number)}">${esc(j.description || '')}${j.client ? ' — ' + esc(j.client) : ''}</option>`)
    .join('');
}

// ── Render ────────────────────────────────────────────────────

function setJNSort(col) {
  if (jnSort.col === col) { jnSort.dir = jnSort.dir === 'asc' ? 'desc' : 'asc'; }
  else { jnSort.col = col; jnSort.dir = 'asc'; }
  renderJobNumbers();
}

function renderJobNumbers() {
  const search = (document.getElementById('jobnumbers-search').value || '').toLowerCase();
  let items    = [...jobNumbers];
  if (search) items = items.filter(j =>
    (j.number      || '').toLowerCase().includes(search) ||
    (j.description || '').toLowerCase().includes(search) ||
    (j.client      || '').toLowerCase().includes(search) ||
    (j.site_name   || '').toLowerCase().includes(search)
  );

  // Sort
  const colKey = { 'number':'number', 'description':'description', 'client':'client', 'site':'site_name', 'status':'status' };
  const key = colKey[jnSort.col] || 'number';
  items.sort((a, b) => {
    const av = (a[key] || '').toLowerCase();
    const bv = (b[key] || '').toLowerCase();
    return jnSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  if (!items.length) {
    document.getElementById('jobnumbers-content').innerHTML =
      `<div class="empty"><div class="empty-icon">🔢</div><p>${search ? 'No matching job numbers' : 'No job numbers added yet'}</p></div>`;
    _jnUpdateBulkBar();
    return;
  }

  const statusColors = { Active: 'var(--green)', Complete: 'var(--ink-3)', 'On Hold': 'var(--amber)' };
  const statusBg     = { Active: 'var(--green-lt)', Complete: 'var(--surface-2)', 'On Hold': 'var(--amber-lt)' };

  const sortArrow = (col) => jnSort.col === col ? (jnSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const thStyle = 'padding:8px 12px;text-align:left;font-weight:700;cursor:pointer;user-select:none';

  let html = '<div class="roster-card" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">';
  html += '<thead><tr style="background:var(--navy);color:white">';
  if (isManager) html += `<th style="padding:8px 10px;width:36px;text-align:center"><input type="checkbox" id="jn-select-all" onchange="_jnToggleAll(this.checked)" title="Select all" style="cursor:pointer;accent-color:var(--sky)"></th>`;
  html += `<th style="${thStyle}" onclick="setJNSort('number')">Job #${sortArrow('number')}</th>`;
  html += `<th style="${thStyle}" onclick="setJNSort('description')">Project / Description${sortArrow('description')}</th>`;
  html += `<th style="${thStyle}" onclick="setJNSort('client')">Client${sortArrow('client')}</th>`;
  html += `<th style="${thStyle}" onclick="setJNSort('site')">Site${sortArrow('site')}</th>`;
  html += `<th style="${thStyle}" onclick="setJNSort('status')">Status${sortArrow('status')}</th>`;
  if (isManager) html += '<th style="padding:8px 10px;text-align:center;font-weight:700;width:70px"></th>';
  html += '</tr></thead><tbody>';

  items.forEach((j, idx) => {
    const bg      = idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)';
    const sc      = statusColors[j.status] || 'var(--ink-3)';
    const sb      = statusBg[j.status]     || 'var(--surface-2)';
    const checked = jnSelected.has(String(j.id)) ? ' checked' : '';
    html += `<tr style="background:${bg};border-bottom:1px solid var(--border)">`;
    if (isManager) html += `<td style="padding:8px 10px;text-align:center"><input type="checkbox" class="jn-row-cb" data-jid="${j.id}"${checked} onchange="_jnToggleRow('${j.id}')" style="cursor:pointer;accent-color:var(--sky)"></td>`;
    html += `
      <td style="padding:8px 12px;font-weight:700;color:var(--navy);font-size:13px">${esc(j.number || '')}</td>
      <td style="padding:8px 12px;color:var(--ink)">${esc(j.description || '')}${j.notes ? `<div style="font-size:10px;color:var(--ink-4);margin-top:2px">${esc(j.notes)}</div>` : ''}</td>
      <td style="padding:8px 12px;color:var(--ink-2)">${esc(j.client    || '')}</td>
      <td style="padding:8px 12px;color:var(--ink-2)">${esc(j.site_name || '')}</td>
      <td style="padding:8px 10px;text-align:center"><span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${sb};color:${sc}">${esc(j.status || '')}</span></td>`;
    if (isManager) {
      html += `<td style="padding:8px 10px;text-align:center">
        <button class="btn-icon btn-sm" title="Edit" onclick="editJobNumber('${j.id}')">✎</button>
        <button class="btn-icon btn-sm" style="color:var(--red)" title="Delete"
          data-jid="${j.id}" data-jnum="${esc(j.number || '')}"
          onclick="confirmDeleteJobNumber(this.dataset.jid, this.dataset.jnum)">✕</button>
      </td>`;
    }
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  document.getElementById('jobnumbers-content').innerHTML = html;
  _jnSyncSelectAll();
  _jnUpdateBulkBar();
}

// ── CRUD ──────────────────────────────────────────────────────

function populateJNSiteDropdown() {
  const sel     = document.getElementById('jn-site');
  sel.innerHTML = '<option value="">— Select site —</option>' +
    (STATE.sites || []).map(s => `<option value="${esc(s.name)}">${esc(s.abbr)} — ${esc(s.name)}</option>`).join('');
}

function openAddJobNumber() {
  if (!isManager) { showToast('Supervision access required'); return; }
  ['jn-edit-id', 'jn-number', 'jn-description', 'jn-client', 'jn-notes']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('jn-status').value = 'Active';
  populateJNSiteDropdown();
  document.getElementById('jn-site').value = '';
  document.getElementById('modal-jobnumber-title').textContent = 'Add Job Number';
  openModal('modal-jobnumber');
}

function editJobNumber(id) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const j = jobNumbers.find(x => String(x.id) === String(id));
  if (!j) return;
  document.getElementById('jn-edit-id').value     = id;
  document.getElementById('jn-number').value      = j.number      || '';
  document.getElementById('jn-description').value = j.description || '';
  document.getElementById('jn-client').value      = j.client      || '';
  document.getElementById('jn-notes').value       = j.notes       || '';
  document.getElementById('jn-status').value      = j.status      || 'Active';
  populateJNSiteDropdown();
  document.getElementById('jn-site').value        = j.site_name   || '';
  document.getElementById('modal-jobnumber-title').textContent = 'Edit Job Number';
  openModal('modal-jobnumber');
}

async function saveJobNumber() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const editId      = document.getElementById('jn-edit-id').value;
  const number      = document.getElementById('jn-number').value.trim();
  const description = document.getElementById('jn-description').value.trim();
  const client      = document.getElementById('jn-client').value.trim();
  const site_name   = document.getElementById('jn-site').value;
  const status      = document.getElementById('jn-status').value;
  const notes       = document.getElementById('jn-notes').value.trim();

  if (!number) { showToast('Job number is required'); return; }

  const row = {
    number,
    description: description || null,
    client:      client      || null,
    site_name:   site_name   || null,
    status,
    notes:       notes       || null
  };

  try {
    if (editId) {
      await sbFetch('job_numbers?id=eq.' + editId, 'PATCH', row);
      // v3.4.21: id is a uuid string — do NOT parseInt
      const existing = jobNumbers.find(j => String(j.id) === String(editId));
      if (existing) Object.assign(existing, row);
      showToast(`${number} updated`);
    } else {
      const res = await sbFetch('job_numbers', 'POST', row, 'return=representation');
      if (res && res[0]) jobNumbers.push(res[0]);
      showToast(`${number} added`);
    }
    closeModal('modal-jobnumber');
    renderJobNumbers();
    populateJobNumberDatalist();
    auditLog(editId ? `Updated job: ${number}` : `Added job: ${number}`, 'Job Numbers', description || '', null);
  } catch (e) {
    showToast('Save failed — check connection');
  }
}

function confirmDeleteJobNumber(id, number) {
  if (!isManager) { showToast('Supervision access required'); return; }
  document.getElementById('confirm-title').textContent = 'Delete Job Number';
  document.getElementById('confirm-msg').textContent   = `Delete job number ${number}?`;
  document.getElementById('confirm-action').textContent = 'Delete';
  document.getElementById('confirm-action').onclick    = async () => {
    try {
      await sbFetch('job_numbers?id=eq.' + id, 'DELETE');
      jobNumbers = jobNumbers.filter(j => j.id !== id);
      jnSelected.delete(String(id));
      closeModal('modal-confirm');
      renderJobNumbers();
      populateJobNumberDatalist();
      showToast(`${number} deleted`);
      auditLog(`Deleted job: ${number}`, 'Job Numbers', '', null);
    } catch (e) {
      showToast('Delete failed');
    }
  };
  openModal('modal-confirm');
}

// ── Bulk selection ────────────────────────────────────────────

function _jnToggleRow(id) {
  const sid = String(id);
  if (jnSelected.has(sid)) jnSelected.delete(sid);
  else jnSelected.add(sid);
  _jnSyncSelectAll();
  _jnUpdateBulkBar();
}

function _jnToggleAll(checked) {
  document.querySelectorAll('.jn-row-cb').forEach(cb => {
    cb.checked = checked;
    if (checked) jnSelected.add(cb.dataset.jid);
    else         jnSelected.delete(cb.dataset.jid);
  });
  _jnUpdateBulkBar();
}

function _jnSyncSelectAll() {
  const all = document.querySelectorAll('.jn-row-cb');
  const el  = document.getElementById('jn-select-all');
  if (el) el.checked = all.length > 0 && [...all].every(cb => jnSelected.has(cb.dataset.jid));
}

function _jnUpdateBulkBar() {
  const bar     = document.getElementById('jobnumbers-bulk-bar');
  const countEl = document.getElementById('jobnumbers-bulk-count');
  if (!bar) return;
  const n = jnSelected.size;
  if (n === 0) { bar.style.display = 'none'; _jnDisarm(); return; }
  bar.style.display = 'flex';
  countEl.textContent = n + ' selected';
  _jnDisarm();
}

function _jnDisarm() {
  clearTimeout(_jnArmTimer);
  _jnArmTimer = null;
  const btn = document.getElementById('jobnumbers-bulk-delete-btn');
  if (!btn) return;
  btn.dataset.armed = '';
  btn.textContent   = 'Delete selected';
  btn.style.background = 'var(--red-lt)';
  btn.style.color      = 'var(--red)';
  btn.style.fontWeight = '';
}

function _jnArmBulkDelete(btn) {
  if (!isManager) { showToast('Supervision access required'); return; }
  if (btn.dataset.armed === '1') { _jnBulkDelete(); return; }
  btn.dataset.armed   = '1';
  const n = jnSelected.size;
  btn.textContent     = `Confirm delete ${n}?`;
  btn.style.background = 'var(--red)';
  btn.style.color      = 'white';
  btn.style.fontWeight = '700';
  clearTimeout(_jnArmTimer);
  _jnArmTimer = setTimeout(() => _jnDisarm(), 3000);
}

async function _jnBulkDelete() {
  if (!isManager) { showToast('Supervision access required'); return; }
  const ids  = [...jnSelected];
  if (!ids.length) return;
  const nums = ids.map(id => { const j = jobNumbers.find(x => String(x.id) === id); return j ? j.number : id; }).join(', ');
  try {
    await sbFetch(`job_numbers?id=in.(${ids.join(',')})`, 'DELETE');
    jobNumbers = jobNumbers.filter(j => !jnSelected.has(String(j.id)));
    jnSelected.clear();
    renderJobNumbers();
    populateJobNumberDatalist();
    showToast(`${ids.length} job number${ids.length > 1 ? 's' : ''} deleted`);
    auditLog(`Deleted ${ids.length} job number${ids.length > 1 ? 's' : ''}: ${nums}`, 'Job Numbers', '', null);
  } catch (e) {
    showToast('Delete failed — check connection');
    _jnDisarm();
  }
}

// ── CSV import/export ─────────────────────────────────────────

function exportJobNumbersCSV() {
  const headers = ['Job Number', 'Description', 'Client', 'Site', 'Status', 'Notes'];
  const rows    = jobNumbers.map(j => [
    j.number || '', j.description || '', j.client || '',
    j.site_name || '', j.status || '', j.notes || ''
  ]);
  const csv = [headers, ...rows].map(r =>
    r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')
  ).join('\n');
  const a    = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'EQ_Job_Numbers_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
  a.click();
  showToast('Job numbers exported');
}

function _parseCSVRow(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += ch;
  }
  result.push(current);
  return result;
}

async function importJobNumbersCSV(input) {
  if (!isManager) { showToast('Supervision access required'); input.value = ''; return; }
  const file = input.files[0];
  if (!file) return;
  try {
    const text  = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { showToast('CSV is empty'); input.value = ''; return; }

    const header   = _parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
    const numIdx   = header.findIndex(h => h.includes('job') || h.includes('number'));
    const descIdx  = header.findIndex(h => h.includes('desc') || h.includes('project'));
    const clientIdx = header.findIndex(h => h.includes('client'));
    const siteIdx  = header.findIndex(h => h.includes('site'));
    const statusIdx = header.findIndex(h => h.includes('status'));
    const notesIdx = header.findIndex(h => h.includes('note'));

    if (numIdx === -1) { showToast('CSV must have a "Job Number" column'); input.value = ''; return; }

    const newJobs = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = _parseCSVRow(lines[i]);
      const num  = (cols[numIdx] || '').trim();
      if (!num) continue;
      newJobs.push({
        number:      num,
        description: descIdx   >= 0 ? (cols[descIdx]   || '').trim() : null,
        client:      clientIdx >= 0 ? (cols[clientIdx]  || '').trim() : null,
        site_name:   siteIdx   >= 0 ? (cols[siteIdx]    || '').trim() : null,
        status:      statusIdx >= 0 ? (cols[statusIdx]  || '').trim() || 'Active' : 'Active',
        notes:       notesIdx  >= 0 ? (cols[notesIdx]   || '').trim() : null
      });
    }
    if (!newJobs.length) { showToast('No valid rows found'); input.value = ''; return; }

    const existing = jobNumbers.length;
    document.getElementById('confirm-title').textContent   = 'Import Job Numbers';
    document.getElementById('confirm-msg').textContent     =
      existing ? `Replace ${existing} existing job numbers with ${newJobs.length} from CSV?` : `Import ${newJobs.length} job numbers?`;
    document.getElementById('confirm-action').textContent  = 'Import';
    document.getElementById('confirm-action').onclick      = async () => {
      try {
        if (existing) await sbFetch(`job_numbers?org_id=eq.${TENANT.ORG_UUID}`, 'DELETE');
        const res = await sbFetch('job_numbers', 'POST', newJobs, 'return=representation');
        jobNumbers = res || newJobs;
        closeModal('modal-confirm');
        renderJobNumbers();
        populateJobNumberDatalist();
        showToast(newJobs.length + ' job numbers imported');
        auditLog('Imported ' + newJobs.length + ' job numbers from CSV', 'Job Numbers', '', null);
      } catch (e) {
        showToast('Import failed: ' + e.message);
      }
    };
    openModal('modal-confirm');
    input.value = '';
  } catch (e) {
    showToast('Failed to read CSV: ' + e.message);
    input.value = '';
  }
}