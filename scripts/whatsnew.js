/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/whatsnew.js  —  EQ Solves Field
// "What's new" banner shown once per user after a major upgrade.
// Dismissible; remembered via localStorage.
//
// v3.4.77: the banner now credits the person who suggested each
// change. The point isn't decoration — it's the start of a feedback
// flywheel: when someone sees their name attached to a shipped
// feature, the next idea comes much more freely. Keep the credit
// honest. Don't make up names.
//
// Re-accessible at any time via the "What's new" link in the
// sidebar footer (calls openWhatsNew() which clears the dismiss
// flag and re-renders).
//
// Bump WHATSNEW_KEY when there's a meaningful set of features to
// surface — the change to the key string forces the banner to
// show again for everyone, since the old key is no longer in
// their localStorage.
// ─────────────────────────────────────────────────────────────

const WHATSNEW_KEY     = 'eq.whatsnew.v3.4.78.seen';
const WHATSNEW_VERSION = 'v3.4.78';

// Two sections — "shipped" (live in this release) and "coming"
// (in the pipeline, credited to the requester so they know their
// idea is being worked on). Both feed the same "your feedback
// ships" story.
//
// v3.4.78: Teams promoted from "Coming next" → "Just shipped".
// Ben's credit moves with it — the whole point of the credit line
// is to follow the request all the way through, so the person who
// asked sees their name appear when it lands. Undo (Matt) stays as
// recently-shipped reminder.
const WHATSNEW_SHIPPED = [
  {
    icon:  '👥',
    title: 'Teams — filter the roster to your crew',
    body:  'New "Team" pill row above the roster and contacts pages. Click a team to show just those people. A person can be in more than one team (Equinix Crew AND Apprentice Pool both work). Coloured stripe down each row matches the team. ⚙ Manage Teams lets you create, recolour, and edit memberships.',
    credit: 'Ben Ritchie'
  },
  {
    icon:  '↶',
    title: 'Undo button (Ctrl-Z) — shipped in v3.4.76',
    body:  'Still here — hit ↶ Undo in the top bar or Ctrl-Z to reverse your last roster edit. Now even more useful when you accidentally re-shuffle a whole crew\'s week.',
    credit: 'Matt Miller'
  }
];

const WHATSNEW_COMING = [];

function _renderWhatsNew() {
  const el = document.getElementById('whatsnew-banner');
  if (!el) return;

  if (localStorage.getItem(WHATSNEW_KEY)) {
    el.style.display = 'none';
    return;
  }

  const renderEntry = h => `
    <div style="display:flex;gap:12px;padding:10px 0;border-top:1px solid rgba(124,119,185,.15)">
      <div style="font-size:20px;flex-shrink:0;width:24px;text-align:center;line-height:1.2">${h.icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--navy);line-height:1.3">${h.title}</div>
        <div style="font-size:12px;color:var(--ink-2);line-height:1.45;margin-top:3px">${h.body}</div>
        ${h.credit ? `<div style="margin-top:8px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--ink-3);font-weight:500">— suggested by</span>
          <span style="font-size:15px;color:var(--purple);font-weight:700;letter-spacing:.2px">${h.credit}</span>
        </div>` : ''}
      </div>
    </div>`;

  const shippedRows = WHATSNEW_SHIPPED.map(renderEntry).join('');
  // v3.4.78: "Coming next" section only renders when there's actually
  // something credited in the pipeline. Empty section with a stale
  // heading reads like the product is stalled — better to drop it and
  // let the feedback CTA at the bottom do the "what's next?" work.
  const comingRows  = WHATSNEW_COMING.map(renderEntry).join('');
  const headerSubtitle = WHATSNEW_COMING.length
    ? 'Two updates — both from your feedback.'
    : 'Your idea, shipped. What\'s next?';

  el.innerHTML = `
    <div style="background:var(--purple-lt);border-left:4px solid var(--purple);border-radius:6px;padding:14px 18px;margin-bottom:20px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:.5px">What's new — ${WHATSNEW_VERSION}</div>
          <div style="font-size:14px;font-weight:600;color:var(--navy);margin-top:2px">${headerSubtitle}</div>
        </div>
        <button onclick="dismissWhatsNew()" title="Dismiss"
          style="background:none;border:none;font-size:18px;color:var(--ink-3);cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0">✕</button>
      </div>

      <div style="margin-top:6px">
        <div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-top:10px">Just shipped</div>
        ${shippedRows}
      </div>

      ${WHATSNEW_COMING.length ? `<div style="margin-top:8px">
        <div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-top:10px">Coming next</div>
        ${comingRows}
      </div>` : ''}

      <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(124,119,185,.18);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--ink-2);line-height:1.4">
            <strong style="color:var(--navy)">Got an idea?</strong>
            Tell us — your name on the next one.
          </div>
        </div>
        <a href="mailto:dev@eq.solutions?subject=SKS%20Labour%20%E2%80%94%20feature%20idea&body=I'd%20like%20to%20suggest%3A%0A%0A"
           class="btn btn-secondary btn-sm" style="font-size:11px;text-decoration:none">✉ Email an idea</a>
        <button class="btn btn-primary btn-sm" onclick="dismissWhatsNew()" style="font-size:11px">Got it</button>
      </div>
    </div>`;
  el.style.display = 'block';
}

function dismissWhatsNew() {
  try { localStorage.setItem(WHATSNEW_KEY, '1'); } catch (e) {}
  const el = document.getElementById('whatsnew-banner');
  if (el) el.style.display = 'none';
}

// v3.4.77 — re-open the banner from the sidebar "What's new" link.
// Clears the dismiss flag and re-renders so the supervisor can show
// it to someone, refresh their memory on what landed, or just see
// the upcoming-features credit again.
function openWhatsNew() {
  try { localStorage.removeItem(WHATSNEW_KEY); } catch (e) {}
  _renderWhatsNew();
  // Scroll to the banner so it's visible even if the user is mid-page.
  const el = document.getElementById('whatsnew-banner');
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Render once after the DOM is ready. Dashboard renders may run before or
// after this — the banner div is a static HTML element so it doesn't need
// re-rendering on each renderDashboard() call.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _renderWhatsNew);
} else {
  _renderWhatsNew();
}
