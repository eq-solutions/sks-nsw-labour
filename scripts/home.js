/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/home.js  —  EQ Solves Field (SKS deploy)
// Ported from eq-solves-field v3.5.1, updated v3.10.11.
// Staff variant:     greeting + week nav + shift pill + 2 tiles
// Supervisor variant: greeting + action strip + 5 tiles
//
// Public API:
//   window.renderHomeScreen()    — branches by isManager
//   window.eqhTileTap(target)    — tile tap → mobileNav/showPage
//   window.eqhSetWeek(dir)       — week navigation (-1 / +1)
//   window.eqhOpenDrawer()       — slide-up cog drawer
//   window.eqhCloseDrawer()      — close drawer
//   window.eqhsActionStripTap()  — supervisor action strip tap
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────────
  let _eqhWeek = null; // null = current week; set by eqhSetWeek()

  // ── Shared helpers ───────────────────────────────────────────

  function getLoggedInName() {
    try {
      const raw = sessionStorage.getItem('eq_logged_in_name') || '';
      if (!raw || !window.STATE || !Array.isArray(STATE.people)) return raw;
      // Exact match — common case
      if (STATE.people.find(p => p.name === raw)) return raw;
      // Fuzzy match — mirrors refreshPersonSelects() so partial gate names
      // (e.g. "Phillip" stored but "Phillip Smith" in STATE) still resolve
      const lower = raw.toLowerCase();
      const fuzzy = STATE.people.find(p =>
        p.name.toLowerCase() === lower ||
        p.name.toLowerCase().includes(lower) ||
        lower.includes(p.name.toLowerCase())
      );
      return fuzzy ? fuzzy.name : raw;
    } catch (e) { return ''; }
  }

  function getTodayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function isFirstSessionOfDay() {
    try {
      const last = sessionStorage.getItem('eqh_last_greet_day');
      const today = getTodayKey();
      if (last === today) return false;
      sessionStorage.setItem('eqh_last_greet_day', today);
      return true;
    } catch (e) { return true; }
  }

  function formatToday() {
    const d = new Date();
    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function isManagerSession() {
    try { return typeof window.isManager !== 'undefined' && window.isManager === true; }
    catch (e) { return false; }
  }

  function currentWeekKey() {
    if (window.STATE && STATE.currentWeek) return STATE.currentWeek;
    const d = new Date(), mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return String(mon.getDate()).padStart(2,'0') + '.' + String(mon.getMonth()+1).padStart(2,'0') + '.' + String(mon.getFullYear()).slice(-2);
  }

  function _weekOffset(week, n) {
    const [d, m, y] = week.split('.').map(Number);
    const date = new Date(2000 + y, m - 1, d);
    date.setDate(date.getDate() + n * 7);
    return String(date.getDate()).padStart(2,'0') + '.' +
           String(date.getMonth()+1).padStart(2,'0') + '.' +
           String(date.getFullYear()).slice(-2);
  }

  function _fmtWeek(week) {
    try { if (typeof formatWeekLabel === 'function') return formatWeekLabel(week); } catch (e) {}
    return week;
  }

  // ── SKS schedule helpers ─────────────────────────────────────

  function getUserScheduleRow(week) {
    const name = getLoggedInName().trim();
    if (!name) return null;
    const rows = (window.STATE && Array.isArray(STATE.schedule)) ? STATE.schedule : [];
    return rows.find(r => r.name === name && r.week === week) || null;
  }

  function isSiteCode(s) {
    if (!s || !s.trim()) return false;
    if (typeof isLeave      === 'function' && isLeave(s))      return false;
    if (typeof isEducation  === 'function' && isEducation(s))  return false;
    return true;
  }

  function countShiftsInWeek(week) {
    const row = getUserScheduleRow(week);
    if (!row) return 0;
    return ['mon','tue','wed','thu','fri'].filter(d => isSiteCode(row[d])).length;
  }

  function findNextShiftInWeek(week) {
    try {
      const row = getUserScheduleRow(week);
      if (!row) return null;
      const dayOrder = ['mon','tue','wed','thu','fri'];
      const thisWk   = currentWeekKey();
      // For the current week start from today; for other weeks start Monday
      let start = 0;
      if (week === thisWk) {
        const todayIdx = (new Date().getDay() + 6) % 7;
        if (todayIdx > 4) return null; // weekend — this week is done
        start = todayIdx;
      }
      for (let i = start; i < 5; i++) {
        const d = dayOrder[i];
        if (isSiteCode(row[d])) {
          const site = typeof getSiteName === 'function' ? getSiteName(row[d]) : row[d];
          return { day: d, site, week };
        }
      }
    } catch (e) {}
    return null;
  }

  function formatShiftDay(shift) {
    if (!shift) return '';
    const dayMap = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday' };
    return (dayMap[shift.day] || shift.day) + ' · ' + (shift.site || '');
  }

  // ── Supervisor-only helpers ──────────────────────────────────

  function countPendingLeave() {
    try { if (typeof window.eqGetPendingLeaveCount === 'function') return window.eqGetPendingLeaveCount(); }
    catch (e) {}
    return 0;
  }

  function describeScheduleThisWeek() {
    try {
      const wk   = (window.STATE && STATE.currentWeek) ? STATE.currentWeek : null;
      const rows = (window.STATE && Array.isArray(STATE.schedule)) ? STATE.schedule : [];
      const ppl = new Set(), sites = new Set();
      rows.forEach(r => {
        if (wk && r.week !== wk) return;
        ['mon','tue','wed','thu','fri'].forEach(d => {
          if (isSiteCode(r[d])) { ppl.add(r.name); sites.add(r[d].trim()); }
        });
      });
      const p = ppl.size, s = sites.size;
      if (p === 0) return 'No-one rostered yet';
      return p + ' staff · ' + s + ' site' + (s === 1 ? '' : 's');
    } catch (e) { return 'Roster overview'; }
  }

  function actionStripHTML() {
    const leave = countPendingLeave();
    if (leave === 0) {
      return '<div class="eqh-shift eqh-shift-allclear">' +
               '<div class="eqh-shift-icon eqh-shift-icon-ok">✓</div>' +
               '<div style="flex:1">' +
                 '<div class="eqh-shift-label">All clear</div>' +
                 '<div class="eqh-shift-value">Nothing waiting on you today</div>' +
               '</div>' +
             '</div>';
    }
    return '<button class="eqh-shift eqh-shift-warn" onclick="eqhsActionStripTap()">' +
             '<div class="eqh-shift-icon eqh-shift-icon-warn">⚠</div>' +
             '<div style="flex:1;text-align:left">' +
               '<div class="eqh-shift-label">Needs you today</div>' +
               '<div class="eqh-shift-value">' + leave + ' leave request' + (leave === 1 ? '' : 's') + ' to approve</div>' +
             '</div>' +
             '<span class="eqh-shift-chev">›</span>' +
           '</button>';
  }

  function eqhsActionStripTap() {
    try { if (window.EQ_ANALYTICS && EQ_ANALYTICS.capture) EQ_ANALYTICS.capture('home_supervisor_action_tapped', {}); } catch (e) {}
    if (countPendingLeave() > 0 && typeof window.showPage === 'function') return window.showPage('leave');
  }

  // ── Render: staff ────────────────────────────────────────────

  function renderStaffHomeScreen(mount) {
    const week       = _eqhWeek || currentWeekKey();
    const thisWeek   = currentWeekKey();
    const isThisWeek = week === thisWeek;

    const name      = getLoggedInName();
    const firstName = (name || 'mate').split(/\s+/)[0];
    const greeting  = isFirstSessionOfDay() ? "G'day, " + esc(firstName) : esc(formatToday());
    const offline   = typeof navigator !== 'undefined' && navigator.onLine === false;
    const shiftCount = countShiftsInWeek(week);
    const nextShift  = findNextShiftInWeek(week);
    const version    = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?';

    const offlineBanner = offline
      ? '<div class="eqh-offline"><span>⚠</span><span>You\'re offline — showing last synced data.</span></div>'
      : '';

    // Week navigator
    const btnStyle = 'width:34px;height:34px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--ink-2);font-family:inherit;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0';
    const thisWeekBadge = isThisWeek
      ? '<span style="font-size:9px;font-weight:700;color:var(--blue);background:var(--blue-lt);padding:2px 6px;border-radius:4px;letter-spacing:.4px">THIS WEEK</span>'
      : '';
    const weekNav =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<button onclick="eqhSetWeek(-1)" style="' + btnStyle + '">‹</button>' +
        '<div style="flex:1;text-align:center;display:flex;flex-direction:column;align-items:center;gap:3px">' +
          '<span style="font-size:12px;font-weight:600;color:var(--ink-3)">' + esc(_fmtWeek(week)) + '</span>' +
          thisWeekBadge +
        '</div>' +
        '<button onclick="eqhSetWeek(1)" style="' + btnStyle + '">›</button>' +
      '</div>';

    // Shift pill
    const shiftPill = nextShift
      ? '<button class="eqh-shift" onclick="eqhTileTap(\'schedule\')">' +
          '<span class="eqh-shift-icon">📍</span>' +
          '<div style="flex:1;text-align:left">' +
            '<div class="eqh-shift-label">' + (isThisWeek ? 'Next shift' : 'First shift') + '</div>' +
            '<div class="eqh-shift-value">' + esc(formatShiftDay(nextShift)) + '</div>' +
          '</div>' +
          '<span class="eqh-shift-chev">›</span>' +
        '</button>'
      : '<button class="eqh-shift" onclick="eqhTileTap(\'schedule\')">' +
          '<span class="eqh-shift-icon">📅</span>' +
          '<div style="flex:1;text-align:left">' +
            '<div class="eqh-shift-label">No shifts this week</div>' +
            '<div class="eqh-shift-value">Tap to view schedule</div>' +
          '</div>' +
          '<span class="eqh-shift-chev">›</span>' +
        '</button>';

    const scheduleSub = shiftCount === 0 ? 'Nothing rostered'
      : shiftCount === 1 ? '1 shift this week'
      : shiftCount + ' shifts this week';

    mount.innerHTML =
      '<div class="eqh-header">' +
        '<div>' +
          '<div class="eqh-brand">EQ Field</div>' +
          '<div class="eqh-greeting">' + greeting + '</div>' +
        '</div>' +
        '<button class="eqh-cog" onclick="eqhOpenDrawer()" aria-label="More options"><span>⚙</span></button>' +
      '</div>' +
      offlineBanner +
      weekNav +
      shiftPill +
      '<div class="eqh-tiles">' +
        '<button class="eqh-tile eqh-t-schedule" onclick="eqhTileTap(\'schedule\')">' +
          '<div class="eqh-tile-icon">📅</div>' +
          '<div><div class="eqh-tile-title">My schedule</div><div class="eqh-tile-sub">' + esc(scheduleSub) + '</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-leave" onclick="eqhTileTap(\'leave\')">' +
          '<div class="eqh-tile-icon">✈</div>' +
          '<div><div class="eqh-tile-title">Leave</div><div class="eqh-tile-sub">Request time off</div></div>' +
        '</button>' +
      '</div>' +
      '<div class="eqh-footer">EQ Field · v' + esc(version) + '</div>';

    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.events && EQ_ANALYTICS.events.pageViewed) {
        EQ_ANALYTICS.events.pageViewed({ page: 'home' });
      }
    } catch (e) {}
  }

  // ── Render: supervisor ───────────────────────────────────────

  function renderSupervisorHomeScreen(mount) {
    const name      = getLoggedInName();
    const firstName = (name || 'boss').split(/\s+/)[0];
    const greeting  = isFirstSessionOfDay() ? "G'day, " + esc(firstName) : esc(formatToday());
    const offline   = typeof navigator !== 'undefined' && navigator.onLine === false;
    const schedSub  = describeScheduleThisWeek();
    const version   = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?';

    const offlineBanner = offline
      ? '<div class="eqh-offline"><span>⚠</span><span>You\'re offline — counts may be stale.</span></div>'
      : '';

    mount.innerHTML =
      '<div class="eqh-header">' +
        '<div>' +
          '<div class="eqh-brand">EQ Field <span class="eqh-role-chip">SUPERVISOR</span></div>' +
          '<div class="eqh-greeting">' + greeting + '</div>' +
        '</div>' +
        '<button class="eqh-cog" onclick="eqhOpenDrawer()" aria-label="More options"><span>⚙</span></button>' +
      '</div>' +
      offlineBanner +
      actionStripHTML() +
      '<div class="eqh-tiles">' +
        '<button class="eqh-tile eqh-t-schedule" onclick="eqhTileTap(\'roster\')">' +
          '<div class="eqh-tile-icon">📅</div>' +
          '<div><div class="eqh-tile-title">Schedule</div><div class="eqh-tile-sub">' + esc(schedSub) + '</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-time" onclick="eqhTileTap(\'timesheets\')">' +
          '<div class="eqh-tile-icon">⏱</div>' +
          '<div><div class="eqh-tile-title">Timesheets</div><div class="eqh-tile-sub">Review &amp; approve</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-leave" onclick="eqhTileTap(\'leave\')">' +
          '<div class="eqh-tile-icon">✈</div>' +
          '<div><div class="eqh-tile-title">Leave</div><div class="eqh-tile-sub">Requests &amp; balance</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-team" onclick="eqhTileTap(\'contacts\')">' +
          '<div class="eqh-tile-icon">👥</div>' +
          '<div><div class="eqh-tile-title">Team</div><div class="eqh-tile-sub">Contacts &amp; roster</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-reports" onclick="eqhTileTap(\'dashboard\')">' +
          '<div class="eqh-tile-icon">📊</div>' +
          '<div><div class="eqh-tile-title">Reports</div><div class="eqh-tile-sub">Weekly hours &amp; sites</div></div>' +
        '</button>' +
      '</div>' +
      '<div class="eqh-footer">EQ Field · v' + esc(version) + ' · Supervisor</div>';

    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.events && EQ_ANALYTICS.events.pageViewed) {
        EQ_ANALYTICS.events.pageViewed({ page: 'home-supervisor' });
      }
    } catch (e) {}
  }

  // ── Top-level render ─────────────────────────────────────────

  function renderHomeScreen(keepWeek) {
    // Reset to current week on fresh navigation; keep position during week nav
    if (!keepWeek) _eqhWeek = null;
    const mount = document.getElementById('page-home');
    if (!mount) return;
    if (isManagerSession()) return renderSupervisorHomeScreen(mount);
    return renderStaffHomeScreen(mount);
  }

  // ── Week navigation ──────────────────────────────────────────

  function eqhSetWeek(dir) {
    const base = _eqhWeek || currentWeekKey();
    _eqhWeek   = _weekOffset(base, dir);
    renderHomeScreen(true);
  }

  // ── Tile tap router ──────────────────────────────────────────

  function eqhTileTap(target) {
    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.capture) {
        EQ_ANALYTICS.capture(isManagerSession() ? 'home_supervisor_tile_tapped' : 'home_tile_tapped', { tile: target });
      }
    } catch (e) {}
    if (typeof window.mobileNav === 'function') window.mobileNav(target);
    else if (typeof window.showPage === 'function') window.showPage(target);
  }

  // ── Cog drawer ───────────────────────────────────────────────

  function drawerContent(role) {
    const c = 'eqhCloseDrawer()';
    if (role === 'supervisor') {
      return (
        '<div class="eqh-drawer-sheet" onclick="event.stopPropagation()">' +
          '<div class="eqh-drawer-handle"></div>' +
          '<div class="eqh-drawer-title">More</div>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'editor\')"><span class="eqh-drawer-item-icon">✎</span> Edit roster</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'contacts\')"><span class="eqh-drawer-item-icon">👥</span> Contacts</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'sites\')"><span class="eqh-drawer-item-icon">📍</span> Sites</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'jobnumbers\')"><span class="eqh-drawer-item-icon">#</span> Job numbers</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'apprentices\')"><span class="eqh-drawer-item-icon">🎓</span> Apprentices</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'managers\')"><span class="eqh-drawer-item-icon">🛡</span> Supervision</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'data\')"><span class="eqh-drawer-item-icon">⇅</span> Import / Export</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';if(typeof openPrivacyNotice===\'function\')openPrivacyNotice()"><span class="eqh-drawer-item-icon">🔒</span> Privacy</button>' +
          '<button class="eqh-drawer-item" onclick="' + c + ';if(typeof logoutUser===\'function\')logoutUser()"><span class="eqh-drawer-item-icon">↪</span> Log out</button>' +
          '<button class="eqh-drawer-close" onclick="' + c + '">Close</button>' +
        '</div>'
      );
    }
    return (
      '<div class="eqh-drawer-sheet" onclick="event.stopPropagation()">' +
        '<div class="eqh-drawer-handle"></div>' +
        '<div class="eqh-drawer-title">More</div>' +
        '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'schedule\')"><span class="eqh-drawer-item-icon">◷</span> My schedule</button>' +
        '<button class="eqh-drawer-item" onclick="' + c + ';mobileNav(\'leave\')"><span class="eqh-drawer-item-icon">✈</span> Leave</button>' +
        '<button class="eqh-drawer-item" onclick="' + c + ';if(typeof openPrivacyNotice===\'function\')openPrivacyNotice()"><span class="eqh-drawer-item-icon">🔒</span> Privacy</button>' +
        '<button class="eqh-drawer-item" onclick="' + c + ';if(typeof logoutUser===\'function\')logoutUser()"><span class="eqh-drawer-item-icon">↪</span> Log out</button>' +
        '<button class="eqh-drawer-close" onclick="' + c + '">Close</button>' +
      '</div>'
    );
  }

  function ensureDrawer() {
    let host = document.getElementById('eqh-drawer');
    if (!host) {
      host = document.createElement('div');
      host.id = 'eqh-drawer';
      host.className = 'eqh-drawer';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      host.addEventListener('click', function () { eqhCloseDrawer(); });
      document.body.appendChild(host);
    }
    return host;
  }

  function eqhOpenDrawer() {
    const role = isManagerSession() ? 'supervisor' : 'staff';
    const host = ensureDrawer();
    host.innerHTML = drawerContent(role);
    host.classList.add('open');
    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.capture) {
        EQ_ANALYTICS.capture(role === 'supervisor' ? 'home_supervisor_cog_opened' : 'home_cog_opened', {});
      }
    } catch (e) {}
  }

  function eqhCloseDrawer() {
    const host = document.getElementById('eqh-drawer');
    if (host) host.classList.remove('open');
  }

  // Re-render on connectivity change
  window.addEventListener('online',  function () { if (typeof currentPage !== 'undefined' && currentPage === 'home') renderHomeScreen(true); });
  window.addEventListener('offline', function () { if (typeof currentPage !== 'undefined' && currentPage === 'home') renderHomeScreen(true); });

  // ── Expose ───────────────────────────────────────────────────
  window.renderHomeScreen   = renderHomeScreen;
  window.eqhTileTap         = eqhTileTap;
  window.eqhSetWeek         = eqhSetWeek;
  window.eqhOpenDrawer      = eqhOpenDrawer;
  window.eqhCloseDrawer     = eqhCloseDrawer;
  window.eqhsActionStripTap = eqhsActionStripTap;

})();
