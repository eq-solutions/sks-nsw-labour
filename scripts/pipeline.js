/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/pipeline.js  —  SKS NSW Labour  v3.4.89
// Tender pipeline Kanban, enrichment panel, nominations.
//
// Depends on: app-state.js, supabase.js
// Three visible stages: Watch (50%), Likely (70-90%), Won (100%).
// Confirmed tenders shown in a collapsed "Confirmed" column.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Stage config ──────────────────────────────────────────
  var STAGES = [
    { key: 'watch',  label: 'Watch',  color: '#d97706', bg: '#fef3c7', desc: '50%' },
    { key: 'likely', label: 'Likely', color: '#2563eb', bg: '#dbeafe', desc: '70–90%' },
    { key: 'won',    label: 'Won',    color: '#16a34a', bg: '#dcfce7', desc: '100%' }
  ];

  // ── Module state ─────────────────────────────────────────
  var _tenders    = [];
  var _enrichment = {};   // tender_id → enrichment row
  var _noms       = {};   // tender_id → { pm: row|null, supervisor: row|null }
  var _managers   = [];
  var _openId     = null;
  var _filterDept  = '';
  var _filterVert  = '';
  var _filterValue = 100000; // default: hide <$100k jobs
  var _loading    = false;
  var _lastImport = null;  // most recent tender_import_runs row

  // ── Load ─────────────────────────────────────────────────
  async function _load() {
    if (!TENANT.ORG_UUID) return;
    _loading = true;
    try {
      var [tRows, eRows, nRows] = await Promise.all([
        // tenders is in ORG_TABLES — org_id filter auto-applied
        sbFetch('tenders?stage=in.(watch,likely,won,confirmed)&archived_at=is.null' +
          '&order=quote_value.desc.nullslast&limit=500'),
        sbFetch('tender_enrichment?select=*&limit=1000'),
        sbFetch('nominations?select=*&limit=2000')
      ]);

      _tenders = Array.isArray(tRows) ? tRows : [];

      _enrichment = {};
      (Array.isArray(eRows) ? eRows : []).forEach(function (e) {
        _enrichment[e.tender_id] = e;
      });

      _noms = {};
      (Array.isArray(nRows) ? nRows : []).forEach(function (n) {
        if (!_noms[n.tender_id]) _noms[n.tender_id] = { pm: null, supervisor: null };
        // last write wins for each role
        if (n.role === 'pm')         _noms[n.tender_id].pm         = n;
        else if (n.role === 'supervisor') _noms[n.tender_id].supervisor = n;
      });

      // Use already-loaded managers if available
      if (STATE.managers && STATE.managers.length) {
        _managers = STATE.managers.filter(function (m) { return !m.archived; });
      } else {
        // managers is in ORG_TABLES — org_id filter auto-applied
        var mRows = await sbFetch('managers?archived=eq.false&select=id,name,category&order=name');
        _managers = Array.isArray(mRows) ? mRows : [];
      }

      // Last import timestamp (non-fatal)
      try {
        var iRows = await sbFetch('tender_import_runs?order=imported_at.desc&limit=1&select=imported_at,file_name');
        _lastImport = (Array.isArray(iRows) && iRows[0]) ? iRows[0] : null;
      } catch (e) { _lastImport = null; }
    } catch (e) {
      console.error('[pipeline] load error:', e);
    }
    _loading = false;
  }

  // ── Main render ───────────────────────────────────────────
  async function renderPipeline() {
    var el = document.getElementById('page-pipeline');
    if (!el) return;
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink-2)">Loading pipeline…</div>';

    await _load();
    if (!document.getElementById('page-pipeline')) return; // navigated away

    el.innerHTML = _buildHtml();

    // Restore open panel
    if (_openId) {
      var t = _findTender(_openId);
      if (t) openPanel(t);
    }
  }

  function _buildHtml() {
    var filtered = _tenders.filter(function (t) {
      if (t.stage === 'confirmed') return false; // handled separately below
      if (_filterDept && t.department !== _filterDept) return false;
      if (_filterVert && t.vertical  !== _filterVert)  return false;
      if (_filterValue && (t.quote_value || 0) < _filterValue) return false;
      return true;
    });

    var depts     = _uniq(_tenders.map(function (t) { return t.department; }).filter(Boolean)).sort();
    var verticals = _uniq(_tenders.map(function (t) { return t.vertical;   }).filter(Boolean)).sort();
    var confirmed = _tenders.filter(function (t) { return t.stage === 'confirmed'; });

    var html = '';

    // ── Header bar ─────────────────────────────────────────
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px">';
    html +=   '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
    // Dept filter
    html +=     '<select class="form-input" style="height:32px;font-size:12px;padding:0 8px;width:auto" onchange="SKS_PIPELINE.setDept(this.value)">';
    html +=       '<option value="">All departments</option>';
    depts.forEach(function (d) {
      html += '<option value="' + _esc(d) + '"' + (d === _filterDept ? ' selected' : '') + '>' + _esc(d) + '</option>';
    });
    html +=     '</select>';
    // Vertical filter
    html +=     '<select class="form-input" style="height:32px;font-size:12px;padding:0 8px;width:auto" onchange="SKS_PIPELINE.setVert(this.value)">';
    html +=       '<option value="">All verticals</option>';
    verticals.forEach(function (v) {
      html += '<option value="' + _esc(v) + '"' + (v === _filterVert ? ' selected' : '') + '>' + _esc(v) + '</option>';
    });
    html +=     '</select>';
    // Value filter
    var valueOpts = [
      { label: 'All values',  val: 0       },
      { label: '≥$100k',      val: 100000  },
      { label: '≥$250k',      val: 250000  },
      { label: '≥$500k',      val: 500000  },
      { label: '≥$1M',        val: 1000000 }
    ];
    html +=     '<select class="form-input" title="Applies to Watch and Likely only — Won tenders always shown" style="height:32px;font-size:12px;padding:0 8px;width:auto" onchange="SKS_PIPELINE.setValueFilter(+this.value)">';
    valueOpts.forEach(function (o) {
      html += '<option value="' + o.val + '"' + (o.val === _filterValue ? ' selected' : '') + '>' + _esc(o.label) + '</option>';
    });
    html +=     '</select>';
    html +=   '</div>';
    html +=   '<div style="display:flex;align-items:center;gap:10px">';
    if (_lastImport) html += '<span style="font-size:11px;color:var(--ink-3)" title="' + _esc(_lastImport.file_name || '') + '">Last import: ' + _timeAgo(_lastImport.imported_at) + '</span>';
    html +=   '<button class="btn btn-primary btn-sm" onclick="showPage(\'pipeline-import\')">↑ Import Smartsheet</button>';
    html +=   '</div>';
    html += '</div>';

    // ── Summary strip ──────────────────────────────────────
    var pipelineValue = 0;
    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px">';
    STAGES.forEach(function (s) {
      var cards = filtered.filter(function (t) { return t.stage === s.key; });
      var val   = cards.filter(function (t) { return !t.below_threshold; })
                       .reduce(function (sum, t) { return sum + (t.quote_value || 0); }, 0);
      pipelineValue += val;
      html += '<div style="background:' + s.bg + ';border-radius:10px;padding:10px 16px;min-width:100px">';
      html +=   '<div style="font-size:10px;font-weight:700;color:' + s.color + ';letter-spacing:.06em">' + s.label.toUpperCase() + '</div>';
      html +=   '<div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">' + cards.length + '</div>';
      if (val) html += '<div style="font-size:11px;color:var(--ink-2)">$' + _fmtK(val) + '</div>';
      html += '</div>';
    });
    if (pipelineValue) {
      html += '<div style="background:var(--bg-2);border-radius:10px;padding:10px 16px;min-width:100px">';
      html +=   '<div style="font-size:10px;font-weight:700;color:var(--ink-2);letter-spacing:.06em">PIPELINE</div>';
      html +=   '<div style="font-size:22px;font-weight:700;color:var(--navy);line-height:1.1">$' + _fmtK(pipelineValue) + '</div>';
      html +=   '<div style="font-size:11px;color:var(--ink-3)">watch + likely + won</div>';
      html += '</div>';
    }
    html += '</div>';

    // ── Empty state ────────────────────────────────────────
    if (!_tenders.length) {
      html += '<div style="text-align:center;padding:60px 24px">';
      html +=   '<div style="font-size:40px;margin-bottom:12px">📋</div>';
      html +=   '<div style="font-weight:700;color:var(--navy);font-size:16px;margin-bottom:8px">No tenders in pipeline</div>';
      html +=   '<div style="color:var(--ink-2);font-size:13px;margin-bottom:20px">Import a Smartsheet export to populate the pipeline.</div>';
      html +=   '<button class="btn btn-primary" onclick="showPage(\'pipeline-import\')">↑ Import Smartsheet</button>';
      html += '</div>';
      return html;
    }

    // ── Kanban columns ─────────────────────────────────────
    html += '<div style="display:flex;gap:16px;align-items:flex-start;overflow-x:auto;padding-bottom:20px">';
    STAGES.forEach(function (s) {
      var cards = filtered.filter(function (t) { return t.stage === s.key; });
      html += '<div style="flex:0 0 290px;background:var(--bg-2);border-radius:14px;padding:12px">';
      // Column header
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:0 2px">';
      html +=   '<div>';
      html +=     '<span style="font-weight:700;color:' + s.color + ';font-size:14px">' + s.label + '</span>';
      html +=     '<span style="font-size:11px;color:var(--ink-3);margin-left:5px">' + s.desc + '</span>';
      html +=   '</div>';
      html +=   '<span style="background:' + s.bg + ';color:' + s.color + ';font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px">' + cards.length + '</span>';
      html += '</div>';
      // Cards
      if (!cards.length) {
        html += '<div style="text-align:center;padding:20px 0;color:var(--ink-3);font-size:12px">No tenders</div>';
      } else {
        cards.forEach(function (t) { html += _cardHtml(t); });
      }
      html += '</div>';
    });

    // Confirmed column — click navigates to Resource Allocation
    if (confirmed.length) {
      html += '<div onclick="showPage(\'pipeline-resource\')" style="flex:0 0 180px;background:#f0fdf4;border-radius:14px;padding:12px;opacity:.85;cursor:pointer;transition:opacity .12s" onmouseenter="this.style.opacity=\'1\'" onmouseleave="this.style.opacity=\'.85\'">';
      html +=   '<div style="font-weight:700;color:#166534;font-size:14px;margin-bottom:4px">Confirmed</div>';
      html +=   '<div style="font-size:28px;font-weight:700;color:#16a34a">' + confirmed.length + '</div>';
      html +=   '<div style="font-size:11px;color:#166534;margin-top:4px">→ Resources</div>';
      html += '</div>';
    }
    html += '</div>';

    // ── Detail panel (hidden by default) ──────────────────
    html += '<div id="pl-panel" style="display:none;position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);background:#fff;border-left:1px solid var(--border);box-shadow:-6px 0 32px rgba(0,0,0,.14);z-index:300;overflow-y:auto"></div>';
    html += '<div id="pl-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:299" onclick="SKS_PIPELINE.closePanel()"></div>';

    return html;
  }

  // ── Card HTML ─────────────────────────────────────────────
  function _cardHtml(t) {
    var enr = _enrichment[t.id] || {};
    var nom = _noms[t.id] || {};
    var pmName  = nom.pm  && nom.pm.person_id  ? _mgrName(nom.pm.person_id)  : null;
    var supName = nom.supervisor && nom.supervisor.person_id ? _mgrName(nom.supervisor.person_id) : null;

    var html = '<div data-tender-id="' + t.id + '" onclick="SKS_PIPELINE.openPanel(\'' + t.id + '\')" style="background:#fff;border-radius:10px;border:1px solid var(--border);padding:12px;margin-bottom:8px;cursor:pointer;transition:box-shadow .12s,transform .12s" onmouseenter="this.style.boxShadow=\'0 3px 10px rgba(0,0,0,.1)\';this.style.transform=\'translateY(-1px)\'" onmouseleave="this.style.boxShadow=\'none\';this.style.transform=\'\'">';

    // Ref + value row
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px">';
    html +=   '<span style="font-size:10px;color:var(--ink-3);font-family:monospace">' + _esc(t.external_ref) + '</span>';
    if (t.quote_value && !t.below_threshold) {
      html += '<span style="font-size:12px;font-weight:700;color:var(--navy)">$' + _fmtK(t.quote_value) + '</span>';
    } else if (t.below_threshold) {
      html += '<span style="font-size:10px;color:var(--ink-3)">&lt;$100k</span>';
    }
    html += '</div>';

    // Job name
    html += '<div style="font-weight:600;font-size:13px;color:var(--navy);line-height:1.35;margin-bottom:4px">' + _esc(t.job_name) + '</div>';

    // Client
    if (t.client) html += '<div style="font-size:12px;color:var(--ink-2);margin-bottom:6px">' + _esc(t.client) + '</div>';

    // Probability + due date
    if (t.probability_label || t.due_date) {
      html += '<div style="display:flex;gap:10px;font-size:11px;color:var(--ink-3);margin-bottom:6px;flex-wrap:wrap">';
      if (t.probability_label) html += '<span>' + _esc(t.probability_label) + '</span>';
      if (t.due_date)          html += '<span>Due ' + t.due_date + '</span>';
      html += '</div>';
    }

    // Tags (enrichment + nominations)
    var tags = [];
    if (enr.hours_estimated)  tags.push('~' + enr.hours_estimated + 'h');
    if (enr.peak_workers)     tags.push(enr.peak_workers + ' workers');
    if (pmName)               tags.push('PM: ' + pmName.split(' ')[0]);
    if (supName)              tags.push('Sup: ' + supName.split(' ')[0]);
    if (tags.length) {
      html += '<div style="display:flex;gap:4px;flex-wrap:wrap">';
      tags.forEach(function (tag) {
        html += '<span style="background:#EAF5FB;color:#2986B4;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:500">' + _esc(tag) + '</span>';
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // ── Detail panel ─────────────────────────────────────────
  function openPanel(idOrTender) {
    var t = (typeof idOrTender === 'string') ? _findTender(idOrTender) : idOrTender;
    if (!t) return;
    _openId = t.id;
    var panel    = document.getElementById('pl-panel');
    var backdrop = document.getElementById('pl-backdrop');
    if (!panel) return;
    panel.style.display    = '';
    if (backdrop) backdrop.style.display = '';
    panel.innerHTML = _panelHtml(t);
  }

  function closePanel() {
    _openId = null;
    var p = document.getElementById('pl-panel');
    var b = document.getElementById('pl-backdrop');
    if (p) p.style.display = 'none';
    if (b) b.style.display = 'none';
  }

  function _panelHtml(t) {
    var enr     = _enrichment[t.id] || {};
    var nom     = _noms[t.id] || {};
    var pmMgrs  = _managers.filter(function (m) { return m.category === 'Project Management'; });
    var supMgrs = _managers.filter(function (m) { return m.category === 'Supervisor'; });
    var currentPmId  = nom.pm  && nom.pm.person_id  ? String(nom.pm.person_id)  : '';
    var currentSupId = nom.supervisor && nom.supervisor.person_id ? String(nom.supervisor.person_id) : '';

    var html = '<div style="padding:20px 22px">';

    // ── Panel header ──────────────────────────────────────
    html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px">';
    html +=   '<div style="min-width:0;flex:1">';
    html +=     '<div style="font-size:11px;color:var(--ink-3);font-family:monospace;margin-bottom:4px">' + _esc(t.external_ref) + '</div>';
    html +=     '<div style="font-size:16px;font-weight:700;color:var(--navy);line-height:1.3">' + _esc(t.job_name) + '</div>';
    if (t.client) html += '<div style="font-size:13px;color:var(--ink-2);margin-top:3px">' + _esc(t.client) + '</div>';
    html +=   '</div>';
    html +=   '<button onclick="SKS_PIPELINE.closePanel()" style="background:none;border:none;font-size:22px;color:var(--ink-3);cursor:pointer;padding:0;margin-left:12px;flex-shrink:0;line-height:1">✕</button>';
    html += '</div>';

    // Stage mover — pill buttons (Watch / Likely / Won)
    html += '<div style="display:flex;gap:6px;margin-bottom:16px">';
    STAGES.forEach(function (s) {
      var cur = t.stage === s.key;
      html += '<button onpointerdown="SKS_PIPELINE.moveStage(\'' + t.id + '\',\'' + s.key + '\')" ' +
        'style="flex:1;padding:7px 0;border-radius:8px;font-size:12px;font-weight:' + (cur ? '700' : '500') + ';' +
        'cursor:pointer;border:2px solid ' + s.color + ';' +
        'background:' + (cur ? s.bg : '#fff') + ';color:' + (cur ? s.color : 'var(--ink-3)') + '">' +
        s.label + '</button>';
    });
    html += '</div>';

    // Key facts (stage chip removed — pills above serve that purpose)
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px">';
    if (t.probability_label) html += '<span style="background:var(--bg-2);color:var(--ink-2);padding:3px 12px;border-radius:20px;font-size:12px">' + _esc(t.probability_label) + '</span>';
    if (t.quote_value && !t.below_threshold) html += '<span style="background:var(--bg-2);color:var(--navy);padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700">$' + _fmtK(t.quote_value) + '</span>';
    if (t.due_date)   html += '<span style="background:var(--bg-2);color:var(--ink-2);padding:3px 12px;border-radius:20px;font-size:12px">Due ' + t.due_date + '</span>';
    if (t.department) html += '<span style="background:var(--bg-2);color:var(--ink-2);padding:3px 12px;border-radius:20px;font-size:12px">' + _esc(t.department) + '</span>';
    if (t.vertical)   html += '<span style="background:var(--bg-2);color:var(--ink-2);padding:3px 12px;border-radius:20px;font-size:12px">' + _esc(t.vertical) + '</span>';
    html += '</div>';

    // ── Estimating ────────────────────────────────────────
    html += '<div style="border-top:1px solid var(--border);padding-top:18px;margin-bottom:22px">';
    html +=   '<div style="font-size:11px;font-weight:700;color:var(--ink-2);letter-spacing:.06em;margin-bottom:14px">PLANNING ESTIMATE</div>';
    html +=   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">';
    html +=     '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Est. hours</label>';
    html +=       '<input class="form-input" type="number" min="0" id="enr-hours" value="' + (enr.hours_estimated || '') + '" placeholder="—"></div>';
    html +=     '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Peak workers</label>';
    html +=       '<input class="form-input" type="number" min="0" id="enr-workers" value="' + (enr.peak_workers || '') + '" placeholder="—"></div>';
    html +=     '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Start date (est)</label>';
    html +=       '<input class="form-input" type="date" id="enr-start" value="' + (enr.start_date_estimated || '') + '"></div>';
    html +=     '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Duration (weeks)</label>';
    html +=       '<input class="form-input" type="number" min="1" id="enr-duration" value="' + (enr.duration_weeks || '') + '" placeholder="—"></div>';
    html +=   '</div>';
    html +=   '<div style="margin-bottom:12px"><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Notes</label>';
    html +=     '<textarea class="form-input" id="enr-notes" rows="2" placeholder="Confidence, scope, assumptions…" style="resize:vertical">' + _esc(enr.confidence_notes || '') + '</textarea></div>';
    // ── Nominations ───────────────────────────────────────
    html += '<div style="border-top:1px solid var(--border);padding-top:18px">';
    html +=   '<div style="font-size:11px;font-weight:700;color:var(--ink-2);letter-spacing:.06em;margin-bottom:14px">NOMINATIONS</div>';

    html +=   '<div style="margin-bottom:12px"><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Project Manager</label>';
    html +=     '<select class="form-input" id="nom-pm">';
    html +=       '<option value="">— not nominated —</option>';
    pmMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === currentPmId ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html +=     '</select></div>';

    html +=   '<div style="margin-bottom:20px"><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:4px">Supervisor</label>';
    html +=     '<select class="form-input" id="nom-sup">';
    html +=       '<option value="">— not nominated —</option>';
    supMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === currentSupId ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html +=     '</select></div>';

    html +=   '<button class="btn btn-primary btn-sm" id="panel-save-btn" style="width:100%" onclick="SKS_PIPELINE.savePanel(\'' + t.id + '\')">Save</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Save panel (estimates + nominations in one hit) ───────
  async function savePanel(tenderId) {
    var btn = document.getElementById('panel-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    var enrData = {
      tender_id:            tenderId,
      hours_estimated:      _numVal('enr-hours'),
      peak_workers:         _intVal('enr-workers'),
      start_date_estimated: _strVal('enr-start') || null,
      duration_weeks:       _intVal('enr-duration'),
      confidence_notes:     _strVal('enr-notes'),
      updated_at:           new Date().toISOString()
    };
    var pmId  = _intVal('nom-pm');
    var supId = _intVal('nom-sup');

    try {
      // Enrichment upsert
      var existing = _enrichment[tenderId];
      if (existing) {
        await sbFetch('tender_enrichment?tender_id=eq.' + tenderId, 'PATCH', enrData);
        _enrichment[tenderId] = Object.assign({}, existing, enrData);
      } else {
        var rows = await sbFetch('tender_enrichment', 'POST', enrData, 'return=representation');
        _enrichment[tenderId] = (Array.isArray(rows) && rows[0]) ? rows[0] : enrData;
      }
      // Nominations upsert
      if (!_noms[tenderId]) _noms[tenderId] = { pm: null, supervisor: null };
      var nom = _noms[tenderId];
      await Promise.all([
        _upsertNom(tenderId, 'pm',         pmId,  nom.pm),
        _upsertNom(tenderId, 'supervisor',  supId, nom.supervisor)
      ]);
      showToast('Saved');
      _refreshCard(tenderId);
    } catch (e) {
      showToast('Save failed — ' + e.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }

  // ── Save enrichment ───────────────────────────────────────
  async function saveEnrichment(tenderId) {
    var data = {
      tender_id:            tenderId,
      hours_estimated:      _numVal('enr-hours'),
      peak_workers:         _intVal('enr-workers'),
      start_date_estimated: _strVal('enr-start') || null,
      duration_weeks:       _intVal('enr-duration'),
      confidence_notes:     _strVal('enr-notes'),
      updated_at:           new Date().toISOString()
    };

    var btn = document.getElementById('enr-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      var existing = _enrichment[tenderId];
      if (existing) {
        await sbFetch('tender_enrichment?tender_id=eq.' + tenderId, 'PATCH', data);
        _enrichment[tenderId] = Object.assign({}, existing, data);
      } else {
        var rows = await sbFetch('tender_enrichment', 'POST', data, 'return=representation');
        _enrichment[tenderId] = (Array.isArray(rows) && rows[0]) ? rows[0] : data;
      }
      showToast('Estimates saved');
      _refreshCard(tenderId);
    } catch (e) {
      showToast('Save failed — ' + e.message);
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Save estimates'; }
  }

  // ── Save nominations ──────────────────────────────────────
  async function saveNominations(tenderId) {
    var pmId  = _intVal('nom-pm');
    var supId = _intVal('nom-sup');

    var btn = document.getElementById('nom-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    if (!_noms[tenderId]) _noms[tenderId] = { pm: null, supervisor: null };
    var nom = _noms[tenderId];

    try {
      await Promise.all([
        _upsertNom(tenderId, 'pm',         pmId,  nom.pm),
        _upsertNom(tenderId, 'supervisor',  supId, nom.supervisor)
      ]);
      showToast('Nominations saved');
      _refreshCard(tenderId);
    } catch (e) {
      showToast('Save failed — ' + e.message);
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Save nominations'; }
  }

  async function _upsertNom(tenderId, role, newId, existing) {
    var nom = _noms[tenderId] || (_noms[tenderId] = { pm: null, supervisor: null });
    var key = role === 'pm' ? 'pm' : 'supervisor';

    if (newId && existing) {
      if (String(existing.person_id) !== String(newId)) {
        await sbFetch('nominations?id=eq.' + existing.id, 'PATCH', { person_id: newId });
        nom[key] = Object.assign({}, existing, { person_id: newId });
      }
    } else if (newId && !existing) {
      var row = { tender_id: tenderId, person_id: newId, role: role, status: 'pencilled', is_primary: true };
      var res = await sbFetch('nominations', 'POST', row, 'return=representation');
      nom[key] = (Array.isArray(res) && res[0]) ? res[0] : row;
    } else if (!newId && existing) {
      await sbFetch('nominations?id=eq.' + existing.id, 'DELETE');
      nom[key] = null;
    }
  }

  // ── Refresh a single card in the DOM ─────────────────────
  function _refreshCard(tenderId) {
    var cardEl = document.querySelector('[data-tender-id="' + tenderId + '"]');
    var t = _findTender(tenderId);
    if (!cardEl || !t) return;
    // Replace just the card's outer HTML (outerHTML swap)
    var tmp = document.createElement('div');
    tmp.innerHTML = _cardHtml(t);
    var newCard = tmp.firstChild;
    if (newCard) cardEl.parentNode.replaceChild(newCard, cardEl);
  }

  // ── Filter setters (called from inline onchange) ──────────
  function setDept(v)         { _filterDept  = v;    renderPipeline(); }
  function setVert(v)         { _filterVert  = v;    renderPipeline(); }
  function setValueFilter(v)  { _filterValue = v;    renderPipeline(); }

  // ── Move a tender to a different stage ────────────────────
  // Called from the pill buttons in the slide-out panel.
  // Updates DB, updates local state, rebuilds board from local
  // state (no re-fetch) then reopens the panel at the new stage.
  async function moveStage(tenderId, newStage) {
    var t = _tenders.find(function (x) { return String(x.id) === String(tenderId); });
    if (!t || t.stage === newStage) return;
    try {
      await sbFetch('tenders?id=eq.' + tenderId, 'PATCH', {
        stage:      newStage,
        updated_at: new Date().toISOString()
      });
      t.stage = newStage;
      var stageMeta = STAGES.find(function (s) { return s.key === newStage; });
      showToast('Moved to ' + (stageMeta ? stageMeta.label : newStage));
      // Rebuild board from local state (no loading spinner, instant)
      var boardEl = document.getElementById('page-pipeline');
      if (boardEl) {
        boardEl.innerHTML = _buildHtml();
        // Re-open the panel so the pills reflect the new stage
        if (_openId) {
          var reopenTender = _tenders.find(function (x) { return String(x.id) === String(_openId); });
          if (reopenTender) openPanel(reopenTender);
        }
      }
    } catch (e) {
      showToast('Move failed — ' + e.message);
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  function _findTender(id)   { return _tenders.find(function (t) { return t.id === id; }) || null; }
  function _mgrName(id)      { var m = _managers.find(function (m) { return String(m.id) === String(id); }); return m ? m.name : ''; }
  function _uniq(a)          { return a.filter(function (v, i, s) { return s.indexOf(v) === i; }); }

  function _numVal(id) { var e = document.getElementById(id); return (e && e.value !== '') ? parseFloat(e.value) : null; }
  function _intVal(id) { var e = document.getElementById(id); return (e && e.value !== '') ? parseInt(e.value, 10) : null; }
  function _strVal(id) { var e = document.getElementById(id); return e ? (e.value || '').trim() : ''; }

  function _timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _fmtK(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return Math.round(n / 1000) + 'k';
  }

  // ── Export ────────────────────────────────────────────────
  window.SKS_PIPELINE = {
    renderPipeline:  renderPipeline,
    openPanel:       openPanel,
    closePanel:      closePanel,
    savePanel:       savePanel,
    setDept:         setDept,
    setVert:         setVert,
    setValueFilter:  setValueFilter,
    moveStage:       moveStage
  };
})();
