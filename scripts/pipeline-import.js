/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/pipeline-import.js  —  SKS NSW Labour
// Tender Smartsheet import screen.
//
// Depends on: app-state.js, supabase.js, scripts/tender-parser.js
// SheetJS (window.XLSX) is lazy-loaded from CDN on first visit.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── SheetJS CDN (lazy) ────────────────────────────────────
  var SHEETJS_CDN = '/scripts/xlsx.full.min.js';  // vendored locally — v3.4.86 (CSP blocks external CDN)
  var _xlsxReady   = false;
  var _xlsxPromise = null;

  function _ensureXlsx() {
    if (_xlsxReady || (typeof window !== 'undefined' && window.XLSX && typeof window.XLSX.read === 'function')) {
      _xlsxReady = true;
      return Promise.resolve();
    }
    if (_xlsxPromise) return _xlsxPromise;
    _xlsxPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SHEETJS_CDN;
      s.onload  = function () { _xlsxReady = true; resolve(); };
      s.onerror = function () { reject(new Error('Failed to load SheetJS — check network and try again')); };
      document.head.appendChild(s);
    });
    return _xlsxPromise;
  }

  // ── Module state ─────────────────────────────────────────
  var _parsed        = null; // { rows:[], errors:[] }
  var _aboveRows     = [];   // rows with quote_value >= $100k
  var _belowRows     = [];   // rows with quote_value < $100k (below_threshold flag)
  var _diff          = null; // diff of _aboveRows against existing
  var _includeBelow  = false; // toggle: also import below-threshold rows
  var _fileName      = '';
  // Keyed by external_ref — carries current DB state (stage, missing_import_count)
  // so confirm() can protect confirmed tenders and increment missing counts.
  var _existingByRef = {};

  // ── Render ────────────────────────────────────────────────
  async function renderPipelineImport() {
    var el = document.getElementById('page-pipeline-import');
    if (!el) return;
    _parsed = null; _diff = null; _fileName = '';
    _aboveRows = []; _belowRows = []; _includeBelow = false; _existingByRef = {};
    el.innerHTML = _pageHtml();
    _bindEvents();
    // Show last import timestamp (non-fatal)
    try {
      var runs = await sbFetch('tender_import_runs?order=imported_at.desc&limit=1&select=imported_at,file_name,rows_total');
      if (Array.isArray(runs) && runs[0]) _showLastImport(runs[0]);
    } catch (e) { /* non-fatal */ }
  }

  function _pageHtml() {
    return '<div style="max-width:720px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">' +
        '<button class="btn btn-secondary btn-sm" onclick="showPage(\'pipeline\')">← Pipeline</button>' +
        '<h2 style="margin:0;font-size:16px;font-weight:700;color:var(--navy)">Import Smartsheet</h2>' +
      '</div>' +
      '<div id="imp-last-import"></div>' +
      '<div class="roster-card">' +
        '<div id="imp-drop" style="border:2px dashed var(--border);border-radius:12px;padding:52px 24px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s" onclick="document.getElementById(\'imp-file\').click()">' +
          '<div style="font-size:36px;margin-bottom:8px">📂</div>' +
          '<div style="font-weight:600;color:var(--navy);margin-bottom:4px">Upload Smartsheet xlsx</div>' +
          '<div style="font-size:12px;color:var(--ink-3)">Open 12m Tenders (State) – NSW export · drag &amp; drop or click</div>' +
          '<input type="file" id="imp-file" accept=".xlsx" style="display:none">' +
        '</div>' +
        '<div id="imp-status"  style="margin-top:16px"></div>' +
        '<div id="imp-diff"    style="margin-top:16px"></div>' +
        '<div id="imp-actions" style="margin-top:20px;display:none;text-align:right;border-top:1px solid var(--border);padding-top:16px">' +
          '<button class="btn btn-secondary" style="margin-right:8px" onclick="SKS_PIPELINE_IMPORT.cancel()">Cancel</button>' +
          '<button class="btn btn-primary" id="imp-confirm-btn" onclick="SKS_PIPELINE_IMPORT.confirm()">Confirm Import</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function _bindEvents() {
    var inp = document.getElementById('imp-file');
    if (inp) inp.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) _handleFile(f);
    });

    var dz = document.getElementById('imp-drop');
    if (!dz) return;
    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.style.borderColor = 'var(--sky)';
      dz.style.background  = 'rgba(61,168,216,.04)';
    });
    dz.addEventListener('dragleave', function () {
      dz.style.borderColor = 'var(--border)';
      dz.style.background  = '';
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.style.borderColor = 'var(--border)';
      dz.style.background  = '';
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!f.name.match(/\.xlsx$/i)) { showToast('Please drop an .xlsx file'); return; }
      _handleFile(f);
    });
  }

  async function _handleFile(file) {
    _fileName = file.name;
    _setStatus('<div style="color:var(--ink-2);font-size:13px">Reading file…</div>');
    _setDiff('');
    _setActions(false);
    _parsed = null; _diff = null;

    // Load SheetJS
    try { await _ensureXlsx(); }
    catch (e) {
      _setStatus('<div style="color:var(--red);font-size:13px">' + _esc(e.message) + '</div>');
      return;
    }

    // Parse
    var result;
    try { result = await window.SKS_TENDER_PARSER.parseTenderXlsx(file); }
    catch (e) {
      _setStatus('<div style="color:var(--red);font-size:13px">Parse error: ' + _esc(e.message) + '</div>');
      return;
    }

    var fatals = result.errors.filter(function (e) { return e.severity === 'fatal'; });
    if (fatals.length) {
      _setStatus('<div style="color:var(--red);font-size:13px">' + fatals.map(function (e) { return _esc(e.message); }).join('<br>') + '</div>');
      return;
    }

    _parsed = result;

    // Split above / below $100k threshold
    _aboveRows = result.rows.filter(function (r) { return !r.below_threshold; });
    _belowRows = result.rows.filter(function (r) { return r.below_threshold; });

    // Fetch existing for diff (diff only above-threshold rows)
    _setStatus('<div style="color:var(--ink-2);font-size:13px">Comparing with existing…</div>');
    var existing = [];
    try {
      // tenders is in ORG_TABLES — org_id filter auto-applied.
      // below_threshold=eq.false: compare like-for-like (above-threshold xlsx rows vs
      // above-threshold DB rows). Without this, any below-threshold tender previously
      // imported with "Include anyway" shows as MISSING every subsequent run.
      var rows = await sbFetch('tenders?select=external_ref,probability_pct,quote_value,stage,missing_import_count&below_threshold=eq.false&limit=5000');
      existing = Array.isArray(rows) ? rows : [];
    } catch (e) { /* non-fatal — diff will show all as new */ }

    _existingByRef = {};
    existing.forEach(function (e) { _existingByRef[e.external_ref] = e; });

    _diff = window.SKS_TENDER_PARSER.diffAgainstExisting(_aboveRows, existing);
    _renderDiff(_aboveRows, _diff);
    _setActions(true);
  }

  function _renderDiff(aboveRows, diff) {
    var warns   = (_parsed && _parsed.errors) ? _parsed.errors.filter(function (e) { return e.severity === 'warning'; }).length : 0;
    var changed = diff.stageChanged.length + diff.valueChanged.length;
    var total   = aboveRows.length + _belowRows.length;

    // Summary chips (counts are for above-threshold rows only; below shown separately)
    var status = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:' + (warns ? '8' : '0') + 'px">';
    status += _chip(total,              'Parsed',    '#64748b', '#f1f5f9');
    status += _chip(diff.new.length,    'New',       '#16a34a', '#dcfce7');
    status += _chip(changed,            'Changed',   '#d97706', '#fef3c7');
    status += _chip(diff.missing.length,'Missing',   '#dc2626', '#fee2e2');
    status += '</div>';
    if (warns) status += '<div style="font-size:11px;color:var(--ink-3)">' + warns + ' row(s) skipped — missing SKS Quote No</div>';
    _setStatus(status);

    // Preview table
    var changes = diff.new.concat(diff.stageChanged).concat(diff.valueChanged).concat(diff.missing);
    if (!changes.length) {
      _setDiff('<div style="text-align:center;padding:20px;color:var(--ink-2);font-size:13px">No changes — all tenders are up to date.</div>');
      return;
    }
    var cap = Math.min(changes.length, 60);
    var html = '<div style="font-size:11px;font-weight:600;color:var(--ink-2);margin-bottom:8px">Preview (' + cap + (changes.length > 60 ? ' of ' + changes.length : '') + ' changes)</div>';
    html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<thead><tr style="border-bottom:2px solid var(--border)">';
    ['Ref','Job','Client','Value','Stage','Change'].forEach(function (h) {
      html += '<th style="text-align:left;padding:5px 8px;color:var(--ink-2);font-weight:600;white-space:nowrap">' + h + '</th>';
    });
    html += '</tr></thead><tbody>';

    function addRows(arr, type, badge) {
      arr.slice(0, cap).forEach(function (r) {
        html += '<tr style="border-bottom:1px solid var(--border-lt)">';
        html += '<td style="padding:5px 8px;font-family:monospace;white-space:nowrap;color:var(--ink-2)">' + _esc(r.external_ref || '—') + '</td>';
        html += '<td style="padding:5px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(r.job_name || '—') + '</td>';
        html += '<td style="padding:5px 8px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)">' + _esc(r.client || '—') + '</td>';
        html += '<td style="padding:5px 8px;white-space:nowrap;font-weight:600">' + (r.quote_value ? '$' + _fmtK(r.quote_value) : '—') + '</td>';
        html += '<td style="padding:5px 8px;white-space:nowrap;color:var(--ink-2)">' + _esc(r.stage || '—') + '</td>';
        html += '<td style="padding:5px 8px">' + badge + '</td>';
        html += '</tr>';
      });
    }

    addRows(diff.new,          'new',     '<span style="background:#dcfce7;color:#16a34a;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600">NEW</span>');
    addRows(diff.stageChanged, 'stage',   '<span style="background:#fef3c7;color:#d97706;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600">STAGE</span>');
    addRows(diff.valueChanged, 'value',   '<span style="background:#dbeafe;color:#1d4ed8;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600">VALUE</span>');
    addRows(diff.missing,      'missing', '<span style="background:#fee2e2;color:#dc2626;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600">MISSING</span>');

    html += '</tbody></table></div>';

    // Below-threshold notice
    if (_belowRows.length) {
      html += '<div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ink-2)">';
      html += '<span>' + _belowRows.length + ' tender' + (_belowRows.length !== 1 ? 's' : '') + ' below $100k will be skipped</span>';
      html += '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:auto;white-space:nowrap">';
      html += '<input type="checkbox" id="imp-include-below"' + (_includeBelow ? ' checked' : '') + ' onchange="SKS_PIPELINE_IMPORT.toggleBelowThreshold(this.checked)">';
      html += '<span>Include anyway</span>';
      html += '</label>';
      html += '</div>';
    }

    _setDiff(html);
  }

  function _chip(n, label, color, bg) {
    return '<div style="background:' + bg + ';border-radius:8px;padding:8px 14px;text-align:center;min-width:72px">' +
      '<div style="font-size:19px;font-weight:700;color:' + color + '">' + n + '</div>' +
      '<div style="font-size:11px;color:var(--ink-2);margin-top:1px">' + label + '</div>' +
      '</div>';
  }

  // ── Confirm import ────────────────────────────────────────
  async function confirm() {
    if (!_parsed || !_diff) return;
    var btn = document.getElementById('imp-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    var now = new Date().toISOString();
    // Fields to exclude from upsert (DB-managed or import-only)
    var EXCLUDE = ['_row_index', '_probability_raw', 'first_imported_at', 'created_at', 'updated_at',
                   'archived_at', 'missing_import_count', 'job_number_id', 'site_id'];

    // Respect the below-threshold guardrail
    var rowsToUpsert = _includeBelow ? _aboveRows.concat(_belowRows) : _aboveRows;

    var upsertRows = rowsToUpsert.map(function (r) {
      var row = { org_id: TENANT.ORG_UUID, last_imported_at: now };
      Object.keys(r).forEach(function (k) {
        if (EXCLUDE.indexOf(k) === -1) row[k] = r[k];
      });
      // ── Confirmed stage protection ──────────────────────────────────────
      // If this tender is already Confirmed in the app (start date set, resources
      // committed), do NOT let the import reset its stage back to the
      // probability-derived value. Confirmed is the terminal app-managed stage;
      // Smartsheet probability no longer drives it.
      var dbRow = _existingByRef[r.external_ref];
      if (dbRow && dbRow.stage === 'confirmed') row.stage = 'confirmed';
      return row;
    });

    var ok = true;
    try {
      // Batch upsert — PostgREST merge-duplicates on unique constraint (org_id, external_ref)
      await sbFetch(
        'tenders?on_conflict=org_id,external_ref',
        'POST',
        upsertRows,
        'return=minimal,resolution=merge-duplicates'
      );
    } catch (e) {
      ok = false;
      showToast('Import failed: ' + e.message);
    }

    if (ok) {
      // ── Missing import count ────────────────────────────────────────────
      // Tenders in the DB but absent from this import get their missing_import_count
      // incremented. At 2 consecutive misses the tender is archived — it has
      // probably been closed or removed from Smartsheet. Confirmed tenders are
      // excluded: a job on-site won't appear in an open-tenders export.
      if (_diff && _diff.missing.length) {
        var missingPatches = _diff.missing
          .filter(function (m) { return m.stage !== 'confirmed'; })
          .map(function (m) {
            var newCount = (m.missing_import_count || 0) + 1;
            var patch = { missing_import_count: newCount };
            if (newCount >= 2) { patch.archived_at = now; patch.stage = 'archived'; }
            return sbFetch(
              'tenders?external_ref=eq.' + m.external_ref + '&org_id=eq.' + TENANT.ORG_UUID,
              'PATCH', patch
            );
          });
        try { await Promise.all(missingPatches); }
        catch (e) { console.warn('[pipeline-import] missing count patch failed:', e); }
      }

      // Record import run (non-fatal if this fails)
      try {
        var stats = window.SKS_TENDER_PARSER.summariseImport(_diff, rowsToUpsert);
        await sbFetch('tender_import_runs', 'POST', Object.assign({
          org_id:      TENANT.ORG_UUID,
          imported_at: now,
          file_name:   _fileName || null
        }, stats), 'return=minimal');
      } catch (e) { console.warn('[pipeline-import] run record failed:', e); }

      showToast('Imported ' + upsertRows.length + ' tenders');
      setTimeout(function () { showPage('pipeline'); }, 700);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm Import'; }
    }
  }

  function cancel() {
    _parsed = null; _diff = null;
    _aboveRows = []; _belowRows = []; _includeBelow = false;
    renderPipelineImport();
  }

  function toggleBelowThreshold(checked) {
    _includeBelow = !!checked;
    // Update confirm button label to reflect count change
    var btn = document.getElementById('imp-confirm-btn');
    var count = _includeBelow ? (_aboveRows.length + _belowRows.length) : _aboveRows.length;
    if (btn) btn.textContent = 'Confirm Import (' + count + ')';
  }

  // ── Last import timestamp ─────────────────────────────────
  function _showLastImport(run) {
    var el = document.getElementById('imp-last-import');
    if (!el || !run) return;
    var parts = ['Last import: <strong>' + _timeAgo(run.imported_at) + '</strong>'];
    if (run.file_name)  parts.push(_esc(run.file_name));
    if (run.rows_total) parts.push(run.rows_total + ' tenders');
    el.innerHTML = '<div style="font-size:12px;color:var(--ink-3);margin-bottom:12px">' + parts.join(' · ') + '</div>';
  }

  function _timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // ── DOM helpers ───────────────────────────────────────────
  function _setStatus(h)  { var e = document.getElementById('imp-status');  if (e) e.innerHTML = h; }
  function _setDiff(h)    { var e = document.getElementById('imp-diff');    if (e) e.innerHTML = h; }
  function _setActions(v) { var e = document.getElementById('imp-actions'); if (e) e.style.display = v ? '' : 'none'; }

  // ── Utils ─────────────────────────────────────────────────
  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _fmtK(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return Math.round(n / 1000) + 'k';
  }

  // ── Export ────────────────────────────────────────────────
  window.SKS_PIPELINE_IMPORT = {
    renderPipelineImport:  renderPipelineImport,
    confirm:               confirm,
    cancel:                cancel,
    toggleBelowThreshold:  toggleBelowThreshold
  };
})();
