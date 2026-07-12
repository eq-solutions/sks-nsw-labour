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
  var _deployedWk         = 0;    // distinct people actually deployed on the live roster THIS week
  var _thisWeekStr        = '';   // current Mon-snapped week string
  var _headcount          = 0;
  var _openPanel          = null;
  var _openConfirmedPanel = null;
  var _addingJob          = false;
  var _editingDetails     = null;   // tender id whose details are being edited (confirmed panel)

  // Phase B: contract assignment state (persists across re-renders within session)
  var _ca        = {};   // tenderId → { tracks: [{label,weekStrs[],rowIds[],segments:[{fromIdx,toIdx,personId}]}] }
  var _wplan     = {};   // tenderId → pending write plan awaiting conflict resolution
  var _siteCodes = {};   // tenderId → site code string (persists across re-renders)
  var _splitOpen   = null; // 'tid:ti:si' — which segment's split-week picker is open
  var _lastLoaded  = null; // Date of last successful data load

  // Floating chart panel — persisted across sessions
  var _floatChart = (function () {
    try { return localStorage.getItem('ra_float') === '1'; } catch (x) { return false; }
  }());
  var _floatPos = (function () {
    try {
      var s = JSON.parse(localStorage.getItem('ra_float_pos') || 'null');
      if (s && s.x !== undefined) return s;
    } catch (x) {}
    return { x: 240, y: 90, w: 540, h: 440 };
  }());

  // ── Entry point ───────────────────────────────────────────
  async function renderPipelineResource() {
    var old = document.getElementById('ra-float-panel');
    if (old) old.remove();
    var el = document.getElementById('page-pipeline-resource');
    if (!el) return;
    _injectStyles();

    var firstVisit = !document.getElementById('ra-body');
    if (firstVisit) el.innerHTML = _shell();

    if (_lastLoaded) {
      // Repeat visit — paint cached data instantly, then silently refresh in background
      _render();
      _load().then(function () { _render(); }).catch(function () {});
    } else {
      // First visit — wait for data before painting
      await _load();
      _render();
    }
  }

  async function refresh() {
    var bodyEl = document.getElementById('ra-body');
    if (bodyEl) bodyEl.innerHTML = '<div style="color:var(--ink-3);font-size:12px;padding:12px 0">Refreshing…</div>';
    await _load();
    _render();
  }

  function _injectStyles() {
    if (document.getElementById('ra-styles')) return;
    var s = document.createElement('style');
    s.id = 'ra-styles';
    s.textContent =
      '#ra-body .ra-job-row:not(.ra-open):hover { background-color: #f0f7ff !important; }' +
      '#ra-body .ra-alloc-row:hover { background-color: #f5f9ff !important; }';
    document.head.appendChild(s);
  }

  function _shell() {
    return '<div style="max-width:1100px;margin:0 auto" id="ra-root">' +
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
      // Current week, Monday-snapped — matches how the schedule weeks are keyed
      var nowD = new Date(); nowD.setHours(0, 0, 0, 0);
      var back = nowD.getDay() === 0 ? 6 : nowD.getDay() - 1;
      nowD.setDate(nowD.getDate() - back);
      _thisWeekStr = _toWeekStr(nowD);

      var results = await Promise.all([
        sbFetch('tenders?stage=in.(won,confirmed)&archived_at=is.null&below_threshold=eq.false&order=quote_value.desc.nullslast&limit=500'),
        sbFetchAll('tender_enrichment?select=*', 'tender_id'),
        sbFetchAll('nominations?select=*', 'id'),
        sbFetch('people?select=id,name&archived=eq.false&order=name&limit=1000'),
        sbFetchAll('pending_schedule?select=*&confirmed_at=is.null', 'id'),
        // Non-fatal: a roster-fetch failure must not blank the whole planning page —
        // degrade to "0 on the roster" rather than killing the load.
        sbFetch('schedule?week=eq.' + _thisWeekStr + '&select=name,mon,tue,wed,thu,fri&limit=5000')
          .catch(function () { return []; })
      ]);

      // People actually DEPLOYED on the live roster this week — distinct names with a
      // site on any weekday. Same source the Dashboard "Site Breakdown" reads. This is
      // the real headcount on the board; per-job attribution waits for site codes (B).
      var _depSeen = {};
      _deployedWk = 0;
      (Array.isArray(results[5]) ? results[5] : []).forEach(function (row) {
        if (_depSeen[row.name]) return;
        if (!(row.mon || row.tue || row.wed || row.thu || row.fri)) return;
        _depSeen[row.name] = true;
        _deployedWk++;
      });

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
      _lastLoaded = new Date();
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

    // Full-width stacked layout — chart on top, card grid below
    if (_floatChart) {
      html += '<div style="background:rgba(31,51,92,0.05);border:2px dashed rgba(31,51,92,0.15);border-radius:16px;' +
        'padding:36px 32px;margin-bottom:28px;display:flex;align-items:center;justify-content:center;min-height:110px">' +
        '<div style="text-align:center">' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;color:rgba(31,51,92,0.3);text-transform:uppercase;margin-bottom:10px">Chart is floating</div>' +
          '<button class="btn btn-secondary btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.toggleFloat()">⊞ Dock chart</button>' +
        '</div>' +
      '</div>';
    } else {
      html += _capacitySection();
    }
    html += _confirmedSection(confirmed);
    html += _needsAllocSection(won);

    el.innerHTML = html;

    if (_floatChart) {
      _renderFloat();
    } else {
      var stalePanel = document.getElementById('ra-float-panel');
      if (stalePanel) stalePanel.remove();
    }
    if (_openPanel) suggestWorkers(_openPanel);
  }

  // ── Floating chart panel ──────────────────────────────────
  function _saveFloat() {
    try {
      localStorage.setItem('ra_float',     _floatChart ? '1' : '0');
      localStorage.setItem('ra_float_pos', JSON.stringify(_floatPos));
    } catch (x) {}
  }

  function toggleFloat() {
    _floatChart = !_floatChart;
    _saveFloat();
    _render();
  }

  function _resizeHandle(dir, css) {
    return '<div data-rdir="' + dir + '" style="position:absolute;' + css + ';z-index:2"></div>';
  }

  function _renderFloat() {
    var old = document.getElementById('ra-float-panel');
    if (old) old.remove();
    if (!_floatChart) return;

    var p   = _floatPos;
    var panel = document.createElement('div');
    panel.id  = 'ra-float-panel';
    panel.style.cssText =
      'position:fixed;left:' + p.x + 'px;top:' + p.y + 'px;' +
      'width:' + p.w + 'px;height:' + p.h + 'px;' +
      'z-index:600;background:#fff;border:1px solid #e2e8f0;' +
      'border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18);' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'min-width:280px;min-height:200px';

    panel.innerHTML =
      // ── title bar
      '<div id="ra-float-bar" style="background:#f8fafc;border-bottom:1px solid #e2e8f0;' +
        'padding:9px 14px;cursor:move;display:flex;align-items:center;gap:8px;' +
        'flex-shrink:0;user-select:none;-webkit-user-select:none">' +
        '<div style="display:flex;gap:5px">' +
          '<div style="width:10px;height:10px;border-radius:50%;background:#fca5a5"></div>' +
          '<div style="width:10px;height:10px;border-radius:50%;background:#fde68a"></div>' +
          '<div style="width:10px;height:10px;border-radius:50%;background:#bbf7d0"></div>' +
        '</div>' +
        '<span style="font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--ink-2)">CAPACITY PLANNING — 26 WEEKS</span>' +
        '<div style="flex:1"></div>' +
        '<button onpointerdown="SKS_PIPELINE_RESOURCE.toggleFloat()" style="background:none;border:none;cursor:pointer;' +
          'font-size:13px;color:var(--ink-3);padding:0 4px;line-height:1" title="Dock chart back">⊞ Dock</button>' +
      '</div>' +
      // ── content
      '<div style="flex:1;overflow:auto;padding:16px 16px 12px">' + _capacitySection() + '</div>' +
      // ── resize handles (edges)
      _resizeHandle('n',  'top:0;left:10px;right:10px;height:5px;cursor:n-resize') +
      _resizeHandle('s',  'bottom:0;left:10px;right:10px;height:5px;cursor:s-resize') +
      _resizeHandle('e',  'right:0;top:10px;bottom:10px;width:5px;cursor:e-resize') +
      _resizeHandle('w',  'left:0;top:10px;bottom:10px;width:5px;cursor:w-resize') +
      // ── resize handles (corners)
      _resizeHandle('nw', 'top:0;left:0;width:12px;height:12px;cursor:nw-resize') +
      _resizeHandle('ne', 'top:0;right:0;width:12px;height:12px;cursor:ne-resize') +
      _resizeHandle('sw', 'bottom:0;left:0;width:12px;height:12px;cursor:sw-resize') +
      _resizeHandle('se', 'bottom:0;right:0;width:12px;height:12px;cursor:se-resize');

    document.body.appendChild(panel);
    _initFloat(panel);
  }

  function _initFloat(panel) {
    var bar    = document.getElementById('ra-float-bar');
    var mode   = null; // 'drag' | 'resize'
    var dir    = '';
    var startX, startY, startL, startT, startW, startH;
    var MIN_W  = 280, MIN_H = 200;

    panel.addEventListener('pointerdown', function (e) {
      var tgt    = e.target;
      if (tgt.tagName === 'BUTTON' || tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT') return;
      var handle = tgt.closest ? tgt.closest('[data-rdir]') : null;
      var inBar  = tgt === bar || (bar && bar.contains && bar.contains(tgt));
      if (handle)     { mode = 'resize'; dir = handle.getAttribute('data-rdir'); }
      else if (inBar) { mode = 'drag'; }
      else            { return; }

      startX = e.clientX; startY = e.clientY;
      startL = _floatPos.x; startT = _floatPos.y;
      startW = _floatPos.w; startH = _floatPos.h;
      panel.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    panel.addEventListener('pointermove', function (e) {
      if (!mode) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var nx = startL, ny = startT, nw = startW, nh = startH;

      if (mode === 'drag') {
        nx = Math.max(0, startL + dx);
        ny = Math.max(0, startT + dy);
      } else {
        if (dir.indexOf('e') !== -1) nw = Math.max(MIN_W, startW + dx);
        if (dir.indexOf('s') !== -1) nh = Math.max(MIN_H, startH + dy);
        if (dir.indexOf('w') !== -1) { var ww = Math.max(MIN_W, startW - dx); nx = startL + startW - ww; nw = ww; }
        if (dir.indexOf('n') !== -1) { var hh = Math.max(MIN_H, startH - dy); ny = startT + startH - hh; nh = hh; }
      }

      _floatPos = { x: nx, y: ny, w: nw, h: nh };
      panel.style.left   = nx + 'px';
      panel.style.top    = ny + 'px';
      panel.style.width  = nw + 'px';
      panel.style.height = nh + 'px';
    });

    function _endMove() {
      if (!mode) return;
      mode = null;
      document.body.style.userSelect = '';
      _saveFloat();
    }
    panel.addEventListener('pointerup',     _endMove);
    panel.addEventListener('pointercancel', _endMove);
  }

  // ── Design helpers ────────────────────────────────────────
  function _tenderColor(tenderId) {
    var id  = String(tenderId);
    var ci  = 0;
    var hit = false;
    _tenders.every(function (t) {
      var e = _enr[String(t.id)];
      if (!e || !e.start_date_estimated || !e.peak_workers || !e.duration_weeks) return true;
      if (String(t.id) === id) { hit = true; return false; }
      ci++;
      return true;
    });
    return hit ? _CHART_PALETTE[ci % _CHART_PALETTE.length] : '#94a3b8';
  }

  function _miniTimeline(enr, color) {
    var NOW  = new Date(); NOW.setHours(0, 0, 0, 0);
    var WEEK = 7 * 24 * 60 * 60 * 1000;
    var SEGS = 26;
    var tip  = 'No schedule set';
    if (enr.start_date_estimated) {
      var sd = new Date(enr.start_date_estimated);
      tip = 'Starts ' + sd.getDate() + '/' + (sd.getMonth() + 1) + '/' + String(sd.getFullYear()).slice(-2);
      if (enr.duration_weeks) {
        var ed = new Date(sd.getTime() + enr.duration_weeks * WEEK);
        tip += ' · ' + enr.duration_weeks + ' weeks · Ends ' + ed.getDate() + '/' + (ed.getMonth() + 1) + '/' + String(ed.getFullYear()).slice(-2);
      }
    }
    var html = '<div title="' + _esc(tip) + '" style="display:flex;gap:2px">';
    for (var w = 0; w < SEGS; w++) {
      var active = false;
      if (enr.start_date_estimated && enr.duration_weeks) {
        var start = new Date(enr.start_date_estimated); start.setHours(0, 0, 0, 0);
        var end   = new Date(start.getTime() + enr.duration_weeks * WEEK);
        var ws    = new Date(NOW.getTime() + w * WEEK);
        var we    = new Date(ws.getTime() + WEEK);
        active = start < we && end > ws;
      }
      html += '<div style="flex:1;height:5px;border-radius:1px;background:' + (active ? color : '#e2e8f0') + '"></div>';
    }
    html += '</div>';
    return html;
  }

  // ── Capacity planning chart ───────────────────────────────
  var _CHART_PALETTE = [
    '#3b82f6','#10b981','#f59e0b','#8b5cf6',
    '#06b6d4','#f97316','#84cc16','#ec4899',
    '#6366f1','#14b8a6','#ef4444','#0ea5e9',
    '#d946ef','#22c55e','#a855f7','#f43f5e',
    '#fb923c','#4ade80','#818cf8','#2dd4bf'
  ];

  function _buildWeeklyDemand() {
    var NOW    = new Date(); NOW.setHours(0,0,0,0);
    var WEEK   = 7 * 24 * 60 * 60 * 1000;
    var WEEKS  = 26;
    var labels = [];
    var bands  = [];
    var totals = new Array(WEEKS).fill(0);

    for (var w = 0; w < WEEKS; w++) {
      var d = new Date(NOW.getTime() + w * WEEK);
      labels.push(d.getDate() + '/' + (d.getMonth() + 1));
    }

    _tenders.forEach(function (t) {
      var e = _enr[String(t.id)];
      if (!e || !e.start_date_estimated || !e.peak_workers || !e.duration_weeks) return;
      var start = new Date(e.start_date_estimated); start.setHours(0,0,0,0);
      var end   = new Date(start.getTime() + e.duration_weeks * WEEK);
      var weeks = new Array(WEEKS).fill(0);
      for (var w = 0; w < WEEKS; w++) {
        var ws = new Date(NOW.getTime() + w * WEEK);
        var we = new Date(ws.getTime() + WEEK);
        if (start < we && end > ws) {
          weeks[w] = e.peak_workers;
          totals[w] += e.peak_workers;
        }
      }
      var weeksLeft = Math.max(0, Math.ceil((end - NOW) / WEEK));
      bands.push({
        id:        t.id,
        ref:       t.external_ref || '',
        name:      t.job_name || ('Job ' + t.id),
        client:    t.client || '',
        start:     start,
        end:       end,
        peak:      e.peak_workers,
        weeksLeft: weeksLeft,
        weeks:     weeks
      });
    });

    return { bands: bands, totals: totals, labels: labels };
  }

  // ── "This week" strip — plan (allocated) vs reality (deployed on the roster) ──
  // Aggregate only. Per-job attribution waits for site codes on jobs (phase B);
  // until then we don't pretend to know which roster rows belong to which job.
  function _rightNowBlock(data) {
    var NOW   = new Date(); NOW.setHours(0, 0, 0, 0);
    var bands = data.bands;

    // Started = actually running now (not bucket-overlap with a near-future start)
    var started   = bands.filter(function (b) { return b.start <= NOW && b.end > NOW; });
    var allocated = started.reduce(function (s, b) { return s + b.peak; }, 0);
    var free      = _headcount > 0 ? Math.max(0, _headcount - _deployedWk) : null;

    var cells = [];
    cells.push(['#86efac', started.length, started.length === 1 ? 'job live' : 'jobs live']);
    cells.push(['#93c5fd', allocated, 'allocated']);
    cells.push(['#e2e8f0', _deployedWk, 'on the roster']);
    if (free !== null) cells.push(['#e2e8f0', free, 'free']);

    var html = '<div style="margin-bottom:24px;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 22px">';
    html += '<span style="font-size:10px;font-weight:700;letter-spacing:.1em;color:rgba(255,255,255,0.4)">THIS WEEK</span>';
    cells.forEach(function (c) {
      html += '<span style="white-space:nowrap;font-size:13px;color:rgba(255,255,255,0.55)">' +
        '<b style="color:' + c[0] + ';font-size:15px;font-weight:700">' + _esc(String(c[1])) + '</b> ' + _esc(c[2]) +
        '</span>';
    });
    html += '</div>';
    return html;
  }

  function _capacitySection() {
    var allocated = _tenders.filter(function (t) {
      var e = _enr[String(t.id)];
      return e && e.start_date_estimated && e.peak_workers && e.duration_weeks;
    });

    // ── Dark hero container
    var html = '<div style="background:#1F335C;border-radius:16px;padding:28px 32px 24px;margin-bottom:28px">';

    // Header
    var loadedStr = _lastLoaded
      ? String(_lastLoaded.getHours()).padStart(2,'0') + ':' + String(_lastLoaded.getMinutes()).padStart(2,'0')
      : '';
    html += '<div style="display:flex;align-items:center;margin-bottom:20px">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;color:rgba(255,255,255,0.45);text-transform:uppercase">Capacity Planning — 26 Weeks</div>' +
      '<div style="flex:1"></div>' +
      (loadedStr ? '<span style="font-size:10px;color:rgba(255,255,255,0.25);margin-right:10px">Updated ' + loadedStr + '</span>' : '') +
      '<button onclick="SKS_PIPELINE_RESOURCE.refresh()" ' +
        'style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.45);' +
        'font-size:10px;padding:3px 10px;border-radius:5px;cursor:pointer;margin-right:8px">↻ Refresh</button>' +
      (_floatChart ? '' : '<button onpointerdown="SKS_PIPELINE_RESOURCE.toggleFloat()" ' +
        'style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.65);' +
        'font-size:11px;padding:4px 12px;border-radius:6px;cursor:pointer">⤢ Float</button>') +
    '</div>';

    if (!allocated.length) {
      html += '<div style="text-align:center;color:rgba(255,255,255,0.35);font-size:13px;padding:40px 0">Set start dates and worker counts on Won jobs to see the demand forecast.</div>';
      html += '</div>';
      return html;
    }

    var data    = _buildWeeklyDemand();
    var bands   = data.bands;
    var totals  = data.totals;
    var labels  = data.labels;
    var peakDem = Math.max.apply(null, totals);
    var scaleMax = _headcount > 0
      ? Math.max(_headcount, peakDem)
      : Math.max(peakDem > 0 ? Math.ceil(peakDem * 1.5) : 10, 10);
    var maxVal  = Math.max(scaleMax, 1);
    var hasGap  = _headcount > 0 && totals.some(function (d) { return d > _headcount; });
    var CHART_H = 200;

    var yIntervals = [1,2,5,10,20,25,50,100,200,500];
    var yInterval  = yIntervals[yIntervals.length - 1];
    for (var ii = 0; ii < yIntervals.length; ii++) {
      if (maxVal / yIntervals[ii] <= 6) { yInterval = yIntervals[ii]; break; }
    }

    // ── Large stat row
    var bench     = _headcount > 0 ? _headcount - peakDem : null;
    var lockedVal = _tenders.filter(function (t) { return t.stage === 'confirmed'; })
      .reduce(function (s, t) { return s + (t.quote_value || 0); }, 0);

    var stats = [];
    stats.push({ label: 'PEAK DEMAND', val: peakDem,           unit: 'workers',    color: peakDem > 0 && peakDem > _headcount ? '#fca5a5' : '#93c5fd' });
    stats.push({ label: 'ACTIVE JOBS', val: allocated.length,  unit: allocated.length === 1 ? 'job' : 'jobs', color: '#86efac' });
    if (bench !== null) stats.push({ label: 'BENCH', val: Math.max(0, bench), unit: 'available', color: bench > 0 ? '#e2e8f0' : '#fca5a5' });
    if (lockedVal)      stats.push({ label: 'LOCKED IN', val: '$' + _fmtK(lockedVal), unit: 'contracted', color: '#86efac' });

    html += '<div style="display:flex;gap:0;margin-bottom:28px;padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,0.1)">';
    stats.forEach(function (s, i) {
      html += '<div style="flex:1;' + (i > 0 ? 'border-left:1px solid rgba(255,255,255,0.1);padding-left:28px;' : '') + 'padding-right:28px">';
      html += '<div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:rgba(255,255,255,0.4);margin-bottom:10px">' + s.label + '</div>';
      html += '<div style="font-size:42px;font-weight:700;color:' + s.color + ';line-height:1;letter-spacing:-.02em">' + _esc(String(s.val)) + '</div>';
      html += '<div style="font-size:12px;color:rgba(255,255,255,0.3);margin-top:6px">' + _esc(s.unit) + '</div>';
      html += '</div>';
    });
    html += '</div>';

    // ── "Right now" block — this-week strip + current-projects table
    html += _rightNowBlock(data);

    // ── Chart directly on dark background
    html += '<div style="display:flex;gap:8px;align-items:flex-end">';

    // Y-axis
    html += '<div style="position:relative;width:24px;flex-shrink:0;height:' + CHART_H + 'px;margin-bottom:22px">';
    for (var yv = 0; yv <= maxVal; yv += yInterval) {
      html += '<div style="position:absolute;bottom:' + (yv / maxVal * 100) + '%;right:0;font-size:9px;color:rgba(255,255,255,0.3);line-height:1;transform:translateY(50%)">' + yv + '</div>';
    }
    if (maxVal % yInterval !== 0) {
      html += '<div style="position:absolute;bottom:100%;right:0;font-size:9px;color:rgba(255,255,255,0.3);line-height:1;transform:translateY(50%)">' + maxVal + '</div>';
    }
    html += '</div>';

    // Bars + x-axis
    html += '<div style="flex:1;min-width:0">';
    var useStacked = bands.length <= 6;

    html += '<div style="display:flex;align-items:flex-end;gap:2px;height:' + CHART_H + 'px;position:relative;border-bottom:1px solid rgba(255,255,255,0.15);margin-bottom:6px">';
    for (var gv = yInterval; gv < maxVal; gv += yInterval) {
      html += '<div style="position:absolute;left:0;right:0;bottom:' + (gv / maxVal * 100) + '%;border-top:1px solid rgba(255,255,255,0.07);pointer-events:none"></div>';
    }
    for (var wi = 0; wi < totals.length; wi++) {
      var tot  = totals[wi];
      var barH = tot > 0 ? Math.max(Math.round((tot / maxVal) * CHART_H), 2) : 0;
      var isGap = _headcount > 0 && tot > _headcount;
      var tipParts = [labels[wi] + ': ' + tot + ' workers'];
      bands.forEach(function (b) { if (b.weeks[wi]) tipParts.push(b.name.split(/\s+/).slice(0, 3).join(' ') + ': ' + b.weeks[wi]); });
      html += '<div title="' + _esc(tipParts.join(' | ')) + '" style="flex:1;height:' + barH + 'px;display:flex;flex-direction:column-reverse;border-radius:3px 3px 0 0;overflow:hidden' + (isGap ? ';outline:1px solid rgba(252,165,165,0.7)' : '') + '">';
      if (tot > 0) {
        if (useStacked) {
          bands.forEach(function (b, ci) {
            if (!b.weeks[wi]) return;
            html += '<div style="flex:' + b.weeks[wi] + ';background:' + _CHART_PALETTE[ci % _CHART_PALETTE.length] + '"></div>';
          });
        } else {
          // Utilisation colour — single bar, colour encodes load vs headcount
          var util = _headcount > 0 ? tot / _headcount : 0.5;
          var uColor = util > 1 ? '#ef4444' : util > 0.75 ? '#f97316' : util > 0.4 ? '#facc15' : '#4ade80';
          html += '<div style="flex:1;background:' + uColor + '"></div>';
        }
      }
      html += '</div>';
    }
    if (_headcount > 0) {
      var hcPct = _headcount / maxVal * 100;
      html += '<div style="position:absolute;left:0;right:0;bottom:' + hcPct + '%;border-top:2px dashed rgba(252,165,165,0.75);pointer-events:none">' +
        '<span style="position:absolute;left:4px;top:-14px;font-size:9px;color:rgba(252,165,165,0.95);font-weight:700;' +
          'letter-spacing:.02em;background:rgba(31,51,92,0.75);padding:1px 5px;border-radius:3px">HC ' + _headcount + '</span>' +
      '</div>';
    }
    html += '</div>'; // bars

    html += '<div style="display:flex;gap:2px">';
    labels.forEach(function (l, i) {
      html += '<div style="flex:1;font-size:8px;color:rgba(255,255,255,0.25);text-align:center;overflow:hidden">' + (i % 4 === 0 ? l : '') + '</div>';
    });
    html += '</div>';
    html += '</div>'; // bars + x-axis
    html += '</div>'; // y + bars row

    // Legend
    html += '<div style="display:flex;gap:6px 20px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,0.45);margin-top:16px">';
    if (useStacked) {
      bands.forEach(function (b, ci) {
        var lbl = b.name.length > 26 ? b.name.slice(0, 24) + '…' : b.name;
        html += '<span style="white-space:nowrap">' +
          '<span style="display:inline-block;width:10px;height:10px;background:' + _CHART_PALETTE[ci % _CHART_PALETTE.length] + ';border-radius:2px;margin-right:5px;vertical-align:middle"></span>' +
          _esc(lbl) + '</span>';
      });
    } else {
      // Utilisation colour key
      html += '<span style="color:rgba(255,255,255,0.6);font-size:11px">' + bands.length + ' jobs — bars show demand load: </span>';
      [['#4ade80','&lt;40%'],['#facc15','40–75%'],['#f97316','75–100%'],['#ef4444','&gt;100%']].forEach(function(pair) {
        html += '<span style="white-space:nowrap"><span style="display:inline-block;width:10px;height:10px;background:' + pair[0] + ';border-radius:2px;margin-right:4px;vertical-align:middle"></span>' + pair[1] + '</span>';
      });
    }
    if (_headcount > 0) {
      html += '<span style="white-space:nowrap">' +
        '<span style="display:inline-block;width:16px;border-top:2px dashed rgba(252,165,165,0.75);margin-right:5px;vertical-align:middle"></span>' +
        'Headcount (' + _headcount + ')</span>';
    }
    if (hasGap) html += '<span style="color:#fca5a5;font-weight:700;white-space:nowrap">⚠ Exceeds headcount</span>';
    html += '</div>';

    html += '</div>'; // dark hero
    return html;
  }

  // ── Needs allocation ───────────────────────────────────────
  function _needsAllocSection(wonTenders) {
    if (!wonTenders.length) {
      // If confirmed jobs are visible above, stay quiet — empty needs-alloc is a good state
      var hasConfirmed = _tenders.some(function (t) { return t.stage === 'confirmed'; });
      if (hasConfirmed) return '';
      return '<div style="text-align:center;padding:48px 20px;color:var(--ink-3)">' +
        '<div style="font-size:22px;margin-bottom:10px">📋</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:5px">Nothing in the pipeline yet</div>' +
        '<div style="font-size:12px">Won jobs from the Pipeline will appear here to be scheduled and confirmed.</div>' +
      '</div>';
    }

    var html = '<div style="margin-bottom:24px">';
    // Section header
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#f97316;white-space:nowrap">NEEDS ALLOCATION (' + wonTenders.length + ')</div>';
    html += '<div style="flex:1;height:1px;background:#fed7aa"></div>';
    html += '</div>';

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
      html += '<div class="ra-alloc-row" onpointerdown="SKS_PIPELINE_RESOURCE.openPanel(\'' + id + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;background:' + (isOpen ? '#f0f9ff' : 'transparent') + ';user-select:none;-webkit-user-select:none">';
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

  // Shared editable field grid (start / hours / duration / workers / PM / sup / notes).
  // Used by both the Needs-Allocation panel and the Confirmed-job "Edit details" block,
  // so saveAlloc + saveConfirmedDetails read the same ra-* input ids.
  function _detailsFields(id, enr, nom) {
    enr = enr || {};
    nom = nom || { pm: null, supervisor: null };
    var pmMgrs = _managers.filter(function (m) { return m.category === 'Project Management'; });
    if (!pmMgrs.length) pmMgrs = _managers;

    var curPm  = nom.pm  && nom.pm.person_id  ? String(nom.pm.person_id)  : '';
    var curSup = _picCurVal(nom.supervisor);

    var html = '';
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

    html += '<div><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Person in charge</label>';
    html += '<select class="form-input" id="ra-sup-' + id + '"><option value="">— not nominated —</option>';
    html += _picOptionsHtml(curSup);
    html += '</select></div>';

    html += '</div>';

    html += '<div style="margin-bottom:14px"><label style="font-size:11px;color:var(--ink-3);display:block;margin-bottom:3px">Notes</label>';
    html += '<textarea class="form-input" id="ra-notes-' + id + '" rows="2" placeholder="Scope assumptions, conditions, access…" style="resize:vertical">' + _esc(enr.confidence_notes || '') + '</textarea></div>';
    return html;
  }

  function _allocPanel(t, enr, nom) {
    var id     = String(t.id);

    var html = '<div style="padding:14px 14px 16px;border-top:1px solid var(--border);background:#f8fafc">';
    html += _detailsFields(id, enr, nom);

    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<button class="btn btn-secondary btn-sm" id="ra-save-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',false)">Save</button>';
    html += '<button class="btn btn-primary btn-sm" id="ra-conf-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveAlloc(\'' + id + '\',true)" title="Requires start date + workers">Save &amp; Confirm →</button>';
    html += '<div style="flex:1"></div>';
    html += '<button class="btn btn-ghost btn-sm" onclick="SKS_PIPELINE_RESOURCE.removeProject(\'' + id + '\')" style="color:#dc2626" title="Archive this job — hides it here and in the Pipeline">Remove job</button>';
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
      var s = Math.ceil(hours / (weeks * 40));
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
    var supPic  = _parsePic(_strVal('ra-sup-' + id));
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
        _upsertNom(id, 'supervisor', supPic.id, nom.supervisor, supPic.source)
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

  async function _upsertNom(tenderId, role, newId, existing, source) {
    var nom = _noms[String(tenderId)] || (_noms[String(tenderId)] = { pm: null, supervisor: null });
    var key = role === 'pm' ? 'pm' : 'supervisor';
    // capacity_tag flags a people-table id; null = managers (incl. all PMs + legacy supervisors).
    var tag = source === 'people' ? 'people' : null;
    if (newId && existing) {
      if (String(existing.person_id) !== String(newId) || (existing.capacity_tag || null) !== tag) {
        await sbFetch('nominations?id=eq.' + existing.id, 'PATCH', { person_id: newId, capacity_tag: tag });
        nom[key] = Object.assign({}, existing, { person_id: newId, capacity_tag: tag });
      }
    } else if (newId && !existing) {
      var row = { tender_id: tenderId, person_id: newId, role: role, status: 'pencilled', is_primary: true, capacity_tag: tag };
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
    if (!confirmed.length) {
      return '<div style="margin-bottom:28px">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--ink-3);white-space:nowrap">CONFIRMED JOBS</div>' +
          '<div style="flex:1;height:1px;background:#e2e8f0"></div>' +
        '</div>' +
        '<div style="text-align:center;padding:32px 20px;background:#fafafa;border:1px dashed #e2e8f0;border-radius:12px">' +
          '<div style="font-size:24px;margin-bottom:8px">🏗</div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:4px">No confirmed jobs yet</div>' +
          '<div style="font-size:12px;color:var(--ink-3)">Fill in details on a Won job below, then hit <strong>Save &amp; Confirm</strong> to move it here.</div>' +
        '</div>' +
      '</div>';
    }

    var html = '<div style="margin-bottom:28px">';

    // Section header
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--ink-2);white-space:nowrap">CONFIRMED JOBS (' + confirmed.length + ')</div>';
    html += '<div style="flex:1;height:1px;background:#e2e8f0"></div>';
    html += '</div>';

    // Table — overflow-x:auto for narrow viewports
    html += '<div style="overflow-x:auto">';
    html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;min-width:640px">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';

    // Header
    html += '<thead><tr style="border-bottom:1px solid #f1f5f9">';
    var thStyle = 'padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--ink-3);white-space:nowrap;background:#fafafa';
    html += '<th style="' + thStyle + ';padding-left:18px">JOB</th>';
    html += '<th style="' + thStyle + ';text-align:right">WORKERS</th>';
    html += '<th style="' + thStyle + ';text-align:right">WEEKS</th>';
    html += '<th style="' + thStyle + ';text-align:right">VALUE</th>';
    html += '<th style="' + thStyle + '">SCHEDULE — 26 WKS</th>';
    html += '<th style="' + thStyle + ';text-align:right">STATUS</th>';
    html += '<th style="' + thStyle + ';width:20px"></th>';
    html += '</tr></thead>';

    // Rows
    html += '<tbody>';
    confirmed.forEach(function (t, ri) {
      var id       = String(t.id);
      var enr      = _enr[id] || {};
      var nom      = _noms[id] || { pm: null, supervisor: null };
      var pmN      = nom.pm         ? _mgrName(nom.pm.person_id)         : null;
      var spN      = nom.supervisor ? _picName(nom.supervisor) : null;
      var rows     = _pending[id] || [];
      var isOpen   = _openConfirmedPanel === id;
      var accent   = _tenderColor(id);
      var unpushed = rows.filter(function (r) { return !r._pushed; });
      var hasPushed = rows.some(function (r) { return r._pushed; });

      var badge = '';
      if (unpushed.length) {
        badge = '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:20px;font-weight:600;white-space:nowrap">' + unpushed.length + ' to assign</span>';
      } else if (hasPushed || (enr.peak_workers && enr.duration_weeks)) {
        badge = '<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:20px;font-weight:600;white-space:nowrap">✓ On roster</span>';
      }

      var rowBg = isOpen ? accent + '0d' : (ri % 2 === 0 ? '#fff' : '#fafafa');
      var tdBase = 'padding:12px 14px;vertical-align:middle;border-bottom:1px solid #f1f5f9';

      html += '<tr id="ra-conf-row-' + id + '" class="ra-job-row' + (isOpen ? ' ra-open' : '') + '" ' +
        'onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(\'' + id + '\')" ' +
        'style="cursor:pointer;background:' + rowBg + ';user-select:none;-webkit-user-select:none' + (isOpen ? ';outline:2px solid ' + accent + ';outline-offset:-2px' : '') + '">';

      // Job name cell — accent bar + ref + name + client
      html += '<td style="' + tdBase + ';padding-left:0;min-width:200px;max-width:260px">';
      html += '<div style="display:flex;align-items:center;gap:0">';
      html += '<div style="width:4px;min-height:44px;background:' + accent + ';border-radius:0;flex-shrink:0;margin-right:14px"></div>';
      html += '<div style="min-width:0">';
      html += '<div style="font-size:10px;font-family:monospace;color:var(--ink-3);margin-bottom:1px">' + _esc(t.external_ref || '—') + '</div>';
      html += '<div style="font-size:13px;font-weight:700;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(t.job_name || '—') + '</div>';
      if (t.client) html += '<div style="font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(t.client) + '</div>';
      if (pmN || spN) {
        var people = [];
        if (pmN) people.push(pmN.split(' ')[0]);
        if (spN) people.push(spN.split(' ')[0]);
        html += '<div style="font-size:10px;color:var(--ink-3);margin-top:2px">' + _esc(people.join(' · ')) + '</div>';
      }
      html += '</div></div></td>';

      // Metrics
      html += '<td style="' + tdBase + ';text-align:right;white-space:nowrap">';
      if (enr.peak_workers) html += '<div style="font-size:20px;font-weight:700;color:var(--navy);line-height:1">' + enr.peak_workers + '</div>';
      html += '</td>';

      html += '<td style="' + tdBase + ';text-align:right;white-space:nowrap">';
      if (enr.duration_weeks) html += '<div style="font-size:20px;font-weight:700;color:var(--navy);line-height:1">' + enr.duration_weeks + '</div>';
      html += '</td>';

      html += '<td style="' + tdBase + ';text-align:right;white-space:nowrap">';
      if (t.quote_value) html += '<div style="font-size:13px;font-weight:700;color:#16a34a">$' + _fmtK(t.quote_value) + '</div>';
      html += '</td>';

      // Mini timeline
      html += '<td style="' + tdBase + ';min-width:140px">' + _miniTimeline(enr, accent) + '</td>';

      // Status badge
      html += '<td style="' + tdBase + ';text-align:right">' + badge + '</td>';

      // Chevron
      html += '<td style="' + tdBase + ';padding-right:16px;text-align:center;font-size:10px;color:var(--ink-3)">' + (isOpen ? '▲' : '▼') + '</td>';

      html += '</tr>';
    });
    html += '</tbody></table></div></div>'; // table + border card + scroll wrapper

    // Full-width expansion panel below the table
    if (_openConfirmedPanel) {
      var ot    = confirmed.find(function (t) { return String(t.id) === _openConfirmedPanel; });
      if (ot) {
        var oRows = _pending[_openConfirmedPanel] || [];
        var oacc  = _tenderColor(_openConfirmedPanel);
        html += '<div style="margin-top:8px;border:1px solid #e2e8f0;border-top:3px solid ' + oacc + ';border-radius:12px;overflow:hidden;background:#fff">';
        html += _editDetailsSection(ot);
        html += oRows.length ? _labourCurvePanel(ot, oRows) : _emptyConfirmedPanel(ot);
        html += '</div>';
      }
    }

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

    var totalWeeks  = ca.tracks[0].weekStrs.length;
    var totalSlots  = rows.length;
    var unpushed    = rows.filter(function (r) { return !r._pushed; }).length;
    var siteVal     = _siteCodes[id] || '';
    var totalTracks = ca.tracks.length;
    var assignedTracks = ca.tracks.reduce(function (n, track) {
      return n + (track.segments.some(function (seg) { return seg.personId; }) ? 1 : 0);
    }, 0);
    var badgeColor = assignedTracks === totalTracks
      ? 'background:#dcfce7;color:#166534'
      : 'background:#fef3c7;color:#92400e';

    var html = '<div style="padding:16px 18px 18px;background:#fff">';
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2)">ASSIGN WORKERS TO ROSTER</div>' +
      '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;' + badgeColor + '">' +
        assignedTracks + ' of ' + totalTracks + ' assigned</span>' +
    '</div>';

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
    html += '<button class="btn btn-ghost btn-sm" onclick="SKS_PIPELINE_RESOURCE.removeProject(\'' + id + '\')" style="color:#dc2626" title="Archive this job — hides it here and in the Pipeline">Remove job</button>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(null)">Close</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Toggle confirmed review panel ──────────────────────────
  function openConfirmedPanel(tenderId) {
    _openConfirmedPanel = (_openConfirmedPanel === tenderId) ? null : (tenderId || null);
    _splitOpen = null;
    _editingDetails = null;
    _render();
  }

  // ── Edit details on a confirmed job ────────────────────────
  // Lets start date / hours / duration / peak workers / PM / supervisor / notes
  // be amended after confirmation. Writes to tender_enrichment (+ nominations) —
  // the same tables the Pipeline board reads, so changes show there too.
  function _editDetailsSection(t) {
    var id  = String(t.id);
    var enr = _enr[id] || {};
    var nom = _noms[id] || { pm: null, supervisor: null };

    if (_editingDetails !== id) {
      var bits = [
        'Start ' + (enr.start_date_estimated || '—'),
        (enr.hours_estimated ? enr.hours_estimated + 'h' : '—h'),
        (enr.duration_weeks || '—') + ' wks',
        (enr.peak_workers || '—') + ' workers'
      ];
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f8fafc;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          '<strong style="color:var(--ink-3);font-weight:700;letter-spacing:.05em">DETAILS</strong> &nbsp; ' + _esc(bits.join('  ·  ')) +
        '</div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn btn-secondary btn-sm" onclick="SKS_PIPELINE_RESOURCE.toggleEditDetails(\'' + id + '\')">Edit details</button>' +
      '</div>';
    }

    var html = '<div style="padding:14px 14px 16px;background:#f8fafc;border-bottom:1px solid var(--border)">';
    html += '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--ink-2);margin-bottom:10px">EDIT JOB DETAILS</div>';
    html += _detailsFields(id, enr, nom);
    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<button class="btn btn-primary btn-sm" id="ra-cdsave-' + id + '" onclick="SKS_PIPELINE_RESOURCE.saveConfirmedDetails(\'' + id + '\')">Save changes</button>';
    html += '<button class="btn btn-ghost btn-sm" onclick="SKS_PIPELINE_RESOURCE.toggleEditDetails(null)">Cancel</button>';
    html += '<div style="flex:1"></div>';
    html += '<span style="font-size:10px;color:var(--ink-3);text-align:right">Changing workers/duration/start rebuilds the labour plan below (unless workers are already on the roster).</span>';
    html += '</div></div>';
    return html;
  }

  function toggleEditDetails(tenderId) {
    _editingDetails = tenderId ? String(tenderId) : null;
    _render();
  }

  async function saveConfirmedDetails(tenderId) {
    var id  = String(tenderId);
    var btn = document.getElementById('ra-cdsave-' + id);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    var start   = _strVal('ra-start-'   + id) || null;
    var hours   = _numVal('ra-hours-'   + id);
    var dur     = _intVal('ra-dur-'     + id);
    var workers = _intVal('ra-workers-' + id);
    var pmId    = _intVal('ra-pm-'      + id);
    var supPic  = _parsePic(_strVal('ra-sup-' + id));
    var notes   = _strVal('ra-notes-'   + id);

    var prev = _enr[id] || {};
    var structural =
      String(prev.start_date_estimated || '') !== String(start || '') ||
      Number(prev.duration_weeks || 0)        !== Number(dur || 0)     ||
      Number(prev.peak_workers || 0)          !== Number(workers || 0);

    try {
      var enrBase = {
        tender_id:            id,
        hours_estimated:      hours,
        peak_workers:         workers,
        start_date_estimated: start,
        duration_weeks:       dur,
        confidence_notes:     notes
      };
      if (_enr[id]) {
        await sbFetch('tender_enrichment?tender_id=eq.' + id, 'PATCH', enrBase);
        _enr[id] = Object.assign({}, _enr[id], enrBase);
      } else {
        var rows = await sbFetch('tender_enrichment', 'POST', Object.assign({ updated_at: new Date().toISOString() }, enrBase), 'return=representation');
        _enr[id] = (Array.isArray(rows) && rows[0]) ? rows[0] : enrBase;
      }

      var nom = _noms[id] || { pm: null, supervisor: null };
      await Promise.all([
        _upsertNom(id, 'pm',         pmId, nom.pm),
        _upsertNom(id, 'supervisor', supPic.id, nom.supervisor, supPic.source)
      ]);

      _editingDetails = null;

      var msg = '✓ Details saved';
      if (structural) {
        var outcome = await _rebuildLabourPlan(id, start, workers, dur);
        if (outcome === 'rebuilt')      msg = '✓ Saved — labour plan rebuilt to ' + (workers || 0) + ' × ' + (dur || 0) + ' wks';
        else if (outcome === 'pushed')  msg = '✓ Saved — some workers already on roster; labour plan kept (adjust manually)';
        else if (outcome === 'cleared') msg = '✓ Saved — set start, workers & duration to build the labour plan';
      }
      showToast(msg);
      _render();
    } catch (e) {
      showToast('Save failed — ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
    }
  }

  // Rebuild the (unpushed) labour plan after a structural change to a confirmed
  // job. Safe: if any rows were already pushed to the roster, it leaves the plan
  // alone so live roster entries aren't disturbed. Returns 'rebuilt' | 'pushed' | 'cleared'.
  async function _rebuildLabourPlan(tenderId, start, workers, dur) {
    var id = String(tenderId);
    var pushed = await sbFetch('pending_schedule?tender_id=eq.' + id + '&confirmed_at=not.is.null&select=id&limit=1');
    if (Array.isArray(pushed) && pushed.length) return 'pushed';

    await sbFetch('pending_schedule?tender_id=eq.' + id + '&confirmed_at=is.null', 'DELETE');
    delete _ca[id];

    if (start && workers && dur) {
      await _generatePendingSchedule(id, start, workers, dur);
      return 'rebuilt';
    }
    _pending[id] = [];
    return 'cleared';
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
      var partialMsg = pushed > 0
        ? 'Partial — ' + pushed + ' of ' + writePlan.length + ' written. '
        : '';
      showToast(partialMsg + 'Push failed — ' + e.message);
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
      // Scroll the new job's table row into view after render settles
      setTimeout(function () {
        var newRow = document.getElementById('ra-conf-row-' + String(tender.id));
        if (newRow) newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 80);
    } catch (e) {
      showToast('Failed — ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Create & Plan Labour →'; }
    }
  }

  // ── Remove (archive) a job ─────────────────────────────────
  function _emptyConfirmedPanel(t) {
    var id = String(t.id);
    var html = '<div style="padding:16px 18px 18px;background:#fff">';
    html += '<div style="font-size:12px;color:var(--ink-3);margin-bottom:14px">No labour slots were generated for this job — set a duration on the Won job to plan labour.</div>';
    html += '<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<div style="flex:1"></div>';
    html += '<button class="btn btn-ghost btn-sm" onclick="SKS_PIPELINE_RESOURCE.removeProject(\'' + id + '\')" style="color:#dc2626" title="Archive this job — hides it here and in the Pipeline">Remove job</button>';
    html += '<button class="btn btn-ghost btn-sm" onpointerdown="SKS_PIPELINE_RESOURCE.openConfirmedPanel(null)">Close</button>';
    html += '</div></div>';
    return html;
  }

  // BUG-009-safe confirm via the shared #modal-confirm dialog — window.confirm
  // is unreliable in iOS PWA standalone (where field supervisors live), so it
  // can silently return false and the action never fires. Falls back to
  // window.confirm if the modal markup / openModal aren't present.
  function _raConfirm(title, msg, confirmLabel) {
    var titleEl = document.getElementById('confirm-title');
    var msgEl   = document.getElementById('confirm-msg');
    var cb      = document.getElementById('confirm-action');
    var xb      = document.querySelector('#modal-confirm .btn-secondary');
    if (!titleEl || !msgEl || !cb || !xb || typeof openModal !== 'function') {
      return Promise.resolve(window.confirm((title ? title + '\n\n' : '') + msg));
    }
    return new Promise(function (resolve) {
      titleEl.textContent = title || 'Confirm';
      msgEl.textContent   = msg;
      var origX     = xb.onclick;
      var origLabel = cb.textContent;
      cb.textContent  = confirmLabel || 'Confirm';
      function done(val) {
        closeModal('modal-confirm');
        cb.onclick = null; xb.onclick = origX; cb.textContent = origLabel;
        resolve(val);
      }
      cb.onclick = function () { done(true); };
      xb.onclick = function () { done(false); };
      openModal('modal-confirm');
    });
  }

  async function removeProject(tenderId) {
    var id    = String(tenderId);
    var t     = _tenders.find(function (x) { return String(x.id) === id; });
    var label = (t && t.job_name) ? t.job_name : 'this job';
    var ok = await _raConfirm(
      'Remove job',
      'Remove "' + label + '" from Resources? It gets archived — hidden here and in the Pipeline — and can be brought back later. Any roster entries already pushed are left in place.',
      'Remove'
    );
    if (!ok) return;
    try {
      await sbFetch('tenders?id=eq.' + id, 'PATCH', {
        archived_at: new Date().toISOString(),
        updated_at:  new Date().toISOString()
      });
      _tenders = _tenders.filter(function (x) { return String(x.id) !== id; });
      if (_openPanel === id)          _openPanel = null;
      if (_openConfirmedPanel === id) _openConfirmedPanel = null;
      delete _enr[id];
      delete _noms[id];
      delete _pending[id];
      delete _ca[id];
      delete _siteCodes[id];
      delete _wplan[id];
      showToast('✓ Removed — ' + label + ' archived');
      _render();
    } catch (e) {
      showToast('Remove failed — ' + e.message);
    }
  }

  // ── Helpers ────────────────────────────────────────────────
  function _mgrName(personId) {
    if (!personId) return null;
    var m = _managers.find(function (x) { return String(x.id) === String(personId); });
    return m ? m.name : null;
  }

  // Person-in-charge can be a Supervisor (managers table) OR a Direct
  // employee (people table). The two tables have independent id spaces, so a
  // nomination row carries capacity_tag = 'people' when person_id points at
  // STATE.people; otherwise it's a manager id (legacy rows have a null tag).
  function _directPeople() {
    var ppl = (typeof STATE !== 'undefined' && Array.isArray(STATE.people)) ? STATE.people : [];
    return ppl.filter(function (p) {
      return !p.archived && (p.group === 'Direct' || p.group === 'SKS Direct');
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  // Resolve a supervisor/PIC nomination row → display name, from the right table.
  function _picName(nom) {
    if (!nom || !nom.person_id) return null;
    if (nom.capacity_tag === 'people') {
      var ppl = (typeof STATE !== 'undefined' && Array.isArray(STATE.people)) ? STATE.people : [];
      var p = ppl.find(function (x) { return String(x.id) === String(nom.person_id); });
      return p ? p.name : null;
    }
    return _mgrName(nom.person_id);
  }

  // Encoded option value ('p:<id>' | 'm:<id>') → { id, source }.
  function _parsePic(v) {
    if (!v) return { id: null, source: null };
    var i = v.indexOf(':');
    if (i === -1) return { id: parseInt(v, 10) || null, source: 'manager' }; // legacy plain id
    return {
      id:     parseInt(v.slice(i + 1), 10) || null,
      source: v.slice(0, i) === 'p' ? 'people' : 'manager'
    };
  }

  // Encoded current value for a supervisor/PIC nomination row.
  function _picCurVal(nom) {
    if (!nom || !nom.person_id) return '';
    return (nom.capacity_tag === 'people' ? 'p:' : 'm:') + nom.person_id;
  }

  // <option> markup (sans the leading "— not nominated —") for the PIC picker:
  // Direct employees + Supervisor-category managers, grouped.
  function _picOptionsHtml(curVal) {
    var html = '';
    var dirs = _directPeople();
    var sups = _managers.filter(function (m) { return m.category === 'Supervisor'; });
    if (dirs.length) {
      html += '<optgroup label="Direct employees">';
      dirs.forEach(function (p) {
        var v = 'p:' + p.id;
        html += '<option value="' + v + '"' + (v === curVal ? ' selected' : '') + '>' + _esc(p.name) + '</option>';
      });
      html += '</optgroup>';
    }
    if (sups.length) {
      html += '<optgroup label="Supervisors">';
      sups.forEach(function (m) {
        var v = 'm:' + m.id;
        html += '<option value="' + v + '"' + (v === curVal ? ' selected' : '') + '>' + _esc(m.name) + '</option>';
      });
      html += '</optgroup>';
    }
    return html;
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
    refresh:                refresh,
    openPanel:              openPanel,
    openConfirmedPanel:     openConfirmedPanel,
    toggleEditDetails:      toggleEditDetails,
    saveConfirmedDetails:   saveConfirmedDetails,
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
    submitAddJob:           submitAddJob,
    removeProject:          removeProject,
    toggleFloat:            toggleFloat
  };
})();
