/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/pipeline-resource.js  —  SKS NSW Labour
// Resource Allocation screen: Won tenders → fill in start date,
// hours, workers, PM → confirm → capacity planning chart.
//
// Depends on: app-state.js, supabase.js, pipeline.js (STATE.managers)
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  var _tenders   = [];   // won + confirmed tenders
  var _enr       = {};   // keyed by tender_id → enrichment row
  var _noms      = {};   // keyed by tender_id → { pm, supervisor }
  var _managers  = [];
  var _headcount = 0;
  var _openPanel = null; // tender_id with open alloc form (null = all closed)

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
      '</div>' +
      '<div id="ra-body" style="color:var(--ink-2);font-size:13px">Loading…</div>' +
    '</div>';
  }

  // ── Data load ─────────────────────────────────────────────
  async function _load() {
    try {
      var results = await Promise.all([
        sbFetch('tenders?stage=in.(won,confirmed)&archived_at=is.null&order=quote_value.desc.nullslast&limit=500'),
        sbFetch('tender_enrichment?select=*&limit=1000'),
        sbFetch('nominations?select=*&limit=2000'),
        sbFetch('people?select=id&archived=eq.false&limit=1000')
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

      _headcount = Array.isArray(results[3]) ? results[3].length : 0;

      // Prefer already-loaded managers from STATE
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

    var html = _capacitySection();
    html    += _needsAllocSection(won);
    html    += _confirmedSection(confirmed);

    el.innerHTML = html;

    // Restore suggestion display if a panel is open
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

    // Bars
    html += '<div style="display:flex;align-items:flex-end;gap:1px;height:80px;position:relative;border-bottom:1px solid var(--border);margin-bottom:4px">';
    demand.forEach(function (d, i) {
      var pct    = d > 0 ? Math.max((d / maxVal) * 100, 3) : 0;
      var isGap  = _headcount > 0 && d > _headcount;
      var bg     = d === 0 ? '#f1f5f9' : isGap ? '#fca5a5' : '#bfdbfe';
      var tip    = _esc(labels[i] + ': ' + d + ' workers' + (isGap ? ' — EXCEEDS HEADCOUNT' : ''));
      html += '<div title="' + tip + '" style="flex:1;background:' + bg + ';height:' + pct + '%;border-radius:1px 1px 0 0"></div>';
    });
    // Threshold line
    if (_headcount > 0) {
      var botPct = Math.min(_headcount / maxVal * 100, 100);
      html += '<div style="position:absolute;left:0;right:0;bottom:' + botPct + '%;border-top:2px dashed #dc2626;pointer-events:none" title="Headcount: ' + _headcount + '"></div>';
    }
    html += '</div>';

    // X-axis labels
    html += '<div style="display:flex;gap:1px;margin-bottom:12px">';
    labels.forEach(function (l, i) {
      html += '<div style="flex:1;font-size:8px;color:var(--ink-3);text-align:center;overflow:hidden">' + (i % 4 === 0 ? l : '') + '</div>';
    });
    html += '</div>';

    // Legend
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--ink-2)">';
    html += '<span><span style="display:inline-block;width:10px;height:10px;background:#bfdbfe;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Workers needed</span>';
    if (_headcount > 0) {
      html += '<span><span style="display:inline-block;width:14px;border-top:2px dashed #dc2626;margin-right:4px;vertical-align:middle"></span>Headcount (' + _headcount + ')</span>';
    }
    if (hasGap) {
      html += '<span style="color:#dc2626;font-weight:600"><span style="display:inline-block;width:10px;height:10px;background:#fca5a5;border-radius:2px;margin-right:4px;vertical-align:middle"></span>⚠ Gap weeks</span>';
    }
    html += '</div>';
    html += '</div>'; // roster-card
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

      // Row header — click to expand
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
      html += '</div>'; // header

      if (isOpen) html += _allocPanel(t, enr, nom);
      html += '</div>'; // ra-row
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

    // ─ Row 1: dates + hours + duration + workers ─────────────
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

    // ─ Row 2: PM + Supervisor ─────────────────────────────────
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

    // ─ Notes ─────────────────────────────────────────────────
    html += '<div style="margin-bottom:14px">';
    html += '<label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Notes</label>';
    html += '<textarea class="form-input" id="ra-notes-' + id + '" rows="2" placeholder="Scope assumptions, conditions, access…" style="resize:vertical">' + _esc(enr.confidence_notes || '') + '</textarea>';
    html += '</div>';

    // ─ Actions ───────────────────────────────────────────────
    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<button class="btn btn-secondary btn-sm" id="ra-save-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',false)">Save</button>';
    html += '<button class="btn btn-primary btn-sm" id="ra-conf-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',true)" title="Requires start date + workers">Save &amp; Confirm →</button>';
    html += '<div style="flex:1"></div>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openPanel(null)">Cancel</button>';
    html += '</div>';

    html += '</div>'; // panel
    return html;
  }

  // ── Toggle alloc panel ─────────────────────────────────────
  function openPanel(tenderId) {
    _openPanel = (_openPanel === tenderId) ? null : (tenderId || null);
    _render();
  }

  // ── Worker suggestion ─────────────────────────────────────
  // ceil(hours / (weeks × 38h))
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
      if (wEl && !wEl.value) wEl.value = s;  // pre-fill only if empty
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
      // Upsert enrichment.
      // updated_at is intentionally omitted from PATCH — the DB trigger
      // (trg_tender_enrichment_updated_at) handles it on UPDATE.
      // It IS included on POST (INSERT) because the trigger only fires on UPDATE.
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

      // Nominations
      var nom = _noms[id] || { pm: null, supervisor: null };
      await Promise.all([
        _upsertNom(id, 'pm',         pmId,  nom.pm),
        _upsertNom(id, 'supervisor',  supId, nom.supervisor)
      ]);

      // Move to confirmed
      if (andConfirm) {
        await sbFetch('tenders?id=eq.' + id, 'PATCH', { stage: 'confirmed', updated_at: new Date().toISOString() });
        var t = _tenders.find(function (x) { return String(x.id) === id; });
        if (t) t.stage = 'confirmed';
      }

      showToast(andConfirm ? '✓ Confirmed — job locked in' : 'Saved');
      _openPanel = null;
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

  // ── Confirmed jobs ─────────────────────────────────────────
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
      var id  = String(t.id);
      var enr = _enr[id] || {};
      var nom = _noms[id] || { pm: null, supervisor: null };
      var pmN = nom.pm ? _mgrName(nom.pm.person_id) : null;
      var spN = nom.supervisor ? _mgrName(nom.supervisor.person_id) : null;

      var meta = [];
      if (enr.start_date_estimated) meta.push('Start ' + _esc(enr.start_date_estimated));
      if (enr.duration_weeks)       meta.push(enr.duration_weeks + 'w');
      if (enr.peak_workers)         meta.push(enr.peak_workers + ' workers');
      if (enr.hours_estimated)      meta.push(enr.hours_estimated + 'h est.');
      if (pmN)                      meta.push('PM: ' + _esc(pmN));
      if (spN)                      meta.push('Sup: ' + _esc(spN));

      html += '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:8px;background:#f0fdf4">';
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-size:11px;font-family:monospace;color:var(--ink-2)">' + _esc(t.external_ref || '—') + '</div>';
      html += '<div style="font-size:13px;font-weight:600;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">' + _esc(t.job_name || '—') + '</div>';
      html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + (meta.length ? meta.join(' · ') : 'No resource details yet') + '</div>';
      html += '</div>';
      html += '<div style="text-align:right;flex-shrink:0">';
      html += '<div style="font-size:14px;font-weight:700;color:#16a34a">' + (t.quote_value ? '$' + _fmtK(t.quote_value) : '—') + '</div>';
      html += '<div style="font-size:10px;color:#16a34a;margin-top:2px">✓ Confirmed</div>';
      html += '</div>';
      html += '</div>';
    });

    html += '</div>';
    return html;
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
    suggestWorkers:         suggestWorkers,
    saveAlloc:              saveAlloc
  };
})();
