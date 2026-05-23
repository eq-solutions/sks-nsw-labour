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
  var SHEETJS_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
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
  var _parsed   = null; // { rows:[], errors:[] }
  var _diff     = null; // { new:[], stageChanged:[], valueChanged:[], unchanged:[], missing:[] }
  var _fileName = '';

  // ── Render ────────────────────────────────────────────────
  function renderPipelineImport() {
    var el = document.getElementById('page-pipeline-import');
    if (!el) return;
    _parsed = null; _diff = null; _fileName = '';
    el.innerHTML = _pageHtml();
    _bindEvents();
  }

  function _pageHtml() {
    return '<div style="max-width:720px;margin:0 auto">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">' +
        '<button class="btn btn-secondary btn-sm" onclick="showPage(\'pipeline\')">← Pipeline</button>' +
        '<h2 style="margin:0;font-size:16px;font-weight:700;color:var(--navy)">Import Smartsheet</h2>' +
      '</div>' +
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

    // Fetch existing for diff
    _setStatus('<div style="color:var(--ink-2);font-size:13px">Comparing with existing…</div>');
    var existing = [];
    try {
      // tenders is in ORG_TABLES — org_id filter auto-applied
      var rows = await sbFetch('tenders?select=external_ref,probability_pct,quote_value,stage&limit=5000');
      existing = Array.isArray(rows) ? rows : [];
    } catch (e) { /* non-fatal — diff will show all as new */ }

    _diff = window.SKS_TENDER_PARSER.diffAgainstExisting(result.rows, existing);
    _renderDiff(result, _diff);
    _setActions(true);
  }

  function _renderDiff(parsed, diff) {
    var warns = parsed.errors.filter(function (e) { return e.severity === 'warning'; }).length;
    var belowCount = parsed.rows.filter(function (r) { return r.below_threshold; }).length;
    var changed = diff.stageChanged.length + diff.valueChanged.length;

    // Summary chips
    var status = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:' + (warns ? '8' : '0') + 'px">';
    status += _chip(parsed.rows.length, 'Parsed',   '#64748b', '#f1f5f9');
    status += _chip(diff.new.length,    'New',       '#16a34a', '#dcfce7');
    status += _chip(changed,            'Changed',   '#d97706', '#fef3c7');
    status += _chip(diff.missing.length,'Missing',   '#dc2626', '#fee2e2');
    status += _chip(belowCount,         'Below $100k','#94a3b8','#f8fafc');
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

    var upsertRows = _parsed.rows.map(function (r) {
      var row = { org_id: TENANT.ORG_UUID, last_imported_at: now };
      Object.keys(r).forEach(function (k) {
        if (EXCLUDE.indexOf(k) === -1) row[k] = r[k];
      });
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
      // Record import run (non-fatal if this fails)
      try {
        var stats = window.SKS_TENDER_PARSER.summariseImport(_diff, _parsed.rows);
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
    renderPipelineImport();
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
    renderPipelineImport: renderPipelineImport,
    confirm:              confirm,
    cancel:               cancel
  };
})();
