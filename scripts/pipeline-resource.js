/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/pipeline-resource.js  —  SKS NSW Labour
// Resource Allocation screen: Won tenders → fill in start date,
// hours, workers, PM → confirm → capacity planning chart.
// Phase A: generate pending_schedule rows on confirm.
// Phase B: track-based labour assignment + push to live roster.
// Phase C: add active job (bypasses tender pipeline).
//
// Depends on: app-state.js, supabase.js, pipeline.js (STATE.managers)
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  var _tenders            = [];
  var _enr                = {};
  var _noms               = {};
  var _managers           = [];
  var _people             = [];
  var _pending            = {};   // tenderId → [pending_schedule rows] (includes pushed rows in-session)
  var _headcount          = 0;
  var _openPanel          = null;
  var _openConfirmedPanel = null;
  var _addingJob          = false;

  // Phase B: contract assignment state (persists across re-renders within session)
  var _ca        = {};   // tenderId → { tracks: [{label,weekStrs[],rowIds[],segments:[{fromIdx,toIdx,personId}]}] }
  var _wplan     = {};   // tenderId → pending write plan awaiting conflict resolution
  var _siteCodes = {};   // tenderId → site code string (persists across re-renders)
  var _splitOpen = null; // 'tid:ti:si' — which segment's split-week picker is open

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
      html += '<div style="padding:20px 0 4px;text-align:center;color:var(--ink-3);font-size:13px">Set start dates and worker counts on Won jobs below to see the demand forecast.</div>';
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

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Start date</label>';
    html += '<input class="form-input" type="date" id="ra-start-' + id + '" value="' + _esc(enr.start_date_estimated || '') + '"></div>';

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Est. hours</label>';
    html += '<input class="form-input" type="number" min="0" step="any" id="ra-hours-' + id + '" value="' + (enr.hours_estimated || '') + '" placeholder="—" oninput="SKS_PIPELINE_RESOURCE.suggestWorkers(\'' + id + '\')"></div>';

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Duration (weeks)</label>';
    html += '<input class="form-input" type="number" min="1" id="ra-dur-' + id + '" value="' + (enr.duration_weeks || '') + '" placeholder="—" oninput="SKS_PIPELINE_RESOURCE.suggestWorkers(\'' + id + '\')"></div>';

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Peak workers <span id="ra-sug-' + id + '" style="color:#3DA8D8;font-size:10px"></span></label>';
    html += '<input class="form-input" type="number" min="1" id="ra-workers-' + id + '" value="' + (enr.peak_workers || '') + '" placeholder="—"></div>';

    html += '</div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">';

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Project Manager</label>';
    html += '<select class="form-input" id="ra-pm-' + id + '"><option value="">— not nominated —</option>';
    pmMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === curPm ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html += '</select></div>';

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Supervisor</label>';
    html += '<select class="form-input" id="ra-sup-' + id + '"><option value="">— not nominated —</option>';
    spMgrs.forEach(function (m) {
      html += '<option value="' + m.id + '"' + (String(m.id) === curSup ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
    });
    html += '</select></div>';

    html += '</div>';

    html += '<div style="margin-bottom:14px"><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Notes</label>';
    html += '<textarea class="form-input" id="ra-notes-' + id + '" rows="2" placeholder="Scope assumptions, conditions, access…" style="resize:vertical">' + _esc(enr.confidence_notes || '') + '</textarea></div>';

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
        _upsertNom(id, 'pm',        pmId,  nom.pm),
        _upsertNom(id, 'supervisor', supId, nom.supervisor)
      ]);

      if (andConfirm) {
        await sbFetch('tenders?id=eq.' + id, 'PATCH', { stage: 'confirmed', updated_at: new Date().toISOString() });
        var t = _tenders.find(function (x) { return String(x.id) === id; });
        if (t) t.stage = 'confirmed';

        if (workers && dur && start && !(_pending[id] && _pending[id].length)) {
          await _generatePendingSchedule(id, start, workers, dur);
          delete _ca[id]; // force track re-init with fresh rows
        }

        _openPanel = null;
        _openConfirmedPanel = id;
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
    var d   = new Date(startDate);
    var dow = d.getDay();
    var back = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - back); // snap to Monday

    var rows = [];
    for (var w = 0; w < durationWeeks; w++) {
      var wDate = new Date(d.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      var wStr  = _toWeekStr(wDate);
      for (var p = 1; p <= workers; p++) {
        rows.push({ tender_id: tenderId, person_name_placeholder: 'Worker ' + p, week: wStr });
      }
    }
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

      var unpushed = rows.filter(function (r) { return !r._pushed; });
      var hasPushed = rows.some(function (r) { return r._pushed; });

      var meta = [];
      if (enr.start_date_estimated) meta.push('Start ' + _esc(enr.start_date_estimated));
      if (enr.duration_weeks)       meta.push(enr.duration_weeks + 'w');
      if (enr.peak_workers)         meta.push(enr.peak_workers + ' workers');
      if (pmN)                      meta.push('PM: ' + _esc(pmN));
      if (spN)                      meta.push('Sup: ' + _esc(spN));

      var badge = '';
      var borderColor = '#bbf7d0';
      var bgColor     = '#f0fdf4';
      if (unpushed.length) {
        badge       = ' <span style="font-size:10px;background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:3px;vertical-align:middle">' + unpushed.length + ' slots to assign</span>';
        borderColor = '#fde68a';
        bgColor     = '#fffbeb';
      } else if (hasPushed || (enr.peak_workers && enr.duration_weeks)) {
        badge = ' <span style="font-size:10px;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:3px;vertical-align:middle">✓ On roster</span>';
      }

      html += '<div id="ra-conf-row-' + id + '" style="border:1px solid ' + borderColor + ';border-radius:8px;margin-bottom:8px;overflow:hidden">';
      html += '<div onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(\'' + id + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;background:' + bgColor + ';user-select:none;-webkit-user-select:none">';
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-size:11px;font-family:monospace;color:var(--ink-2)">' + _esc(t.external_ref || '—') + '</div>';
      html += '<div style="font-size:13px;font-weight:600;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">' + _esc(t.job_name || '—') + badge + '</div>';
      html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + (meta.length ? meta.join(' · ') : 'No resource details yet') + '</div>';
      html += '</div>';
      html += '<div style="text-align:right;flex-shrink:0">';
      html += '<div style="font-size:14px;font-weight:700;color:#16a34a">' + (t.quote_value ? '$' + _fmtK(t.quote_value) : '—') + '</div>';
      html += '<div style="font-size:10px;color:' + (unpushed.length ? '#854d0e' : '#16a34a') + ';margin-top:2px">✓ Confirmed ' + (isOpen ? '▲' : '▼') + '</div>';
      html += '</div>';
      html += '</div>';

      if (isOpen && rows.length) html += _labourCurvePanel(t, rows);
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  // ── Phase B: Initialise contract assignment tracks ─────────
  function _initCA(tenderId, rows) {
    var id = String(tenderId);
    if (_ca[id]) return; // preserve in-session state across re-renders

    // Group rows by worker placeholder, sort each group by week date
    var byWorker = {};
    rows.forEach(function (r) {
      var key = r.person_name_placeholder || 'Worker 1';
      if (!byWorker[key]) byWorker[key] = [];
      byWorker[key].push(r);
    });

    function parseWk(s) {
      var p = s.split('.');
      return new Date('20' + p[2] + '-' + p[1] + '-' + p[0]);
    }

    var workerKeys = Object.keys(byWorker).sort(function (a, b) {
      var na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      var nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });

    var tracks = workerKeys.map(function (key) {
      var sorted = byWorker[key].slice().sort(function (a, b) {
        return parseWk(a.week) - parseWk(b.week);
      });
      return {
        label:    key,
        weekStrs: sorted.map(function (r) { return r.week; }),
        rowIds:   sorted.map(function (r) { return String(r.id); }),
        rowPushed: sorted.map(function (r) { return !!r._pushed; }),
        segments: [{ fromIdx: 0, toIdx: sorted.length - 1, personId: null }]
      };
    });

    _ca[id] = { tracks: tracks };
  }

  // ── Phase B: Labour curve panel (track-based) ──────────────
  function _labourCurvePanel(t, rows) {
    var id = String(t.id);

    _initCA(id, rows);
    var ca = _ca[id];
    if (!ca || !ca.tracks.length) return '';

    var totalWeeks = ca.tracks[0].weekStrs.length;
    var totalSlots = rows.length;
    var unpushed   = rows.filter(function (r) { return !r._pushed; }).length;
    var siteVal    = _siteCodes[id] || '';

    var html = '<div style="padding:14px 14px 16px;border-top:1px solid #fde68a;background:#fffdf5">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2);margin-bottom:10px">ASSIGN WORKERS TO ROSTER</div>';

    // Site code + summary row
    html += '<div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:14px;padding:10px 12px;background:white;border:1px solid var(--border);border-radius:6px">';
    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Site code (Mon–Fri for all workers)</label>';
    html += '<input class="form-input" type="text" id="ra-site-' + id + '" value="' + _esc(siteVal) + '" placeholder="e.g. DC1" style="width:100px;text-transform:uppercase" maxlength="10" oninput="SKS_PIPELINE_RESOURCE.setSiteCode(\'' + id + '\',this.value)"></div>';
    html += '<div style="font-size:11px;color:var(--ink-3);padding-bottom:6px">' + totalWeeks + ' week' + (totalWeeks !== 1 ? 's' : '') + ' · ' + totalSlots + ' slots' + (unpushed < totalSlots ? ' · ' + (totalSlots - unpushed) + ' already on roster' : '') + '</div>';
    html += '</div>';

    // Conflict panel placeholder
    html += '<div id="ra-conflict-' + id + '"></div>';

    // Worker tracks
    ca.tracks.forEach(function (track, ti) {
      html += '<div style="margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden">';
      html += '<div style="font-size:11px;font-weight:700;color:var(--ink-2);padding:7px 10px;background:#f8fafc;border-bottom:1px solid var(--border)">' + _esc(track.label) + ' <span style="font-weight:400;color:var(--ink-3)">(' + track.weekStrs.length + ' weeks)</span></div>';

      track.segments.forEach(function (seg, si) {
        var splitKey = id + ':' + ti + ':' + si;
        var isSplitOpen = (_splitOpen === splitKey);
        var fromWk  = track.weekStrs[seg.fromIdx] || '—';
        var toWk    = track.weekStrs[seg.toIdx]   || '—';
        var wkCount = seg.toIdx - seg.fromIdx + 1;

        var rangeLabel = (track.segments.length === 1 && wkCount === totalWeeks)
          ? 'all ' + totalWeeks + ' weeks'
          : 'wks ' + (seg.fromIdx + 1) + '–' + (seg.toIdx + 1) + ' (' + _esc(fromWk) + ' → ' + _esc(toWk) + ')';

        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;' + (si < track.segments.length - 1 ? 'border-bottom:1px solid var(--border-lt)' : '') + '">';

        // Person picker
        html += '<select class="form-input" style="flex:1;min-width:0" onchange="SKS_PIPELINE_RESOURCE.setSegmentPerson(\'' + id + '\',' + ti + ',' + si + ',this.value)">';
        html += '<option value="">— assign person —</option>';
        _people.forEach(function (p) {
          html += '<option value="' + p.id + '"' + (seg.personId === p.id ? ' selected' : '') + '>' + _esc(p.name) + '</option>';
        });
        html += '</select>';

        // Range label
        html += '<span style="font-size:11px;color:var(--ink-3);white-space:nowrap;min-width:120px;flex-shrink:0">' + rangeLabel + '</span>';

        // Split button (only when more than 1 week in this segment)
        if (wkCount > 1 && !isSplitOpen) {
          html += '<button class="btn btn-ghost btn-sm" style="white-space:nowrap;font-size:11px;flex-shrink:0" onpointerdown="SKS_PIPELINE_RESOURCE.splitSegment(\'' + id + '\',' + ti + ',' + si + ')">÷ Split</button>';
        }

        // Remove-this-split button (for all segments after the first)
        if (si > 0) {
          html += '<button class="btn btn-ghost btn-sm" style="font-size:11px;color:#dc2626;flex-shrink:0;padding:3px 6px" title="Merge with previous segment" onpointerdown="SKS_PIPELINE_RESOURCE.mergeSegment(\'' + id + '\',' + ti + ',' + (si - 1) + ')">✕</button>';
        }

        html += '</div>';

        // Inline split-week picker
        if (isSplitOpen) {
          html += '<div style="padding:8px 10px;background:#f0f9ff;border-top:1px solid var(--border-lt);display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
          html += '<span style="font-size:11px;color:var(--ink-2);white-space:nowrap">Split after week:</span>';
          html += '<select class="form-input" style="max-width:200px" onchange="SKS_PIPELINE_RESOURCE.confirmSplit(\'' + id + '\',' + ti + ',' + si + ',parseInt(this.value,10))">';
          html += '<option value="-1">— pick a week —</option>';
          for (var wi = seg.fromIdx; wi < seg.toIdx; wi++) {
            html += '<option value="' + wi + '">' + _esc(track.weekStrs[wi]) + '</option>';
          }
          html += '</select>';
          html += '<button class="btn btn-ghost btn-sm" style="font-size:11px" onpointerdown="SKS_PIPELINE_RESOURCE.cancelSplit()">Cancel</button>';
          html += '</div>';
        }
      });

      html += '</div>';
    });

    // Push / close footer
    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px;margin-top:4px">';
    html += '<button class="btn btn-primary btn-sm" id="ra-push-' + id + '" onclick="SKS_PIPELINE_RESOURCE.pushToRoster(\'' + id + '\')">Push to Roster →</button>';
    html += '<div style="font-size:11px;color:var(--ink-3);flex:1">Headcount-only tracks are skipped. Writes Mon–Fri for all weeks.</div>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(null)">Close</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Toggle confirmed review panel ──────────────────────────
  function openConfirmedPanel(tenderId) {
    _openConfirmedPanel = (_openConfirmedPanel === tenderId) ? null : (tenderId || null);
    _splitOpen = null;
    _render();
  }

  // ── Track assignment state mutations ───────────────────────
  function setSiteCode(tenderId, val) {
    _siteCodes[String(tenderId)] = (val || '').toUpperCase().trim();
  }

  function setSegmentPerson(tenderId, trackIdx, segIdx, personIdStr) {
    var track = _ca[tenderId] && _ca[tenderId].tracks[trackIdx];
    var seg   = track && track.segments[segIdx];
    if (!seg) return;
    seg.personId = parseInt(personIdStr, 10) || null;
  }

  function splitSegment(tenderId, trackIdx, segIdx) {
    _splitOpen = tenderId + ':' + trackIdx + ':' + segIdx;
    _render();
  }

  function cancelSplit() {
    _splitOpen = null;
    _render();
  }

  function confirmSplit(tenderId, trackIdx, segIdx, splitWeekIdx) {
    if (splitWeekIdx < 0) return; // "— pick a week —" selected
    var track = _ca[tenderId] && _ca[tenderId].tracks[trackIdx];
    if (!track) return;
    var seg    = track.segments[segIdx];
    var oldTo  = seg.toIdx;

    seg.toIdx = splitWeekIdx; // first segment ends here
    track.segments.splice(segIdx + 1, 0, {
      fromIdx:  splitWeekIdx + 1,
      toIdx:    oldTo,
      personId: null
    });

    _splitOpen = null;
    _render();
  }

  function mergeSegment(tenderId, trackIdx, firstSegIdx) {
    var track = _ca[tenderId] && _ca[tenderId].tracks[trackIdx];
    if (!track) return;
    if (firstSegIdx < 0 || firstSegIdx >= track.segments.length - 1) return;

    var seg  = track.segments[firstSegIdx];
    var next = track.segments[firstSegIdx + 1];
    seg.toIdx = next.toIdx;
    track.segments.splice(firstSegIdx + 1, 1);

    _splitOpen = null;
    _render();
  }

  // ── Phase B: Push to roster ────────────────────────────────
  async function pushToRoster(tenderId) {
    var id = String(tenderId);
    var ca = _ca[id];
    var rows = _pending[id] || [];
    if (!ca || !rows.length) return;

    var site = _siteCodes[id] || '';
    if (!site) { showToast('Enter a site code first'); return; }

    // Build write plan from tracks
    var writePlan = [];
    ca.tracks.forEach(function (track, ti) {
      track.segments.forEach(function (seg) {
        if (!seg.personId) return; // headcount only — skip
        var person = _people.find(function (p) { return p.id === seg.personId; });
        if (!person) return;
        for (var wi = seg.fromIdx; wi <= seg.toIdx; wi++) {
          writePlan.push({
            personName: person.name,
            week:       track.weekStrs[wi],
            rowId:      track.rowIds[wi],
            personId:   seg.personId
          });
        }
      });
    });

    if (!writePlan.length) {
      showToast('Assign at least one person before pushing');
      return;
    }

    var pushBtn = document.getElementById('ra-push-' + id);
    if (pushBtn) { pushBtn.disabled = true; pushBtn.textContent = 'Checking…'; }

    try {
      // Batch GET existing schedule rows for all affected people + weeks
      var namesObj = {};
      var weeksObj = {};
      writePlan.forEach(function (p) { namesObj[p.personName] = true; weeksObj[p.week] = true; });
      var names = Object.keys(namesObj);
      var weeks = Object.keys(weeksObj);

      var nameFilter = 'name=in.(' + names.map(function (n) { return '"' + n.replace(/"/g, '\\"') + '"'; }).join(',') + ')';
      var weekFilter = 'week=in.(' + weeks.map(function (w) { return '"' + w + '"'; }).join(',') + ')';

      var existing = await sbFetch('schedule?' + nameFilter + '&' + weekFilter + '&select=*&limit=5000');
      var schedIdx = {};
      (Array.isArray(existing) ? existing : []).forEach(function (row) {
        schedIdx[row.name + '|' + row.week] = row;
      });

      // Find conflicts: (person, week) where any weekday slot has a different site code
      var conflicts = [];
      var seen = {};
      writePlan.forEach(function (plan) {
        var key = plan.personName + '|' + plan.week;
        if (seen[key]) return;
        seen[key] = true;
        var existingRow = schedIdx[key];
        if (!existingRow) return;
        var conflictSites = [];
        ['mon','tue','wed','thu','fri'].forEach(function (d) {
          if (existingRow[d] && existingRow[d] !== site) {
            if (conflictSites.indexOf(existingRow[d]) < 0) conflictSites.push(existingRow[d]);
          }
        });
        if (conflictSites.length) {
          conflicts.push({ personName: plan.personName, week: plan.week, existingSites: conflictSites });
        }
      });

      if (conflicts.length) {
        if (pushBtn) { pushBtn.disabled = false; pushBtn.textContent = 'Push to Roster →'; }
        _wplan[id] = { writePlan: writePlan, site: site, schedIdx: schedIdx, conflicts: conflicts };
        _renderConflictPanel(id, conflicts);
        return;
      }

      // No conflicts — write immediately
      await _executeRosterWrite(id, writePlan, site, schedIdx, pushBtn);

    } catch (e) {
      showToast('Push failed — ' + e.message);
      if (pushBtn) { pushBtn.disabled = false; pushBtn.textContent = 'Push to Roster →'; }
    }
  }

  function _renderConflictPanel(tenderId, conflicts) {
    var id = String(tenderId);
    var el = document.getElementById('ra-conflict-' + id);
    if (!el) return;

    var html = '<div style="margin-bottom:14px;padding:12px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px">';
    html += '<div style="font-size:12px;font-weight:700;color:#854d0e;margin-bottom:6px">⚠ ' + conflicts.length + ' conflict' + (conflicts.length !== 1 ? 's' : '') + ' — these people are already on another job that week</div>';
    html += '<div style="max-height:120px;overflow-y:auto;margin-bottom:10px;font-size:11px">';
    conflicts.forEach(function (c) {
      html += '<div style="padding:2px 0"><strong>' + _esc(c.personName) + '</strong> — week ' + _esc(c.week) + ' <span style="color:var(--ink-3)">(has: ' + c.existingSites.map(_esc).join(', ') + ')</span></div>';
    });
    html += '</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    html += '<button class="btn btn-secondary btn-sm" onclick="SKS_PIPELINE_RESOURCE.pushOverwrite(\'' + id + '\')">Overwrite — replace their existing assignment</button>';
    html += '<button class="btn btn-ghost btn-sm" onclick="SKS_PIPELINE_RESOURCE.pushSkipConflicts(\'' + id + '\')">Skip those weeks</button>';
    html += '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'ra-conflict-' + id + '\').innerHTML=\'\'">Cancel</button>';
    html += '</div></div>';

    el.innerHTML = html;
  }

  async function pushOverwrite(tenderId) {
    var id   = String(tenderId);
    var plan = _wplan[id];
    if (!plan) return;
    var conflictEl = document.getElementById('ra-conflict-' + id);
    if (conflictEl) conflictEl.innerHTML = '';
    var btn = document.getElementById('ra-push-' + id);
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
    await _executeRosterWrite(id, plan.writePlan, plan.site, plan.schedIdx, btn);
  }

  async function pushSkipConflicts(tenderId) {
    var id   = String(tenderId);
    var plan = _wplan[id];
    if (!plan) return;
    var conflictEl = document.getElementById('ra-conflict-' + id);
    if (conflictEl) conflictEl.innerHTML = '';
    var btn = document.getElementById('ra-push-' + id);
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }

    // Remove conflicted (person, week) pairs from the write plan
    var skipKeys = {};
    plan.conflicts.forEach(function (c) { skipKeys[c.personName + '|' + c.week] = true; });
    var filtered = plan.writePlan.filter(function (p) { return !skipKeys[p.personName + '|' + p.week]; });

    await _executeRosterWrite(id, filtered, plan.site, plan.schedIdx, btn);
  }

  async function _executeRosterWrite(tenderId, writePlan, site, schedIdx, pushBtn) {
    var id  = String(tenderId);
    var now = new Date().toISOString();
    var pushed = 0;

    try {
      for (var i = 0; i < writePlan.length; i++) {
        var plan      = writePlan[i];
        var key       = plan.personName + '|' + plan.week;
        var existing  = schedIdx[key];

        if (existing) {
          await sbFetch('schedule?id=eq.' + existing.id, 'PATCH', { mon: site, tue: site, wed: site, thu: site, fri: site });
        } else {
          await sbFetch('schedule', 'POST', { name: plan.personName, week: plan.week, mon: site, tue: site, wed: site, thu: site, fri: site, sat: null, sun: null }, 'return=minimal');
        }

        await sbFetch('pending_schedule?id=eq.' + plan.rowId, 'PATCH', { confirmed_at: now, person_id: plan.personId });

        // Mark row as pushed in local state
        var localRows = _pending[id] || [];
        var localRow  = localRows.find(function (r) { return String(r.id) === plan.rowId; });
        if (localRow) localRow._pushed = true;

        pushed++;
      }

      delete _wplan[id];

      var headcountSkipped = 0;
      if (_ca[id]) {
        _ca[id].tracks.forEach(function (track) {
          track.segments.forEach(function (seg) {
            if (!seg.personId) headcountSkipped += (seg.toIdx - seg.fromIdx + 1);
          });
        });
      }

      var msg = '✓ ' + pushed + ' weeks pushed to roster';
      if (headcountSkipped) msg += ' (' + headcountSkipped + ' headcount-only slots skipped)';
      showToast(msg);

      var allPushed = (_pending[id] || []).every(function (r) { return r._pushed; });
      if (allPushed) _openConfirmedPanel = null;

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
      delete _ca[String(tender.id)]; // fresh track init on render

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
    setSiteCode:            setSiteCode,
    setSegmentPerson:       setSegmentPerson,
    splitSegment:           splitSegment,
    cancelSplit:            cancelSplit,
    confirmSplit:           confirmSplit,
    mergeSegment:           mergeSegment,
    pushToRoster:           pushToRoster,
    pushOverwrite:          pushOverwrite,
    pushSkipConflicts:      pushSkipConflicts,
    openAddJob:             openAddJob,
    submitAddJob:           submitAddJob
  };
})();
