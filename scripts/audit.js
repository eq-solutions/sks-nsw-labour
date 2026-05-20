/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/audit.js  —  EQ Solves Field
// Audit log: write, open modal, render, export CSV.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

let auditCache = [];

// v3.4.76 — runtime probe for the revert-capable schema. Set true when
// the audit_log table has been migrated to include before_value/after_value/
// target_table/target_id/target_field/is_reverted columns. Until then the
// Revert UI stays hidden and auditLog drops the new fields from the POST
// (PostgREST 400s on unknown columns). Detected lazily in openAuditLog().
let _AUDIT_HAS_REVERT_COLS = null;

// ── Write ─────────────────────────────────────────────────────

function auditLog(action, category, detail, week, opts) {
  if (!currentManagerName) return;
  opts = opts || {};
  const entry = {
    manager_name: currentManagerName,
    action,
    category,
    detail: detail || null,
    week:   week   || STATE.currentWeek || null
  };
  // v3.4.76: enrich the row with before/after + target metadata so the
  // audit modal's Revert button has enough to reverse a single-cell edit.
  // Gated on the migration probe — if the columns don't exist yet, send
  // only the legacy fields so PostgREST doesn't reject the POST.
  if (_AUDIT_HAS_REVERT_COLS === true) {
    if (opts.before       != null) entry.before_value = String(opts.before);
    if (opts.after        != null) entry.after_value  = String(opts.after);
    if (opts.target_table)         entry.target_table = opts.target_table;
    if (opts.target_id    != null) entry.target_id    = String(opts.target_id);
    if (opts.target_field)         entry.target_field = opts.target_field;
  }
  // Fire-and-forget — never block UI on audit writes — but DON'T swallow
  // errors silently. v3.4.56: switched the no-op catch to a console.warn
  // so RLS / schema drift / validation rejections are visible in DevTools.
  // Audit logging is forensics-load-bearing; "we logged everything" can
  // only be claimed if the failure mode is observable.
  sbFetch('audit_log', 'POST', entry, 'return=minimal').catch(e => {
    console.warn('EQ[audit] write failed:', e && e.message || e);
  });
}

// ── Open modal ────────────────────────────────────────────────

async function openAuditLog() {
  if (!isManager) { showToast('Supervision access required'); return; }
  openModal('modal-audit');
  document.getElementById('audit-log-content').innerHTML =
    '<div class="empty"><div class="empty-icon">⏳</div><p>Loading…</p></div>';

  try {
    const rows   = await sbFetch('audit_log?select=*&order=created_at.desc&limit=500');
    auditCache   = rows;

    // v3.4.76: detect whether the table has been migrated to the revert
    // schema by looking for the columns on the first returned row. We
    // can't tell from an empty result, so leave probe as null and the
    // next page load will re-probe. False positives are harmless (the
    // Revert button is hidden when before_value is null per-row anyway).
    if (_AUDIT_HAS_REVERT_COLS === null && rows.length) {
      _AUDIT_HAS_REVERT_COLS = Object.prototype.hasOwnProperty.call(rows[0], 'before_value');
    }

    const managers = [...new Set(rows.map(r => r.manager_name))].sort();
    const mSel     = document.getElementById('audit-filter-manager');
    mSel.innerHTML = '<option value="">All Supervision</option>' +
      managers.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');

    renderAuditLog();
  } catch (e) {
    document.getElementById('audit-log-content').innerHTML =
      '<div class="empty"><div class="empty-icon">⚠️</div><p>Failed to load audit log</p></div>';
  }
}

// ── Render ────────────────────────────────────────────────────

function renderAuditLog() {
  const filterMgr = document.getElementById('audit-filter-manager').value;
  const filterCat = document.getElementById('audit-filter-category').value;

  let rows = auditCache;
  if (filterMgr) rows = rows.filter(r => r.manager_name === filterMgr);
  if (filterCat) rows = rows.filter(r => r.category      === filterCat);

  document.getElementById('audit-count').textContent = rows.length + ' entries';

  if (!rows.length) {
    document.getElementById('audit-log-content').innerHTML =
      '<div class="empty"><div class="empty-icon">📋</div><p>No entries found</p></div>';
    return;
  }

  const catColors = {
    Roster:     '#2563EB', Timesheet: '#7C77B9', People: '#16A34A',
    Sites:      '#D97706', Access:    '#34486C', Import: '#566686', Leave: '#059669'
  };
  const catBg = {
    Roster:     '#EFF6FF', Timesheet: '#EEF2FF', People: '#F0FDF4',
    Sites:      '#FFFBEB', Access:    '#F1F5F9', Import: '#F8FAFC', Leave: '#ECFDF5'
  };

  // Group by date
  const grouped = {};
  rows.forEach(r => {
    const d       = new Date(r.created_at);
    const dateKey = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(r);
  });

  let html = '';
  Object.entries(grouped).forEach(([date, entries]) => {
    html += `<div style="padding:6px 18px 2px;font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;background:var(--surface-2);border-bottom:1px solid var(--border)">${date}</div>`;
    entries.forEach(r => {
      const d    = new Date(r.created_at);
      const time = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const col  = catColors[r.category] || '#566686';
      const bg   = catBg[r.category]     || '#F8FAFC';
      // v3.4.76: per-row Revert button — enabled when the row was captured
      // with before/after values, has a target row id, and hasn't already
      // been reverted. Hidden entirely on pre-migration schema.
      const canRevert = _AUDIT_HAS_REVERT_COLS === true
        && r.before_value != null
        && !r.is_reverted
        && r.target_table
        && r.target_id
        && r.target_field;
      const revertCtl = canRevert
        ? `<button class="audit-revert-btn" onclick="revertAuditEntry(${r.id})" title="Restore the previous value">↶ Revert</button>`
        : (r.is_reverted ? '<span class="audit-reverted-badge">REVERTED</span>' : '');

      html += `<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border)">
        <span style="font-size:10px;color:var(--ink-3);white-space:nowrap;padding-top:2px;min-width:42px">${time}</span>
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${bg};color:${col};white-space:nowrap;min-width:72px;text-align:center">${r.category}</span>
        <div style="flex:1;min-width:0">
          <span style="font-weight:600;font-size:12px;color:var(--navy)">${esc(r.manager_name || '')}</span>
          <span style="font-size:12px;color:var(--ink-2)"> — ${esc(r.action || '')}</span>
          ${r.detail ? `<div style="font-size:11px;color:var(--ink-3);margin-top:2px">${esc(r.detail)}</div>` : ''}
          ${r.week   ? `<div style="font-size:10px;color:var(--ink-3)">Week ${r.week}</div>` : ''}
        </div>
        ${revertCtl ? `<div style="margin-left:auto;align-self:center">${revertCtl}</div>` : ''}
      </div>`;
    });
  });

  document.getElementById('audit-log-content').innerHTML = html;
}

// v3.4.76 — revert a single audit entry.
// Writes `before_value` back to the original row + flags the audit row
// as reverted + drops a fresh audit row of category 'Revert' to keep
// the trail honest. Refuses if the target row is missing or if its
// current value differs from `after_value` (someone else has edited
// the cell since); the latter requires explicit user confirmation.
async function revertAuditEntry(auditId) {
  if (!isManager) { showToast('Supervision access required'); return; }
  if (_AUDIT_HAS_REVERT_COLS !== true) {
    showToast('Revert is unavailable — database migration has not been applied yet.');
    return;
  }
  const row = auditCache.find(r => r.id === auditId);
  if (!row) { showToast('Audit row not found'); return; }
  if (row.is_reverted) { showToast('Already reverted'); return; }
  if (!row.target_table || !row.target_id || !row.target_field) {
    showToast('This entry can\'t be reverted (no target reference)'); return;
  }

  const beforeDisp = row.before_value || '(empty)';
  const afterDisp  = row.after_value  || '(empty)';
  if (!confirm(`Revert ${row.action}?\n\nFrom: ${afterDisp}\nBack to: ${beforeDisp}`)) return;

  if (row.target_table !== 'schedule') {
    showToast('Revert for ' + row.target_table + ' is not yet supported');
    return;
  }

  try {
    // Read current value first to detect concurrent edits.
    const current = await sbFetch(
      `schedule?id=eq.${row.target_id}&select=id,name,week,` + encodeURIComponent(row.target_field)
    );
    if (!current || !current.length) {
      showToast('Target row no longer exists — can\'t revert');
      return;
    }
    const curRow = current[0];
    const curVal = curRow[row.target_field];
    if (String(curVal || '') !== String(row.after_value || '')) {
      if (!confirm(
        'Heads up — the current value is "' + (curVal || '(empty)') + '", not "' + afterDisp + '". ' +
        'Someone else has changed it since this edit. Revert anyway?'
      )) return;
    }

    // Apply the revert.
    const patch = {}; patch[row.target_field] = row.before_value || null;
    await sbFetch(`schedule?id=eq.${row.target_id}`, 'PATCH', patch);
    await sbFetch(`audit_log?id=eq.${auditId}`, 'PATCH', { is_reverted: true });

    // Write a fresh audit row so the revert itself is logged.
    auditLog(
      'Revert: ' + (row.action || ''),
      'Roster',
      (afterDisp) + ' → ' + (beforeDisp) + ' (reverting #' + auditId + ')',
      row.week,
      {
        before: row.after_value,
        after:  row.before_value,
        target_table: row.target_table,
        target_id:    row.target_id,
        target_field: row.target_field
      }
    );

    // Refresh data + modal so the UI matches the DB.
    if (typeof loadFromSupabase === 'function') {
      try { await loadFromSupabase(); } catch (_) {}
    }
    if (typeof renderCurrentPage === 'function') renderCurrentPage();
    showToast('Reverted — ' + (curRow.name || '') + ' ' + (row.target_field || '').toUpperCase() + ' → ' + beforeDisp);
    openAuditLog();
  } catch (e) {
    console.warn('EQ[audit] revert failed:', e && e.message || e);
    showToast('Revert failed: ' + (e && e.message || e));
  }
}

// ── Export ────────────────────────────────────────────────────

function exportAuditCSV() {
  if (!auditCache.length) { showToast('No entries to export'); return; }
  // v3.4.56: ISO 8601 timestamps + row id in the export. Auditors and
  // payroll integrators want machine-readable timestamps (UTC, ISO) so
  // they can sort and join across tools. The previous toLocaleString
  // output was viewer-locale dependent (DD/MM/YYYY vs MM/DD/YYYY) and
  // ambiguous. The id column makes any row in the CSV findable in the
  // DB if a question comes up later.
  const header = 'ID,Created At (UTC ISO),Manager,Category,Action,Detail,Week';
  const lines  = auditCache.map(r => {
    const ts = r.created_at ? new Date(r.created_at).toISOString() : '';
    return [r.id || '', ts, r.manager_name, r.category, r.action, r.detail || '', r.week || '']
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
  });
  downloadCSV(header + '\n' + lines.join('\n'), 'EQ_Audit_Log.csv');
  showToast('Audit log exported');
}