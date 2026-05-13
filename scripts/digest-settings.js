/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/digest-settings.js  —  EQ Solves Field  v3.4.28
// Per-supervisor opt-in toggle for the weekly digest email.
// Renders a compact strip above #managers-content on the Supervision
// page. Reads/writes managers.digest_opt_in via the existing sbFetch()
// helper (so the same RLS / org scoping applies as everywhere else).
// Standalone — does not modify managers.js.
// ─────────────────────────────────────────────────────────────

(function () {
  // Guard: only wire up once.
  if (window.__EQ_DIGEST_SETTINGS_INSTALLED__) return;
  window.__EQ_DIGEST_SETTINGS_INSTALLED__ = true;

  // Ensure STATE.managers rows carry a digest_opt_in property even if the
  // existing sbFetch mapping didn't pick it up. We lazy-load once per
  // page visit from Supabase.
  async function hydrateDigestOptIns() {
    if (!window.sbFetch || !window.STATE || !Array.isArray(STATE.managers)) return;
    try {
      const rows = await sbFetch('managers?select=id,digest_opt_in');
      const byId = {};
      // v3.4.26: stringify keys so bigint vs string ids don't miss.
      (rows || []).forEach(r => { byId[String(r.id)] = r.digest_opt_in; });
      STATE.managers.forEach(m => {
        const k = String(m.id);
        if (byId[k] !== undefined) m.digest_opt_in = byId[k];
        // Default opt-in true if the column isn't there yet (migration not applied).
        if (m.digest_opt_in === undefined) m.digest_opt_in = true;
      });
    } catch (e) {
      // Migration not applied yet → column doesn't exist → silently treat
      // everyone as opted in. This lets the drop install cleanly even if
      // the SQL is applied after the zip.
      STATE.managers.forEach(m => { if (m.digest_opt_in === undefined) m.digest_opt_in = true; });
    }
  }

  async function toggleDigest(managerId, nextVal) {
    // v3.4.26: coerce both sides to String. SKS managers.id is bigint
    // (number) but onchange passes the id as a quoted string template,
    // so strict === would always fail and the handler would silently no-op.
    const idStr = String(managerId);
    const mgr = (STATE.managers || []).find(m => String(m.id) === idStr);
    if (!mgr) {
      console.warn('toggleDigest: manager not found for id', managerId, '— STATE has', (STATE.managers || []).length, 'managers');
      return;
    }
    const prev = mgr.digest_opt_in;
    mgr.digest_opt_in = nextVal;          // optimistic
    // v3.4.57: removed the immediate renderDigestPanel() call here. The
    // user's click already toggled the native <input type="checkbox">
    // visually — re-rendering the whole panel was redundant for the
    // success case AND raced the PATCH (renderDigestPanel does a fresh
    // sbFetch; if that fetch returned BEFORE the PATCH committed, the
    // checkbox visibly UNCHECKED for ~50-200ms). On failure path below
    // we DO re-render to surface the rollback.
    try {
      await sbFetch(`managers?id=eq.${encodeURIComponent(idStr)}`, 'PATCH', { digest_opt_in: nextVal });
      if (typeof showToast === 'function') {
        showToast(nextVal ? `📧 Digest on for ${mgr.name}` : `✋ Digest off for ${mgr.name}`);
      }
      // v3.4.35: track digest opt-in/out toggles for the analytics dashboard.
      if (window.EQ_ANALYTICS && EQ_ANALYTICS.events) {
        EQ_ANALYTICS.events.digestToggled({ manager_id: idStr, opt_in: nextVal });
      }
    } catch (e) {
      console.error('toggleDigest failed:', e);
      mgr.digest_opt_in = prev;
      renderDigestPanel();              // re-render: native checkbox stuck on the wrong value, fix it
      if (typeof showToast === 'function') {
        showToast('Digest toggle failed — check that the digest migration has been applied.');
      }
    }
  }
  window.toggleDigest = toggleDigest;

  function _ensurePanel() {
    const host = document.getElementById('managers-content');
    if (!host) return null;
    let panel = document.getElementById('digest-settings-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'digest-settings-panel';
      panel.style.cssText = 'background:#F8FAFC;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px;margin-bottom:14px';
      host.parentNode.insertBefore(panel, host);
    }
    return panel;
  }

  function _paintPanel(rows) {
    const panel = _ensurePanel();
    if (!panel) return;
    const mgrs = (rows || []).filter(m => m.email);
    if (!mgrs.length) {
      panel.innerHTML = '<div style="font-size:12px;color:#6B7280">No supervisors with emails — nobody to receive the weekly digest.</div>';
      return;
    }
    // v3.4.59: BATTLE-TEST #39 — moved from inline onchange="toggleDigest('${m.id}',…)"
    // to data-attribute + delegated listener. m.id is uuid/bigint today (no
    // quote-injection risk), but a future schema change that lets ids contain
    // quotes or backslashes would break the inline string OR open an XSS
    // surface. data-digest-id goes through escHtmlLocal which already escapes
    // attribute-context special chars; the listener reads dataset.digestId
    // which is intrinsically string-safe.
    const items = mgrs.map(m => {
      const on = m.digest_opt_in !== false;
      return `
        <label style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:#374151">
          <input type="checkbox" ${on ? 'checked' : ''} data-digest-id="${escHtmlLocal(m.id)}"
                 style="width:16px;height:16px;accent-color:#1F335C">
          <span style="font-weight:600">${escHtmlLocal(m.name)}</span>
          <span style="color:#6B7280;font-size:12px">${escHtmlLocal(m.email)}</span>
        </label>`;
    }).join('');
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div>
          <div style="font-weight:700;color:#1F335C;font-size:14px">📧 Weekly supervisor digest</div>
          <div style="font-size:12px;color:#6B7280;margin-top:2px">Fridays 12:00 AEST · leave next week, pending approvals, unrostered staff, timesheet completion</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:4px">${items}</div>`;
    // Wire the listeners (delegated equivalent: read data-digest-id off each input).
    panel.querySelectorAll('input[data-digest-id]').forEach(inp => {
      inp.addEventListener('change', e => {
        toggleDigest(inp.dataset.digestId, e.target.checked);
      });
    });
  }

  // v3.4.29: bulletproof render — always fetches fresh from DB on every call.
  // v3.4.34: demo tenant has no Supabase, so sbFetch returns []. Don't blank
  // the panel in that case — keep the seed paint (which IS the truth on
  // demo, since STATE.managers is the only source of data).
  async function renderDigestPanel() {
    const host = document.getElementById('managers-content');
    if (!host) return;
    // First paint: use STATE so user sees something instantly. Synced after fetch.
    const seed = (STATE.managers || []).map(m => ({
      id: m.id, name: m.name, email: m.email,
      digest_opt_in: m.digest_opt_in === false ? false : true,
    }));
    _paintPanel(seed);

    // Demo / EQ tenant — no DB, no fetch, seed IS the truth.
    if (typeof TENANT !== 'undefined' && (TENANT.ORG_SLUG === 'demo' || TENANT.ORG_SLUG === 'eq')) return;
    if (!window.sbFetch || (typeof SB_URL !== 'undefined' && !SB_URL)) return;

    try {
      const rows = await sbFetch('managers?select=id,name,email,digest_opt_in&order=name.asc');
      // v3.4.34: empty fetch → keep the seed paint (was overwriting with "No supervisors").
      if (!Array.isArray(rows) || rows.length === 0) return;
      // Sync STATE so toggle's optimistic update is in agreement.
      const byId = {};
      rows.forEach(r => { byId[String(r.id)] = r.digest_opt_in; });
      (STATE.managers || []).forEach(m => {
        const k = String(m.id);
        if (byId[k] !== undefined) m.digest_opt_in = byId[k];
      });
      _paintPanel(rows);
    } catch (e) {
      console.warn('renderDigestPanel: fresh fetch failed, keeping STATE-derived paint', e);
    }
  }
  window.renderDigestPanel = renderDigestPanel;

  function escHtmlLocal(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Wrap renderManagers so the panel appears any time the Supervision page
  // renders. We defer the wrap until after DOM load so managers.js is defined.
  function installWrap() {
    if (typeof window.renderManagers !== 'function') return false;
    if (window.__EQ_RENDER_MANAGERS_WRAPPED__) return true;
    const orig = window.renderManagers;
    window.renderManagers = function () {
      const r = orig.apply(this, arguments);
      // v3.4.29: renderDigestPanel always fetches fresh; no pre-hydrate needed.
      renderDigestPanel();
      return r;
    };
    window.__EQ_RENDER_MANAGERS_WRAPPED__ = true;
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Try to wrap; if managers.js loads later, retry shortly.
    if (!installWrap()) {
      let tries = 0;
      const t = setInterval(() => {
        tries += 1;
        if (installWrap() || tries > 20) clearInterval(t);
      }, 250);
    }
    // First hydration + render once the app has loaded STATE.managers.
    // Kick off a short polling loop for up to 10s waiting for managers to populate.
    let hydrated = false;
    let tries = 0;
    const h = setInterval(async () => {
      tries += 1;
      if (!hydrated && STATE && Array.isArray(STATE.managers) && STATE.managers.length) {
        hydrated = true;
        await hydrateDigestOptIns();
        if (document.getElementById('page-managers') && !document.getElementById('page-managers').classList.contains('hidden')) {
          renderDigestPanel();
        }
      }
      if (hydrated || tries > 40) clearInterval(h);
    }, 250);
  });
})();