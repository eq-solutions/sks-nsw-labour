/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/home.js  —  EQ Solves Field (SKS deploy)
// Ported from eq-solves-field v3.5.1.
// Staff variant:     greeting + next-shift pill + 3 tiles (Schedule / Timesheets / Leave)
// Supervisor variant: greeting + action strip + 5 tiles
//
// SKS schedule format: STATE.schedule rows are {name, week, mon, tue, wed, thu, fri}
// (not the eq-field {person_id, day, site} shape — all lookups rewritten accordingly).
//
// No feature flag needed — SKS ships it on for all mobile staff by default.
// Viewport gate still applies: desktop (≥768px) never sees this page.
//
// Public API:
//   window.renderHomeScreen()    — branches by isManager
//   window.eqhTileTap(target)    — tile tap → mobileNav/showPage + analytics
//   window.eqhOpenDrawer()       — slide-up cog drawer
//   window.eqhCloseDrawer()      — close drawer
//   window.eqhsActionStripTap()  — supervisor action strip tap
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Shared helpers ───────────────────────────────────────────

  function getLoggedInName() {
    try { return sessionStorage.getItem('eq_logged_in_name') || ''; } catch (e) { return ''; }
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

  function escapeHtml(s) {
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

  // ── SKS schedule helpers ────────────────────────────────────
  // SKS stores schedule as {name, week, mon, tue, wed, thu, fri}.

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

  function countShiftsThisWeek() {
    const row = getUserScheduleRow(currentWeekKey());
    if (!row) return 0;
    return ['mon','tue','wed','thu','fri'].filter(d => isSiteCode(row[d])).length;
  }

  function findNextShift() {
    try {
      const wk       = currentWeekKey();
      const row      = getUserScheduleRow(wk);
      if (!row) return null;
      const dayOrder = ['mon','tue','wed','thu','fri'];
      const todayIdx = ((new Date().getDay() + 6) % 7); // 0=Mon … 4=Fri
      if (todayIdx > 4) return null; // weekend
      for (let i = todayIdx; i < 5; i++) {
        const d = dayOrder[i];
        if (isSiteCode(row[d])) {
          const siteName = (typeof getSiteName === 'function') ? getSiteName(row[d]) : row[d];
          return { day: d, site: siteName, week: wk };
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

  function isTimesheetDueSoon() {
    const d = new Date().getDay();
    return d >= 3 && d <= 5; // Wed–Fri
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
    const name       = getLoggedInName();
    const firstName  = (name || 'mate').split(/\s+/)[0];
    const greeting   = isFirstSessionOfDay() ? "G'day, " + escapeHtml(firstName) : escapeHtml(formatToday());
    const offline    = typeof navigator !== 'undefined' && navigator.onLine === false;
    const shiftCount = countShiftsThisWeek();
    const nextShift  = findNextShift();
    const tsDueSoon  = isTimesheetDueSoon();
    const version    = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?';

    const offlineBanner = offline
      ? '<div class="eqh-offline"><span>⚠</span><span>You\'re offline — showing last synced data.</span></div>'
      : '';

    const shiftPill = nextShift
      ? '<button class="eqh-shift" onclick="eqhTileTap(\'schedule\')">' +
          '<span class="eqh-shift-icon">📍</span>' +
          '<div style="flex:1;text-align:left">' +
            '<div class="eqh-shift-label">Next shift</div>' +
            '<div class="eqh-shift-value">' + escapeHtml(formatShiftDay(nextShift)) + '</div>' +
          '</div>' +
          '<span class="eqh-shift-chev">›</span>' +
        '</button>'
      : '<button class="eqh-shift" onclick="eqhTileTap(\'schedule\')">' +
          '<span class="eqh-shift-icon">📅</span>' +
          '<div style="flex:1;text-align:left">' +
            '<div class="eqh-shift-label">No upcoming shifts found</div>' +
            '<div class="eqh-shift-value">Tap to view your schedule</div>' +
          '</div>' +
          '<span class="eqh-shift-chev">›</span>' +
        '</button>';

    const scheduleSub = shiftCount === 0 ? 'Nothing rostered this week'
      : shiftCount === 1 ? '1 shift this week'
      : shiftCount + ' shifts this week';

    const tsBadge = tsDueSoon ? '<span class="eqh-badge eqh-badge-warn">Due Fri</span>' : '';

    mount.innerHTML =
      '<div class="eqh-header">' +
        '<div>' +
          '<div class="eqh-brand">EQ Field</div>' +
          '<div class="eqh-greeting">' + greeting + '</div>' +
        '</div>' +
        '<button class="eqh-cog" onclick="eqhOpenDrawer()" aria-label="More options"><span>⚙</span></button>' +
      '</div>' +
      offlineBanner +
      shiftPill +
      '<div class="eqh-tiles">' +
        '<button class="eqh-tile eqh-t-schedule" onclick="eqhTileTap(\'schedule\')">' +
          '<div class="eqh-tile-icon">📅</div>' +
          '<div><div class="eqh-tile-title">My schedule</div><div class="eqh-tile-sub">' + escapeHtml(scheduleSub) + '</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-time" onclick="eqhTileTap(\'staff-ts-gate\')">' +
          tsBadge +
          '<div class="eqh-tile-icon">⏱</div>' +
          '<div><div class="eqh-tile-title">Timesheets</div><div class="eqh-tile-sub">Submit this week</div></div>' +
        '</button>' +
        '<button class="eqh-tile eqh-t-leave" onclick="eqhTileTap(\'leave\')">' +
          '<div class="eqh-tile-icon">✈</div>' +
          '<div><div class="eqh-tile-title">Leave</div><div class="eqh-tile-sub">Request time off</div></div>' +
        '</button>' +
      '</div>' +
      '<div class="eqh-footer">EQ Field · v' + escapeHtml(version) + '</div>';

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
    const greeting  = isFirstSessionOfDay() ? "G'day, " + escapeHtml(firstName) : escapeHtml(formatToday());
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
          '<div><div class="eqh-tile-title">Schedule</div><div class="eqh-tile-sub">' + escapeHtml(schedSub) + '</div></div>' +
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
      '<div class="eqh-footer">EQ Field · v' + escapeHtml(version) + ' · Supervisor</div>';

    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.events && EQ_ANALYTICS.events.pageViewed) {
        EQ_ANALYTICS.events.pageViewed({ page: 'home-supervisor' });
      }
    } catch (e) {}
  }

  // ── Top-level render ─────────────────────────────────────────

  function renderHomeScreen() {
    const mount = document.getElementById('page-home');
    if (!mount) return;
    if (isManagerSession()) return renderSupervisorHomeScreen(mount);
    return renderStaffHomeScreen(mount);
  }

  // ── Tile tap router ──────────────────────────────────────────

  function eqhTileTap(target) {
    try {
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.capture) {
        EQ_ANALYTICS.capture(isManagerSession() ? 'home_supervisor_tile_tapped' : 'home_tile_tapped', { tile: target });
      }
    } catch (e) {}
    // staff-ts-gate opens the PIN modal rather than navigating to a page
    if (target === 'staff-ts-gate') {
      if (typeof openStaffTsGate === 'function') openStaffTsGate();
      return;
    }
    // mobileNav handles both showPage + active-state on bottom bar
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
  window.addEventListener('online',  function () { if (typeof currentPage !== 'undefined' && currentPage === 'home') renderHomeScreen(); });
  window.addEventListener('offline', function () { if (typeof currentPage !== 'undefined' && currentPage === 'home') renderHomeScreen(); });

  // ── Expose ───────────────────────────────────────────────────
  window.renderHomeScreen   = renderHomeScreen;
  window.eqhTileTap         = eqhTileTap;
  window.eqhOpenDrawer      = eqhOpenDrawer;
  window.eqhCloseDrawer     = eqhCloseDrawer;
  window.eqhsActionStripTap = eqhsActionStripTap;

})();
