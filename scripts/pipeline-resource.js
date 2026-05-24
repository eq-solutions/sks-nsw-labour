/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/pipeline-resource.js  —  SKS NSW Labour
// Resource Allocation screen: Won tenders → fill in start date,
// hours, workers, PM → confirm → capacity planning chart.
// Phase A: generate pending_schedule rows on confirm.
// Phase B: review + push labour curve to live roster.
// Phase C: add active job (bypasses tender pipeline).
//
// Depends on: app-state.js, supabase.js, pipeline.js (STATE.managers)
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  var _tenders            = [];   // won + confirmed tenders
  var _enr                = {};   // keyed by tender_id → enrichment row
  var _noms               = {};   // keyed by tender_id → { pm, supervisor }
  var _managers           = [];
  var _people             = [];   // active people (id, name) for picker
  var _pending            = {};   // keyed by tender_id → [pending_schedule rows]
  var _headcount          = 0;
  var _openPanel          = null; // won tender_id with open alloc form
  var _openConfirmedPanel = null; // confirmed tender_id with open review panel
  var _addingJob          = false;

  // ── Entry point ───────────────────────────────────────────
  async function renderPipelineResource() {
    var el = document.getElementById('page-pipeline-resource');
    if (!el) return;
    el.innerHTML = _shell();
    await _load();
    _render();
  }

  function _shell() {
    return '<div style="max-width:900px;margin:0 auto" id="ra-root">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">' +
        '<button class="btn btn-secondary btn-sm" onclick="showPage(\'pipeline\')">← Pipeline</button>' +
        '<h2 style="margin:0;font-size:16px;font-weight:700;color:var(--navy)">Resource Allocation</h2>' +
        '<div style="flex:1"></div>' +
        '<button class="btn btn-primary btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openAddJob()">+ Add Active Job</button>' +
      '</div>' +
      '<div id="ra-body" style="color:var(--ink-2);font-size:13px">Loading…</div>' +
    '</div>';
  }

  // ── Data load ─────────────────────────────────────────────
  async function _load() {
    try {
      var results = await Promise.all([
        sbFetch('tenders?stage=in.(won,confirmed)&archived_at=is.null&below_threshold=eq.false&order=quote_value.desc.nullslast&limit=500'),
        sbFetch('tender_enrichment?select=*&limit=1000'),
        sbFetch('nominations?select=*&limit=2000'),
        sbFetch('people?select=id,name&archived=eq.false&order=name&limit=1000'),
        sbFetch('pending_schedule?select=*&confirmed_at=is.null&limit=5000')
      ]);

      _tenders = Array.isArray(results[0]) ? results[0] : [];

      _enr = {};
      (Array.isArray(results[1]) ? results[1] : []).forEach(function (e) {
        _enr[String(e.tender_id)] = e;
      });

      _noms = {};
      (Array.isArray(results[2]) ? results[2] : []).forEach(function (n) {
        if (!n.tender_id) return;
        var key = String(n.tender_id);
        if (!_noms[key]) _noms[key] = { pm: null, supervisor: null };
        if (n.role === 'pm')              _noms[key].pm         = n;
        else if (n.role === 'supervisor') _noms[key].supervisor = n;
      });

      _people    = Array.isArray(results[3]) ? results[3] : [];
      _headcount = _people.length;

      _pending = {};
      (Array.isArray(results[4]) ? results[4] : []).forEach(function (r) {
        var key = String(r.tender_id);
        if (!_pending[key]) _pending[key] = [];
        _pending[key].push(r);
      });

      if (typeof STATE !== 'undefined' && STATE.managers && STATE.managers.length) {
        _managers = STATE.managers.filter(function (m) { return !m.archived; });
      } else {
        var mRows = await sbFetch('managers?archived=eq.false&select=id,name,category&order=name');
        _managers = Array.isArray(mRows) ? mRows : [];
      }
    } catch (e) {
      console.error('[pipeline-resource] load failed:', e);
    }
  }

  // ── Main render ───────────────────────────────────────────
  function _render() {
    var el = document.getElementById('ra-body');
    if (!el) return;

    var won       = _tenders.filter(function (t) { return t.stage === 'won'; });
    var confirmed = _tenders.filter(function (t) { return t.stage === 'confirmed'; });

    var html = '';
    if (_addingJob) html += _addJobPanel();
    html += _capacitySection();
    html += _needsAllocSection(won);
    html += _confirmedSection(confirmed);

    el.innerHTML = html;

    if (_openPanel) suggestWorkers(_openPanel);
  }

  // ── Capacity planning chart ───────────────────────────────
  function _buildWeeklyDemand() {
    var NOW    = new Date(); NOW.setHours(0,0,0,0);
    var WEEK   = 7 * 24 * 60 * 60 * 1000;
    var WEEKS  = 26;
    var demand = new Array(WEEKS).fill(0);
    var labels = [];

    for (var w = 0; w < WEEKS; w++) {
      var d = new Date(NOW.getTime() + w * WEEK);
      labels.push(d.getDate() + '/' + (d.getMonth() + 1));
    }

    _tenders.forEach(function (t) {
      var e = _enr[String(t.id)];
      if (!e || !e.start_date_estimated || !e.peak_workers || !e.duration_weeks) return;
      var start = new Date(e.start_date_estimated); start.setHours(0,0,0,0);
      var end   = new Date(start.getTime() + e.duration_weeks * WEEK);
      for (var w = 0; w < WEEKS; w++) {
        var ws = new Date(NOW.getTime() + w * WEEK);
        var we = new Date(ws.getTime() + WEEK);
        if (start < we && end > ws) demand[w] += e.peak_workers;
      }
    });

    return { demand: demand, labels: labels };
  }

  function _capacitySection() {
    var allocated = _tenders.filter(function (t) {
      var e = _enr[String(t.id)];
      return e && e.start_date_estimated && e.peak_workers && e.duration_weeks;
    });

    var html = '<div class="roster-card" style="margin-bottom:20px">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:' + (allocated.length ? '14' : '0') + 'px">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2)">CAPACITY PLANNING — NEXT 26 WEEKS</div>';
    html += '<div style="font-size:12px;color:var(--ink-2)">' + _headcount + ' active staff</div>';
    html += '</div>';

    if (!allocated.length) {
      html += '<div style="padding:20px 0 4px;text-align:center;color:var(--ink-3);font-size:13px">';
      html += 'Set start dates and worker counts on Won jobs below to see the demand forecast.';
      html += '</div>';
      html += '</div>';
      return html;
    }

    var data   = _buildWeeklyDemand();
    var demand = data.demand;
    var labels = data.labels;
    var maxVal = Math.max(_headcount, Math.max.apply(null, demand), 1);
    var hasGap = _headcount > 0 && demand.some(function (d) { return d > _headcount; });

    html += '<div style="display:flex;align-items:flex-end;gap:1px;height:80px;position:relative;border-bottom:1px solid var(--border);margin-bottom:4px">';
    demand.forEach(function (d, i) {
      var pct   = d > 0 ? Math.max((d / maxVal) * 100, 3) : 0;
      var isGap = _headcount > 0 && d > _headcount;
      var bg    = d === 0 ? '#f1f5f9' : isGap ? '#fca5a5' : '#bfdbfe';
      var tip   = _esc(labels[i] + ': ' + d + ' workers' + (isGap ? ' — EXCEEDS HEADCOUNT' : ''));
      html += '<div title="' + tip + '" style="flex:1;background:' + bg + ';height:' + pct + '%;border-radius:1px 1px 0 0"></div>';
    });
    if (_headcount > 0) {
      var botPct = Math.min(_headcount / maxVal * 100, 100);
      html += '<div style="position:absolute;left:0;right:0;bottom:' + botPct + '%;border-top:2px dashed #dc2626;pointer-events:none" title="Headcount: ' + _headcount + '"></div>';
    }
    html += '</div>';

    html += '<div style="display:flex;gap:1px;margin-bottom:12px">';
    labels.forEach(function (l, i) {
      html += '<div style="flex:1;font-size:8px;color:var(--ink-3);text-align:center;overflow:hidden">' + (i % 4 === 0 ? l : '') + '</div>';
    });
    html += '</div>';

    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--ink-2)">';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#bfdbfe;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Workers needed</span>';
    if (_headcount > 0) {
      html += '<span><span style="display:inline-block;width:14px;border-top:2px dashed #dc2626;margin-right:4px;vertical-align:middle"></span>Headcount (' + _headcount + ')</span>';
    }
    if (hasGap) {
      html += '<span style="color:#dc2626;font-weight:600"><span style="display:inline-block;width:10px;height:10px;background:#fca5a5;border-radius:2px;margin-right:4px;vertical-align:middle"></span>⚠ Gap weeks</span>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ── Needs allocation ───────────────────────────────────────
  function _needsAllocSection(wonTenders) {
    var html = '<div class="roster-card" style="margin-bottom:20px">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2);margin-bottom:14px">NEEDS ALLOCATION (' + wonTenders.length + ')</div>';

    if (!wonTenders.length) {
      html += '<div style="padding:20px 0 4px;text-align:center;color:var(--ink-3);font-size:13px">No Won tenders waiting for allocation.<br>Move tenders to Won on the Pipeline board.</div>';
      html += '</div>';
      return html;
    }

    wonTenders.forEach(function (t) {
      var id   = String(t.id);
      var enr  = _enr[id] || {};
      var nom  = _noms[id] || { pm: null, supervisor: null };
      var pmN  = nom.pm ? _mgrName(nom.pm.person_id) : null;
      var isOpen = _openPanel === id;

      var chips = [];
      if (enr.start_date_estimated) chips.push('<span style="font-size:10px;background:#dcfce7;color:#166534;padding:1px 7px;border-radius:3px;white-space:nowrap">📅 ' + _esc(enr.start_date_estimated) + '</span>');
      if (enr.peak_workers)         chips.push('<span style="font-size:10px;background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:3px;white-space:nowrap">👷 ' + enr.peak_workers + ' workers</span>');
      if (pmN)                      chips.push('<span style="font-size:10px;background:#f3e8ff;color:#6b21a8;padding:1px 7px;border-radius:3px;white-space:nowrap">PM: ' + _esc(pmN.split(' ')[0]) + '</span>');
      var chipHtml = chips.length ? chips.join('') : '<span style="font-size:10px;color:#f97316;font-weight:600">Not allocated</span>';

      html += '<div id="ra-row-' + id + '" style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">';

      html += '<div onpointerdown="SKS_PIPELINE_RESOURCE.openPanel(\'' + id + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;background:' + (isOpen ? '#f0f9ff' : 'transparent') + ';user-select:none;-webkit-user-select:none">';
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-size:11px;font-family:monospace;color:var(--ink-2)">' + _esc(t.external_ref || '—') + '</div>';
      html += '<div style="font-size:13px;font-weight:600;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">' + _esc(t.job_name || '—') + '</div>';
      html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + _esc(t.client || '—') + (t.vertical ? ' · ' + _esc(t.vertical) : '') + '</div>';
      html += '</div>';
      html += '<div style="text-align:right;flex-shrink:0;min-width:90px">';
      html += '<div style="font-size:14px;font-weight:700;color:var(--navy)">' + (t.quote_value ? '$' + _fmtK(t.quote_value) : '—') + '</div>';
      html += '<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' + chipHtml + '</div>';
      html += '</div>';
      html += '<div style="font-size:14px;color:var(--ink-3);flex-shrink:0">' + (isOpen ? '▲' : '▼') + '</div>';
      html += '</div>';

      if (isOpen) html += _allocPanel(t, enr, nom);
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  function _allocPanel(t, enr, nom) {
    var id     = String(t.id);
    var pmMgrs = _managers.filter(function (m) { return m.category === 'Project Management'; });
    var spMgrs = _managers.filter(function (m) { return m.category === 'Supervisor'; });
    if (!pmMgrs.length) pmMgrs = _managers;
    if (!spMgrs.length) spMgrs = _managers;

    var curPm  = nom.pm  && nom.pm.person_id  ? String(nom.pm.person_id)  : '';
    var curSup = nom.supervisor && nom.supervisor.person_id ? String(nom.supervisor.person_id) : '';

    var html = '<div style="padding:14px 14px 16px;border-top:1px solid var(--border);background:#f8fafc">';

    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Start date</label>';
    html += '<input class="form-input" type="date" id="ra-start-' + id + '" value="' + _esc(enr.start_date_estimated || '') + '">';
    html += '</div>';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Est. hours</label>';
    html += '<input class="form-input" type="number" min="0" step="any" id="ra-hours-' + id + '" value="' + (enr.hours_estimated || '') + '" placeholder="—" oninput="SKS_PIPELINE_RESOURCE.suggestWorkers(\'' + id + '\')">';
    html += '</div>';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Duration (weeks)</label>';
    html += '<input class="form-input" type="number" min="1" id="ra-dur-' + id + '" value="' + (enr.duration_weeks || '') + '" placeholder="—" oninput="SKS_PIPELINE_RESOURCE.suggestWorkers(\'' + id + '\')">';
    html += '</div>';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Peak workers <span id="ra-sug-' + id + '" style="color:#3DA8D8;font-size:10px"></span></label>';
    html += '<input class="form-input" type="number" min="1" id="ra-workers-' + id + '" value="' + (enr.peak_workers || '') + '" placeholder="—">';
    html += '</div>';

    html += '</div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Project Manager</label>';
    html += '<select class="form-input" id="ra-pm-' + id + '">';
    html += '<option value="">— not nominated —</option>';
    pmMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === curPm ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html += '</select></div>';

    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Supervisor</label>';
    html += '<select class="form-input" id="ra-sup-' + id + '">';
    html += '<option value="">— not nominated —</option>';
    spMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === curSup ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html += '</select></div>';

    html += '</div>';

    html += '<div style="margin-bottom:14px">';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Notes</label>';
    html += '<textarea class="form-input" id="ra-notes-' + id + '" rows="2" placeholder="Scope assumptions, conditions, access…" style="resize:vertical">' + _esc(enr.confidence_notes || '') + '</textarea>';
    html += '</div>';

    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<button class="btn btn-secondary btn-sm" id="ra-save-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',false)">Save</button>';
    html += '<button class="btn btn-primary btn-sm" id="ra-conf-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',true)" title="Requires start date + workers">Save &amp; Confirm →</button>';
    html += '<div style="flex:1"></div>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openPanel(null)">Cancel</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Toggle alloc panel ─────────────────────────────────────
  function openPanel(tenderId) {
    _openPanel = (_openPanel === tenderId) ? null : (tenderId || null);
    _render();
  }

  // ── Worker suggestion ─────────────────────────────────────
  function suggestWorkers(tenderId) {
    var id    = String(tenderId);
    var hEl   = document.getElementById('ra-hours-'   + id);
    var dEl   = document.getElementById('ra-dur-'     + id);
    var wEl   = document.getElementById('ra-workers-' + id);
    var sEl   = document.getElementById('ra-sug-'     + id);
    var hours = parseFloat(hEl && hEl.value) || 0;
    var weeks = parseInt(dEl  && dEl.value, 10) || 0;
    if (hours > 0 && weeks > 0) {
      var s = Math.ceil(hours / (weeks * 38));
      if (sEl) sEl.textContent = '— suggest ' + s;
      if (wEl && !wEl.value) wEl.value = s;
    } else {
      if (sEl) sEl.textContent = '';
    }
  }

  // ── Save allocation ────────────────────────────────────────
  async function saveAlloc(tenderId, andConfirm) {
    var id      = String(tenderId);
    var saveBtn = document.getElementById('ra-save-' + id);
    var confBtn = document.getElementById('ra-conf-' + id);
    var active  = andConfirm ? confBtn : saveBtn;
    if (active) { active.disabled = true; active.textContent = 'Saving…'; }

    var start   = _strVal('ra-start-'   + id) || null;
    var hours   = _numVal('ra-hours-'   + id);
    var dur     = _intVal('ra-dur-'     + id);
    var workers = _intVal('ra-workers-' + id);
    var pmId    = _intVal('ra-pm-'      + id);
    var supId   = _intVal('ra-sup-'     + id);
    var notes   = _strVal('ra-notes-'   + id);

    if (andConfirm && (!start || !workers)) {
      showToast('Start date and peak workers required to confirm');
      if (active) { active.disabled = false; active.textContent = 'Save & Confirm →'; }
      return;
    }

    try {
      var enrBase = {
        tender_id:            id,
        hours_estimated:      hours,
        peak_workers:         workers,
        start_date_estimated: start,
        duration_weeks:       dur,
        confidence_notes:     notes
      };
      var existing = _enr[id];
      if (existing) {
        await sbFetch('tender_enrichment?tender_id=eq.' + id, 'PATCH', enrBase);
        _enr[id] = Object.assign({}, existing, enrBase);
      } else {
        var enrInsert = Object.assign({ updated_at: new Date().toISOString() }, enrBase);
        var rows = await sbFetch('tender_enrichment', 'POST', enrInsert, 'return=representation');
        _enr[id] = (Array.isArray(rows) && rows[0]) ? rows[0] : enrInsert;
      }

      var nom = _noms[id] || { pm: null, supervisor: null };
      await Promise.all([
        _upsertNom(id, 'pm',         pmId,  nom.pm),
        _upsertNom(id, 'supervisor',  supId, nom.supervisor)
      ]);

      if (andConfirm) {
        await sbFetch('tenders?id=eq.' + id, 'PATCH', { stage: 'confirmed', updated_at: new Date().toISOString() });
        var t = _tenders.find(function (x) { return String(x.id) === id; });
        if (t) t.stage = 'confirmed';

        // Phase A: generate pending_schedule rows (skip if already exists)
        if (workers && dur && start && !(_pending[id] && _pending[id].length)) {
          await _generatePendingSchedule(id, start, workers, dur);
        }

        _openPanel = null;
        _openConfirmedPanel = id; // open review panel on the newly confirmed job
      }

      showToast(andConfirm ? '✓ Confirmed — assign workers below' : 'Saved');
      if (!andConfirm) _openPanel = null;
      _render();
    } catch (e) {
      showToast('Save failed — ' + e.message);
      var label = andConfirm ? 'Save & Confirm →' : 'Save';
      if (active) { active.disabled = false; active.textContent = label; }
    }
  }

  async function _upsertNom(tenderId, role, newId, existing) {
    var nom = _noms[String(tenderId)] || (_noms[String(tenderId)] = { pm: null, supervisor: null });
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

  // ── Phase A: Generate pending_schedule rows ────────────────
  async function _generatePendingSchedule(tenderId, startDate, workers, durationWeeks) {
    // Snap startDate to the Monday of its containing week
    var d   = new Date(startDate);
    var dow = d.getDay(); // 0=Sun, 1=Mon…6=Sat
    var back = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - back);

    var rows = [];
    for (var w = 0; w < durationWeeks; w++) {
      var wDate = new Date(d.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      var wStr  = _toWeekStr(wDate);
      for (var p = 1; p <= workers; p++) {
        rows.push({ tender_id: tenderId, person_name_placeholder: 'Worker ' + p, week: wStr });
      }
    }

    // pending_schedule is in ORG_TABLES — sbFetch auto-stamps org_id on each row
    var inserted = await sbFetch('pending_schedule', 'POST', rows, 'return=representation');
    _pending[String(tenderId)] = Array.isArray(inserted) ? inserted : rows;
  }

  function _toWeekStr(date) {
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    var yy = String(date.getFullYear()).slice(-2);
    return dd + '.' + mm + '.' + yy;
  }

  // ── Phase B: Confirmed jobs ────────────────────────────────
  function _confirmedSection(confirmed) {
    var total = confirmed.reduce(function (s, t) { return s + (t.quote_value || 0); }, 0);

    var html = '<div class="roster-card">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2)">CONFIRMED JOBS (' + confirmed.length + ')</div>';
    if (confirmed.length) html += '<div style="font-size:13px;font-weight:700;color:#16a34a">$' + _fmtK(total) + ' locked in</div>';
    html += '</div>';

    if (!confirmed.length) {
      html += '<div style="padding:20px 0 4px;text-align:center;color:var(--ink-3);font-size:13px">No confirmed jobs yet.</div>';
      html += '</div>';
      return html;
    }

    confirmed.forEach(function (t) {
      var id    = String(t.id);
      var enr   = _enr[id] || {};
      var nom   = _noms[id] || { pm: null, supervisor: null };
      var pmN   = nom.pm ? _mgrName(nom.pm.person_id) : null;
      var spN   = nom.supervisor ? _mgrName(nom.supervisor.person_id) : null;
      var rows  = _pending[id] || [];
      var isOpen = _openConfirmedPanel === id;

      var meta = [];
      if (enr.start_date_estimated) meta.push('Start ' + _esc(enr.start_date_estimated));
      if (enr.duration_weeks)       meta.push(enr.duration_weeks + 'w');
      if (enr.peak_workers)         meta.push(enr.peak_workers + ' workers');
      if (enr.hours_estimated)      meta.push(enr.hours_estimated + 'h est.');
      if (pmN)                      meta.push('PM: ' + _esc(pmN));
      if (spN)                      meta.push('Sup: ' + _esc(spN));

      var badge = '';
      if (rows.length) {
        badge = ' <span style="font-size:10px;background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:3px;vertical-align:middle">' + rows.length + ' slots to assign</span>';
      } else if (enr.peak_workers && enr.duration_weeks) {
        badge = ' <span style="font-size:10px;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:3px;vertical-align:middle">✓ On roster</span>';
      }

      html += '<div id="ra-conf-row-' + id + '" style="border:1px solid ' + (rows.length ? '#fde68a' : '#bbf7d0') + ';border-radius:8px;margin-bottom:8px;overflow:hidden">';

      html += '<div onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(\'' + id + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;background:' + (rows.length ? '#fffbeb' : '#f0fdf4') + ';user-select:none;-webkit-user-select:none">';
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-size:11px;font-family:monospace;color:var(--ink-2)">' + _esc(t.external_ref || '—') + '</div>';
      html += '<div style="font-size:13px;font-weight:600;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">' + _esc(t.job_name || '—') + badge + '</div>';
      html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + (meta.length ? meta.join(' · ') : 'No resource details yet') + '</div>';
      html += '</div>';
      html += '<div style="text-align:right;flex-shrink:0">';
      html += '<div style="font-size:14px;font-weight:700;color:#16a34a">' + (t.quote_value ? '$' + _fmtK(t.quote_value) : '—') + '</div>';
      html += '<div style="font-size:10px;color:' + (rows.length ? '#854d0e' : '#16a34a') + ';margin-top:2px">✓ Confirmed ' + (isOpen ? '▲' : '▼') + '</div>';
      html += '</div>';
      html += '</div>';

      if (isOpen && rows.length) html += _labourCurvePanel(t, rows);
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  // ── Phase B: Labour curve review panel ────────────────────
  function _labourCurvePanel(t, rows) {
    var id = String(t.id);

    var byWeek = {};
    rows.forEach(function (r) {
      if (!byWeek[r.week]) byWeek[r.week] = [];
      byWeek[r.week].push(r);
    });

    var weeks = Object.keys(byWeek).sort(function (a, b) {
      var pa = a.split('.'), pb = b.split('.');
      return new Date('20' + pa[2] + '-' + pa[1] + '-' + pa[0]) - new Date('20' + pb[2] + '-' + pb[1] + '-' + pb[0]);
    });

    var html = '<div style="padding:14px 14px 16px;border-top:1px solid #fde68a;background:#fffdf5">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2);margin-bottom:10px">ASSIGN WORKERS TO ROSTER</div>';

    // Site code + summary
    html += '<div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:14px;padding:10px 12px;background:white;border:1px solid var(--border);border-radius:6px">';
    html += '<div>';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Site code (Mon–Fri for all workers)</label>';
    html += '<input class="form-input" type="text" id="ra-site-' + id + '" placeholder="e.g. DC1" style="width:100px;text-transform:uppercase" maxlength="10">';
    html += '</div>';
    html += '<div style="font-size:11px;color:var(--ink-3);padding-bottom:6px">' + weeks.length + ' week' + (weeks.length !== 1 ? 's' : '') + ' · ' + rows.length + ' slots · assign people then push</div>';
    html += '</div>';

    // Worker rows per week
    weeks.forEach(function (week) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Week of ' + _esc(week) + '</div>';
      byWeek[week].forEach(function (r) {
        var rId = String(r.id);
        html += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-lt)">';
        html += '<div style="font-size:11px;color:var(--ink-3);min-width:60px">' + _esc(r.person_name_placeholder || '—') + '</div>';
        html += '<select class="form-input" id="ra-ps-' + rId + '" style="flex:1">';
        html += '<option value="">— assign person —</option>';
        _people.forEach(function (p) {
          html += '<option value="' + p.id + '">' + _esc(p.name) + '</option>';
        });
        html += '</select>';
        html += '</div>';
      });
      html += '</div>';
    });

    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px;margin-top:4px">';
    html += '<button class="btn btn-primary btn-sm" id="ra-push-' + id + '" onclick="SKS_PIPELINE_RESOURCE.pushToRoster(\'' + id + '\')">Push to Roster →</button>';
    html += '<div style="font-size:11px;color:var(--ink-3);flex:1">Writes to the live roster. Unassigned slots are skipped.</div>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(null)">Close</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Toggle confirmed review panel ──────────────────────────
  function openConfirmedPanel(tenderId) {
    _openConfirmedPanel = (_openConfirmedPanel === tenderId) ? null : (tenderId || null);
    _render();
  }

  // ── Phase B: Push labour curve to live roster ──────────────
  async function pushToRoster(tenderId) {
    var id   = String(tenderId);
    var rows = _pending[id] || [];
    if (!rows.length) return;

    var siteEl = document.getElementById('ra-site-' + id);
    var site   = siteEl ? siteEl.value.toUpperCase().trim() : '';
    if (!site) { showToast('Enter a site code first'); return; }

    var pushBtn = document.getElementById('ra-push-' + id);
    if (pushBtn) { pushBtn.disabled = true; pushBtn.textContent = 'Pushing…'; }

    var now       = new Date().toISOString();
    var pushed    = 0;
    var skipped   = 0;

    try {
      for (var i = 0; i < rows.length; i++) {
        var r        = rows[i];
        var selEl    = document.getElementById('ra-ps-' + String(r.id));
        var personId = selEl ? (parseInt(selEl.value, 10) || null) : null;
        var person   = personId ? _people.find(function (p) { return String(p.id) === String(personId); }) : null;

        if (!person) { skipped++; continue; }

        var name = person.name;

        // GET the existing schedule row to avoid overwriting occupied days
        var existing = await sbFetch('schedule?name=eq.' + encodeURIComponent(name) + '&week=eq.' + encodeURIComponent(r.week) + '&select=*&limit=1');
        var schedRow = Array.isArray(existing) && existing[0];

        var days = ['mon', 'tue', 'wed', 'thu', 'fri'];
        if (schedRow) {
          // PATCH only empty weekday slots
          var patch = {};
          days.forEach(function (d) { if (!schedRow[d]) patch[d] = site; });
          if (Object.keys(patch).length) {
            await sbFetch('schedule?id=eq.' + schedRow.id, 'PATCH', patch);
          }
        } else {
          // POST new row
          var newRow = { name: name, week: r.week, mon: site, tue: site, wed: site, thu: site, fri: site, sat: null, sun: null };
          await sbFetch('schedule', 'POST', newRow, 'return=minimal');
        }

        // Mark pending_schedule row confirmed
        await sbFetch('pending_schedule?id=eq.' + r.id, 'PATCH', { confirmed_at: now, person_id: personId });
        pushed++;
      }

      // Remove pushed rows from local state
      delete _pending[id];

      var msg = '✓ ' + pushed + ' rows pushed to roster';
      if (skipped) msg += ' (' + skipped + ' unassigned skipped)';
      showToast(msg);
      _openConfirmedPanel = null;
      _render();
    } catch (e) {
      showToast('Push failed — ' + e.message);
      if (pushBtn) { pushBtn.disabled = false; pushBtn.textContent = 'Push to Roster →'; }
    }
  }

  // ── Phase C: Add Active Job ────────────────────────────────
  function openAddJob() {
    _addingJob = !_addingJob;
    _render();
  }

  function _addJobPanel() {
    var html = '<div class="roster-card" style="margin-bottom:20px;border:2px solid #3DA8D8">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#3DA8D8;margin-bottom:8px">ADD ACTIVE JOB</div>';
    html += '<div style="font-size:12px;color:var(--ink-2);margin-bottom:14px">Creates a confirmed job directly — no Smartsheet needed. Use for service contracts and scheduled maintenance.</div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Job name</label>';
    html += '<input class="form-input" id="aj-name" placeholder="e.g. DC1 Maintenance Contract"></div>';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Client</label>';
    html += '<input class="form-input" id="aj-client" placeholder="e.g. Equinix"></div>';
    html += '</div>';

    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Start date</label>';
    html += '<input class="form-input" type="date" id="aj-start"></div>';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Duration (weeks)</label>';
    html += '<input class="form-input" type="number" min="1" id="aj-dur" placeholder="—"></div>';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Peak workers</label>';
    html += '<input class="form-input" type="number" min="1" id="aj-workers" placeholder="—"></div>';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Est. value ($, optional)</label>';
    html += '<input class="form-input" type="number" min="0" id="aj-value" placeholder="—"></div>';
    html += '</div>';

    html += '<div style="display:flex;gap:10px">';
    html += '<button class="btn btn-primary btn-sm" id="aj-submit" onclick="SKS_PIPELINE_RESOURCE.submitAddJob()">Create &amp; Plan Labour →</button>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openAddJob()">Cancel</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  async function submitAddJob() {
    var name    = (_strVal('aj-name') || '').trim();
    var client  = _strVal('aj-client');
    var start   = _strVal('aj-start');
    var dur     = _intVal('aj-dur');
    var workers = _intVal('aj-workers');
    var value   = _numVal('aj-value');

    if (!name || !start || !workers || !dur) {
      showToast('Job name, start date, duration, and workers are required');
      return;
    }

    var btn = document.getElementById('aj-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    try {
      var ref = 'SVC-' + Date.now().toString(36).toUpperCase().slice(-6);
      var tenderRows = await sbFetch('tenders', 'POST', {
        external_ref:    ref,
        job_name:        name,
        client:          client || null,
        stage:           'confirmed',
        quote_value:     value || null,
        below_threshold: false
      }, 'return=representation');

      var tender = Array.isArray(tenderRows) && tenderRows[0];
      if (!tender || !tender.id) throw new Error('Job creation failed — no id returned');

      var enrData = {
        tender_id:            tender.id,
        start_date_estimated: start,
        duration_weeks:       dur,
        peak_workers:         workers,
        confidence_notes:     '',
        updated_at:           new Date().toISOString()
      };
      await sbFetch('tender_enrichment', 'POST', enrData, 'return=minimal');

      await _generatePendingSchedule(tender.id, start, workers, dur);

      _tenders.push(tender);
      _enr[String(tender.id)] = enrData;
      _addingJob          = false;
      _openConfirmedPanel = String(tender.id);

      showToast('✓ Active job created — assign workers below');
      _render();
    } catch (e) {
      showToast('Failed — ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Create & Plan Labour →'; }
    }
  }

  // ── Helpers ────────────────────────────────────────────────
  function _mgrName(personId) {
    if (!personId) return null;
    var m = _managers.find(function (x) { return String(x.id) === String(personId); });
    return m ? m.name : null;
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _fmtK(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return Math.round(n / 1000) + 'k';
  }

  function _strVal(id) {
    var e = document.getElementById(id); return e ? (e.value || '').trim() : '';
  }

  function _numVal(id) {
    var v = parseFloat(_strVal(id)); return isNaN(v) ? null : v;
  }

  function _intVal(id) {
    var v = parseInt(_strVal(id), 10); return isNaN(v) ? null : v;
  }

  // ── Export ─────────────────────────────────────────────────
  window.SKS_PIPELINE_RESOURCE = {
    renderPipelineResource: renderPipelineResource,
    openPanel:              openPanel,
    openConfirmedPanel:     openConfirmedPanel,
    suggestWorkers:         suggestWorkers,
    saveAlloc:              saveAlloc,
    pushToRoster:           pushToRoster,
    openAddJob:             openAddJob,
    submitAddJob:           submitAddJob
  };
})();
