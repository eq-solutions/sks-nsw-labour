# EQ Solves Field — Changelog

_Rolling changelog for `sks-nsw-labour` — the SKS deployment of EQ Solves Field. EQ owns the code; this repo is the stable deploy lane for SKS, forked from `eq-solves-field` so the live SKS app isn't churned by active EQ Field development. Most recent release first. Older entries below were written when this code lived in `eq-solves-field` and reference its demo→main flow — that flow no longer applies here._

_Consolidated 2026-04-28: all per-version `CHANGELOG-v3.4.X.md` files merged in and removed._

---

# v3.4.83.2 — Phase 4a live-test fixes

**Date:** 2026-05-23
**Scope:** Two fixes after Royce's live phone test of v3.4.83.1 against `sks-nsw-labour.netlify.app`.

- **Hours quick-select chips fire on touch.** Tapping the `8` chip did nothing on iOS because the previous `ontouchstart="event.preventDefault()"` suppressed the synthesized `click` event entirely. Switched to a single `onpointerdown="event.preventDefault();_pickTsHoursChip(...)"` handler that fires for both mouse and touch *before* any blur/focus shift, then runs the pick directly. Same code path for desktop — slightly more robust there too. Symptom on phone: chip popover appeared, tap was visually acknowledged, but the hours input stayed empty and no save fired.
- **Mobile re-renders after every save.** `onTsCellChange` was calling `updateTsRowTotal` which only updates a desktop-only `#tst-<name>` element — on phone the card total / status icon / variance chip / **Fill Week banner** all stayed stale until you reloaded. Now `onTsCellChange` triggers a full `renderTimesheets()` if `_isPhoneViewport()` is true. Card-expansion state is preserved via the existing `_tsExpandedCards` Set so the supervisor's open row stays open. Desktop save path unchanged.

Version stamps: `APP_VERSION = '3.4.83.2'`, SW cache `eq-field-v3.4.83.2`.

---

# v3.4.83.1 — Phase 4a deploy-preview fixes

**Date:** 2026-05-23
**Scope:** Three follow-ups after Royce's first phone test of the v3.4.83 deploy preview.

- **Saves on mobile actually work now.** `onTsCellChange` was looking up its peer inputs via `el.closest('tr')`, which returns null in the mobile card-stack DOM (cells are `<div class="ts-mday">`). Selector loosened to `tr, .ts-mday` — desktop unchanged, mobile saves go through. `_onTsKeydown` got the same defensive update. **Any timesheet edits made on the v3.4.83 deploy preview before this patch did NOT persist** — they need to be re-entered. (No data corruption; the save just no-op'd, the inputs showed the typed value locally.)
- **Hours quick-select popover clamped to viewport.** Was anchored to the input's `rect.left` and overflowed the right edge on phones. Now measures itself, falls back to right-aligning to the input's right edge when a left-aligned popover would clip, with a final viewport-margin guard. Same logic on desktop — slightly more robust.
- **`7.6h` chip dropped.** Per Royce — SKS uses 8h as the standard day. Quick-select is now `[8, 4, 0]`.
- **"Fill Week" banner** in the mobile card body when Monday is filled and at least one of Tue–Fri is empty. Tap → calls the existing `fillTsWeekFromMon` (which already prompts before overwriting non-empty days). Sits at the top of the expanded card so it's the first thing you see after Mon is in.
- **Card-expansion state persists across re-renders.** `_tsExpandedCards` Set tracks which person cards the supervisor has opened. After Fill Week (which calls `renderTimesheets`), the card stays open instead of snapping back to collapsed.

Version stamps: `APP_VERSION = '3.4.83.1'`, SW cache `eq-field-v3.4.83.1`. The new cache key forces the SW to discard the v3.4.83 install — first phone load after deploy will hit network and pick up the fixed `timesheets.js` / `mobile.css`.

---

# v3.4.83 — Timesheets Phase 4a (supervisor phone view + roster bubble)

**Date:** 2026-05-23
**Branch flow:** `claude/hungry-thompson-648935` → `main` (squash). SKS ships straight to main now — no demo branch.
**Scope:** Supervisor Timesheets layout at ≤768px viewport. No schema, API, or data-path changes. Desktop view unchanged.

## Why this release

SKS NSW is a site-based business — supervisors often don't have a laptop at hand on Friday/Monday when timesheets are due. The previous desktop-table layout shipped in v3.4.79–v3.4.82 reads great on a screen but is unusable on a phone: the cells need ~124px each to fit Job + Hours + split + repeat, so 5–7 of them across forced horizontal scroll and made every input a fat-finger problem.

Apprentices and Labour Hire timesheets are the **source of truth for invoiced hours** for those groups — letting them lapse costs real money. Lowering the friction to update from a phone is the cleanest mitigation while job-numbers data hygiene catches up. (Direct employees still flow through Workbench externally — out of scope here.)

## What changed (≤768px only)

### `scripts/timesheets.js`

New phone-view branch at the top of `renderTimesheets()`:

```js
_hookTsResizeOnce();
if (_isPhoneViewport()) {
  _renderTimesheetsMobile({ ... });
  updateTsStats();
  return;
}
```

`_renderTimesheetsMobile()` produces a card-stack DOM (one card per person, days nested inside) using the **same** input `data-*` attributes and the **same** handlers (`onTsCellChange`, `_onComboboxInput`, `_showTsHoursChips`, `repeatDayAcrossTs`, `copyLastWeekTs`) the desktop table wires up. Identical data path — only the layout flips.

New helpers:

- `_isPhoneViewport()` — `window.innerWidth ≤ 768`.
- `_tsScheduleBubble(name, week, day)` — returns `{ html, isKnown, code }` for the read-only roster bubble. Reads `getPersonSchedule(name, week)[day]`, returns the cell verbatim wrapped in a `.sched-bubble`. **isKnown** = the cell (uppercase + trim) matches an active job's `site_name` — the bubble gets the 📍 icon. Otherwise free-text gets 📝. Leave/TAFE days return empty html — the parent renders the existing mute pill instead.
- `toggleTsCard(pid)` / `toggleTsDay(rid)` — collapse/expand handlers wired to inline `onclick`.
- `toggleMTsSplit(rid, btn)` — split-day toggle for the mobile DOM.
- `_hookTsResizeOnce()` — single idempotent resize listener; re-renders Timesheets when the viewport crosses the 768px breakpoint (rotation, dev-tools resize).

### `styles/mobile.css`

~280 lines under the existing `@media (max-width: 768px)` block. Highlights:

- `.ts-mcard` collapsible card with 4px coloured left-stripe carrying the same complete / partial / empty / on-leave signal as the desktop row stripe.
- Chevron rotation on card expand (`▸` → `▾`).
- `.ts-mday` collapsible day row inside the expanded card. **Filled days start collapsed** with a one-line summary (`D5384 — tap to edit`); empty days stay expanded. Muted (leave/TAFE) days are non-tappable.
- `.sched-bubble` + `.sched-bubble-freetext` styles for the read-only roster bubble.
- Inputs: 16px font (prevents iOS zoom-on-focus), 12px padding, 10px radius.
- Repeat-day, split, copy-last-wk affordances rebuilt in the mobile DOM (preserved from desktop).

`#page-timesheets .ts-table-scroll { display: none; }` belt-and-braces in case a stale desktop render is still in the DOM when the breakpoint is crossed.

### Roster bubble — what about messy roster cells?

The roster is occasionally filled with partner names ("with Lewis"), placeholders ("TBC"), or free text rather than clean site codes. The bubble copes:

- Cell matches a known site → 📍 styled bubble (data-site attribute holds the normalised value — used by Phase 4b).
- Cell is anything else → 📝 italic neutral bubble showing the cell verbatim.
- Cell is blank → no bubble.
- Cell is leave/TAFE → existing mute pill (unchanged from v3.4.79).

The supervisor's brain does the parsing — the app just surfaces what was already on the roster, in plain English.

## Out of scope (deferred to Phase 4b, v3.4.84+)

- **Tappable schedule bubble.** Designed and prototyped, held back until we've had a week of 4a in production. Plan: 📍 bubbles become tappable; 1 job at site → autofill the cell with that job + 8h; 2+ jobs → focused mini-picker filtered to that site; 0 jobs / 📝 free-text → no-op (no chevron). The risk that justifies the staged rollout is wrong autofill → wrong invoiced job if a job's `site_name` is mis-tagged — Phase 4a is read-only, so data-quality issues at most look confusing, never bill wrong.

## Mockup

A static HTML mockup of the proposed phone layout lives at `MOCKUP-v3.4.83-timesheets-phone.html` at repo root. Includes toggles for the 4a vs 4b bubble behaviours so reviewers can compare; safe to delete once the live build has stabilised.

## Version stamps

- `scripts/app-state.js` — `APP_VERSION = '3.4.83'`.
- `sw.js` — header + `CACHE = 'eq-field-v3.4.83'`.
- `index.html` — header comment block (new `CHANGES IN v3.4.83` entry prepended).
- Favicon cache-buster `var v` (line ~23) unchanged at `3.4.40` — no icon changes.

## Smoke test

Open Timesheets on a phone-sized viewport (≤768px wide — devtools responsive mode works):

1. Sidebar/topbar collapses to mobile nav (existing behaviour). Filter chip row + lock banner render unchanged.
2. The grid is gone — instead, a stack of person cards, all collapsed, ordered by group (Apprentice first, Labour Hire second).
3. Tap a person header → card expands, chevron rotates, 5 day rows appear. Filled days are collapsed (summary line); empty days are expanded.
4. Each workable day shows the schedule bubble — 📍 for clean sites, 📝 for free-text. Leave/TAFE days show the existing mute pill instead.
5. Type into a job/hours input → fires `onTsCellChange` → save toasts as on desktop. Hours quick-select chips still pop. Combobox autocomplete still works.
6. ↺ "last wk" copy, ↻ repeat day, ＋ split — all wired and tested in the mobile DOM.
7. Resize the window past 768px → page re-renders into the desktop table (and back) without a page reload.

## Deploy

SKS NSW Labour ships straight from `main` — no demo branch, no cross-repo deploy.

1. PR `claude/hungry-thompson-648935` → `main`, squash-merge.
2. Netlify auto-deploys `main` to `sks-nsw-labour.netlify.app`.
3. Hard-refresh on a phone (SW cache key changed, so first load will hit the network).

# v3.4.63 — Help tab rewrite (timesheet + leave coverage, tenant-aware URL)

**Date:** 2026-05-13
**Branch flow:** demo → main (squash)
**Scope:** Help tab content only. No schema, API, or backend changes.


## What changed

### Help tab (`index.html` ~lines 1898–1915)

**Employee Guide** — 3 cards → 4 cards:

1. **Logging In** — URL is now tenant-aware. The hardcoded `eq-solves-field.netlify.app` was wrong for SKS staff. The card now contains `<span id="help-app-url">` which `showHelpTab()` fills with the actual `location.hostname` on view. SKS staff see `sks-nsw-labour.netlify.app`; EQ demo staff see `eq-solves-field.netlify.app`.
2. **Checking Your Schedule** — unchanged.
3. **Entering Your Timesheet** *(NEW)* — week picker, Start/Finish entry, the 8h/40h red rule, save flow, Friday reminder note.
4. **Submitting Leave** — expanded from 3 steps to 5. Now covers approver email, status flow (Pending → Approved/Rejected), and Withdraw.

**Supervisor Guide** — 3 cards → 6 cards:

1. **Supervisor Login** — unchanged.
2. **Editing the Roster** — unchanged.
3. **Reviewing Timesheets** *(NEW)* — staff filter, red-cell meaning, Outstanding panel, link to Friday digest.
4. **Approving Leave** *(NEW)* — Review → Approve/Reject, Calendar/roster reflection, Archive, Resend email, Withdraw note.
5. **Friday Digest** *(NEW)* — opt-in path via Supervision card, 12:00 AEST send.
6. **Backup & Security** — unchanged.

### `showHelpTab()` (`index.html` ~line 2397)

Added a 4-line block inside `showHelpTab()` that stamps `location.hostname` into `#help-app-url` each time the tab is shown. Try/catch wrapped so a missing element fails quietly.

## Version stamps

Since v3.4.45 the sidebar version badge is derived from `APP_VERSION` at runtime, so the manual stamp surface has shrunk:

- `scripts/app-state.js` — `APP_VERSION = '3.4.63'`.
- `sw.js` — header comment + `CACHE = 'eq-field-v3.4.63'`.
- `index.html` — header comment block only (new `CHANGES IN v3.4.63` entry prepended).
- New `CHANGELOG-v3.4.63.md` at repo root.

Favicon cache-buster `var v` (index.html line ~23) was left at `3.4.39` upstream; only bump it when icons actually change, which this release doesn't.

## Why this release

Two holes:

1. The hardcoded `eq-solves-field.netlify.app` URL was wrong for SKS staff — they'd see a useless instruction.
2. The two biggest workflows (timesheets and leave) had only one card each, neither of which covered approval, withdrawal, or red-rule meaning. Royce flagged it for an update on 2026-05-13.

Calendar/Contacts coverage was deliberately scoped out of this pass — Royce asked specifically for Timesheets + Leave. Easy follow-up if needed.

## Deploy

Standard demo-first flow per CLAUDE.md:

1. Push `demo` → eq-solves-field rebuilds.
2. PR `demo` → `main`, squash-merge.
3. Sync `demo` with `main` via `git merge -X ours main`.
4. Hard-refresh both tenants (the SW auto-update toast still isn't shipped).

## Smoke test

- Open Help → Employee Guide → confirm "Logging In" shows the right hostname per tenant.
- Switch to Supervisor Guide → confirm 6 cards render and the new Timesheets / Leave / Digest copy is present.

## v3.4.39 — id-coercion sweep + EMAIL_FROM wired up

**Date:** 2026-04-27
**Branch flow:** demo → main
**Why:** v3.4.38 fixed the leave.js id-coercion bugs Royce reported. A whole-codebase sweep showed the same `r.id === X` pattern in three other files — same silent-failure class, just less visible because the affected features (Apprentices, Job Numbers, Journal) get less use on SKS than the leave list does. Closing the class now while the rule is fresh.

Plus a small env-var feature wired up: configurable `from:` address on outbound emails.

### Code changes

#### `scripts/apprentices.js` — 7 lookups coerced

All `find()` and `findIndex()` lookups in user-facing handlers now use `String(a) === String(b)`:

- Line 378 — `getCustomCompetencies` entry lookup
- Lines 744 + 2065 — `apprenticeProfiles` lookup by `req.apprentice_id`
- Line 1060 — `feedbackEntries` findIndex by `feedbackId`
- Line 1344 — `competencies` lookup by `entry.competency_id`
- Line 1802 — `feedbackRequests` lookup by `requestId`
- Line 2062 — `feedbackRequests` lookup by `reqId`

(Line 510 was already defensively coerced — left alone. Line 1568 already coerced.)

#### `scripts/jobnumbers.js` — 2 lookups coerced

- Line 127 — `editJobNumber` lookup
- Line 166 — duplicate-check lookup before save

#### `scripts/journal.js` — 1 lookup coerced

- Line 263 — `apprenticeJournal` findIndex on shared toggle

#### `netlify/functions/send-email.js` — EMAIL_FROM env var support

```js
// Before
from: 'Leave Request <noreply@eq.solutions>',

// After
from: process.env.EMAIL_FROM || 'Leave Request <noreply@eq.solutions>',
```

Each Netlify project can now set `EMAIL_FROM` independently. Falls back to the prior hardcoded value if unset, so existing behaviour preserved.

**Suggested values** (optional):
- `eq-solves-field`: `EMAIL_FROM='EQ Field <noreply@eq.solutions>'` (Royce already added EMAIL_FROM as an env var on demo earlier today — was previously dead, now active)
- `sks-nsw-labour`: leave unset to keep current behaviour, or set to e.g. `'SKS Labour Hire <noreply@eq.solutions>'`

Resend authorises by domain, not mailbox, so any address on the verified `eq.solutions` domain works.

### Verification

```bash
grep -rn "\\.id === [a-zA-Z]" scripts/ | grep -v "String("
```

Should return only `apprentices.js:510` (the defensive belt-and-braces line) and `auth.js:145` (DOM element string compare, not a bigint issue).

---

## v3.4.38 — Leave action lookups: id coercion fix (2026-04-27)

Royce reported on SKS prod that the Withdraw button "doesn't work" for older leave requests. Root cause: `leaveRequests.find(r => r.id === id)` uses strict equality without `String()` coercion — when Supabase returns `id` as a string (older rows on SKS) but the onclick handler passes a numeric literal, the comparison silently fails. `find` returns `undefined`, function returns at `if (!req) return;` with no toast. Same coercion rule that bit us through v3.4.21–v3.4.25.

**Fix:** six `find()` lookups in `leave.js` (lines 397, 447, 595, 612, 629, 715) all now use `String(r.id) === String(id)`. Affects Review, Approve/Reject submit, Archive, Restore, Withdraw, Resend Email.

---

---

## v3.4.37 — Lift eq/demo exclusion on token mint (2026-04-27)

After v3.4.36 the eq tenant (eq-solves-field) still couldn't send emails. Three places in `auth.js` had a `TENANT.ORG_SLUG !== 'eq' && TENANT.ORG_SLUG !== 'demo'` gate around the verify-pin token-mint call, dating back to when only SKS had a Netlify backend. Both tenants now have backends — the gate was obsolete.

**Fix:** removed the eq/demo exclusion in three places (gate login, restore-from-rawLocal, legacy `eq_remember_token` restore). All three flows now mint a session token unconditionally after a successful local check.

**Required env vars per project** — must match each tenant's Supabase `app_config` codes:

| Netlify project | STAFF_CODE | MANAGER_CODE |
|---|---|---|
| `sks-nsw-labour` | `2026` | `SKSNSW` |
| `eq-solves-field` | `demo` | `demo1234` |

---

---

## v3.4.36 — PIN auth simplified to plaintext env-var compare (2026-04-27)

Multi-hour debugging loop on 2026-04-27 traced "Email failed: Not authenticated" to a brittle salt+hash chain across two Netlify projects. Too many things had to align (salt env var name + value, hash env var name + value, hardcoded fallback) — any drift = silent 401. The hash layer was also security theatre for 4-char PINs (brute-forces in milliseconds even hashed, salt sat in same env vars anyway).

**Fix:** `verify-pin.js` now reads `process.env.STAFF_CODE` / `process.env.MANAGER_CODE` and does a plaintext `===` compare. Removed `hashCode()` function, hardcoded `STAFF_HASH`/`MANAGER_HASH` constants, and the override-env-var fallbacks. Returns 500 fail-loud if either env var missing. `EQ_SECRET_SALT` kept — still used for HMAC-signing session tokens (real security against token forgery).

`auth.js` demo block also now mints a server-side session token after local check, so demo can call `/netlify/functions/send-email`.

**Cruft env vars to delete on both Netlify projects after this lands:** `SECRET_SALT`, `STAFF_HASH`, `MANAGER_HASH`, `STAFF_HASH_OVERRIDE`, `MANAGER_HASH_OVERRIDE`. None are read by any code.

---

---

## v3.4.30 → v3.4.35 — not separately documented

_No per-version changelog files exist for these intermediate releases. Highlights from the original placeholder note:_

- v3.4.30 — favicon link tags injected via JS (race-fix)
- v3.4.31 — supervision unlock specific errors
- v3.4.32 / v3.4.33 — Clarity + PostHog wired on SKS prod
- v3.4.34 — demo digest panel keeps seed paint when no DB
- v3.4.35 — six PostHog custom events for Royce-on-leave visibility

---

## v3.4.29 — Digest panel bulletproofing + tenant 404 silencing (2026-04-26)

### Bug 1 — Digest opt-in checkboxes still re-appearing as ticked

v3.4.28 added a re-hydrate-before-render path via the `renderManagers` wrap. Royce reported it didn't fully fix the bug — unticks persisted to the DB but the UI still painted "all ticked" on Supervision page.

**Why the wrap pattern wasn't enough:** wrap fires when `renderManagers` is called from page-nav, but other code paths can call `renderDigestPanel()` directly (the function is exposed on `window`). Those direct calls skipped the hydrate, painted from STATE.managers (which doesn't carry `digest_opt_in`), and rendered everyone as ticked because `undefined !== false` reads as "on".

**Fix in v3.4.29:** make `renderDigestPanel` itself responsible for getting the truth. On every call:
1. Paint immediately from STATE (instant feedback, possibly stale).
2. Fire `sbFetch('managers?select=id,name,email,digest_opt_in&order=name.asc')` (~25ms).
3. Repaint from the fetch result, and sync STATE so `toggleDigest`'s optimistic update stays consistent.

Falls back to STATE-only render if the fetch fails (offline, migration absent on tenant).

### Bug 2 — Console 404 noise on SKS

SKS is a leaner tenant than EQ — it doesn't have the apprentice / feedback / skills-ratings / rotations / competencies / etc. tables. The frontend optimistically loads all `ORG_TABLES` and a few ad-hoc ones, hitting a postgrest 404 each time. ~10 red errors in DevTools on every page load. Cosmetic, but alarming.

**Fix:** new `TENANT_DISABLED_TABLES` map in `app-state.js`. `sbFetch` GET checks the active tenant's list and returns `[]` immediately — no fetch made, no 404 logged. Writes (POST/PATCH/DELETE) still hit the wire so a bug accidentally trying to insert into a disabled table fails loudly.

SKS's disabled list:
- `apprentice_profiles`, `apprentice_journal`
- `skills_ratings`, `competencies`, `sks_quotes_materials`, `checkins`
- `feedback_entries`, `feedback_requests`
- `rotations`, `buddy_checkins`, `quarterly_reviews`, `engagement_log`

EQ tenant gets the empty default — all tables enabled.

### Verification

- DB-truth check on SKS: `select count(*) filter (where digest_opt_in) as on, count(*) filter (where not digest_opt_in) as off from managers where org_id = sks_id;` → still 1 on / 14 off (Royce's earlier unticks). v3.4.29 should now paint that correctly on every render.
- Console: page load on SKS expected to show 0 red 404 lines for the table list above.

---

## v3.4.28 — Digest re-hydrate + tenant-aware favicon (2026-04-26)

Two follow-ups to v3.4.26 / v3.4.27:

### Bug 1 — Digest opt-in UI shows stale "all ticked" after navigation

**Symptom:** Untick a supervisor on the Supervision page → checkbox unticks → DB row updates correctly (`digest_opt_in = false`) → toast confirms. Navigate away and back → all checkboxes show ticked again, even though the DB still says `false`.

**Root cause:** The bulk `managers` fetch (in app-state) doesn't include the `digest_opt_in` column in its SELECT. `digest-settings.js` lazy-loads that column once on DOMContentLoaded via `hydrateDigestOptIns()`. After a navigation that re-fetches managers, those rows come back without the column → `m.digest_opt_in === undefined` → render path treats `undefined !== false` as "ticked".

**Fix:** `renderManagers` wrap now checks `STATE.managers.some(m => m.digest_opt_in === undefined)` before painting. If any row is missing the column, re-hydrate first, then render. Cheap query (id + boolean), runs ~25ms.

### Bug 2 — SKS-branded favicon serving on EQ demo

**Symptom:** `eq-solves-field.netlify.app` showed the SKS logo in the browser tab.

**Root cause:** Single repo, two Netlify sites. v3.4.26 replaced the icons in `/icons/` with SKS-branded versions; both sites pull from the same repo so both got the SKS icons.

**Fix:** Repo now has two icon sets:
- `/icons/` — SKS-branded (default, served as-is on `sks-nsw-labour.netlify.app`)
- `/icons-eq/` — EQ-branded (recovered from pre-v3.4.26 git history)

Inline `<script>` in `<head>` detects the hostname at boot. If hostname doesn't contain "sks", it rewrites every `<link rel*="icon">` href from `icons/` → `icons-eq/`. Runs synchronously, no flash.

Future tenants (anything that isn't SKS) inherit the EQ icons by default. If/when a third tenant ships, add a host check + a third `/icons-<tenant>/` folder.

### Verified

- DB after Royce's SKS unticks: 14/15 supervisors `digest_opt_in=false`, only Royce Milmlow `true`. PATCH path was always working — just the render path was lying.
- Live favicon md5 mismatch confirmed pre-fix: EQ demo and SKS prod both served the 2361-byte SKS-branded `favicon-32x32.png`. Post-fix should resolve to different bytes.

---

## v3.4.27 — IP wording simplification (2026-04-26)

Touch-up over v3.4.26. Verbose proprietary-licence copy was overkill for a footer line and a source-file header — replaced with "Property of EQ" everywhere.

### Changes

**Footer** — sidebar copyright block reduced to a single line: `Property of EQ`.

**Source headers** — every `scripts/*.js`, `sw.js`, `supabase/functions/*/index.ts` now carries:

```
/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
```

**LICENSE.md** — rewritten to a short statement.

### What didn't change

Legal weight is essentially the same — "Property of EQ" + "All rights reserved" is the foundational protection. The trust name (CDC Solutions Pty Ltd ATF Hexican Holdings Trust) can be reintroduced later if a specific licence agreement needs it.

---

## v3.4.26 — SKS go-live polish (2026-04-26)

Bundled fixes from the post-cutover review. None of these block SKS from operating but they're what Royce flagged after seeing v3.4.25 live.

---

### Database (already applied to SKS prod by Claude this session)

**Migration `sks_promote_part6_people_year_level`** — `ALTER TABLE public.people ADD COLUMN IF NOT EXISTS year_level smallint;` plus a backfill from existing `licence` text (`'1st Year'` → 1, `'2nd Year'` → 2, etc.). The original column was added on EQ demo by an early apprentice-profiles migration that never made it to SKS — without it, every `people` fetch with `year_level` in the select list 400'd with PGRST 42703 ("column does not exist"). Cascade was breaking the contacts grid on the Supervision page and the Add Person flow.

**Verification:**
```sql
-- col present, all 9 SKS apprentices backfilled with year_level 1..4
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='people' AND column_name='year_level';
SELECT count(*) FROM public.people WHERE org_id='1eb831f9-aeae-4e57-b49e-9681e8f51e15' AND year_level IS NOT NULL;
-- → 9 of 9
```

---

### Frontend (in workspace, awaiting demo→main merge)

#### `scripts/digest-settings.js` — Supervision digest opt-in checkbox no-op

Symptom: untick a supervisor's checkbox on the Supervision page → checkbox visually unticks → next render re-ticks it. Database never updated.

Root cause: same uuid-vs-bigint cluster as v3.4.22. SKS `managers.id` is `bigint` (number); the inline `onchange="toggleDigest('${m.id}', this.checked)"` template literal wraps the id in quotes so the handler receives a string `'17'`. Then `find(m => m.id === managerId)` strict-compares `17 === '17'` → false → handler bails silently. Optimistic UI update never happens, render replays from STATE.

Fix: `String()` coerce both sides in the find, and stringify keys in the bulk hydrate. EQ demo (uuid string ids) is unaffected either way; SKS is the one this rescues.

#### `scripts/timesheets.js` — Incomplete timesheets red highlight

New rule per Royce: **complete = every Mon–Fri ≥ 8 hrs AND week total ≥ 40 hrs**. Anything less → row red. Drops the prior amber middle state.

Behavioural changes:
- Hours are the source of truth, not job-cell presence. A row with job numbers entered but no hrs now reads as red until the hrs are filled in. (Old logic looked at `_job` cells only.)
- The Total column gains a new `.ts-total-red` class. CSS injected at module load for forward-compat with base.css.

#### `index.html` — Favicon, footer, copyright

- New SKS-branded favicons in `/icons/` (16, 32, 48, 192, 512, apple-touch-icon, multi-size .ico) — generated from `pub-97a4f025d993484e91b8f15a8c73084d.r2.dev/SKS_Logo_Colour_Arrows_Clean.png`, tight-cropped and padded to a square.
- Sidebar version stamp bumped to `v3.4.26`.
- Sidebar footer now carries a quiet copyright line: "© 2026 CDC Solutions Pty Ltd ATF Hexican Holdings Trust. All rights reserved. Proprietary & confidential — unauthorised use prohibited."

#### `LICENSE.md` — Proprietary licence

Full proprietary terms at repo root: ownership, confidentiality, no-licence-by-distribution, NSW jurisdiction. Names CDC Solutions Pty Ltd ATF Hexican Holdings Trust as Owner.

#### Source-file copyright headers

Single-line `/*! Copyright … */` stamp prepended to every `.js` in `scripts/`, the supervisor-digest edge function, and `sw.js`. Idempotent — won't double-stamp on re-run.

---

### Backend code — deployed this session

#### `supervisor-digest-v2` — Resend rate-limit throttle (DEPLOYED to SKS)

The 2026-04-26 dry-run probe surfaced Resend's 2/sec free-tier limit: 6 of 15 sends got 429'd because the loop fired fast. Adds a 600ms sleep between live sends (`firstLiveSend` skips the first delay, `dryRun` skips entirely). Configurable via env `DIGEST_SEND_INTERVAL_MS`.

**What actually shipped:** The MCP `deploy_edge_function` repeatedly 500'd when redeploying to the existing `supervisor-digest` slug (something stuck on that specific function — fresh function names deploy fine). So Claude deployed the new code as `supervisor-digest-v2` and re-pointed `app_config.digest_fn_url` to that endpoint. The cron pulls the URL from app_config every fire, so next Friday's run automatically uses v2.

**Verified live on SKS:**
- v2 endpoint dry-run: 200 OK, 15/15 SKS managers, ts 73/87 (84%), no errors.
- Cron command (re-run as a probe with the live `digest_fn_url`): 200 OK against v2 for both `sks` and `demo` orgs.

**EQ demo project still needs the same deploy** — Claude only had MCP access to the SKS Supabase project. Run on demo when convenient:

```bash
supabase functions deploy supervisor-digest --project-ref <eq-demo-project-ref>
```

(Or just dashboard-deploy the workspace `index.ts` to demo.)

---

### Smoke tests run this session

| # | Canary | Result |
|---|---|---|
| 0 | year_level migration | ✅ column present, 9/9 apprentices backfilled |
| 1 | Footer shows current version | ✅ live SKS shows v3.4.25 (will flip to v3.4.26 after merge) |
| 3 | People dedupe (no dupes in current data) | ✅ 0 duplicate names per org on SKS |
| 4 | Schedule dedupe (no dupes in current data) | ✅ 0 duplicate (name, week) rows; timesheets also clean |
| 5 | Multi-day leave structure | ✅ 4 active approved multi-day request

---

## EQ Field v3.4.21 — Leave: fix uuid id breaking inline handlers

**Released:** 2026-04-23
**Severity:** P1 — Review / Approve / Reject / Withdraw / Archive all silently
broken in the leave list since the SKS port (v3.4.8).

### What was broken

Clicking **Review** (or Resend / Withdraw / Archive / Restore) on a leave
request did nothing. No modal, no toast, no visible error. The console
showed three `Uncaught SyntaxError: Invalid or unexpected token` messages
at `(index):1` per pending row but they were dismissed as extension noise.

### Root cause

`scripts/leave.js` rendered each row's action buttons with raw template
interpolation:

```js
`<button onclick="openLeaveRespond(${r.id})">Review</button>`
```

In **SKS** (`leave_requests.id` is `bigint`) this produces valid JS:
`openLeaveRespond(123)`.

In **EQ Field** (`leave_requests.id` is `uuid`) this produces invalid JS:
`openLeaveRespond(a1b2c3d4-5e6f-7a8b-9c0d-…)`. The substring `5e6f` is
parsed as numeric-with-exponent, which then collides with the trailing
`f`/hex chars and throws `SyntaxError: Invalid or unexpected token`. The
inline handler is parsed lazily at click time, so the error fires on
click and the handler never runs — exactly matching the "nothing happens"
symptom.

The leave module was ported from SKS v3.4.5 in EQ Field v3.4.8 without
adapting for the uuid id type.

### Fixes

`scripts/leave.js`:

1. Quote `${r.id}` → `'${r.id}'` in all five inline onclick handlers in
   `renderLeaveList` (lines ~904-908): Review, Resend, Withdraw, Archive,
   Restore.
2. In `respondLeave` (line ~448), drop `parseInt()` on the modal's hidden
   id field — keep it as a string. Without this, Approve/Reject would
   silently fail with `id = NaN` after fix #1 lands.

`index.html`:

3. Bump version stamp to v3.4.21 (header comment + footer span).
4. Add this changelog block to the in-page CHANGES section.

### Verification

- Open demo, log in as a supervisor, open a Pending leave request → click
  Review → modal renders with requester / dates / type populated.
- Click Approve → status updates, toast confirms, modal closes, list
  refreshes.
- Click Reject without a note → red border + toast prompt for a reason.
- Click Reject with a note → status updates.
- Console clean of `Invalid or unexpected token` errors.

### Audit follow-up (recommended for v3.4.22)

Other modules likely have the same `${r.id}` pattern in inline handlers.
If their backing tables are uuid-keyed in EQ Field, the same bug applies.
Quick scan candidates: timesheets, jobnumbers, audit, journal, apprentices.
A grep for `onclick="[a-zA-Z]+\(\$\{[^}]*\.id\}` across `scripts/*.js`
will surface them. Worth a 30-min sweep before the next SKS promotion.

### Affects

- **EQ Field demo** — broken since v3.4.8 (2026-04-19).
- **SKS** — not affected (bigint id renders as valid number).

### Does not affect

- The Submit / Withdraw flow for end-users (their own request cards use
  a different path).
- Leave email notifications (separate code path).
- Schedule write-back (runs server-side after Approve, only after Approve
  works again).

---

---

## v3.4.25 — parseInt(uuid) cluster (audit follow-up N1)

**Date:** 2026-04-26
**Scope:** EQ Field demo (eq-solves-field.netlify.app). Closes the EQ-only
bulk-ops bug surfaced during the pre-merge audit (`AUDIT-REPORT-PR9-promotion.md`).

---

### Why

The pre-merge audit for the SKS promotion (PR #9) flagged an outstanding
`parseInt(<uuid string>)` cluster that the v3.4.22 sweep missed.

Eleven call sites across five files were calling `parseInt()` on values
that, on the EQ tenant, are uuid strings. `parseInt('5e6f-abc...')` returns
NaN, which silently broke every dependent operation:

- Bulk PIN ops on Contacts page never matched any rows.
- Batch fill from the schedule view selected 0 people.
- Apprentice self-assessment, feedback, recurring-feedback, training
  records, and rotation forms all loaded but couldn't find the profile.
- Staff timesheet gate (PIN login) couldn't look up the person.
- Journal entry submit couldn't find the apprentice profile.

SKS prod was unaffected because bigint ids parse cleanly through
`parseInt`. But the upcoming demo→main merge would have shipped this bug
to SKS in latent form (would fire the moment SKS migrated any table to
uuid PKs in future).

### What's in

#### `scripts/people.js`

- Bulk PIN ops (`applyBulkPin`, `clearBulkPin`): drop `parseInt(cb.dataset.id)`.
- Both downstream `STATE.people.find(x => x.id === person.id)` calls
  coerced to `String(x.id) === String(person.id)`.

#### `scripts/batch.js`

- `selectedIds = new Set(... .map(cb => parseInt(cb.value)))` becomes
  `new Set(... .map(cb => cb.value))`.
- Downstream `STATE.people.filter(p => selectedIds.has(p.id))` now uses
  `selectedIds.has(String(p.id))` so it works for both uuid and bigint.

#### `scripts/apprentices.js`

- Five `parseInt(document.getElementById('XX-apprentice-id').value)` reads
  drop the parseInt across `submitSelfAssessment`, `submitFeedback`,
  `submitRecurringFeedback`, `submitTrainingRecord`, `submitRotation`.
- Three `parseInt(editId)` call sites in profile save flow dropped.
- `apprenticeProfiles.find/findIndex(p => p.id === <id>)` String-coerced
  (lines 346, 374, 540, 813, 1126, 1211, 1521, 1567).
- `renderApprenticeProfile(parseInt(editId))` now passes editId raw.

#### `scripts/auth.js`

- `checkStaffTsLogin`: `personId = parseInt(sel.value)` becomes
  `personId = sel.value`. Downstream URL interpolation
  `people?id=eq.${personId}` works with string ids.

#### `scripts/journal.js`

- `submitJournalEntry`: drop `parseInt` on `jn-apprentice-id` read.
  `apprenticeProfiles.find` String-coerced.

#### `parseInt PRESERVED` where the value is genuinely an integer

- `parseInt(pinVal)` in `people.js:511` — PIN value, 4-digit integer.
- `parseInt(yearEl.value)` in `apprentices.js:188` — apprentice year 1–4.
- `parseInt(year)` in `apprentices.js:1507` — same.
- `parseInt(competencyId)` and `parseInt(ratingVal)` in
  `apprentices.js:1867–68` — competency id (integer in DB) and rating (1–5).

#### Version bumps

- `sw.js` cache + header → `v3.4.25`.
- `scripts/app-state.js` `APP_VERSION` → `'3.4.25'`.
- `index.html` header comment, new changelog block, footer span → v3.4.25.

### Verification (on demo)

1. Footer shows v3.4.25.
2. Open Contacts → click "Bulk PIN" → select multiple staff →
   apply a PIN → confirm rows update in Supabase (no silent no-op).
3. Open Schedule → click "Batch Fill" → select people + days +
   site → apply → confirm cells fill across the matrix.
4. Open Apprentices (BETA) → edit an apprentice profile → save →
   confirm changes persist.
5. Submit a self-assessment, feedback entry, journal entry → confirm
   each writes to Supabase without error.
6. Open the staff timesheet gate (`/staff-ts` flow if exposed) →
   PIN login should resolve the person and accept correct PIN.
7. No console errors on any of the above.

### Unblocks

PR #9 (demo→main) audit-finding N1 closed. Merge can proceed via the
audit's recommended R1–R6 resolutions plus the B1 (TAFE migration) +
B2 (`EQ_SECRET_SALT`) blockers.

---

## v3.4.23 — "What's new" banner (SKS upgrade comms)

**Date:** 2026-04-26
**Scope:** EQ Field demo (eq-solves-field.netlify.app). Ships immediately
before the demo→main promotion to SKS Labour prod so SKS users see a
"what's new" card on first load post-update.

---

### Why

SKS prod is currently on v3.4.9. The demo→main promotion (per
`PROMOTE-v3.4.9-to-v3.4.23-TO-SKS.md`) brings 12 releases of changes —
some of them user-visible in ways that will look unannounced if nobody
explains them (e.g. Friday digest emails arriving for the first time).
Field-team comms approach picked from the runbook Q5: in-app banner +
short email blast.

This release ships the in-app banner. The email is a separate text
artifact in the workspace folder for Royce to send via his preferred
channel.

### What's in

#### `scripts/whatsnew.js` (new)

- Renders a dismissible "What's new — v3.4.22" card into
  `#whatsnew-banner` at the top of the dashboard.
- Six highlights: Friday digest, birthdays/anniversaries, timesheet
  progress + reminders, leave-approver attribution fix, multi-day leave
  roster write, nav reshuffle.
- Once-per-user via `localStorage.setItem('eq.whatsnew.v3.4.22.seen', '1')`.
- Bump the key name when there's a comparable batch of features to
  surface in a future release.

#### `index.html`

- Empty `<div id="whatsnew-banner" style="display:none">` at the top of
  `page-dashboard`, just inside the `print-active` page wrapper.
- `<script src="scripts/whatsnew.js">` added after `digest-settings.js`.
- Header comment + footer span bumped to v3.4.23.

#### `sw.js` + `scripts/app-state.js`

- `sw.js` cache + header → `v3.4.23`. PRECACHE list adds
  `/scripts/whatsnew.js`.
- `APP_VERSION` → `'3.4.23'`.

### Verification (on demo)

1. Open eq-solves-field.netlify.app in an incognito window. Footer shows
   v3.4.23. The "What's new" card renders above the dashboard stats row.
2. Click "Got it" or the ✕ → card disappears. Reload → stays dismissed.
3. Open DevTools → Application → Local Storage → delete the
   `eq.whatsnew.v3.4.22.seen` key. Reload → card returns.
4. No console errors.

### Behaviour for SKS post-merge

When the SKS deploy lands at v3.4.23, every SKS user sees the card on
first load — regardless of whether they used the app since v3.4.9. The
card is one card, dismissible in one click, and never auto-shows again
unless we bump the localStorage key.

EQ demo users will also see it once. That's fine — they were the test
audience for these features and a quick "yes, this is the same stuff
you've been seeing on demo" reminder is harmless.

---

## v3.4.22 — SKS-promotion blockers: id handling

**Date:** 2026-04-26
**Scope:** EQ Field demo (eq-solves-field.netlify.app). Prerequisite for the
demo→main promotion (`PROMOTE-v3.4.9-to-v3.4.21-TO-SKS.md` — superseded by
`PROMOTE-v3.4.9-to-v3.4.22-TO-SKS.md` once written).

---

### Why

Two id-handling problems were found while writing the demo→main promotion runbook:

1. **`_isRealDbId` (scripts/supabase.js) was uuid-only since v3.4.13.** SKS
   uses `bigint` PKs. Running the demo branch as-is on SKS would have made
   `_isRealDbId(12345)` return `false`, treating every real row as a tempId.
   Every `_upsertById`, `saveCellToSB`, `saveRowToSB`, and batch rollup would
   have fallen through to `POST` — duplicating rows on every edit.

2. **Latent uuid-in-onclick bug** in `people.js` / `managers.js` / `sites.js`
   / `roster.js` — flagged in v3.4.21's changelog as deferred. On `eq` tenant
   these handlers receive uuid ids from the live Supabase (not SEED data)
   and the same `editPerson(${p.id})` raw interpolation that broke leave
   would silently break Edit/Remove on every Person/Manager/Site row.

Neither blocker manifests on demo today (demo SEED ids are integers; remove
buttons currently work because `parseInt` succeeds on integers) — but both
would fire on prod the moment the merge ships.

### What's in

#### `scripts/supabase.js` — `_isRealDbId` tenant-gated

```js
const _UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _BIGINT_RE = /^[1-9][0-9]{0,18}$/;
function _isRealDbId(id) {
  if (id === null || id === undefined) return false;
  const s = String(id);
  if (typeof TENANT !== 'undefined' && TENANT.ORG_SLUG === 'sks') {
    return _BIGINT_RE.test(s);
  }
  return _UUID_RE.test(s);
}
```

The `eq` demo SEED-id rejection (101..318 → fails uuid regex) is preserved
because the `sks` branch only fires on the SKS tenant.

#### `scripts/people.js`

- Two `editPerson(${p.id})` onclick sites quoted to `editPerson('${p.id}')`.
- Two `confirmRemove(parseInt(this.dataset.pid), …)` calls drop the
  `parseInt` (was producing NaN on uuid).
- Three `STATE.people.find(x => x.id === id)` / `=== parseInt(id)` calls
  coerced to `String(x.id) === String(id)`.

#### `scripts/managers.js`

- Two `openEditManager(${m.id})` onclick sites quoted.
- Two `confirmRemoveManager(parseInt(this.dataset.mid), …)` calls drop
  `parseInt`.
- `find()` in `openEditManager` and `saveManager` (existing-row check + the
  duplicate-name guard) coerced to `String()`.

#### `scripts/sites.js`

- One `openEditSite(${site.id})` onclick site quoted.
- One `confirmDeleteSite(parseInt(this.dataset.sid), …)` drops `parseInt`.
- `find()` in `openEditSite` and `saveSite` (existing-row check + the
  duplicate-abbr guard) coerced to `String()`.

#### `scripts/roster.js`

- One `editPerson(${p.id})` onclick site quoted (the per-row Edit icon in
  the editor view).

#### Version bumps

- `sw.js`: header comment + CACHE name → `v3.4.22`.
- `scripts/app-state.js`: `APP_VERSION` `'3.4.20'` → `'3.4.22'` (was lagging
  since v3.4.21 didn't touch app-state).
- `index.html`: header comment, new changelog block, footer span → v3.4.22.

### What's NOT in

- Any schema change. No migrations needed for v3.4.22.
- Any change to leave/dashboard/jobnumbers — those were closed in v3.4.21.

### Verification (on demo)

1. Footer shows `v3.4.22`.
2. Open Contacts (people) → click ✎ on any row → modal opens with that
   person's data. Save → row updates without duplicating.
3. Open Contacts → click ✕ → confirm dialog shows the right name → confirm →
   row removes.
4. Open Supervision (managers) → ✎ + ✕ same checks.
5. Open Sites → ✎ + ✕ same checks.
6. Open Roster → click ✎ next to a name in the editor → person modal opens.
7. No console errors on any of the above.

### Unblocks

The demo→main promotion can now proceed safely. SKS will receive working
PATCHes on edits (not duplicate inserts) and working Edit/Remove buttons on
Contacts/Supervision/Sites/Roster despite SKS having different id types.

---

## v3.4.21 — Leave: fix uuid id breaking inline handlers

**Released:** 2026-04-23
**Severity:** P1 — Review / Approve / Reject / Withdraw / Archive all silently
broken in the leave list since the SKS port (v3.4.8).

### What was broken

Clicking **Review** (or Resend / Withdraw / Archive / Restore) on a leave
request did nothing. No modal, no toast, no visible error. The console
showed three `Uncaught SyntaxError: Invalid or unexpected token` messages
at `(index):1` per pending row but they were dismissed as extension noise.

### Root cause

`scripts/leave.js` rendered each row's action buttons with raw template
interpolation:

```js
`<button onclick="openLeaveRespond(${r.id})">Review</button>`
```

In **SKS** (`leave_requests.id` is `bigint`) this produces valid JS:
`openLeaveRespond(123)`.

In **EQ Field** (`leave_requests.id` is `uuid`) this produces invalid JS:
`openLeaveRespond(a1b2c3d4-5e6f-7a8b-9c0d-…)`. The substring `5e6f` is
parsed as numeric-with-exponent, which then collides with the trailing
`f`/hex chars and throws `SyntaxError: Invalid or unexpected token`. The
inline handler is parsed lazily at click time, so the error fires on
click and the handler never runs — exactly matching the "nothing happens"
symptom.

The leave module was ported from SKS v3.4.5 in EQ Field v3.4.8 without
adapting for the uuid id type.

### Fixes

`scripts/leave.js`:

1. Quote `${r.id}` → `'${r.id}'` in all five inline onclick handlers in
   `renderLeaveList` (lines ~904-908): Review, Resend, Withdraw, Archive,
   Restore.
2. In `respondLeave` (line ~448), drop `parseInt()` on the modal's hidden
   id field — keep it as a string. Without this, Approve/Reject would
   silently fail with `id = NaN` after fix #1 lands.

`index.html`:

3. Bump version stamp to v3.4.21 (header comment + footer span).
4. Add this changelog block to the in-page CHANGES section.

### Verification

- Open demo, log in as a supervisor, open a Pending leave request → click
  Review → modal renders with requester / dates / type populated.
- Click Approve → status updates, toast confirms, modal closes, list
  refreshes.
- Click Reject without a note → red border + toast prompt for a reason.
- Click Reject with a note → status updates.
- Console clean of `Invalid or unexpected token` errors.

### Audit follow-up (recommended for v3.4.22)

Other modules likely have the same `${r.id}` pattern in inline handlers.
If their backing tables are uuid-keyed in EQ Field, the same bug applies.
Quick scan candidates: timesheets, jobnumbers, audit, journal, apprentices.
A grep for `onclick="[a-zA-Z]+\(\$\{[^}]*\.id\}` across `scripts/*.js`
will surface them. Worth a 30-min sweep before the next SKS promotion.

### Affects

- **EQ Field demo** — broken since v3.4.8 (2026-04-19).
- **SKS** — not affected (bigint id renders as valid number).

### Does not affect

- The Submit / Withdraw flow for end-users (their own request cards use
  a different path).
- Leave email notifications (separate code path).
- Schedule

---

## v3.4.18 — Timesheet Reminder Emails

**Date:** 2026-04-21
**Scope:** EQ Solves Field (demo tenant ready; SKS promotion gated by `PROMOTE-v3.4.16-18-TO-MAIN.md`)

---

### What's new

- **Per-row "Send reminder" button** on the timesheet pending popover
  (introduced in v3.4.17). Clicking it calls a new edge function that
  emails the person a "please complete your timesheet" nudge for the
  current week, pre-populated with which days are missing or partial.
- **Rate limit** — one reminder per `(org, person_name, week)` per
  `REMIND_COOLDOWN_HOURS` (default **12**). A second click during
  cooldown returns `{ ok: true, rateLimited: true, lastSentAt }` and
  the UI shows "Already reminded · last sent <time>". The button
  locks to `✓ Reminded` so supervisors see the state.
- **Audit trail** — every send (success *and* failure) is recorded
  in the new `ts_reminders_sent` table, with sender, recipient email,
  transport, and provider detail on failure.
- **Client-side gap surfacing** — if a person has no `email` on file
  the button is rendered disabled with a "No email" label, so the
  supervisor sees the missing data *before* clicking.
- **Audit log integration** — `auditLog()` writes a row for each
  send and each cooldown skip so the Supervision → Audit view
  shows reminder history alongside other timesheet actions.

### Schema change

New migration: `migrations/2026-04-21_ts_reminders_sent.sql`

```
public.ts_reminders_sent
  id            uuid pk
  org_id        uuid fk → organisations(id)
  person_name   text
  person_email  text               -- captured at send time
  week          text               -- 'dd.MM.yy' Monday key
  sent_by       text               -- supervisor display name
  sent_at       timestamptz
  transport     text               -- 'resend' | 'netlify'
  ok            boolean
  detail        text               -- provider response preview
```

RLS: enabled; anon/authenticated can `select` (so the client can
display "last reminded" timestamps later). Writes only happen via
the service-role edge function.

Applied to EQ demo Supabase (`ktmjmdzqrogauaevbktn`) on 2026-04-21.

### New edge function

`supabase/functions/ts-reminder/index.ts` — deployed to EQ demo.

- **Auth:** `verify_jwt = true`. The app front-end supplies the anon
  JWT; the function uses `SUPABASE_SERVICE_ROLE_KEY` for DB access.
- **Request body:** `{ orgSlug, personName, week, sentBy?, dryRun?,
  appOrigin? }`.
- **Transport:** reuses the `DIGEST_TRANSPORT` env convention from
  `supervisor-digest` — no new secrets needed. Defaults to Resend
  (`RESEND_API_KEY` + `DIGEST_FROM_EMAIL`). Netlify path supported
  via `NETLIFY_SEND_EMAIL_URL` + `EQ_DIGEST_SECRET`.
- **CORS:** permissive (`*`) for now; can be tightened to
  `eq-solves-field.netlify.app` / `sks-nsw-labour.netlify.app`
  when SKS is promoted.

### Files changed

- `migrations/2026-04-21_ts_reminders_sent.sql` — new.
- `supabase/functions/ts-reminder/index.ts` — new (285 lines).
- `scripts/app-state.js` — `APP_VERSION = '3.4.18'`.
- `scripts/timesheets.js` —
  - `sendTsReminder(personName, week, btn)` helper added. Handles
    demo-tenant short-circuit, email-on-file gate, cooldown
    response, audit logging.
  - `updateTsStats()` popover rows updated to render the per-row
    button (enabled/disabled based on `person.email`).
- `index.html` — header block gains a v3.4.18 entry; footer version
  stamp bumped.
- `sw.js` — cache bumped to `eq-field-v3.4.18`.

### Compatibility notes

- **Schema additive only** — no existing columns touched. Safe to
  deploy the migration before the JS changes go live.
- **Edge function is additive** — `supervisor-digest` is unchanged;
  both functions share transport env.
- **SKS not yet affected** — SKS prod `supervisor-digest` is still
  v3.4.9 (pending promotion), and `ts-reminder` has not been
  deployed to SKS. See `PROMOTE-v3.4.16-18-TO-MAIN.md`.
- **Cooldown default (12h)** can be overridden per-project via
  `REMIND_COOLDOWN_HOURS` env var.

### Verification checklist (demo)

- [ ] Apply migration on EQ demo — confirmed via MCP.
- [ ] Edge function deployed and ACTIVE on EQ demo — confirmed.
- [ ] `RESEND_API_KEY` + `DIGEST_FROM_EMAIL` (or Netlify pair)
      present in EQ demo project secrets.
- [ ] Open Timesheets on demo → click "N pending" → row shows
      `Send reminder` button for staff with emails, `No email`
      for those without.
- [ ] Click `Send reminder` → toast reads "✓ Reminder sent to
      <email>"; button locks to `✓ Sent`.
- [ ] Click again immediately → toast reads "Already reminded · last
      sent …"; button locks to `✓ Reminded`.
- [ ] Inspect `ts_reminders_sent` — one row per attempt with
      `ok = true`, correct `sent_by` (supervisor display name),
      correct `transport`.
- [ ] Delete the row (or wait 12h) → button works again.
- [ ] Supervision → Audit view shows "Sent timesheet reminder →
      <email>" entries against the week.
- [ ] Dry-run via `curl -X POST .../functions/v1/ts-reminder -d
      '{"orgSlug":"eq","personName":"Alex Mitchell","week":"20.04.26","dryRun":true}'`
      returns `{ ok: true, dryRun: true, preview: { subject, html, … } }`.

### Security notes

- Function requires a valid Supabase JWT (anon or user). The front
  end attaches `SB_KEY` (anon) so any app visitor could theoretically
  invoke it; the real check is that the person they target must
  belong to the same `org_id` resolved from `orgSlug`. Tightening
  step (future): cross-check the caller against `managers` before
  allowing a send — deferred until SKS promotion so we can confirm
  the caller identity plumbing on live tenants.
- No PII added to logs beyond what was already there
  (`person_email` is now persisted — note in `ts_reminders_sent`).

---

## v3.4.17 — Timesheet Completion Clarity

**Date:** 2026-04-21
**Scope:** EQ Solves Field (demo tenant ready; SKS promotion gated by `PROMOTE-v3.4.16-18-TO-MAIN.md`)

---

### What's new

- **Inline progress bar** above the timesheet grid — shows
  `X of Y complete (Z%)` for the current week with a colour-coded
  fill (red < 60, amber 60–99, green at 100).
- **"N pending" toggle** next to the bar. Clicking it expands a list
  of staff whose timesheets aren't complete for the selected week,
  tagged Partial vs No Data so supervisors can see at a glance where
  to chase.
- **Row tint + left border** on the timesheet grid are now aligned
  with the same day-based completeness rule the stat cards use:
  - Red tint + red left border when no `_job` cell is populated
  - Amber tint + amber left border when some but not all Mon–Fri cells
    are populated
  - Green left border (no tint) when Mon–Fri are all populated
  The previous tint keyed off hours (< 40h = amber) which disagreed
  with the Complete/Partial count above the grid.
- **Friday supervisor digest** — Section 4 now lists per-name missing
  day counts ("Alex Mitchell · 3 days missing") rather than a bare
  name list. The edge function change is backwards compatible — older
  callers passing `string[]` still render correctly.

### Files changed

- `scripts/app-state.js` — `APP_VERSION = '3.4.17'`.
- `scripts/timesheets.js` — row-tint logic rewritten to match stat
  cards; `updateTsStats()` now renders the progress bar into
  `#ts-progress-bar` and builds the pending-list popover;
  `_togglePendingPopover()` helper added.
- `index.html` — new `#ts-progress-bar` container above the existing
  completion tracker; v3.4.17 header block; footer version stamp.
- `supabase/functions/supervisor-digest/index.ts` — `missing` is
  emitted as `{ name, days }[]`; `buildDigestHtml` accepts either
  shape and appends the day count when present.
- `sw.js` — cache bumped to `eq-field-v3.4.17`.

### Compatibility notes

- No schema changes.
- Edge function deployment required to pick up per-day-count changes
  in the digest; the JS UI change takes effect on next page render.
- SKS prod supervisor-digest function is not yet deployed
  (v3.4.9 deploy tracked for demo only) — so this change doesn't
  affect SKS digests until the SKS promotion path runs.

### Verification checklist (demo)

- [ ] Open Timesheets → current-week progress bar visible, reads the
      correct count for `Apprentice + Labour Hire` staff
- [ ] Click "N pending" → popover lists names with Partial / No Data tag
- [ ] Populate one day for an empty staff member → row goes red → amber,
      border + tint update on next render
- [ ] Fill Mon–Fri → row shows green left border only, total reads green
- [ ] Dry-run supervisor-digest → HTML now lists "… · N days missing"
- [ ] sw.js cache invalidates on reload

---

## v3.4.16 — Birthdays + Work Anniversaries

**Date:** 2026-04-21
**Scope:** EQ Solves Field (demo tenant ready; SKS promotion gated by `PROMOTE-v3.4.16-18-TO-MAIN.md`)

---

### What's new

- Staff records now capture **Birthday (day + month)** and **Start Date**.
  Year of birth is deliberately **not** stored — day + month only.
- Dashboard gains a **Birthdays & Anniversaries — next 30 days** card,
  sorted by days-until. Today's events are tinted.
- Contacts list shows inline **🎂 Today** and **🎉 N yrs** chips on the
  matching day, in both desktop table and mobile card views.
- People CSV export / import round-trips `Birthday` (DD-MMM) and
  `StartDate` (YYYY-MM-DD) columns. Import accepts DD-MMM, DD/MM,
  D Mon, and 5-March style entries.

### Schema

New nullable columns on `public.people`:

| column       | type     | notes                                                  |
|--------------|----------|--------------------------------------------------------|
| `dob_day`    | smallint | 1..31, CHECK constrained                               |
| `dob_month`  | smallint | 1..12, CHECK constrained                               |
| `start_date` | date     | used for anniversary year delta                        |

Indexes:

- `people_dob_month_day_idx` (partial, month+day not null)
- `people_start_date_idx` (partial, start_date not null)

Migration file: `migrations/2026-04-21_people_dob_start_date.sql`.
Applied to EQ demo Supabase (`ktmjmdzqrogauaevbktn`) on 2026-04-21.
SKS prod (`nspbmirochztcjijmcrx`) apply deferred — see
`PROMOTE-v3.4.16-18-TO-MAIN.md`.

### Files changed

- `scripts/app-state.js` — `APP_VERSION = '3.4.16'`; SEED people rows
  enriched with `dob_day`, `dob_month`, `start_date` for demo visibility.
- `scripts/people.js` — new helpers (`personHasDob`, `_daysUntilMD`,
  `personBirthdayLabel`, `personIsBirthdayToday`,
  `personAnniversaryYearsToday`). `openAddPerson`, `editPerson`,
  `savePerson` now read/write the three new fields.
  `renderContacts` gains `todayBadges(p)` inline chips.
- `scripts/dashboard.js` — new `renderAnniversariesWidget()` invoked
  at the end of `renderDashboard`. Early-return paths also trigger
  the widget so an empty pending-leave list doesn't hide it.
- `scripts/import-export.js` — `_fmtCsvBirthday`, `_parseCsvBirthday`
  helpers; People + Contacts CSV export add Birthday + StartDate
  columns; import parses them when present (backwards compatible).
- `scripts/supabase.js` — `savePersonToSB` and `importPeopleToSB`
  pass the new columns.
- `index.html` — new form fields in the Person modal (Day / Month
  selects + date input); `loadFromSupabase` maps the new columns
  in both demo and live paths; new `#dashboard-anniversaries`
  container on the Dashboard page; v3.4.16 header block.
- `sw.js` — cache bumped to `eq-field-v3.4.16`.
- `migrations/2026-04-21_people_dob_start_date.sql` — new.

### Compatibility notes

- Legacy rows without DOB / start_date render normally — the chip
  helpers, widget, and CSV formatters all null-safe.
- Partial DOB entries (day without month or vice versa) are cleared
  on save so the widget never sees a half-populated date.
- SKS group alias (`SKS Direct` ↔ `Direct`) is untouched by this
  change; the new columns are plain passthroughs.
- Analytics stripping on SKS tenant (v3.4.14) continues to apply —
  no new telemetry introduced.

### Verification checklist (demo)

- [ ] Open Contacts → Add Person → new Birthday + Start Date fields visible
- [ ] Save a person with today's DOB → 🎂 Today chip appears immediately
- [ ] Dashboard shows "Birthdays & Anniversaries — next 30 days" card
- [ ] Export People CSV → Birthday and StartDate columns populated
- [ ] Re-import the same CSV → values round-trip cleanly
- [ ] sw.js cache invalidates on reload (hard refresh clears old card)

---

## v3.4.14 — Analytics scope: demo-only, SKS stripped

Housekeeping release to make the analytics scope explicit in code.
Decision 2026-04-20: PostHog + Clarity are scoped to the EQ Solves
DEMO site only (`eq-solves-field.netlify.app`). SKS prod is
deliberately NOT wired — putting session analytics on a live
labour-hire platform triggers APP 1/5/8 privacy obligations, NSW
industrial-relations considerations (apprentice-heavy workforce,
ETU/CFMEU coverage), and client-contract questions (Equinix /
Schneider supply-chain compliance). None of that pays back on a
stable tenant.

### Changes

- `scripts/analytics.js` — `_ANALYTICS_CONFIG` no longer carries
  the `sks` block. The SKS PostHog key and SKS Clarity ID
  (`wek8dmtbuu`) are parked in `KEYS_INVENTORY.md`, not referenced
  in shipped code, so they can't be revived by accident.
- `scripts/analytics.js` — fallback behaviour hardened. Previously
  any tenant slug not in the config silently fell back to the `eq`
  demo config, meaning the SKS hostname (if anyone navigated to
  it) would have posted events tagged `tenant: sks` against the
  demo PostHog project. Now: unknown slug → `_config = null` →
  init returns early with a console.info, PostHog + Clarity never
  load.
- `scripts/app-state.js` — `APP_VERSION = '3.4.14'`.
- `sw.js` — cache bumped to `eq-field-v3.4.14`.
- `index.html` — header banner + sidebar footer version updated.

### Not changed

- PostHog + Clarity still run on the demo site exactly as before.
- Event taxonomy unchanged. Call-site wiring unchanged.
- No schema, RLS, or CSP changes.

### If SKS prod ever gets revived

Before adding an `sks` block back:
1. Staff disclosure email sent + written consent captured
2. `tenant_settings.analytics_enabled` migration shipped (kill switch)
3. Prod PII-masking audit (rendered text, not just inputs)
4. PostHog billing cap set
5. Replay-deletion process documented
6. Clarity set to Strict mode (not Balanced) for SKS
(See conversation 2026-04-20 for full risk stack.)

---

## v3.4.13 — Schedule PATCH fix (integer SEED IDs)

Hotfix: silences the `invalid input syntax for type uuid: "306"`
400 flood that appeared in the browser console whenever the demo
tenant touched the schedule table.

### Root cause

All our primary keys (`schedule`, `people`, `sites`, `managers`) are
`uuid` in Postgres. `scripts/app-state.js` still seeds demo data with
integer IDs:

```js
STATE.schedule = SEED.schedule.map(r => ({ id: r.id || Math.random(), ... }));
// SEED.schedule rows are 101..118, 201..218, 301..318
```

Five save-path call sites guarded the PATCH-vs-POST branch with:

```js
if (entity.id && !String(entity.id).startsWith('temp')) { /* PATCH */ }
```

That guard happily lets `306` through. PostgREST then rejects the
URL `?id=eq.306` with a 400. 18 rows × every schedule interaction =
the console flood Royce screenshotted.

### Fix

- `scripts/supabase.js` — new `_isRealDbId()` helper. Returns `true`
  only when the value matches a real UUID (`^[0-9a-f]{8}-…$`).
  Rejects `null`, `undefined`, `temp_*` offline-mint IDs, and the
  integer SEED IDs.
- `scripts/supabase.js` — 3 call sites swapped to `_isRealDbId()`:
  - line 321 (`saveEntity` temp-ID branch)
  - line 376 (`sbUpsertSchedule` existing-row branch)
  - line 483 (`sbUpsertPeople` existing-row branch)
- `scripts/batch.js` — 2 call sites swapped to `_isRealDbId()`:
  - line 156 (`applyBatch` PATCH-or-POST branch)
  - line 269 (`savePromises` PATCH-or-POST branch)

Net effect: integer-ID rows now POST on first save (server mints a
real UUID, client state updated), then PATCH thereafter — same path
as a temp-ID row.

### Not changed

- No schema changes. No RLS changes. No event changes.
- Non-demo tenants (SKS) are unaffected — they never carried integer
  IDs in the first place.
- Analytics pipeline (v3.4.11/v3.4.12) unchanged.

### Verify after deploy

1. Hard-reload `https://eq-solves-field.netlify.app` in incognito.
2. Open the schedule view. Touch any schedule row (drag, assign,
   re-assign).
3. Console should show no `invalid input syntax for type uuid` 400s.
   First edit per row is a POST to `/schedule` (201); subsequent
   edits are PATCHes against the returned uuid.
4. Supabase `schedule` table — new rows should appear with proper
   uuid primary keys.

### Ops notes

- `sw.js` cache bumped to `eq-field-v3.4.13` so existing clients
  invalidate and pick up patched supabase.js + batch.js.
- `scripts/app-state.js` `APP_VERSION = '3.4.13'`.
- `index.html` — header banner + sidebar footer span updated.

---

## v3.4.12 — Clarity IDs live (Field demo + SKS prod)

Small, single-purpose release: replace the Clarity `REPLACE_ME`
placeholders in `scripts/analytics.js` with the real 10-char project
IDs. With these in, the Clarity snippet no longer no-ops and both the
demo and SKS sites now capture session replays + heatmaps in addition
to the PostHog event stream that went live in v3.4.11.

### Changes

- `scripts/analytics.js` — Clarity IDs wired:
  - `eq` (demo, `eq-solves-field.netlify.app`) → `wek7yeida5`
    (project `eq-field-demo`)
  - `sks` (prod, `sks-nsw-labour.netlify.app`) → `wek8dmtbuu`
    (project `eq-field-sks`)
- `sw.js` — cache bumped to `eq-field-v3.4.12` so existing clients
  invalidate and pick up the new `analytics.js`.
- `scripts/app-state.js` — `APP_VERSION = '3.4.12'`.
- `index.html` — version stamps in header comment + sidebar footer
  bumped.

### Keys inventory

All four Clarity project IDs are now recorded in
`Projects/eq-analytics-v2/eq-context/KEYS_INVENTORY.md`. The `eq-service`
and `eq-assets` IDs are held there until those two apps are wired in
follow-up releases.

### Verify after deploy

1. Hard-reload `https://eq-solves-field.netlify.app` in incognito.
   Console should show `[analytics] Clarity init running` (or, at
   minimum, no more `Clarity ID is a placeholder` info log).
2. Network tab → filter `clarity` → expect a GET to
   `https://www.clarity.ms/tag/wek7yeida5` and follow-up POSTs to
   `https://c.clarity.ms/...`.
3. Clarity dashboard → project `eq-field-demo` → the top-right
   "Waiting for first visit" banner should disappear within a few
   minutes. Session recordings appear ~5 minutes after a session ends.
   Heatmaps require ~100 sessions to render.

### Privacy reminder

Clarity is Balanced-mode masked (default) and our app additionally
stamps `data-clarity-mask="true"` on every PII-ish input (gate PIN,
staff TS PIN, person PIN, bulk PIN, site address, journal reflection).
Verify in a replay that those fields render as black boxes before
letting anyone outside EQ watch a recording.

---

## v3.4.11 — Analytics wire-up (PostHog EU + Microsoft Clarity)

Adds opt-in-able product analytics to EQ Field. PostHog for structured
events/funnels/cohorts; Clarity for session replay and heatmaps. Both
free tiers. Region: PostHog **EU Cloud** (`eu.i.posthog.com`) — PostHog
has no AU region; EU is the closest to Australia and data-sovereignty-
friendlier than US. Clarity is US-only.

Demo-only on this release. SKS production push is gated on Royce
sending the internal disclosure note.

### What's in

#### New files

- `scripts/analytics.js` — plain-JS IIFE loader. Hostname-keyed config
  (`eq` for demo, `sks` for prod) selects the right PostHog project key
  and Clarity ID. Exports `window.EQ_ANALYTICS` with an `init()`,
  `identify()`, `track()`, and an `events.*` namespace for named helpers.
- `scripts/analytics-TODO-hooks.md` — snippets for the five event hooks
  whose home scripts (`auth.js`, `timesheets.js`, `roster.js`) aren't on
  disk yet. Drop in when those files land.

#### Modified

- `index.html` — loads `scripts/analytics.js` after `app-state.js`.
  `initApp()` fires `session_started` once identity is resolved.
  Six inputs masked from session replay via `data-ph-no-capture` +
  `data-clarity-mask="true"`: gate PIN, staff TS PIN, person PIN, bulk
  PIN, site address, journal reflection.
- `scripts/leave.js` — fires `leave_request_submitted` on successful
  submit (includes `days_count`, `leave_type`, `has_note` flags).
- `scripts/people.js` — fires `people_modal_opened` (mode: add/edit) and
  `people_modal_saved` (includes `has_apprentice_year` flag).
- `scripts/import-export.js` — fires `csv_exported` for both exports,
  with `export_type` = `people` or `contacts[_<group>]`.
- `sw.js` — cache bumped to `eq-field-v3.4.11` and
  `/scripts/analytics.js` added to `PRECACHE` so analytics works
  offline.
- `scripts/app-state.js` — `APP_VERSION = '3.4.11'`.

### Events live on this release

| Event | Where it fires | Props |
|---|---|---|
| `session_started` | `initApp()` after identify | `app_env`, `tenant_slug`, `app_version` |
| `leave_request_submitted` | `_performLeaveSubmit()` | `days_count`, `leave_type`, `has_note` |
| `people_modal_opened` | `openAddPerson()` / `editPerson()` | `mode: 'add' \| 'edit'` |
| `people_modal_saved` | `savePerson()` | `has_apprentice_year` |
| `csv_exported` | `exportPeopleCSV()` / `exportContactsCSV()` | `export_type` |
| `error_thrown` | global `window.onerror` + `unhandledrejection` | `message`, `source`, `line` |

### Events still pending (see `scripts/analytics-TODO-hooks.md`)

- `pin_login_succeeded` / `pin_login_failed` — in `auth.js` (file not
  present on demo branch yet)
- `timesheet_viewed` / `timesheet_entry_created` — in `timesheets.js`
  (file not present on demo branch yet)
- `roster_viewed` — in `roster.js` (file not present yet)

Precached in `sw.js` so they load once the home scripts land.

### Privacy and masking

- PostHog `person_profiles: 'identified_only'` — no anonymous profiles
  get created. Identity is set in `initApp()` using the same user handle
  the app already has.
- Session replay is on but masks (a) all inputs with
  `data-ph-no-capture` / `data-clarity-mask="true"`, (b) all `<input>`,
  `<textarea>`, `<select>` contents by default (PostHog's `mask_all_inputs`
  is the default), and (c) all text with `data-private="true"`.
- Per-tenant opt-out wiring is in the plan (`tenant_settings.analytics_enabled`
  Supabase column) but the migration isn't in this release — it lands
  with the SKS prod push.

### Keys

- PostHog EU `eq-development` — embedded in `scripts/analytics.js`
  (public, safe to ship in a frontend bundle).
- PostHog EU `eq-production` — embedded for hostname `sks-nsw-labour.*`.
- Clarity IDs — placeholders; init is guarded and no-ops until filled
  in. Next step is creating four Clarity projects.

Inventory lives in `Projects/eq-analytics-v2/eq-context/KEYS_INVENTORY.md`.

### How to verify after deploy

1. Open `https://eq-solves-field.netlify.app` with DevTools → Network.
   Filter for `posthog`. You should see a POST to
   `https://eu.i.posthog.com/e/` within seconds of page load.
2. In PostHog EU → project `eq-development` → **Activity** → **Live
   events**. You should see `$pageview` and `session_started` within ~30s.
3. Submit a leave request / open the Add Person modal / export a CSV and
   watch the matching events arrive.
4. Wait ~60s then check PostHog → **Replay**. Should see the session.
5. Clarity: skipped until IDs are in.

### Rollback

Netlify → Deploys → pick the v3.4.10 deploy → **Publish deploy**.
Or revert the commit and push.

---

## v3.4.10 — Apprentice year: contacts as source of truth (demo drop)

**Release date:** 2026-04-19
**Branch:** `demo` (eq-solves-field.netlify.app)
**Tag line:** Pick a year when you add the apprentice — the rest of the app
just knows.

---

### What shipped

A small but load-bearing fix to how apprentice year flows through EQ Field.
Before this drop, the **Add Person** modal in v3.4.6 already exposed a year
dropdown when the group was Apprentice — but it only wrote to
`people.licence` (free text like `"2nd Year"`). The **Apprentices** page,
however, reads `people.year_level` (int 1..4). That mismatch let the two
fields drift, and we caught two of five EQ-demo apprentices with the wrong
year on the Apprentices page.

v3.4.10 closes the loop. Contacts is now the source of truth for apprentice
year, the Apprentices page reads it cleanly, and a year badge on the
Contacts page makes the value visible at a glance.

#### 1. Add Person now writes both columns

`scripts/people.js#savePerson` now derives `year_level` (int 1..4) from the
`Licence` text whenever the group is Apprentice, and writes it alongside
`licence` on both insert and update. Existing UI is unchanged — the v3.4.6
year dropdown still shows for Apprentice and replaces the free-text Licence
field exactly as before. The PATCH/POST payload just gets one extra column.

#### 2. Year badge on the Contacts page

A compact 🎓 badge ("1st Yr" / "2nd Yr" / "3rd Yr" / "4th Yr") appears
next to the group pill on Apprentice rows in the Contacts list — desktop
table and mobile cards both. Same colour-coded palette as the TAFE-day
badge, sits to the right of the group badge and to the left of TAFE day so
the row reads:

> `[Apprentice] [🎓 2nd Yr] [TAFE: Wed]   Indigo White`

Implementation lives in `scripts/people.js` as two helpers:
`yearFromLicence()` (used on save) and `contactsYearBadge()` (used on
render). Year resolves from `people.year_level` first, then falls back to
parsing `people.licence` for legacy rows that haven't been re-saved yet.

#### 3. Apprentices page reads contacts directly

`scripts/apprentices.js` now selects `year_level, licence` from `people`
when it builds the `uuidToName` lookup, and falls back to parsing the
licence string when `year_level` is null. That fallback means the
Apprentices page renders the right year even before the backfill SQL has
been run.

The fallback also shields against the case where someone edits the
`apprentice_profiles.year_level` directly via a modal but the `people` row
isn't refreshed — the contacts year still shows as the resolved value.

#### 4. EQ demo data backfill (already applied)

Two of five apprentices on EQ demo had `people.year_level` out of sync with
`people.licence`:

| Name | licence | year_level (before) |
|---|---|---|
| Indigo White | 3rd Year | 1 |
| Kai Martin | 1st Year | 3 |

Backfill ran on EQ demo (`ktmjmdzqrogauaevbktn`) immediately, taking
`licence` as authoritative since it's what the Add Person UI has been
writing since v3.4.6. SKS prod will need the same backfill when this drop
promotes — same SQL, swap the project ref:

```sql
UPDATE public.people
SET year_level = CASE
  WHEN licence ~* '^1st\s+Year' THEN 1
  WHEN licence ~* '^2nd\s+Year' THEN 2
  WHEN licence ~* '^3rd\s+Year' THEN 3
  WHEN licence ~* '^4th\s+Year' THEN 4
  ELSE year_level
END
WHERE "group" = 'Apprentice'
  AND licence ~* '^[1-4](st|nd|rd|th)\s+Year';
```

---

### Database

No new migrations. Both columns already exist on `public.people`:
`licence text` (since v3.4.0) and `year_level int` (since the apprentice
profiles work).

---

#### 5. Year column on People + Contacts CSV export

`scripts/import-export.js#exportPeopleCSV` and `exportContactsCSV` now emit
a **`Year`** column between `Group` and `Phone`. Value is the resolved
apprentice year (1..4) for Apprentice rows, blank for everyone else. Same
resolution rule as the badge — `year_level` first, fall back to parsing
`licence`. Header order:

```
Name,Group,Year,Phone,Email,Licence,Agency
```

CSV import is unchanged — the new `Year` column is ignored on round-trip
import for backward compatibility (the year still derives from Licence on
import, then `savePerson` writes year_level on the next edit).

---

### File changes

* **Edited:** `scripts/people.js` — `yearFromLicence()` + `contactsYearBadge()` helpers, year-level write on save, year-pill render in `renderContacts()` (desktop table + mobile cards)
* **Edited:** `scripts/apprentices.js` — select `year_level, licence` from `people`, fallback parse, `uuidToYear` lookup feeds `_resolvedYear` on each apprentice profile
* **Edited:** `scripts/import-export.js` — `_resolveApprenticeYear()` helper, `Year` column added to People + Contacts CSV exports
* **Edited:** `index.html` — header changelog block + footer version stamp → v3.4.10
* **Edited:** `scripts/app-state.js` — `APP_VERSION` → `3.4.10`
* **Edited:** `sw.js` — comment + `CACHE` → `eq-field-v3.4.10`
* **New:** `CHANGELOG-v3.4.10.md` (this file)

---

### Not in this drop

* **Backfill SQL on SKS prod** — not run yet. Wait until v3.4.10 promotes
  to `nspbmirochztcjijmcrx`, then run the same UPDATE as above.
* **Audit log entry on year change** — `savePerson()` doesn't currently
  log the year_level change separately from the rest of the person update.
  Acceptable for now since contacts edits already write a person-level
  audit row.
* **Migration to drop `apprentice_profiles.year_level`** — not done. The
  apprentice profiles table still has its own `year_level` column. The
  Apprentices page now prefers the `people` value via `_resolvedYear`, but
  the profile column remains as a safety net. Cleanup deferred until we're
  confident contacts is fully authoritative across both apps.

---

---

## v3.4.9 — Supervisor Digest (demo drop)

**Release date:** 2026-04-19
**Branch:** `demo` (eq-solves-field.netlify.app)
**Tag line:** Friday lunchtime, every supervisor knows where their week is going.

---

### What shipped

A scheduled email digest that lands in every opted-in supervisor's inbox at
**12:00 AEST every Friday**. Each digest is personalised to the recipient and
covers four things: leave next week, pending requests waiting on them,
unrostered staff, and timesheet completion for the week just ending.

This is the first piece of EQ Field that runs on a Supabase Edge Function and
pg_cron rather than a user-triggered Netlify call. Same Supabase DB, same
RLS — just driven by a service-role schedule instead of a session.

#### 1. Friday 12:00 AEST cadence

`pg_cron` job `supervisor-digest-weekly` fires at `0 2 * * 5` UTC, which is
Friday 12:00 AEST in winter and 13:00 AEDT during daylight saving. Royce
picked Friday lunchtime so supervisors have the afternoon to review pending
requests and chase missing timesheets before the week closes.

Manual trigger for testing:

```sql
SELECT public.trigger_supervisor_digest(true);   -- dry run
SELECT public.trigger_supervisor_digest(false);  -- send for real
```

#### 2. Per-supervisor opt-in

`managers.digest_opt_in` (boolean, default **true**) controls who receives.
The migration sets every existing supervisor to opted-in. Supervisors can
opt out from the **Supervision page** — there's a new "📧 Weekly supervisor
digest" panel above the contacts list with a checkbox per supervisor with an
email on file. Tick toggles `digest_opt_in` immediately via the same
`sbFetch()` PATCH the rest of the app uses.

Opt-out also works from SQL for ops convenience:

```sql
UPDATE managers SET digest_opt_in = false WHERE name = 'Demo Supervisor';
```

#### 3. Section 1 — On leave next week

Approved `leave_requests` whose date range overlaps next Mon–Sun
(`date_start <= nextSunday AND date_end >= nextMonday`, `status = 'Approved'`,
not archived). Empty state shows "Nobody approved off next week. 🎉" so
nobody mistakes the message for a delivery failure.

#### 4. Section 2 — Pending your approval

Pending `leave_requests` filtered by `approver_name = <recipient>`. The
subject line bumps these to the front: when there's at least one pending,
the subject becomes **"Weekly digest · N pending for you · Mon DD MMM"**
to flag inbox-skim attention. Otherwise it's the plain weekly subject.

#### 5. Section 3 — Unrostered next week

Active people (`people` with `deleted_at IS NULL`) whose name doesn't appear
on a `schedule` row for next week, OR who appears but every Mon–Sun cell is
blank or a leave/education code (RDO, A/L, TAFE, etc.). Defensible
definition of "unrostered" — covers both "missing from the roster" and
"present but unscheduled".

#### 6. Section 4 — Timesheet completion this week

For the week just ending: counts every rostered cell in `schedule`
(non-blank, not a leave/education code) as one expected timesheet day. For
each expected day, checks the matching `timesheets` row's same-day `hrs`
column for `> 0`. Percentage with green/amber/red bar, plus a list of
people still to submit. Returns *"No rostered days this week — nothing to
measure"* on empty weeks rather than an awkward 0%.

#### 7. Two email transports — Resend or Netlify

Edge function reads `DIGEST_TRANSPORT` env:

* `resend` (default): direct call to Resend API. Cleanest for the demo
  drop — no Netlify dependency. Requires `RESEND_API_KEY` and
  `DIGEST_FROM_EMAIL`.
* `netlify`: posts to the existing `/.netlify/functions/send-email` with a
  shared-secret header `x-eq-digest-secret`. Reuses the live SKS sender
  setup, but the Netlify function needs a one-line update on its end to
  accept the secret as an alternative to the `x-eq-token` session check.

Default is `resend` so the demo can ship end-to-end without touching
Netlify. SKS prod can switch to `netlify` once Royce updates `send-email`.

#### 8. Multi-tenant safe

The function loops every active row in `organisations` and runs them
independently. A bad row in one org doesn't block the others. `orgSlug`
parameter on the manual POST scopes a single org for testing
(`{"dryRun":true,"orgSlug":"eq"}`).

#### 9. Defensive UI fallback

`scripts/digest-settings.js` checks for the `digest_opt_in` column at runtime.
If the migration hasn't been applied yet, every supervisor is treated as
opted-in (default state) and toast errors are surfaced cleanly when toggle
PATCHes fail. The zip can be uploaded before the SQL is run without
breaking the page.

---

### Database

Two new migrations:

`migrations/2026-04-19_managers_digest_opt_in.sql`

* `ALTER TABLE managers ADD COLUMN digest_opt_in boolean NOT NULL DEFAULT true`
* Partial index `managers_org_digest_idx` on opted-in non-deleted rows
* Two supporting indexes on `leave_requests` for the digest's status and
  date-range scans

`migrations/2026-04-19_digest_cron_schedule.sql`

* Enables `pg_cron` and `pg_net` if not already on
* Idempotently re-creates `supervisor-digest-weekly` cron entry
* Creates `public.trigger_supervisor_digest(p_dry_run boolean)` for manual
  runs from the SQL editor

**Pre-apply on EQ demo Supabase (`ktmjmdzqrogauaevbktn`):**

```sql
-- Confirm pg_cron and pg_net are available
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');

-- Confirm managers table has rows we want to subscribe by default
SELECT count(*) FROM managers WHERE deleted_at IS NULL AND email IS NOT NULL;
```

Apply order:

1. Deploy edge function (`supabase functions deploy supervisor-digest`)
2. Set function secrets (`RESEND_API_KEY`, optional `APP_ORIGIN`)
3. Insert the two `app_config` rows the cron job reads:
   * `digest_fn_url` — `https://ktmjmdzqrogauaevbktn.supabase.co/functions/v1/supervisor-digest`
   * `digest_fn_token` — service-role JWT
4. Apply both migrations

---

### File changes

* **New:** `supabase/functions/supervisor-digest/index.ts` (~340 lines) — Deno edge function
* **New:** `supabase/functions/supervisor-digest/deno.json`
* **New:** `supabase/functions/supervisor-digest/README.md`
* **New:** `migrations/2026-04-19_managers_digest_opt_in.sql`
* **New:** `migrations/2026-04-19_digest_cron_schedule.sql`
* **New:** `scripts/digest-settings.js` (~125 lines) — opt-in toggle UI
* **New:** `CHANGELOG-v3.4.9.md` (this file)
* **Edited:** `index.html` — `<script src="scripts/digest-settings.js">`, header comment + footer version stamp → v3.4.9
* **Edited:** `scripts/app-state.js` — `APP_VERSION` → `3.4.9`
* **Edited:** `sw.js` — comment + `CACHE` → `eq-field-v3.4.9`, `digest-settings.js` added to PRECACHE

---

### Not in this drop

* No SKS prod promotion. EQ demo runs the digest for two cycles before SKS
  picks it up. When promoted, the same migrations and edge function deploy
  to `nspbmirochztcjijmcrx` — content stays identical, only the project ref
  changes.
* The Netlify `send-email` function does not yet accept the
  `x-eq-digest-secret` shared-secret header. Default transport is Resend so
  this isn't blocking. If Royce wants to switch to Netlify, that function
  needs a single-line check added (separate change).
* Digest opt-in toggles are write-through to Supabase but there is no audit
  log entry for them. If we want this to count toward the audit trail, add
  an `audit_log` insert in `digest-settings.js#toggleDigest`.
* No HTML preview button on the Supervision page yet — for now a dry run
  via `SELECT public.trigger_supervisor_digest(true);` is the testing
  surface. A "Preview my digest" button could come in the next drop.
* Daylight saving: cron runs in UTC, so the digest lands at 12:00 AEST in
  winter and 13:00 AEDT in summer. Accepted trade-off — `pg_cron` doesn't
  do timezone-aware scheduling.

---

---

## v3.4.8 — Leave Module (demo drop)

**Release date:** 2026-04-19
**Branch:** `demo` (eq-solves-field.netlify.app)
**Tag line:** Leave requests you can trust to reach the right person.

---

### What shipped

The leave module is now fully functional on EQ Field demo. Previously the modals and the Leave tab were present in the UI but had no JavaScript behind them — submitting a request did nothing. The working implementation is ported from SKS v3.4.5, where these behaviours have been running in production.

#### 1. Leave requests actually work

`scripts/leave.js` is now shipped with EQ Field. Every button on the Leave tab does what it says: submit, approve, reject, withdraw, resend email, archive, restore, print, filter, search, calendar view. Both staff (`STATE.people`) and supervisors (`STATE.managers`) can submit their own requests.

#### 2. Supervisor selection is required

Submitting without picking an approver now red-highlights the select, scrolls to it, focuses it, and shows a toast:

> ⚠ Choose your supervisor — they need to approve this request

The approver dropdown filters out the person submitting, so you can't pick yourself. This was the most common cause of orphaned requests on SKS before the v3.4.5 hotfix.

The approver field copy is clearer too — label reads **"Your Supervisor *"** with a helper line: *"📧 Your approval email will be sent to this supervisor — the request is not flagged to anyone without a selection."*

#### 3. Rejection requires a reason

Rejecting a request with an empty response note now red-highlights the note field and shows:

> ⚠ Add a reason when rejecting — the requester will see this

The requester sees the reason in their rejection email and in the list view.

#### 4. Backdated-leave confirmation

Submitting a request with a start date before today now opens a confirm modal:

> This leave starts on YYYY-MM-DD, which is in the past. Continue submitting a backdated request?

Prevents accidental submits when the date picker was left on a stale value.

#### 5. Withdraw a pending request

New **Withdrawn** status (neutral grey chip). Withdraw button is visible to the requester themselves or to any supervisor while the request is still Pending. Uses the standard confirm modal so a stray tap on a phone won't nuke the request.

Bulk archive of resolved requests now includes Withdrawn alongside Approved/Rejected, so withdrawn requests don't linger.

#### 6. Submission receipt

New `submit_confirmation` email type. Requesters get a receipt email the moment they submit, including who needs to approve it. Silent-fail: if the requester has no email on file, it skips without a toast (the approver email is the critical one).

#### 7. CC supervisors on status emails

Approval and rejection emails now CC the same supervisor CC list that was already CC'd on new requests. The whole chain sees the outcome, not just the requester.

#### 8. Status emails fall through to managers list

If the person submitting leave is a supervisor (in `STATE.managers`) rather than regular staff (in `STATE.people`), the status-update email now still lands — previously it looked only in `STATE.people` and silently dropped the notification.

#### 9. Quick-add supervisors to CC config

The Email Notification CC List modal now has a **Quick-add from Supervisors** chip strip above the manual CC list. Chips render from `STATE.managers` with emails, toggle on/off with a visible ✓/+ state, and stay in sync with the manual list.

#### 10. Email CTA URLs follow the current deploy

Email CTA links now use `${window.location.origin}` so preview/branch deploys link back to themselves instead of the hard-coded production host.

---

### Database

New migration: `migrations/2026-04-19_leave_requests_approver_required.sql`

Makes `leave_requests.approver_name` `NOT NULL` with a `CHECK (approver_name <> '')` constraint. Defense-in-depth — the UI now enforces it, this stops anyone hitting the API directly from inserting an orphaned request.

**Pre-check before applying to EQ demo Supabase (`ktmjmdzqrogauaevbktn`):**

```sql
SELECT COUNT(*) FROM leave_requests
WHERE approver_name IS NULL OR approver_name = '';
-- must return 0 before applying
```

If the count is 0, apply the migration. If it's non-zero, backfill the offenders first.

---

### File changes

- **New:** `scripts/leave.js` (996 lines) — full leave module implementation
- **New:** `CHANGELOG-v3.4.8.md` (this file)
- **New:** `migrations/2026-04-19_leave_requests_approver_required.sql`
- **Edited:** `index.html` — approver label + helper text, `#leave-cc-supervisors` container added to CC modal, header comment + footer version stamp → v3.4.8
- **Edited:** `scripts/app-state.js` — `APP_VERSION` → `3.4.8`
- **Edited:** `sw.js` — comment + `CACHE` → `eq-field-v3.4.8`

---

### Not in this drop

- SKS v3.4.5 shipped the same leave improvements as a *hotfix* to an existing module. On EQ Field this is a first-shipment — the leave module has never been live here before. Expect at least one follow-up pass once real demo users poke at it.
- The leave page doesn't yet include an archive-toggle button in the EQ Field header strip. The underlying function (`toggleShowArchived`) is present and guarded against a missing button, so adding the button in a later drop will turn the feature on without any JS changes.

---

## CHANGELOG — EQ Solves Field v3.4.7

**Released:** 18 April 2026
**Branch:** `demo` (pilot — SKS promotion path via `PROMOTE-APPRENTICES-TO-MAIN.md`)
**Live URL:** https://eq-solves-field.netlify.app
**Apprentice module version:** v2.3 (Tier 2 drop)

---

### What's new

This is the **Tier 2 apprentice drop**. Three features that shift the apprentice module from "manager reviews apprentice" to "apprentice drives their own development" — while keeping the supportive / low-admin tone that makes the module the EQ differentiator.

#### 3E — Apprentices can edit their own goals

Apprentices logged in via staff PIN can now tap "Edit My Goals" on their own Overview and update their three development goals (Technical / Professional / Personal) without needing a supervisor to unlock. Year level, start date, site and notes stay supervisor-managed — those fields appear dimmed in the edit modal for apprentices.

Every goal edit stamps `goals_updated_at` and `goals_updated_by` on the profile, and a subtle "Last edited by X on DATE" line renders under the goals grid so there's a visible audit trail without looking like a bureaucracy.

#### 3F — Ask for Feedback (email flow)

Apprentices can now proactively request feedback from a supervisor. New **💬 Ask for Feedback** button on self-view Overview. Flow:

1. Apprentice picks a supervisor from the list (sourced from `managers`).
2. Optional prompt suggestions (e.g. *"What should I focus on this quarter?"*) with free-text override.
3. Tapping Send Request:
   - Inserts a row in `feedback_requests`
   - Fires an HTML email via `/.netlify/functions/send-email` (Resend) with a brand-gradient header and a deep link `?request=<id>`.
4. Supervisor opens the deep link → app auto-opens the apprentice's profile → feedback form opens with a purple "Requested by X" banner showing the prompt.
5. Submitting the feedback stamps `completed_at` and `feedback_entry_id` on the request.

Supervisors also see a new **Apprentices asking for your feedback** card at the top of the apprentice list (shown above the Check-in card) with all open asks addressed to them. Tap opens the feedback form with the request bound.

Apprentice's own Overview shows a "You've asked for feedback" card listing outstanding requests so they can see what's still pending.

#### 3G — Journal (private reflection, apprentice-initiated)

New **📓 Journal** tab on the apprentice profile. Apprentice-initiated only — no weekly reminder cards, no streaks, no nagging. The app only shows the journal; the apprentice decides whether/when to use it.

Features:
- Rotating prompts across four axes (Technical / Professional / Personal / Open) matching the goal axes. A new rotation each day-of-year, plus manual axis buttons.
- **Another** / **Skip** buttons on every prompt so nothing feels prescriptive.
- Entries are **private by default**. Per-entry checkbox to "Share with your supervisor" — can be toggled on/off after the fact from the entry card.
- Manager view only sees entries where `shared=true`. Apprentice always sees their full journal.
- Delete is owner-only.

Stored in a new `apprentice_journal` table with a CHECK constraint that only allows `prompt_key` in `['tech','prof','personal','open']`.

---

### Files changed

```
index.html                      (v3.4.7 header + footer; journal.js include; 2 new modals; fb-request-id hidden; deep-link init)
sw.js                           (CACHE = 'eq-field-v3.4.7'; apprentices.js + journal.js added to PRECACHE)
scripts/app-state.js            (APP_VERSION = '3.4.7')
scripts/apprentices.js          (v2.3 — canEditThisProfile gate, audit stamp, Ask for Feedback flow, inbound asks card, Journal tab hook)
scripts/journal.js              (NEW — v1.0 — journal module)
```

---

### DB migrations (already applied on demo Supabase `ktmjmdzqrogauaevbktn`)

1. `apprentice_profiles` — added `goals_updated_at TIMESTAMPTZ` and `goals_updated_by TEXT`.
2. New table `feedback_requests` — UUID PK, org_id FK, apprentice_id FK, requested_by, requested_of, requested_of_email, prompt, created_at, completed_at, feedback_entry_id (FK → feedback_entries), declined_at, declined_note. Indexes on apprentice and org. RLS enabled with permissive policy (matches rest of the tenant).
3. New table `apprentice_journal` — UUID PK, org_id FK, apprentice_id FK, entry_date DATE, prompt_key TEXT (CHECK in allowed set), prompt_text, reflection (CHECK non-empty), shared BOOLEAN, created_at, updated_at.

These migrations **must be re-applied to the SKS production project (`nspbmirochztcjijmcrx`)** before any of this JS can ship to main. See `PROMOTE-APPRENTICES-TO-MAIN.md`.

---

### Testing notes

Phone-testable flows:

1. **3E self-edit goals**
   - Log in as an apprentice via staff PIN (staff code).
   - Open own profile → tap **Edit My Goals**.
   - Confirm: year/start/site/notes are visible but greyed out; only the three goal fields and suggestion dropdowns are interactive.
   - Save → audit line appears under goals showing your name + today's date.
   - Log in as supervisor → open same profile → audit line still visible.

2. **3F ask for feedback (end-to-end)**
   - Log in as apprentice → open own profile → **💬 Ask for Feedback**.
   - Pick a supervisor, add a prompt like "What should I work on next quarter?" → Send.
   - Confirm toast "Sent ✓ — email on its way" (or "Request sent ✓" if the supervisor has no email on file).
   - Supervisor receives email → opens link on phone → app should auto-open the apprentice's profile and the feedback form with a purple "Requested by X" banner showing the prompt.
   - Fill feedback, submit → confirm `completed_at` stamped in Supabase.
   - Back on apprentice list (supervisor view): inbound asks card should now be gone for this one.

3. **3G journal**
   - Log in as apprentice → open own profile → **📓 Journal** tab.
   - Tap **+ New Entry** → confirm a random prompt appears with axis icon + colour.
   - Tap **🔄 Another** → prompt rotates within the same axis.
   - Tap **Skip — write freely** → prompt box collapses to "Free space".
   - Write something → leave share checkbox OFF → Save.
   - Confirm entry appears with 🔒 Private tag.
   - Tap **Share with supervisor** → tag flips to 👁 Shared + green.
   - Log in as supervisor → open same profile → Journal tab shows only the shared entry, no controls.

---

### Known considerations

- **Email delivery**: the Resend stack on `demo` is already wired (same one `leave.js` uses for leave request notifications). Failure is non-fatal — the `feedback_requests` row is still created and surfaces in the in-app inbox.
- **Deep link & service worker**: the SW is network-first for HTML/JS/CSS (v3.3.7 change), so deploying v3.4.7 will pick up on phones immediately without manual cache-clear.
- **Tier 3 (deferred)**: journal entry editing (current: delete + recreate), prompt library extension via Supabase, per-org prompt catalogue, weekly digest of unresolved asks for supervisors.

---

### Links

- Plan doc for next phase: `PROMOTE-APPRENTICES-TO-MAIN.md`
- Demo Supabase project: `ktmjmdzqrogauaevbktn`
- SKS Supabase project (pending migration): `nspbmirochztcjijmcrx`

---

---

## v3.4.6 — Apprentices v2.2 (demo drop)

**Release date:** 2026-04-18
**Branch:** `demo` (eq-solves-field.netlify.app)
**Tag line:** Fewer blank pages. More "that's me."

---

### What shipped

One bugfix + four improvements that make the apprentice module faster to use and more personal. Every change reduces the "blank page" problem — suggestions, presets, per-apprentice custom skills — so the form stops being admin and starts feeling supportive.

#### 1. Passport period bug fix

Test scenario uncovered it: apprentice submits a Q2 2026 self rating, the **At a Glance** card updates (5.0 / 5), but the **Skills Passport** Self column stays "—".

Root cause: `renderSkillsPassportTab` was defaulting to the **highest-ranked period** (`periods[periods.length - 1]`). Test data had Q3 2026 tradesman ratings seeded. Q3 ranked higher, so the passport showed Q3 by default — and Q3 had no self rating, hence the dash.

Fix: prefer the **current quarter** if it has any data for this apprentice. Fall back to the highest-ranked period only when the current quarter is empty. Future-dated test rows no longer hide live ratings.

#### 2. Add Person — year dropdown for apprentices

When **Group = Apprentice**, the Licence field swaps to a **Year** dropdown (1st / 2nd / 3rd / 4th). When Group is Direct or Labour Hire, it's the free-text Licence field as before. Supports both new and existing apprentices (edit form pre-fills the current year).

Implementation is HTML-driven — no data migration, no change to the `licence` column (Year just lives there as a string like `"2nd Year"`).

#### 3. Goal presets by year — Technical / Professional / Personal

Apprentice profile modal now has a **"Pick an example…"** dropdown above each goal textarea. Options are year-appropriate:

- **1st Year Tech:** *"Learn to bend conduit accurately"*, *"Terminate power and data cables confidently"*, …
- **4th Year Professional:** *"Sit my capstone / final exam with confidence"*, *"Prepare a tradesman-level CV"*, …

Selecting a suggestion fills the textarea (they can still edit or wipe it). "✏️ Type my own" just focuses the field. Dropdowns refresh when the **Year Level** select changes.

Prompts are light-touch and realistic — not prescriptive. Designed to break the blank-page problem without boxing anyone in.

#### 4. Feedback form presets

All four text fields on the **Give Feedback** modal now have a preset-suggestion dropdown:

- **✅ What they did well:** *"Stayed calm under pressure"*, *"Helped a team-mate without being asked"*, …
- **⏭ Trust them next with:** *"Running a small pre-start on their own"*, *"Testing + tagging a circuit under sign-off"*, …
- **🔧 Needs to improve:** *"Tool housekeeping at day end"*, *"Asking for help before going too far wrong"*, …
- **📌 Follow-up:** *"Book a 10-min 1:1 on next site visit"*, *"Pair them with a 3rd year for a week"*, …

Same pattern as goal presets — pick, edit, or "type my own". Supervisors on site can knock out a feedback entry in 20 seconds instead of staring at four empty boxes.

#### 5. Custom skills per apprentice

New **"+ Custom skill"** button on the Skills Passport (manager-only). Prompts for a name, adds it to the passport for that apprentice only — doesn't pollute the global competency catalog or show on anyone else's passport.

Custom skills appear inline with standard competencies, marked with a ✨ custom tag. Fully integrated:

- **Self-rating modal** — apprentice can rate custom skills the same way as standard ones.
- **Tradesman rating modal** — supervisor rates the same skill.
- **Gap column** — calculated the same way.
- **At a Glance** — custom ratings included in averages.
- **Remove** — ✕ button removes the skill and its ratings.

Custom ratings don't show in the "How you've grown" sparkline *unless* the skill has 2+ periods of self ratings — same rule as standard skills.

**Storage:** per-apprentice JSON on `apprentice_profiles` (`custom_competencies` + `custom_ratings`). No FK, no global catalog changes, no tenant spillover.

---

### Files changed

```
index.html                   — version bump + changelog block + year-slot markup + suggestion-dropdown markup
sw.js                        — version bump + CACHE key bump
scripts/app-state.js         — APP_VERSION bump
scripts/people.js            — refreshPersonLicenceField + onPersonGroupChange
scripts/apprentices.js       — v2.1 → v2.2 (period fix, goal presets, feedback presets, custom skills)
```

All four JS files pass `node -c`.

---

### Supabase (demo only — ktmjmdzqrogauaevbktn)

Applied in this session:

```sql
ALTER TABLE apprentice_profiles
  ADD COLUMN IF NOT EXISTS custom_competencies JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS custom_ratings JSONB DEFAULT '{}'::jsonb;
```

**Not yet applied on SKS production** (`nspbmirochztcjijmcrx`). When these features merge to `main`, run the same migration on SKS first or the custom-skill PATCH calls will 400 on the missing columns.

The v3.4.5 `feedback_entries` resolved_* columns are also still demo-only — both migrations need to run on SKS before any of this ships to main.

---

### Upload checklist (demo branch)

1. Unzip `eq-field-demo-v3.4.6.zip`.
2. Upload each file to its matching path on `eq-solutions/eq-field-app`, branch `demo`:
   - `index.html`
   - `sw.js`
   - `scripts/app-state.js`
   - `scripts/apprentices.js`
   - `scripts/people.js`
3. Netlify auto-deploys to `eq-solves-field.netlify.app`.
4. Hard-refresh (Ctrl+Shift+R) to bust the service worker cache.

---

### Not in this drop

- No PDF passport export (still "keep it simple").
- No apprentice-set-their-own-goals (apprentice can edit, manager still creates).
- No feedback-request email flow.
- No journal/reflection prompts.
- No FKs or per-org competencies (Tier 3 — custom skills live per-apprentice on purpose).
- No weekly roster email (separate main-branch candidate).

---

---

## v3.4.5 — Apprentices v2.1 (demo drop)

**Release date:** 2026-04-18
**Branch:** `demo` (eq-solves-field.netlify.app)
**Tag line:** Supportive, not administrative.

---

### What shipped

Three apprentice-module improvements plus a small bugfix, all bundled as one demo drop. Nothing added to the admin load — every new card reduces friction or surfaces what needs a human conversation.

#### 1. Growth view on Skills Passport (B)

Positive-framed QoQ sparkline under the passport grid. For each competency the apprentice has rated 2+ times in the last 4 quarters, shows:

- A row label (competency name).
- A tiny SVG dot strip — last 4 periods, position = score, colour = rating tier.
- A delta chip — `+1.0` when things are going up (green), `−0.5` soft amber when dipping (not red).

Header copy: *"How you've grown"* with a one-liner like *"You've gained ground in 3 areas across this window

---
