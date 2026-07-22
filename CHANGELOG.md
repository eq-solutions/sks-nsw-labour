# EQ Solves Field — Changelog

# v3.10.103 — Leave: make the email-approval confirm step unmissable

**Date:** 2026-07-22
**Scope:** `scripts/leave.js`, `netlify/functions/approve-leave.js`

A supervisor approving/rejecting leave from their email clicks the link, lands on a confirmation page, and must click a second button before anything is actually applied — deliberate, so email security scanners (Gmail, Outlook SafeLinks) that auto-follow links via GET can't silently auto-approve requests. The email itself undersold this: it said "One-click action" with a plain "✓ Approve" button, so a supervisor clicking through reasonably assumed they were done. Found live — 3 leave requests sat Pending with `responded_by`/`responded_at` both null despite the approver believing he'd actioned them.

- Email copy changed: "One-click action" → "Review below, then confirm"; buttons relabelled "Review & Approve" / "Review & Reject"; added a line noting the link opens a confirmation page.
- Confirm page: title/headline changed from "Approve leave" (reads as already-done) to "Confirm approval"; added a loud "⚠ Not yet approved — tap the button below to confirm" banner directly above the confirm button, reusing the existing warning-banner style already used elsewhere on this page.
- No change to the GET/POST split, token verification, or any state-changing logic — copy/UX only.

# v3.10.102 — Safety: Incidents wired into Safety Report + mobile fix

**Date:** 2026-07-22
**Scope:** `scripts/safety-dashboard.js`, `scripts/safety.js`

- Safety Report (manager-only dashboard) now includes Incidents: a stat card (submitted count + high-severity/draft sub-line), an "Incidents / near misses — by person" table, and a 3-way Prestart/Toolbox/Incident split in the per-site coverage bars + legend.
- Fixed a mobile CSS gap from the Incidents tab build: `#modal-incident`, `#modal-incident-sig`, and `#incident-form-body` were missing from `_injectSafetyStyle()`'s `@media(max-width:640px)` rule, so on phones the Incident modal wasn't going full-screen, its inputs weren't getting the 16px iOS-anti-zoom fix, and its two-column fields weren't collapsing to one column — Prestart/Toolbox already had this, Incidents didn't. Also added `flex-wrap` to the "copy from last visit" banner so it stacks instead of squeezing on narrow screens.

# v3.10.101 — Safety: Prestart copy-from-last-visit + Duplicate

**Date:** 2026-07-22
**Scope:** `scripts/safety.js`

Two ways to skip re-typing a prestart's boilerplate (hazards, SWMS refs, HRCW/permit categories, scope, crew) on a site worked recently — no schema change, both reuse the existing draft object.

- **Copy from last visit**: opening a New prestart and picking a site that has a submitted prestart within the last 7 days shows an inline "Copy from last visit — [date]?" prompt. Copy pulls scope/hazards/SWMS/HRCW/permits/crew across (crew signatures cleared — each day still needs its own sign-off); Dismiss hides it for this draft.
- **Duplicate**: a "Duplicate" button on any saved prestart clones it into a fresh draft for today (date/time reset, status back to draft, signatures + photos cleared) — for when the site wasn't caught by the 7-day window or you're duplicating same-day.

# v3.10.100 — Safety: Incident / Near Miss reporting

**Date:** 2026-07-22
**Scope:** `scripts/safety.js`, `scripts/app-state.js`, `index.html`, Supabase (`incidents` table)

New 4th tab in the Safety module, alongside Prestart / Toolbox / Records: report an Incident, Near Miss, or Hazard Observation from site.

- New `incidents` table (Supabase), same shape/RLS/offline-queue pattern as `prestarts`/`toolbox_talks`.
- Form: type (Incident/Near Miss/Hazard Observation), severity (Low/Medium/High), site, date/time, reported by, description + immediate action (voice input), people involved/witnesses with individual sign-off (reuses the existing crew signature pad), photos.
- Draft/submit workflow, offline queue + replay-on-reconnect, delete with two-tap confirm — identical UX to Prestart/Toolbox.
- Word (.docx) export per record, same SKS-branded template kit as Prestart/Toolbox.
- Wired into the Records tab: filter pill, ZIP batch export, search — alongside Prestarts/Toolboxes.
- Submitting a High-severity incident (or any non-near-miss Incident) emails every manager with an address on file — fire-and-forget, never blocks the submit.

# v3.10.99 — Mobile My Schedule: show Saturday/Sunday when rostered

**Date:** 2026-07-21
**Scope:** `scripts/roster.js`, `scripts/home.js`

Mobile "My Schedule" day cards were hardcoded to Mon–Fri, so anyone rostered to work a weekend (labour hire crews, weekend shutdowns) had that day silently missing from their own schedule view — even though the underlying `schedule` table and the desktop roster grid already carry Sat/Sun data.

- `renderSchedule()` (roster.js) now builds its day list from `getVisibleRosterDays()` — the same "only show Sat/Sun if the week actually has weekend work" rule the desktop roster grid already uses — instead of a hardcoded 5-day array. Date/day-offset math fixed to key off each day's fixed Mon=0..Sun=6 offset rather than array position, so a week with Sunday-only work (no Saturday) still lines up with the correct calendar date.
- Home screen ("Next shift" pill, shift count, supervisor "Schedule" tile subtitle) updated the same way, so a weekend-only shift isn't missed as the "next shift" or excluded from the weekly shift count.

No schema or data changes — this is display-logic only, reading fields (`sat`, `sun`) that were already being written.

# v3.10.98 — Nav: hide Pipeline / Resources

**Date:** 2026-07-15
**Scope:** `index.html`

Hides the "Pipeline" nav section (Pipeline + Resources buttons) from the desktop sidebar and the mobile drawer for everyone, including managers — previously visible to any manager-mode user via the `edit-only` class. Pages, data, and the underlying `scripts/pipeline*.js` are untouched; this only removes the nav entry points (no other links into these pages exist). Reversible by removing the added `display:none` styles.

# v3.10.97 — Timesheets total double-count + invisible mobile Roster header

**Date:** 2026-07-15
**Scope:** `scripts/timesheets.js`, `styles/mobile.css`

Two unrelated fixes bundled in the same unreleased version:

**Timesheets: A/L day + a stale entry no longer double-counts the total.** Fixes a reported maths bug where a person's weekly total read higher than the visible cells (Jack Trusler, wk 13.07.26: row showed 43h then 52h for what should be 44h).
- **Root cause.** A day's *leave* status comes from the **roster** (`schedule` table), while its *hours* come from the **timesheet**. When a day is marked A/L on the roster, the cell renders as a read-only 🌴 pill that **hides** any timesheet entry saved against it — but the total kept counting those hidden hours *and* added the paid-leave 8h, counting the same day twice. A stale entry lands there when a "Fill Week" writes a job across Mon–Fri and the day is set to A/L afterwards. TAFE days already guarded this (v3.10.84); paid leave never did.
- **Fix.** New `_tsWorkedHrs(name, week, entry)` sums worked hours but skips any roster-leave day (its stored hours are stale and hidden), leaving the fixed 8h paid-leave contribution to stand alone. Routed through the row total, the apprentice total, the in-place cell-save update, and the CSV-export "Total Hrs". A leave cell is read-only so typed hours are always stale — the opposite of a TAFE cell, which is editable and lets a typed job win.
- **Data.** Cleared the one stale entry in the DB (Jack's Fri 26184/8 behind an A/L) so the per-day CSV/payroll exports don't show it as a worked Friday. It was the only such occurrence across all weeks.

**Weekly Roster: invisible header row on mobile.** The `Name` / day-of-week header cells were unreadable (white-on-near-white) below 768px.
- **Root cause.** The base table style (`thead tr { color: white }`) sets white header text for the navy desktop header. Mobile's sticky-header CSS re-backgrounds `th.name-col` and `th.center` to a light `--surface-2` (so the header stays visible while scrolling) but never reset the inherited white text colour — same white text landed on a near-white background.
- **Fix.** Added `color: var(--navy)` to both mobile sticky-header rules. Desktop (>768px) is untouched — verified the header still renders white-on-navy there; only the mobile sticky cells changed.

# v3.10.96 — Login: supervisors no longer drop to view-only after a reload

**Date:** 2026-07-12
**Scope:** `scripts/auth.js`, `index.html`

Fixes the reported bug where logging in as a supervisor flashed a "logout" and came back **view-only**, every time.

- **Root cause.** Supervisor status was held in a *one-shot* sessionStorage flag (`eq_auto_admin`) that `initApp()` read once and then deleted. The "you're logged in" flag (`eq_access_v1`) is durable across reloads; the supervisor flag was not. Any same-tab reload — most often the service-worker auto-reload that fires on every deploy — re-ran `initApp()` with the flag already consumed, so it fell through to view-only. `checkAccess()` also early-returned on `eq_access_v1` *before* the durable "remember me" restore, so even a remembered supervisor login was bypassed on reload. Staff never noticed (they're view-only anyway), so it looked account-specific to supervisors.
- **Durable role (Option 1).** Role is now written to a durable `eq_role` key at every login path (tenant-code gate, demo, production verify-pin, shell-token SSO, both remember-me restores) and read by `initApp()` on **every** boot — so supervisor status survives a reload. The old `eq_auto_admin` flag is kept only to fire the login-moment UX (welcome toast + jump to the dashboard), never the role. "Switch to view only" and mid-session unlock both update `eq_role`, so that choice also survives a reload; logout clears it. Back-compat: sessions already open across the upgrade still resolve correctly from the legacy flag.
- **Calmer update reload (Option 3).** The SW-activated reload no longer fires the instant a new build lands (which is what made the flip visible on every deploy). It now defers to a non-disruptive moment — the moment the tab is backgrounded, or the first safe moment while foreground (never mid-edit, mid-type, or with queued writes) — with a 5-minute hard cap so a busy tab still updates.

# v3.10.95 — Resilience hardening: sbFetchAll fails loud + degrade alert + bootstrap smoke test

**Date:** 2026-07-12
**Scope:** `scripts/supabase.js`, `index.html`, pipeline/timesheets loaders, `scripts/smoke/`, `.github/workflows/smoke.yml`

Three prevention layers on top of the v3.10.93 resilience work, so the v3.10.90–92 outage class can't recur silently:

- **`sbFetchAll` now fails loud.** Dropped the silent `orderBy = orderBy || 'id'` default that 400'd on id-less tables (`team_members`/`timesheet_locks`) and caused the outage. Every caller must now pass an explicit `orderBy` (or have `order=` in the path); a missing ordering throws with a pointed message instead of guessing a column that may not exist. All callers that relied on the default now pass `'id'` explicitly.
- **Degrade alert.** The v3.10.93 `sync_degraded` PostHog event only helps if someone watches PostHog. `_emitSyncHealth` now also fires a throttled (one per device per day) best-effort email to the ops list on a real degrade transition, so a silent multi-day outage can't recur. sks tenant only; self-guarded, never throws into the sync path.
- **Bootstrap smoke test (scaffold).** `scripts/smoke/bootstrap-smoke.mjs` hits every table `loadFromSupabase()` reads, the way the app reads it, and fails on any non-2xx — plus a guard asserting `team_members`/`timesheet_locks` still 400 on `order=id` (so a revert to the old default is caught). Runs on push to `main` via `.github/workflows/smoke.yml` — the first CI this repo has.

# v3.10.94 — Timesheets: hours-missing flag + weekend auto-show + Sunday week-rollover fix

**Date:** 2026-07-12
**Scope:** `scripts/timesheets.js`, `styles/base.css`, `index.html`, `scripts/auth.js`

Three timesheet/roster UX fixes:

- **Hours-missing flag (the phantom "8").** The hours box used `placeholder="8"`, so an empty cell showed a greyed 8 that read as filled — people entered job numbers and left hours blank without noticing. Now, whenever a job is entered but the hours box is blank, the box turns red with a `?` placeholder (empty days with no job stay quiet). Empty boxes elsewhere show `hrs`/`h` instead of a fake `8`. Live-toggles via `_tsHrsMissing`/`_tsToggleHrsFlag` in `onTsCellChange` (typing, blur, quick-hours chip, split clear) across both the desktop table and the mobile card view. Nothing auto-writes hours — invoiced time stays human-entered.
- **Weekend auto-show.** Weekend columns were gated behind the `Weekends` toggle (per-device), so hours entered for a non-rostered weekend worker were invisible unless someone manually flipped it on. Now any week that already has Sat/Sun data auto-reveals the weekend columns (`_showWE = tsShowWeekends || hasSat || hasSun`); the toggle still opens empty weekend cells for entry. The roster never gated weekend entry — `_tsDayStatus` returns workable for any day with no roster code — only the toggle did.
- **Sunday week-rollover fix.** The app picked its default week with `getDate() - getDay() + 1`, which (because JS `getDay()` is 0 on Sunday) rolled to *next* week all day Sunday — bumping Sunday-night timesheet/schedule users onto an empty next week while the just-worked week showed faded/past, and mismatching the dropdown's own "(this week)" label. Aligned all four week-Monday formulas (`index.html` early-paint, week-selector range, default-open; `auth.js` gate week list) to the ISO formula `- ((getDay()+6)%7)` already used for the label — so Sunday counts as part of the current Mon–Sun week and the app only advances on Monday.

# v3.10.93 — loadFromSupabase: one table's failure can no longer freeze the whole app

**Date:** 2026-07-12
**Scope:** `index.html`

- **Resilience (follow-up to v3.10.92):** v3.10.92 fixed the *specific* `team_members`/`timesheet_locks` 400, but `loadFromSupabase()` was still all-or-nothing — its `Promise.all` over ~8 tables meant any single rejection (a new id-less table, an RLS regression, a renamed column, a transient 500) would fail the entire sync and silently drop every user onto their last IndexedDB snapshot, with the only symptom being the "Cached …" timestamp quietly not advancing. That's the exact shape of the v3.10.90→.92 outage, and it could recur invisibly. Tables are now split into **load-critical** (`people`, `sites`, `schedule`, `managers`, `timesheets` — the app is unusable without them; a failure still aborts the sync and keeps the last-good snapshot) and **optional** (`teams`, `team_members`, `timesheet_locks` — filter chips, memberships, the accounts-review lock banner). Optional fetches are wrapped in `.catch(() => [])` so one table's failure degrades that one feature instead of freezing the whole app (same pattern already used for the Tier-2 tables in `apprentices.js`).
- **Preserve-on-failure:** a failed optional table keeps its last-known in-memory value rather than overwriting `STATE` (and the persisted offline snapshot) with an empty array on a transient blip.
- **No longer silent:** a degraded sync (one or more optional tables failed) shows a user toast and, together with a full-sync failure, fires a `sync_degraded` PostHog event (`kind: partial|failed`) plus a console breadcrumb. Transition-guarded so the 30s background poll reports the failure once (on the healthy→degraded edge), not every tick.
- `sbFetch`/`sbFetchAll` semantics are unchanged — they still throw on 4xx GETs (other callers depend on that); failure is softened only at these specific call sites. `index.html` only.

# v3.10.92 — Roster/Timesheets: whole app frozen on cached data (team_members/timesheet_locks paginated without an order column)

**Date:** 2026-07-12
**Scope:** `index.html`

- **Fix (production outage):** v3.10.90 wrapped the `team_members` and `timesheet_locks` loads in `loadFromSupabase()` with `sbFetchAll()` but passed no `orderBy`, so both defaulted to `order=id` — and neither table has an `id` column (`team_members` PK is `team_id,person_id`; `timesheet_locks` PK is `week_key,org_id`). PostgREST rejected every load with `400: column "id" does not exist`. Because both fetches sit inside the `Promise.all` in `loadFromSupabase()`, the rejection failed the **entire** sync, so the app fell back to its last IndexedDB snapshot and the "Cached …" timestamp never advanced. Every user was stuck on stale data (last good sync 08/07). Fixed by passing each table's real PK: `sbFetchAll('team_members?select=*', 'team_id,person_id')` and `sbFetchAll('timesheet_locks?select=*', 'week_key')`. Verified live: `order=id` errors, both patched orderings succeed.
- Also corrected a stale comment in `loadFromSupabase()` that claimed `sbFetch` swallows 4xx on GETs — it does not (only disabled tables short-circuit to `[]`); a 4xx GET rejects and takes the whole `Promise.all` down. That false assumption is what made the v3.10.90 pagination change look safe.
- Sibling `sbFetchAll` callers audited — `nominations`, `pending_schedule`, `tenders` all have `id`; `tender_enrichment` already passes `tender_id`. No other id-less callers.

# v3.10.91 — Pipeline: tender_enrichment/nominations/pending_schedule/tenders-diff no longer cap-and-truncate

**Date:** 2026-07-10
**Scope:** `scripts/pipeline.js`, `scripts/pipeline-resource.js`, `scripts/pipeline-import.js`, `scripts/supabase.js`

- **Fix:** `sbFetchAll()` gained an `orderBy` param (defaults `id`) for tables without an `id` PK — `tender_enrichment` has none, only `tender_id` (confirmed live). Applied to the 4 remaining full-table pipeline reads that were capped with a generous but still-truncatable `limit=N` as their only guard against the same silent-drop pattern as v3.10.89/90: `tender_enrichment` + `nominations` (both `pipeline.js` and `pipeline-resource.js`), `pending_schedule`, and the tender-import diff read in `pipeline-import.js`.
- **Deliberately left alone:** `audit_log` (limit 500), `prestarts`/`toolbox_talks` (limit 200) are recency-scoped UI displays by design ("show the most recent N"), not full-table loads that are supposed to be complete — converting them to `sbFetchAll` would change intended behaviour (load entire history into the browser) rather than fix a bug. If older audit/prestart/toolbox history needs to be reachable, that's a pagination-UI or date-filter feature, not this fix.

# v3.10.90 — Timesheets/team_members/timesheet_locks/leave_requests: same silent 1000-row cap as v3.10.89

**Date:** 2026-07-10
**Scope:** `index.html`, `scripts/timesheets.js`, `scripts/leave.js`

- **Fix:** v3.10.89 paginated the `schedule` load with `sbFetchAll()` but left its sibling `timesheets?select=*` load (same `loadFromSupabase()` function, same per-person-per-week growth shape) on the old unbounded `sbFetch()`. Same silent-truncation risk, just hasn't crossed 1000 rows yet. Also paginated `team_members`, `timesheet_locks` (both in `loadFromSupabase()`), the standalone `timesheets.js` full-table load, and `leave_requests` (`scripts/leave.js`) — all unbounded `select=*` fetches with no evidence yet of exceeding 1000 rows, fixed proactively rather than waiting for a repeat of the v3.10.89 incident.
- Audit/pipeline/safety fetches that already cap with an explicit `limit=` (audit_log, prestarts, toolbox_talks, tender_enrichment, nominations, pending_schedule) were left as-is — different failure mode (predictable cap vs. silent drop), out of scope here.

# v3.10.89 — Roster: full-table schedule load was silently capped at 1000 rows

**Date:** 2026-07-10
**Scope:** `scripts/supabase.js`, `index.html`

- **Fix:** the initial `schedule?select=*` load had no `order=`/pagination, so once the table crossed Supabase's default 1000-row cap (it hit 1,069 on 2026-07-10) PostgREST silently truncated the response — dropping the highest-id (newest) rows. Because far-future weeks are naturally the newest inserts, this meant STATE.schedule was missing far-future roster data for every user, and any first edit to one of those weeks collided with the untracked server row (the v3.10.88 409 self-heal papered over the save symptom but not the read gap). New `sbFetchAll()` pages through with an explicit `order=id` so the full table actually loads.
- Root cause of Simon Bramall's "roster entries more than a month away" report — the far-future skew wasn't coincidence, it's exactly which rows get cut by an unordered capped fetch.
- Windowed lazy-load (per `MELBOURNE-SCALE-DESIGN.md`) is still the long-term fix as the table keeps growing; this closes the immediate data-gap without the UX change.

# v3.10.88 — Roster: self-heal duplicate-key race on first save of a week

**Date:** 2026-07-10
**Scope:** `scripts/supabase.js`

- **Fix:** editing a roster cell for a person/week that already had a server-side row (stale local cache, race with another device/tab) hit the `UNIQUE (name, week, org_id)` constraint on insert, threw a 409, and surfaced as a misleading "Save failed — check connection" toast even though the connection was fine. `saveCellToSB()` now catches the 409, fetches the existing server row, and PATCHes the edited day onto it instead of failing outright.
- Reported by Collin Toohey (roster save, 2026-07-10).

# v3.10.87 — People: agency is Labour-Hire-only (auto-clears on group change)

**Date:** 2026-07-08
**Scope:** `scripts/people.js`, `index.html`

- **Fix:** an `agency` tag no longer lingers when someone is moved off Labour Hire. `savePerson()` now forces `agency` empty for any group other than Labour Hire, so a person changed from LH → Direct/Apprentice no longer keeps a stale agency that made them still read as labour hire (shown against them + leaking into the v3.10.86 Timesheets agency filter).
- The **Agency** field in the Add/Edit Person form is now hidden (and cleared) for non-Labour-Hire groups — shown only when Group = Labour Hire (`_syncAgencyField()`, wired into the group toggle + add + edit). Belt-and-braces with the save-side guard.
- Data: the one record that surfaced this (Jose Quintanilla Rodriguez — was "SKS Direct" with agency "Madagins") was cleared manually. Ported to EQ Field.

---

# v3.10.86 — Timesheets: filter by labour-hire agency (for sending to each business)

**Date:** 2026-07-08
**Scope:** `scripts/timesheets.js`, `index.html`

- New **Agency** dropdown on the Timesheets filter bar (next to Group). Pick a labour-hire business (Atom, Cranfield, DL Electrical, …) and the list narrows to just their people — so you can print or export that agency's sheet to send to them. Options are built from the `agency` tag on active Labour Hire workers (case-folded to merge stray case variants), and the selection persists across re-renders.
- **Exports now honour the on-screen filters.** `↓ Export CSV` and `↓ Payroll Report` previously dumped everyone regardless of the filter; both now use the same filtered set (group / agency / team / search), and the filename gains an agency suffix (e.g. `EQ_Timesheets_06-07-26_Atom.csv`) so a per-agency file is self-labelled. The top-right `🖨 Print` already prints the filtered view.
- Data tidy (SKS): merged two look-alike agency tags — `Madigans`→`Madagins` and `core`→`Core` — so each business shows once. Ported to EQ Field.

---

# v3.10.85 — Timesheets: TAFE prefill driven by each apprentice's nominated day

**Date:** 2026-07-08
**Scope:** `scripts/timesheets.js`

- Follow-up to v3.10.84. The TAFE prefill now keys off each apprentice's **nominated TAFE day** (`people.tafe_day`), not just cells where a manager hand-typed `TAFE` into the roster. So their TAFE day is pre-populated **every week** — including future weeks the roster hasn't been built for — instead of only the current week.
- Precedence unchanged: the roster still wins when it has content. If an apprentice is rostered to a **site** on their nominated day, that day shows the site (no TAFE); if they're on **leave**, it mutes as leave. The nominated-day TAFE/8h default only fills an otherwise **empty** cell, and stays editable/type-over like any TAFE prefill.
- Apprentices with no nominated `tafe_day` are unaffected (their roster-typed TAFE still shows). Driven entirely by `_tsDayStatus()`; counting/completion logic from v3.10.84 is unchanged. Ported to EQ Field.

---

# v3.10.84 — Timesheets: TAFE days are prefilled but editable (type-over)

**Date:** 2026-07-07
**Scope:** `scripts/timesheets.js`, `index.html`, `styles/mobile.css`

- Supersedes the v3.10.82/83 holiday-specific handling. **Every** apprentice TAFE day now renders as an editable cell **pre-filled with `TAFE` / 8h** — it looks done, counts 8h toward the 40h week, and the week reads complete without touching it (the old convenience), but a supervisor can **type a real job number straight over it** when the apprentice worked instead (e.g. during a TAFE break). Replaces both the old locked pill and the v3.10.83 empty "TAFE break" cell.
- The 8h is display + total only (counted via `_tafeHrs`, entry-aware) — nothing is written unless the supervisor types over it, at which point that real entry is counted and the TAFE 8h is dropped (no double-count). Completion/40h logic is unchanged: TAFE days stay `workable:false`, so they never drag a row to "incomplete".
- Desktop: prefilled cell has a faint purple left-edge + italic value (`.ts-cell-tafedefault`). Mobile: the day's status pill reads **🎓 TAFE · 8h** and the card stays editable. Driven by a `tafePrefill` flag on `_tsDayStatus()`. Ported to EQ Field.

---

# v3.10.83 — Timesheets: soft "TAFE break" hint on holiday-week TAFE days

**Date:** 2026-07-07
**Scope:** `scripts/timesheets.js`, `index.html`, `styles/mobile.css`

- Follow-up to v3.10.82. When an apprentice's TAFE day falls inside a TAFE holiday, the timesheet now shows a subtle **🎓 TAFE break** hint on the cell instead of a bare empty one. The day stays fully **editable and required** — supervisors still enter the real on-site hours (apprentices work during TAFE breaks) — the hint just explains why the usual TAFE day is open for entry, so it no longer looks like the prefill silently vanished.
- Desktop: faint purple left-edge + italic "🎓 TAFE break" placeholder on the job field (`.ts-cell-tafebreak`). Mobile: the day's status pill reads **🎓 TAFE break** (purple) instead of "— missing", and the job field placeholder prompts for site + hours.
- Driven by a new `tafeBreak` flag on `_tsDayStatus()`; no change to hours maths or completion logic. Ported to EQ Field.

---

# v3.10.82 — Timesheets: TAFE days respect the holiday config

**Date:** 2026-07-07
**Scope:** `scripts/timesheets.js`, `scripts/tafe.js`

- **Fix:** apprentice TAFE days no longer mute the timesheet during a configured TAFE holiday. Previously the timesheet read any rostered `TAFE` cell and greyed the day out, auto-counted a phantom 8h, and blocked the supervisor from entering the real on-site hours — even inside a school break when there is no class. During school breaks apprentices are on site all week, so those days were wrong and "stuck".
- The holiday config (`app_config.tafe_holidays`) was already respected by the *writers* (the roster "🎓 Apply TAFE Day" button and the `tafe-weekly-fill` cron), but not by the timesheet *reader*. `_tsDayStatus()` now consults the same config via a shared `isTafeHolidayCell(week, day)` helper: an apprentice's TAFE cell that falls inside a holiday range is treated as a normal workable day (no mute, no auto-8h, real hours enterable).
- No data cleanup needed — self-corrects every current and future break. To be ported to EQ Field.

---

# v3.10.81 — Safety: filter, select & batch-download records (+ toolbox Word export)

**Date:** 2026-06-26
**Scope:** `scripts/safety.js`, `index.html`

- New **Records** tab on the Safety page — filter prestarts + toolbox talks together by type, site, status, free-text search (site / person / topic), and date.
- **Date filtering** built for audits: rolling chips (7/30/90d), **This week / Last week** presets (Mon–Fri), and explicit **From / To** date pickers for any span.
- **Mon–Fri coverage strip** — when a single site + a one-week range are active, shows M T W T F with tick/cross so a missing day's prestart is obvious before downloading.
- Multi-select with **Select all**, or one-tap **Download all (N)** for the whole filtered set.
- Downloads as a `.zip` of individual Word docs (single selection downloads the `.docx` directly). The zip is named from the active filter, e.g. `Prestarts_SYD53_2026-06-22_to_2026-06-26.zip`; duplicate filenames are auto-suffixed.
- **Audit filenames**: `Prestart_<SITE>_<YYYY-MM-DD>_<Day>_<Rep>[_<ProjNo>].docx` (and the toolbox equivalent) — site-grouped, date-sortable, weekday visible.
- Added **Toolbox Talk Word export** (`↓ Word` on the toolbox form) — previously prestart-only.
- Refactored the `.docx` builder into a shared toolkit (`_safetyDocxKit` / `_safetyDocxPackage`) reused by prestart, toolbox and batch export. Prestart output is unchanged.

---

# v3.10.80 — Batch: filter archived workers from people list

**Date:** 2026-06-23
**Scope:** `scripts/batch.js`

- Archived workers no longer appear in the batch selector people list.

---

# v3.10.79 — Safety: prestart Word export — 12-hour AM/PM time format

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- Prestart docx Time field now exports as 12-hour format with AM/PM (e.g. `2:30 PM` instead of `14:30`).

---

# v3.10.78 — Safety: remove SYD53 default from prestart site field

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- New prestart drafts now start with `site_abbr` blank (no default).

---

# v3.10.77 — Safety: prestart site field — default SYD53 + dropdown indicator

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- New prestart drafts default `site_abbr` to `'SYD53'` instead of the first site in the list.
- Site input now has a `▾` chevron indicator (wrapped in `position:relative` div) so it reads as a combobox. Datalist pick-or-type behaviour unchanged.

**Version stamps:** `APP_VERSION = '3.10.77'`, SW cache `eq-field-v3.10.77`.

---

# v3.10.76 — Safety: prestart form — remove redundant project fields

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`, `migrations/2026-06-23_prestarts_project_fields.sql`

- **Removed** `project_name` and `project_address` form inputs — these are already held in the sites table (`site.name`, `site.address`) and resolved from the selected `site_abbr`. Entering them separately was redundant duplication.
- **Docx export** now reads `siteName` and `siteAddress` from the site record for the Project Name and Project Address rows.
- **Migration simplified** to 3 columns: `project_number`, `permits_categories`, `affects_other_trades`.
- **Form layout**: Site + Project Number grouped in one row; Date + Time in the next.

**Version stamps:** `APP_VERSION = '3.10.76'`, SW cache `eq-field-v3.10.76`.

---

# v3.10.75 — Safety: fix iOS auto-zoom on prestart + toolbox inputs

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- **Bug fix**: All prestart and toolbox text inputs were `font-size:13px` (via `_I` constant). iOS Safari auto-zooms the viewport on any input below 16px. Fixed by adding a `@media(max-width:640px)` rule in `_injectSafetyStyle()` that forces `font-size:16px` on all inputs and textareas inside `#prestart-form-body` and `#toolbox-form-body`. Desktop rendering unchanged (stays 13px).

**Version stamps:** `APP_VERSION = '3.10.75'`, SW cache `eq-field-v3.10.75`.

---

# v3.10.74 — Safety: Word export — drawing ID fix + logo perf

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- **Bug fix**: `wp:docPr` and `pic:cNvPr` IDs in signature image runs were set to the relationship string (`rId2` etc.) rather than a unique integer. OOXML requires unique non-negative integers across the document — duplicate IDs caused Word to show repair warnings on any document with multiple signatures. Signatures now use a counter starting at 100 (well clear of the header logo at 1/0).
- **Perf fix**: Logo binary-to-base64 conversion replaced 400K+ `forEach`/string-concat iterations with chunked `String.fromCharCode.apply` (8192 bytes per call, ~49 iterations total). Eliminates UI freeze on low-end Android.

**Version stamps:** `APP_VERSION = '3.10.74'`, SW cache `eq-field-v3.10.74`.

---

# v3.10.73 — Safety: Word export polish — sig table + footer + hoisting fix

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

- **Bug fix**: `hasLogo`/`hasSigs` were declared after their first use in `docRels` (JavaScript `var` hoisting — value was `undefined` at that point). Moved declarations immediately after the logo fetch so the header relationship, content-type entry, and packaging all fire correctly.
- **Signature table**: restructured to match the Terry Su reference — both columns now headed "Name & Signature" (navy), crew paired two per row, name bold-navy + signature image stacked inside one cell per person.
- **Page footer**: replaced the body-paragraph workaround with a proper Word `footer1.xml` (wired through `docRels`, `contentTypes`, and `sectPr`). Bottom margin raised to 1440 DXA (1 inch) to give the footer room.

**Version stamps:** `APP_VERSION = '3.10.73'`, SW cache `eq-field-v3.10.73`.

---

# v3.10.72 — Safety: SKS logo in Word export header

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`, `sw.js`, `images/sks-logo.png`

Added the SKS Technologies logo to the Word export header, matching the Terry Su reference document (`word/header1.xml`, `rId0`, 1619250×590550 EMU). Logo extracted from the reference `.docx` media folder and stored at `/images/sks-logo.png`. Fetched asynchronously at export time via `fetch()` and embedded as a binary PNG inside the ZIP. Added to SW precache. Falls back gracefully (no header) if the fetch fails.

**Version stamps:** `APP_VERSION = '3.10.72'`, SW cache `eq-field-v3.10.72`.

---

# v3.10.71 — Safety: Word export visual redesign

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`

Rewrote `_psExportDocx()` to match the Terry Su SKS Daily Pre-Start template design exactly.

**Design changes:** Replaced the old gray-cell layout with the correct two-color system extracted from the reference OOXML: navy (#1F335C) label cells with white bold text and navy borders; light-blue (#EEF1F8) value cells with CCCCCC borders. Section headings (Controls, Measures, etc.) are now bold-caps navy-colored paragraphs rather than filled dark-blue bars. The info table is now a 4-column grid (4 × 2340 DXA) with single-column label and 3-column spanning value for wide fields. Q&A questions use 2-col inline tables (question navy | answer light-blue) or full-width 2-row tables for long answers. Yes/No answers use green (#4caf82) bold text. Measures table is now 3-column (720 dark-blue number | 6480 plain text | 2160 green-tinted Yes). Controls data rows use EEF1F8 light-blue, not white. Declaration rendered in an italic light-blue table cell.

**Version stamps:** `APP_VERSION = '3.10.71'`, SW cache `eq-field-v3.10.71`.

---

# v3.10.70 — Safety: Word export + project fields

**Date:** 2026-06-23
**Scope:** `scripts/safety.js`, `scripts/jszip.min.js`, `index.html`, `sw.js`, `migrations/2026-06-23_prestarts_project_fields.sql`

Added Word (.docx) export to the prestart form, matching the SKS Daily Pre-Start template format.

**Form changes:** Project Name, Project Number, and Project Address fields added to the prestart form. Saved to Supabase via `migrations/2026-06-23_prestarts_project_fields.sql` (adds three nullable TEXT columns to the `prestarts` table).

**Export:** "↓ Word" button appears in the form footer on every prestart (draft or submitted). Generates a fully structured .docx with: project/site info table, daily briefing Q&A, static Controls table (slips/trips → PPE → manual handling), 8-point Measures checklist (all Yes), Other Hazards & Risks table, HRCW checkboxes (ticked items highlighted), permits, compliance declaration, and crew names with embedded signature images.

**Dependencies:** JSZip 3.10.1 bundled at `scripts/jszip.min.js` — no CDN dependency, precached in the service worker so export works offline once the app is cached.

**Version stamps:** `APP_VERSION = '3.10.70'`, SW cache `eq-field-v3.10.70`.

---

# v3.10.68 — Job Numbers: compact table layout

**Date:** 2026-06-19
**Scope:** `scripts/jobnumbers.js`

Tightened the Job Numbers table to fit more rows on screen. Row padding reduced from 8px to 4px vertical. Font size 12.5px → 12px, header labels 11px. Notes now render inline after the description (same line) instead of a block below. Column widths fixed for Job #, Client, Site, Status. Edit/delete buttons forced inline with `white-space:nowrap` — no more two-line stacking on narrower viewports.

**Version stamps:** `APP_VERSION = '3.10.68'`, SW cache `eq-field-v3.10.68`.

---

# v3.10.67 — Job Numbers: bulk delete

**Date:** 2026-06-19
**Scope:** `scripts/jobnumbers.js`, `index.html`

Checkbox column added to the Job Numbers table (manager-only). Select individual rows or use the header checkbox to select all visible rows (respects the search filter). A bulk bar appears above the table showing the count of selected items. Two-tap arming on delete: first tap changes the button to red "Confirm delete N?", second tap within 3s fires. Auto-disarms on selection change or timeout. Bulk delete uses a single PostgREST `in.()` call — one DB round-trip regardless of count. Audit-logged. Datalist refreshed after delete. Single-delete (✕ per row) still works and clears the deleted ID from selection state.

**Version stamps:** `APP_VERSION = '3.10.67'`, SW cache `eq-field-v3.10.67`.

---

# v3.10.66 — Supervision: simplified category list

**Date:** 2026-06-18
**Scope:** `scripts/managers.js`, `scripts/auth.js`, `index.html`

Collapsed 7 supervision categories down to 5: **Executive, Management, Supervisor, Internal, Other**. Operations / Project Management / Construction merged into Management — people being promoted to management aren't necessarily project managers. Existing records with old category values still render (in an ungrouped section at the bottom) until re-categorised via the edit modal.

`auth.js` `SUPERVISOR_CATEGORIES` updated to include Management while retaining the old values for backward compatibility — existing staff with Operations/PM/Construction categories can still unlock supervisor mode.

**Version stamps:** `APP_VERSION = '3.10.66'`, SW cache `eq-field-v3.10.66`.

---

# v3.10.65 — Leave CC: fix iOS double-fire on supervisor chips

**Date:** 2026-06-14
**Scope:** `scripts/leave.js`

Leave CC supervisor chips used `onclick`, which on iOS fires twice per tap — once from the pointer event and once from the synthesized click that fires after the DOM is replaced. The net effect was that each tap toggled the chip on then immediately off, so supervisors could never be selected. Changed both the supervisor chips (`renderLeaveCCSupervisors`) and the ✕ remove buttons (`renderLeaveCCList`) to `onpointerdown="event.preventDefault();handler()"` — the same pattern used for the hours chip popover in `timesheets.js`.

**Version stamps:** `APP_VERSION = '3.10.65'`, SW cache `eq-field-v3.10.65`.

---

# v3.10.64 — Timesheets: hide archived contacts

**Date:** 2026-06-12
**Scope:** `scripts/timesheets.js`

Archived contacts were still appearing in the timesheets list. Added `!p.archived` to both the people list filter and the stats counter (`updateTsStats`). Matches the filter already in roster, dashboard, and all other pages.

**Version stamps:** `APP_VERSION = '3.10.64'`, SW cache `eq-field-v3.10.64`.

---

# v3.10.63 — Timesheets: 3-job split per day

**Date:** 2026-06-12
**Scope:** `scripts/timesheets.js`

Extended the split-day feature from 2 jobs to 3 jobs per day. Storage format unchanged (pipe notation `JOB1:h|JOB2:h|JOB3:h`). No schema migration required.

- Desktop: `＋` button on the slot-1 row reveals slot 2 (`toggleTsSplit2`); hiding slot 1 also clears slot 2
- Mobile: "＋ Add third job" button appears in the day actions when slot 1 is open (`toggleMTsSplit2`)
- `onTsCellChange` reads slot 2 and combines into 3-part pipe string when slot 2 is filled
- Parse logic in both desktop and mobile render extended to handle `parts[2]`

**Version stamps:** `APP_VERSION = '3.10.63'`, SW cache `eq-field-v3.10.63`.

---

# v3.10.62 — Dashboard top-stats: leave + archived headcount fixes

**Date:** 2026-06-11
**Scope:** `index.html` (`updateTopStats`)

**Bug 1 — On-leave pill always showed 0.** The `peopleOnLeave` check used `days.every()` across all 7 days (Mon–Sun). Since sat/sun are blank, `isLeave('')` returns false, so no one ever passed. Fixed to check Mon–Fri only.

**Bug 2 — Archived workers inflating all counts.** `stat-total`, `stat-active`, and the three group stat cards (Direct / Apprentice / Labour Hire) included archived workers. DB confirmed 2 archived workers. Now filters `!p.archived` at the display layer.

**DB confirmed (2026-06-11):** SKS people table has 61 rows total — 59 active (35 SKS Direct, 13 Apprentice, 11 Labour Hire) + 2 archived (1 SKS Direct, 1 Labour Hire). All groups normalise correctly; no missing-group drift.

---

# v3.10.61 — Fill Week race-condition fix (complete)

**Date:** 2026-06-11
**Scope:** `scripts/supabase.js`

**Bug.** Fill Week (⇒wk button in the roster editor) was silently losing all Tue–Fri values when the user typed Monday's value and immediately clicked Fill. The `onchange` on the Monday input fires `saveCellToSB` (async POST for a new row), then the Fill click fires `saveRowToSB` synchronously. Since the POST hadn't returned, `existing.id` was still unset — `saveRowToSB` fell into its POST branch and issued a second POST with `{ mon: null, tue: val, … }`, racing the first. The DB's UNIQUE(name, week) constraint meant only one POST won; the loser was silently swallowed. Monday's POST (started first) tended to win, so the user saw only Monday. v3.10.60 added a full-state snapshot but did not address the race; this release eliminates it.

**Fix.** `saveRowToSB`'s POST branch now:
1. Checks `_sbPendingRows[lockKey]` and awaits any in-flight row-creation POST before deciding PATCH vs POST — eliminating the race entirely.
2. After the await, re-reads `current.id`; if now set, PATCHes instead of re-POSTing.
3. If a POST is still genuinely needed, snapshots the full current `existing` STATE for all days (not just the fill-week `dayVals`) so no already-set value (e.g. Monday) is lost.

---

# v3.10.60 — Bug fixes: dashboard dedup, archive roster, TAFE fill, name overflow

**Date:** 2026-06-10
**Scope:** `scripts/dashboard.js`, `scripts/roster.js`, `scripts/supabase.js`, `styles/base.css`

- **Dashboard double-count** — site/day counts now use a `Set` per cell so the same person (e.g. duplicate schedule rows, or someone in both `people` + `managers` tables) is only counted once. Total column was already correct; per-day cells were double-counting.
- **Archive doesn't remove from roster** — `getRosterPeopleForGroup()` and `renderEditor()` now filter `!p.archived`, so archiving a contact removes them from the roster view and editor immediately.
- **TAFE day overwrite** — `fillWeek()` (⇒wk button) now skips any day that already has a TAFE/education code. Apprentices on TAFE Wednesday, for example, will no longer have it overwritten.
- **Fill week save bug (partial)** — `saveRowToSB` POST path now seeds from the full in-memory entry before applying the partial dayVals. Race condition addressed in v3.10.61.
- **Long names overflow** — `.editor-name` and `td.name-col` now have `max-width` + `text-overflow: ellipsis` so long names (e.g. Cicero) no longer blow out the table layout.

---

# v3.10.59 — Cards→Field SSO: phone fallback + canonical_id re-sync

**Date:** 2026-06-06
**Scope:** `index.html`, `scripts/auth.js`, `netlify/functions/verify-pin.js`, `docs/merge/*` + sks-labour data

**The completion.** v3.10.58 made `canonical_id` the join key but a live audit found two problems: `people.canonical_id` was **orphaned** (matched no identity row anywhere), and the real canonical identity is eq-canonical `public.workers`, linked by **phone**. This release fixes both and adds a phone fallback so the bridge covers more of the crew.

**Data fix.** `people.canonical_id` re-synced to the real `workers.id` for the **28** active people whose phone uniquely matches exactly one eq-canonical worker (collision-guarded, snapshotted, idempotent). Orphaned values on non-matching rows left untouched. Forward + rollback: `docs/merge/canonical_id_resync_2026-06-06.sql`.

**Code.**
- `_resolveCanonicalPerson()` now resolves by `canonical_id` first, then **phone (last-9)** — covering the ~20 invite-only workers who have a canonical identity but no `people.canonical_id` yet.
- `verify-pin` carries `phone` through the `verify-shell-token`/`verify-token` paths and into the session token; `auth.js` stores/clears `eq_canonical_phone`.

**Coverage.** 28 bridge immediately by UUID; ~20 more by phone as/when invited-workers exist; 11 (10 not-in-pipeline + 1 no-phone) need manual identity. Still inert until eq-shell mints `#sh=` tokens carrying `workers.id` or `phone` (see `docs/merge/cards-field-sso-runbook.md`). Not deployed.

---

# v3.10.58 — Cards→Field SSO: resolve login by canonical_id

**Date:** 2026-06-06
**Scope:** `index.html`, `scripts/auth.js`, `netlify/functions/verify-pin.js`, `docs/merge/cards-field-sso-runbook.md`

**The bridge.** Cards onboards SKS workers into a shared canonical identity (eq-canonical `shell_control.users`, phone-OTP). This app, by contrast, has no per-user auth — login is a shared code plus a name pick, and a person is resolved by **name string**. The two never met: `people.canonical_id` was synced (49/60) but unread. This is Phase C of the bridge — the sks-labour slice that makes `canonical_id` the deterministic join key.

**What's new.**
- **Resolve by canonical_id.** When a worker arrives via an EQ Shell `#sh=` handoff carrying a canonical identity id, `initApp` resolves their `people` row by `people.canonical_id` and adopts that row's exact `name` as `eq_logged_in_name`. This bridges the canonical id onto the existing name-keyed roster/timesheet layer — **no rewrite of that layer.**
- **Token plumbing.** `verify-pin` carries `canonical_id` through the `verify-shell-token` and `verify-token` (remember-me) paths, and bakes it into the 7-day session token so a reload re-resolves the same person.
- **Capture + clear.** `auth.js` stores `eq_canonical_id` on both server-token paths and clears it on logout.

**Backwards-compatible.** With no `canonical_id` (the shared-code gate), the resolver no-ops and name-based login is exactly as before. The slice is **inert until the eq-shell token mint (Phase A1) ships** — until then no token carries a canonical id, so nothing changes for current users.

**Verified.** Against live sks-labour data: a session with a wrong name + a real `canonical_id` self-corrected to the right person; a session with no `canonical_id` left the name untouched; console clean. Full plan + cross-repo specs (eq-shell A1, eq-canonical provisioning, the later sks-canonical migration): `docs/merge/cards-field-sso-runbook.md`.

---

# v3.10.57 — My Schedule: per-day job number on each card

**Date:** 2026-06-05
**Scope:** `scripts/roster.js`

**The refinement.** v3.10.56's crew-total footer answered "what jobs did the whole crew book this week" — but the individual looking at their own schedule wants "what job did *I* work each day." This puts that on each day card.

**What's new.** Each day card on My Schedule now shows a 🔧 chip with the job number **you** booked that day, read from your own timesheet (`getTsEntry(name, week)`). Split cells like `D5384:4|D5385:4` render as separate chips, each tagged with its hours. Only shows on working days where a job is booked.

**Removed.** The v3.10.56 "Job numbers done this week" crew-total footer (`_scheduleCrewJobs`, `_scheduleJobsSection`, `toggleScheduleJobs`) — a whole-week crew aggregate wasn't useful at the individual level. The per-day chips replace it.

---

# v3.10.56 — My Schedule: job numbers done this week

**Date:** 2026-06-05
**Scope:** `scripts/roster.js`

**The gap.** Supervisors fill the timesheets; the team (direct, apprentice, labour hire) had no way to see which job numbers were being booked. This adds that visibility on the surface they already use — My Schedule.

**What's new.** A collapsible footer sits under the day cards: **"Job numbers done this week"**. It aggregates every timesheet for the week being viewed into per-job totals — handling split cells like `J1:4|J2:4` (same parsing as `exportTsByJob()`). Each row shows the job number, its description (from `job_numbers`), a head-count, and total hours, sorted by hours.

- **Shared visibility** — every job with hours logged that week, regardless of who entered it.
- **Quiet by default** — collapsed so it doesn't compete with the day cards; tap to expand. Open/closed state persists as you step weeks (`_scheduleJobsOpen`).
- **Scoped to the viewed week** and hidden entirely when nothing is booked.

New in `roster.js`: `_scheduleCrewJobs(week)`, `_scheduleJobsSection(week)`, `toggleScheduleJobs()`.

---

# v3.10.55 — Mobile: Team week button + crew on My Schedule

**Date:** 2026-06-04
**Scope:** `scripts/home.js`, `scripts/roster.js`

**Team week (new).** The staff mobile home gets a split button below the tiles:
- **👥 Team week** → `openTeamWeek()` — a self-contained full-screen overlay listing who's on each job, day by day, for the week (grouped site → crew, with a head-count per site). ‹ › step through weeks via the global week list. Read-only; no nav page registered/gated (overlay appended to `<body>`, closed via ✕).
- **🤝 Who's with me** → opens the existing My Schedule page.

**Crew on My Schedule.** The per-day co-worker line was capped to ≤2 names — crews of 4+ showed *nobody*. It now lists the crew on your site that day: first 4 names, then a tappable **"+N more"** that reveals the rest inline (`roster.js`).

---

# v3.10.54 — Timesheets: stop the jump-to-top + Direct-employee TAFE

**Date:** 2026-06-04
**Scope:** `scripts/timesheets.js`

**Jump-to-top on data entry (real fix).** `onTsCellChange()` committed each cell then called `renderTimesheets()`, rebuilding the entire `#ts-content` table. That destroyed the input the user was in — focus dropped to `<body>`, so the next Tab started from the top of the page. The v3.10.51 fix only covered re-renders routed through `renderCurrentPage()` (realtime/poll/week-change), not this direct path.
- Now the single-cell path updates **in place** and never rebuilds: `saveTsCell()` already refreshed the row total via `updateTsRowTotal()`, which now *also* syncs the row's left-stripe and uses the same completion test as the full render. `onTsCellChange()` drops `renderTimesheets()` and just calls `updateTsStats()`.
- Trade-off: the per-day ↻ repeat chip and the "Fill Week" banner now refresh on the next full render (navigation / week change) rather than instantly. Neither is focus-critical during entry.

**Direct employees showing "TAFE".** Education codes (`TAFE`/`TRAINING`) auto-muted the timesheet cell for everyone and labelled it "🎓 TAFE". Direct / Labour-Hire staff never attend TAFE — a training course is logged against a job code by the supervisor.
- `_tsDayStatus()` now only mutes education days for `group === 'Apprentice'`. For everyone else the day stays a normal workable cell. (Surfaced by Yura Kovakov, a Direct employee with a `TRAINING` roster day.)

---

# v3.10.53 — Resources: "Supervisor" → "Person in charge"

**Date:** 2026-06-04
**Scope:** `scripts/pipeline-resource.js`, `scripts/pipeline.js`

- The Resource Allocation panel's **Supervisor** field is renamed **Person in charge** and now lists **Direct employees as well as Supervisors** (grouped). Supervisors come from the `managers` table (`category = 'Supervisor'`); Direct employees come from `STATE.people` (`group = 'Direct'`).
- The two tables have independent integer id spaces, so a nomination now records the source in `nominations.capacity_tag` (`'people'` for a Direct employee, null for a manager — legacy rows read as managers). Name resolution checks the right table via `_picName`.
- The Pipeline (Kanban) board's Supervisor picker was widened the same way and resolves either source, so the shared nomination stays consistent across both surfaces (the board keeps the "Supervisor" label). No schema migration — `capacity_tag` already existed on `nominations`.

---

# v3.10.52 — Forecast: a work week is 40 hours, not 38

**Date:** 2026-06-04
**Scope:** `scripts/pipeline-resource.js` (`suggestWorkers`)

- The resource allocation panel's "suggest N workers" hint divided forecast hours by `(weeks × 38)`. A standard work week is 40 hours, so the suggestion ran slightly high.
- Fix: changed the divisor to `(weeks × 40)`.

---

# v3.10.51 — Timesheets: stop the jump-to-top on cell entry

**Date:** 2026-06-03
**Scope:** `index.html` (`renderCurrentPage`)

- Filling a timesheet cell jumped the page to the top. Cause: `renderCurrentPage()` rebuilds the active page's innerHTML and is called on every realtime echo, poll, and post-write refresh — preserving nothing. A background update mid-entry dropped focus to `<body>`, and the next Tab started from the top of the document (the "jump").
- Fix: split the dispatch into `_renderCurrentPageDispatch()` and wrap `renderCurrentPage()` to capture + restore, across the rebuild: the active `.page` scroll position (and any `.ts-table-scroll` horizontal scroll), the focused cell (re-found by its `data-name`/`-group`/`-week`/`-day`/`-type`/`-slot`), and the caret (`selectionStart`). Focus restore uses `focus({preventScroll:true})` and is wrapped in try/catch so it can never break a render.
- Applies to all data-entry pages, not just Timesheets.

---

# v3.10.50 — Resources: "This week" strip — plan vs roster reality

**Date:** 2026-06-03
**Scope:** `scripts/pipeline-resource.js`

- The capacity-planning hero now opens with a **THIS WEEK** strip: `jobs live` · `allocated` (planned peak demand of started jobs) · `on the roster` (real headcount deployed this week, read from the live `schedule` table — the same source the Dashboard "Site Breakdown" uses) · `free` (headcount − deployed).
- Aggregate only by design. Per-job "allocated vs on-site" attribution is deferred (phase B) — it needs a site code persisted on each job; the pipeline→roster push flow isn't used here, so there's no reliable job↔roster link yet.
- The new roster fetch is non-fatal (`.catch → []`): a roster-query failure degrades to "0 on the roster" instead of blanking the planning page.

---

# v3.10.43 — Edit Roster: show team filter bar

**Date:** 2026-06-01
**Scope:** `scripts/teams.js`

- Team filter pill bar now appears on the Edit Roster (`editor`) page. The filter was already being applied via `personInActiveTeam()` — rows were silently hidden if a team filter was active — but the pill bar was excluded from the page allowlist so there was no visual indicator and no way to clear it.
- One-line fix: added `'editor'` to the page list in `renderTeamPills()`.

---

# v3.10.42 — Leave hardening sprint

**Date:** 2026-06-01
**Scope:** `netlify/functions/approve-leave.js`, `netlify/functions/send-email.js`, `scripts/leave.js`

**Root cause fixed: ghost approve/reject from email scanners**
- GET on `approve-leave` now renders a confirmation page only — email security scanners (Gmail, Outlook SafeLinks) follow `<a href>` links via GET before the recipient opens the email. The actual PATCH only fires when the supervisor submits the POST form.

**Org_id scoping on approver lookups**
- Manager name lookups in `approve-leave.js` and `send-email.js` now include `&org_id=eq.${org_id}` so same-name managers across different tenants don't resolve to each other's email.

**Email failure surfaced on magic-link path**
- `sendStatusEmail` is now awaited in `approve-leave.js`. If the requester notification fails, the success page shows a warning: "Leave approved, but the notification email failed — please let them know directly."

**Roster conflict confirmation before overwrite (LEV-003 → LEV-004)**
- Approving leave that overlaps scheduled shifts now shows a confirm modal *before* the PATCH, so the supervisor can cancel cleanly. Previously warned with a toast *after* the write had already happened.
- `respondLeave` extracted the commit logic into `_commitLeaveResponse()` to allow the conflict modal to call it after confirmation.

**Write-back failure surfaced (LEV-011)**
- `writeLeaveToSchedule()` is now wrapped in its own try/catch inside `_commitLeaveResponse`. If the roster write fails, the approval stays committed (correct) and a distinct toast tells the supervisor to check the schedule manually.

**Withdrawal notification to approver (LEV-009)**
- Withdrawing a pending request now emails the named approver: "No action is needed — any approval link in your email is no longer valid." Prevents supervisors from acting on a ghost pending link.
- New `triggerLeaveEmail('withdrawal_notification', req)` type added.

**TTL constant documented as single source of truth**
- `LEAVE_ACTION_TTL_MS` in `send-email.js` now carries a comment clarifying it is the *only* place the TTL lives. `approve-leave.js` reads `exp` from the token and has no TTL constant.

---

# v3.10.41 — Timesheets: A/L + SICK count as 8h; unlock-on-page edit fix

**Date:** 2026-05-31
**Scope:** Timesheets, Auth

- **A/L + SICK now count as 8h/day** — annual leave and sick days contribute 8h each toward the weekly total (mirroring how rostered TAFE days already count for apprentices), so a full leave week reads as 40h / complete instead of "—". RDO, OFF, U/L, PH and JURY are unchanged and still count as 0h. To make another code count as paid 8h, add it to `TS_PAID_LEAVE_TERMS` in `scripts/timesheets.js`.
- **SICK gets a 🏥 icon** — sick days show a hospital icon in the day cell instead of the 🌴 palm tree used for other leave. Other leave codes keep the palm.
- **Unlock-on-page edit fix** — unlocking supervision mode while already sitting on a page (e.g. Timesheets) now re-renders that page immediately, so job-number and hours inputs become editable straight away. Previously the inputs stayed disabled (rendered while view-only) until you navigated away and back, making it look like a supervisor couldn't edit the timesheet.
- **Scroll-to-top on hours/job entry — actually fixed** — entering hours or selecting a job no longer jumps the page to the top. v3.10.40 tried to fix this by restoring `window.scrollY`, but the timesheets page scrolls inside the `.page` container (`overflow-y:auto`), not the window — so `window.scrollY` was always ~0 and the restore was a no-op. Now restores the real scroll container's `scrollTop`.
- **New "Outstanding" report** — a 🖨 button (export bar + the "pending" popover) opens a clean, printable list of everyone whose timesheet is still incomplete for the current week, showing their group, status (No data / Partial) and exactly which days are missing. Save it as PDF to email out. Roster leave/TAFE days are excluded since nothing is expected on those.

---

# v3.10.40 — Timesheets: fix scroll-to-top on job/hours entry

**Date:** 2026-05-29
**Scope:** Timesheets

- **Scroll jump fixed** — selecting a job from the dropdown or entering hours no longer jumps the page back to the top. The vertical and horizontal scroll positions are preserved across the post-cell-change table re-render.

---

# v3.10.39 — Teams: AND-mode multi-select filter (slicer)

**Date:** 2026-05-28
**Scope:** Weekly Roster / Contacts / Timesheets — team filter

- **Team filter is now an intersection (AND) not a union (OR)** — selecting Comms + Vans shows only people who are in both teams simultaneously, like a slicer. Previously it showed anyone in either team.
- Unassigned pseudo-team still works as expected when selected alone; mixing Unassigned with real-team filters applies the real-team intersection only.

---

# v3.10.38 — Auth: EQ Core parallel login + Shell handoff polish

**Date:** 2026-05-28
**Scope:** Authentication / EQ Shell integration

- **Shell handoff supervisor instant-paint** — supervisor state (`isManager`, `currentManagerName`, `applyManagerMode`) is pre-set immediately when a Shell token is verified, matching the existing remember-me restore pattern. Eliminates the "View only" flash for supervisor Shell users.
- **`initPushOptIn` for non-PIN paths** — `window.onload` now calls `initPushOptIn` after `initApp()` for Shell token, remember-me, and existing-session restore paths. Previously only PIN logins triggered push opt-in.
- **EQ Core nudge banner** — SKS PIN users see a soft dismissible banner 4.5 s after login: "Set up your EQ Core account for one-tap login." Shown once per session until permanently dismissed (× writes a localStorage flag). Never shown to Shell-authenticated users.

---

# v3.10.37 — Realtime: suppress 30s poll flicker

**Date:** 2026-05-27
**Scope:** Background sync / polling

- **Skip poll when realtime is live** — the 30s background poll now returns early if the Supabase realtime WebSocket is open. Eliminates the periodic full re-render of Timesheets (and other pages) that users saw as a constant flicker when leaving the page idle.
- **`isRealtimeConnected()`** — new helper exported from `realtime.js`; poll falls back automatically if the WS drops.
- **Timesheets signature fix** — `_computeStateSignature` now hashes all cell values (job + hrs × 7 days, approved, approved_by) so actual multi-user changes are correctly detected when the poll does fire.

---

# v3.10.36 — Timesheets: 5-day default view, weekend toggle

**Date:** 2026-05-26
**Scope:** Timesheet column layout

- **Mon–Fri default** — timesheet table now shows only 5 columns by default, eliminating the horizontal scroll that Sat/Sun caused on most screens.
- **⊞ Weekends toggle** — new button in the chip-actions bar expands Sat/Sun columns inline. Tap again to collapse. Preference persists across sessions via `localStorage`.
- **Amber dot indicator** — if the current week has any data in Sat/Sun columns while weekends are hidden, a small amber dot appears on the toggle button so nothing goes unnoticed.

---

# v3.10.35 — Timesheets: pre-approve leave weeks

**Date:** 2026-05-26
**Scope:** Timesheet approval chip

- **Pre-approve leave rows** — rows where a person is fully on leave (A/L, sick, PH) now show the `○` approval circle for supervisors, even though no timesheet hours exist. Tapping it creates a minimal stub entry and immediately marks it approved.
- Leave is already approved through the leave system, so this is a formality — supervisors can tick off leave rows any day of the week rather than waiting until Monday.
- Un-approve works the same way (tap the green initials chip to remove approval).
- Partial-leave rows (some worked days, some leave) are unchanged — they still require hours to be entered before approval.
- Audit log entry written on every approval toggle.

---

# v3.10.34 — Teams: multi-select filter

**Date:** 2026-05-26
**Scope:** Team filter pills (roster, contacts, timesheets, schedule)

- **Multi-select** — click any team pill to add it to the filter; click it again to remove. Multiple teams can be active simultaneously — a person is shown if they belong to any selected team.
- **All pill** — clears all active filters in one click.
- **Toggle off** — active pills show a ✕ indicator; clicking deactivates that team only.
- **Color stripe** — when exactly one team is active, rows use that team's colour. With multiple teams selected, rows use their natural team colour.
- Persisted to localStorage as a JSON array (old single-ID format silently dropped on upgrade).

---

# v3.10.33 — Timesheets: fix Direct group matching

**Date:** 2026-05-26
**Scope:** Timesheets — group filter

- **Fix:** Direct employees (35 people) still not appearing — v3.10.32 used `'SKS Direct'` but the app normalises DB value `'SKS Direct'` → `'Direct'` on load (via `groupAliases`). All timesheets.js checks and the group dropdown now use `'Direct'` to match the in-memory group name.

---

# v3.10.32 — Timesheets: fix SKS Direct group matching

**Date:** 2026-05-26
**Scope:** Timesheets — group filter

- **Fix:** `'SKS Direct'` group (35 direct employees) was not appearing in timesheets — code was checking for `'Direct Employee'` which didn't match the DB value. All string references updated to `'SKS Direct'`.

---

# v3.10.31 — Timesheets: collapsed groups, teams filter, Direct Employee

**Date:** 2026-05-26
**Scope:** Timesheets page (supervisor + mobile), teams filter, staff self-entry audit.

- **Collapsed groups** — all three groups (Apprentice, Labour Hire, Direct Employee) start collapsed on load. Click the group header to expand. State persists per-browser via localStorage so the preference survives refresh.
- **Teams filter on timesheets** — the existing Team pill row (CDC / Vans / Unassigned etc.) now also shows on the Timesheets page. Filtering to a team scopes both the grid and the completion stats to that team's headcount.
- **Direct Employee group** — added as a third supported group alongside Apprentice and Labour Hire. Shows a `DE` badge (blue), 👷 icon, and blue group stripe. Included in group filter dropdown, stats, and all exports.
- **Fix: self-entry audit gap** — `onStaffTsCellChange` now writes an `auditLog` entry after each successful save, matching the supervisor path. Enables discrepancy investigation by day when staff self-enter.

# v3.10.30 — Pipeline: fix value totals

**Date:** 2026-05-26
**Scope:** Pipeline board summary strip.

- **Fix: value totals inconsistent with card counts** — when "All values" is selected, below-threshold cards were included in the count but excluded from dollar totals via a separate `!below_threshold` guard. Removed the redundant guard so the value sum uses the same card set as the count. Below-threshold items with no `quote_value` contribute $0 regardless.
- **Fix: misleading tooltip** on the value filter dropdown — was incorrectly claiming "Won tenders always shown."

---

# v3.10.29 — Safety dashboard

**Date:** 2026-05-26
**Scope:** New manager-only Safety Report page.

- **Safety Report page** — new `page-safety-dashboard` showing prestart + toolbox compliance data fetched independently (up to 500 records, configurable range).
- **By-person tables** — prestarts (by `sks_rep`) and toolbox talks (by `facilitator`) with count, crew/attendance sign-off rate bar, sites covered, and last date.
- **Site coverage chart** — horizontal bar chart with PS (blue) / TB (green) split per site.
- **Range filter** — 7d / 30d / 90d / All time pills, persists within session.
- **Supervisor home tile** — 🛡 Safety tile added to supervisor mobile home screen.
- **Nav item** — "Safety Report" added under Operations, manager-only (`edit-only`).

---

# v3.10.28 — Home: Prestart + Toolbox tiles for staff

**Date:** 2026-05-26
**Scope:** Mobile home screen — staff tile grid.

- **Prestart tile** (🛡) and **Toolbox Talk tile** (📋) added to the staff mobile home screen. Tiles deep-link directly to the Safety page with the correct tab pre-selected.
- Staff home is now a 2×2 grid: My Schedule, Leave, Prestart, Toolbox Talk.

---

# v3.10.27 — Safety: form improvements + voice input

**Date:** 2026-05-25
**Scope:** Safety module — Prestart + Toolbox Talk form UX improvements.

- **Site field** — changed from `<select>` to `<input>` + `<datalist>`. Known sites autocomplete from the roster list; anything else can be typed freely (e.g. a new site not yet in the system).
- **"Subcontractor" renamed** to **"Principal Contractor / Customer"** on both Prestart and Toolbox Talk forms. DB column (`subcontractor`) unchanged — label only.
- **Pull from roster** — "Pull from roster" button on Crew sign-off (Prestart) and Attendance (Toolbox). Tapping it finds all staff rostered to the selected site on today's date and adds any not already listed. Only visible when a site is set.
- **Voice input (mic buttons)** — 🎤 button added next to all major text areas: Scope of works, Previous day issues, Hazards, Permits (Prestart); Key safety message, Items reviewed, Open actions, Hazards (Toolbox). Uses Web Speech API (en-AU). Tap to start, tap again to stop. Button turns blue while active. Transcribed text appends to existing field content. Falls back silently if browser doesn't support it (button not shown).

---

# v3.10.24 — Safety module: Prestarts + Toolbox Talks

**Date:** 2026-05-25
**Scope:** New feature — Safety section for SKS.

- **New page: Safety** — tab-based UI with Prestart Briefings and Toolbox Talks. Accessible to all staff (no supervisor unlock required to create or submit).
- **Prestart form** — site, date/time, rep/supervisor, scope of works, previous day issues, 19-item HRCW category checklist (NSW WHS Regulation Schedule 3), SWMS references, hazards, permits, crew sign-off with optional signature pad, optional photos (max 8, resized to 1600px, base64 inline).
- **Toolbox Talks form** — site, date/time, facilitator, topic, safety message, items reviewed, open actions, hazards, SWMS references, next meeting date, attendance sign-off with optional signature pad, optional photos.
- **Draft / Submit workflow** — records start as drafts, submitted flag locks the form. Two-tap arming for delete (no `confirm()` dialogs).
- **Offline support** — writes queue to localStorage when offline or on network error, auto-replay on reconnect.
- **Navigation** — "Safety" added to sidebar Operations section and mobile More drawer (all-staff visible).
- **Database** — `prestarts` and `toolbox_talks` tables were already applied to SKS Supabase. Both added to `ORG_TABLES` for auto org_id filtering.
- **New file:** `scripts/safety.js` (self-contained — photo, signature pad, offline queue all inlined).

---

# v3.10.23 — Home screen: fix schedule always blank for staff

**Date:** 2026-05-24
**Scope:** Staff home screen schedule — critical bug fix.

- **Root cause** — `home.js` checked `window.STATE` and `window.isManager` in 5 places. Both are always `undefined` because `STATE` and `isManager` are declared with `const`/`let` (not `var`) and only `var` globals attach to the `window` object. Result: `getUserScheduleRow()` always returned `[]`, `currentWeekKey()` always fell back to the date formula (wrong week on Sundays), and `isManagerSession()` always returned `false`. Staff saw "Nothing rostered" regardless of what data was in the DB.
- Fixed all 5 occurrences to use direct variable references (`typeof STATE !== 'undefined'`, `typeof isManager !== 'undefined'`).

---

# v3.10.22 — Temp diagnostic build (internal)

**Date:** 2026-05-24
**Scope:** Debugging — not visible to end users.

- Added name/week/row-count diagnostic to "Nothing rostered" tile to identify root cause. Removed in v3.10.23.

---

# v3.10.21 — Auto-reload on SW update + version chip

**Date:** 2026-05-24
**Scope:** Update delivery + diagnostics.

- **SW-triggered page reload** — when the new service worker activates it now broadcasts `SW_ACTIVATED` to all open pages, which immediately call `location.reload()`. Previously `skipWaiting` took over the network layer but old JS kept running in memory until the user manually closed and reopened the app — meaning every fix shipped since v3.10.18 never landed for active sessions.
- **Version chip** — `v3.10.x` now appears in the status bar (right side of the Updated row) so it's easy to confirm which build is actually running on device.

---

# v3.10.20 — My Schedule: week nav active after early render

**Date:** 2026-05-24
**Scope:** Staff schedule week navigation.

- **Week nav buttons no longer stuck disabled** — when a staff user tapped Schedule before `initApp()` finished building the `globalWeek` options list, `renderSchedule()` ran with an empty options array, computed `currIdx = -1`, and rendered both ‹ › buttons as `disabled`. They stayed disabled because `initApp()` never re-rendered the schedule page after the week selector was built. Fixed by calling `renderSchedule()` at the end of `initApp()` when the current page is 'schedule'.

---

# v3.10.19 — Fix: "Saving…" badge permanently stuck for staff

**Date:** 2026-05-24
**Scope:** Save indicator / push subscription edge case.

- **`sbFetch` 4xx leak fixed** — when a non-GET request fails with a 4xx client error (e.g. push subscription POST rejected by RLS), `_pendingWriteCount` was incremented but never decremented because the 4xx path fell through to `throw err` without clearing the counter. The "↑ Saving…" badge stayed on screen indefinitely. Now decrements and clears the indicator before throwing.

---

# v3.10.18 — My Schedule: fix schedule always blank for staff

**Date:** 2026-05-24
**Scope:** Staff schedule — critical bug fix.

- **Root cause fixed** — `renderSchedule()` checked `window.isManager` to detect staff mode, but `isManager` is declared with `let` (not `var`) so it is never on the `window` object. `window.isManager` was always `undefined`, the condition always evaluated to `false`, and staff fell through to the dropdown path — reading an empty hidden picker and rendering "Select your name above" with no way to select. Changed to `!isManager` (direct reference).

---

# v3.10.17 — My Schedule: never blank for staff

**Date:** 2026-05-24
**Scope:** Staff schedule reliability — the core app use-case.

- **`renderSchedule()` now self-sufficient for staff** — instead of relying on the `schedule-person` dropdown being pre-populated by `refreshPersonSelects()`, non-manager renders always derive the name directly from `sessionStorage.eq_logged_in_name` + fuzzy match against `STATE.people`. This eliminates the timing race between the early home render and the sequential data loads — staff always see their schedule regardless of when they navigate there.
- **`refreshPersonSelects()` called early** — still called right after `loadFromSupabase()` so the dropdown is in sync for manager-mode restore, but it's no longer the critical path for schedule display.
- **Person picker hidden for staff on mobile** — `body:not(.manager-mode) #page-schedule .filter-row { display: none }` removes the "Select your name above" prompt from non-manager sessions. Staff should never see it.

---

# v3.10.16 — Staff mobile nav: 4-item bar + stripped More drawer

**Date:** 2026-05-24
**Scope:** Staff mobile navigation.

- **Bottom nav** — staff now see 4 items instead of 2. The three previously-hidden supervisor slots are repurposed: `mnav-schedule` → ⌂ Home (unchanged), `mnav-roster` → 📅 Schedule, `mnav-dashboard` → ✈ Leave. Calendar stays hidden.
- **Active state** — `mobileNav()` maps page ids to the correct repurposed button for staff: 'schedule' lights up the Schedule button (roster slot), 'leave' lights up the Leave button (dashboard slot). Manager mode uses original mapping.
- **More drawer** — staff now see only: Contacts · supervisor lock button · Privacy Notice · Log out. Everything else (Dashboard, Calendar, Sites, Supervision, Leave, Timesheets, Import/Export, Help, Job Numbers, Apprentices, Trial Dashboard, section dividers and labels) is hidden via new `manager-only` CSS class, visible only when `body.manager-mode` is active.

---

# v3.10.15 — Home screen: show immediately for mobile staff

**Date:** 2026-05-24
**Scope:** Staff mobile experience — load time.

- **Early render** — staff on mobile now see the home screen as soon as schedule data is ready, without waiting for supervisor-only sequential loads (leave request queue, leave CC list, job numbers, apprentice data). Each of those is a separate Supabase round-trip that staff don't need on the home screen. `mobileNav('home')` is called right after `loadFromSupabase()` completes; the background loads continue and a silent re-render runs when they finish.
- `STATE.currentWeek` is set early (same formula as the full week-selector block) so `home.js` reads the correct week key before the selector is built.

---

# v3.10.14 — Home screen: fix shift lookup on Sunday

**Date:** 2026-05-24
**Scope:** Staff home screen — next-shift pill on Sunday.

- **Sunday edge case** — `findNextShiftInWeek` was returning null on Sundays because `todayIdx = 6 > 4` triggered an early exit. But `initApp()` already points `STATE.currentWeek` at next Monday on Sundays, so all five weekdays are upcoming. Fix: only advance the start index on weekdays (`todayIdx <= 4`); on weekends start from 0 so Monday's shift is correctly returned as the next shift.

---

# v3.10.13 — Mobile week picker tidy + Leave tile opens request modal

**Date:** 2026-05-24
**Scope:** Mobile polish + staff home screen UX.

- **Week picker** — "Week Starting DD Month YYYY" label hidden on mobile; dropdown + ‹ › arrows remain, no wrapping
- **Leave tile** — tapping Leave on the staff home screen now navigates to the leave page and immediately opens the new leave request modal, skipping the list view

---

# v3.10.12 — Home screen: fix shift lookup for partial gate names

**Date:** 2026-05-24
**Scope:** Bug fix — home screen shift pill and count.

- `getLoggedInName()` now fuzzy-matches the sessionStorage name against `STATE.people`, mirroring the same resolution logic in `refreshPersonSelects()`. Fixes "No shifts this week" when the access gate stores a shorter name (e.g. "Phillip") than the full people record ("Phillip Smith").

---

# v3.10.11 — Home screen: navigation fix, week nav, tidy-up

**Date:** 2026-05-24
**Scope:** Staff mobile home screen polish.

- **Navigation fixed** — ⌂ Home button in bottom nav for staff; navigating away and back no longer loses the home screen
- **Week navigation** — ‹ › buttons on home screen to browse any week; shift pill and shift count update per week; "THIS WEEK" badge shows when on current week
- **Timesheets tile removed** — staff don't self-enter; tile was misleading
- **Site lead removed from day cards** — removed the static supervisor name from My Schedule day cards (not reliable for who's physically on site); co-worker 🤝 line has room to breathe
- **nav repurpose** — `mnav-schedule` repurposed as Home for staff; restored to My Week when supervisor unlocks

---

# v3.10.10 — My Schedule: show co-workers at same site

**Date:** 2026-05-24
**Scope:** My Schedule day cards — crew awareness.

- Each day card now shows a 🤝 line with the name(s) of anyone else rostered to the same site that day
- Only shown when total crew at that site is ≤ 3 (1–2 co-workers) — larger teams are hidden to keep the cards clean

---

# v3.10.9 — Week default: always open on current week

**Date:** 2026-05-24
**Scope:** Week selector default on page load.

- Page always opens on this week's Monday — stale localStorage value no longer overrides the default. Supervisors who reviewed an old week last session will now land on the current week on next load.

---

_Rolling changelog for `sks-nsw-labour` — the SKS deployment of EQ Solves Field. EQ owns the code; this repo is the stable deploy lane for SKS, forked from `eq-solves-field` so the live SKS app isn't churned by active EQ Field development. Most recent release first. Older entries below were written when this code lived in `eq-solves-field` and reference its demo→main flow — that flow no longer applies here._

_Consolidated 2026-04-28: all per-version `CHANGELOG-v3.4.X.md` files merged in and removed._

---

# v3.10.8 — Mobile home screen for staff

**Date:** 2026-05-24
**Scope:** Staff mobile experience — new tile-based home screen.

- **Home screen** — staff on mobile (≤768px) land on a tile screen instead of the raw schedule page. Shows a personalised greeting ("G'day, {first name}" on first visit of the day, date thereafter), a next-shift pill, and 3 action tiles: My Schedule, Timesheets, Leave
- **Supervisor variant** — managers on mobile get a 5-tile layout (Schedule, Timesheets, Leave, Team, Reports) plus an action strip showing pending leave requests ("All clear" or "X requests to approve")
- **Cog drawer** — ⚙ button opens a slide-up sheet with role-appropriate links to all other pages; staff get Schedule, Leave, Privacy, Log out; supervisors get the full nav (Edit Roster, Contacts, Sites, Job Numbers, etc.)
- **Offline aware** — banner shown when `navigator.onLine === false`; re-renders on connectivity change
- **Topbar + bottom nav hidden** — home page runs edge-to-edge with no chrome; both restored on any navigation away
- **New files:** `scripts/home.js`, `styles/home.css`

---

# v3.10.7 — Apprentice timesheets: TAFE counts toward 40h + approval indicator

**Date:** 2026-05-24
**Scope:** Apprentice timesheet accuracy + supervisor approval workflow.

- **TAFE = 40h total** — rostered TAFE days count as 8h each toward the weekly total for apprentices. A 32h work week with one TAFE day now shows 40h (green) instead of 32h (red). Completion check only tests workable days for the ≥8h/day rule.
- **Approval chip** — subtle `✓` (green) next to the APP badge once a supervisor marks a row approved; faint `○` shown to managers for rows not yet approved. Tap to toggle. Saves `approved`, `approved_by`, `approved_at` to the timesheets row.
- **DB migration** — `2026-05-24_ts_apprentice_approval.sql` adds `approved`, `approved_by`, `approved_at` columns to `timesheets` table.

**Requires:** run `2026-05-24_ts_apprentice_approval.sql` on SKS Supabase before deploying.

---

# v3.10.6 — Employee mobile: clean topbar, no irrelevant nav

**Date:** 2026-05-24
**Scope:** Staff (non-manager) mobile view polish.

- **Topbar declutter** — week picker hidden on My Schedule for employees (in-content ‹ › nav is sufficient); `margin-left:auto` on actions keeps sync button pinned right
- **Mobile nav** — Home, Roster, Calendar hidden for non-managers; only My Week + More shown
- **Teams filter** — suppressed on My Schedule for non-managers (supervisor-only tool)
- **Supervisor restore** — `applyManagerMode()` un-hides all `data-staff-hidden` elements if a supervisor unlocks mid-session on the same device

---

# v3.10.5 — My Schedule: week navigation, all-week banner, swipe

**Date:** 2026-05-24
**Scope:** My Schedule UX improvements — the #1 most-visited page.

- **Week navigation** — ‹ › arrows at top of schedule; same week state as global picker
- **All-week banner** — navy "All week: Site Name + address + Maps button" banner when Mon–Fri all match one site
- **Swipe to change week** — 60px horizontal swipe on day cards navigates prev/next week on mobile
- Hero meta row cleaned up (removed redundant "w/c [week]" — now shown in the nav row)

---

# v3.10.4 — Push notifications: roster change alerts for staff

**Date:** 2026-05-24
**Scope:** Web Push notifications when a supervisor changes tomorrow's roster.

- New Supabase table `push_subscriptions` stores per-device browser push subscriptions
- New Supabase Edge Function `send-roster-push` sends Web Push via VAPID (npm:web-push)
- Staff see a friendly opt-in banner 3 s after login — "Get notified when your roster changes"
- Supervisor saves a roster cell for tomorrow → edge function fires → staff phone gets a push
- Push shows: "Tomorrow (Day): Site Name" — tapping opens the app
- Expired subscriptions (410/404) auto-pruned from DB
- `sw.js` push + notificationclick handlers added

---

# v3.10.3 — Sidebar restructure: Job Numbers live, Pipeline section, Testing removed

**Date:** 2026-05-24
**Scope:** Nav sidebar cleanup — reduce crowding, promote Job Numbers, clean up hidden pages.

- Job Numbers promoted to Operations section — BETA label removed, now live for all supervisors
- Pipeline and Resources moved to their own "Pipeline" section — Resources no longer sub-indented
- Testing section removed entirely — Trial Dashboard and Apprentices hidden from nav
- Pipeline NEW badge removed (it's been live long enough)

---

# v3.10.2 — My Schedule: today highlight + past day fade

**Date:** 2026-05-24
**Scope:** My Schedule visual improvements — immediate day orientation for staff.

- Today's row: navy left border, light navy tint on day column, "TODAY" badge in SKS purple, bold date
- Past days: 50% opacity so staff focus lands on today and forward

---

# v3.10.1 — Resource Allocation: instant repeat-visit render

**Date:** 2026-05-24
**Scope:** Eliminate loading flash when navigating back to Resource Allocation.

- `renderPipelineResource()` now checks `_lastLoaded` before fetching
- If data exists: paints immediately with cached state, then background-refreshes silently
- First visit still waits for data (unavoidable), all subsequent visits are instant

---

# v3.10.0 — Resource Allocation: polish pass

**Date:** 2026-05-24
**Scope:** 11 UX improvements to the Resource Allocation module following audit.

- Float placeholder ghost box when chart is detached (replaces bare dock button)
- Confirmed jobs empty state with 🏗 icon and call to action
- Smart needs-alloc empty state — suppressed when confirmed jobs already exist
- Partial roster push failure feedback ("Partial — N of M written")
- Headcount label moved to left edge with dark pill background
- CSS hover tint on job rows and alloc cards (injected `<style>`, survives re-renders)
- Mini timeline tooltip: start date, duration, end date on hover
- Labour assign panel: white background
- N-of-M assigned badge in expansion header (green = full, amber = partial)
- Last-refreshed timestamp + ↻ Refresh button in capacity chart hero
- Auto-scroll new confirmed job row into view after Save & Confirm

---

# v3.9.0 — Resource Allocation: audit fixes

**Date:** 2026-05-24
**Scope:** Four issues caught in post-build audit of the Resource Allocation module.

- Float button hidden when chart is already floating
- Confirmed jobs table gets `overflow-x:auto` wrapper for narrow screens
- Dead code removed: `_statPill()` (unused badge builder)
- Dead code removed: `_initSplitter()` + `_splitPct` (old drag-splitter remnant)

---

# v3.4.92 — Pipeline: final polish sprint

**Date:** 2026-05-24
**Scope:** All remaining items from 10/10 review — one P0 bug fix, three UX improvements, one architecture cleanup.

### Bug fix (P0)
- **Confirmed stage protection on re-import** (`pipeline-import.js`) — importing from Smartsheet now preserves the `confirmed` stage for jobs locked in via Resource Allocation. Previously, a Confirmed job at 90% probability would be reset to `likely` on the next import. The upsert now checks `_existingByRef` and forces `stage = 'confirmed'` for any tender that was already confirmed before the import ran.

### Missing import count (`pipeline-import.js`)
- Tenders in the DB but absent from an import now have `missing_import_count` incremented. At **2 consecutive missed imports** the tender is automatically archived (`archived_at` set, `stage = 'archived'`). Confirmed tenders are excluded from this logic — they don't appear in open-tenders exports and should not be auto-archived.

### UX
- **Last import timestamp** — shown on both the Kanban header bar ("Last import: 3h ago") and the Import page header. Pulled from `tender_import_runs`. Filename is shown as a tooltip on Kanban, inline on Import page.
- **Confirmed tile clickable** (`pipeline.js`) — Confirmed count tile on the Kanban now navigates to Resource Allocation on click. Label updated to "→ Resources".
- **Single Save button in enrichment panel** (`pipeline.js`) — "Save estimates" and "Save nominations" consolidated into one "Save" button (`savePanel`). Saves enrichment and nominations in parallel. Cleaner panel, one fewer tap.

### Architecture
- **`updated_at` double-write removed** (`pipeline-resource.js`) — `saveAlloc` now sends `updated_at` only on INSERT. PATCH omits it; the `trg_tender_enrichment_updated_at` trigger handles it on UPDATE.
- **ORG_TABLES guard comment** (`app-state.js`) — explicit warning not to add `tender_enrichment` or `nominations` to `ORG_TABLES`. They have no `org_id` column; sbFetch would append `?org_id=eq.UUID` to GETs causing a 400.

Version stamps: `APP_VERSION = '3.4.92'`, SW cache `eq-field-v3.4.92`.

---

# v3.4.91 — Pipeline: Won column "· all shown" label when value filter is active

**Date:** 2026-05-24
**Scope:** UX clarification — value filter applies to Watch and Likely only.

- **Won column header** — when a value filter (≥$100k etc.) is active, the Won column now shows `· all shown` next to the `100%` label. Won tenders are always visible regardless of the value filter because they are committed work tracked for resource allocation, not prospects being screened.
- **Value filter tooltip** — `title` attribute added: "Applies to Watch and Likely only — Won tenders always shown".

No logic changes. The filter behaviour (Won exempt) was already correct from v3.4.90; this release makes it legible.

Version stamps: `APP_VERSION = '3.4.91'`, SW cache `eq-field-v3.4.91`.

---

# v3.4.90 — Pipeline bug fixes (Won filter, UUID integrity, import diff, pipeline_enabled nav)

**Date:** 2026-05-24
**Scope:** Four correctness fixes identified during post-ship pipeline review.

- **Won tenders now always visible on Kanban** — value filter (`≥$100k` default) was applied to all stages including Won, hiding any Won tender with a null or sub-$100k quote_value. Won is now exempt: only Watch/Likely/Confirmed entries are filtered by value. `pipeline.js:_buildHtml`.
- **Fix UUID corruption in Resource Allocation saves** — `saveAlloc` and `_upsertNom` were calling `parseInt(tender_id, 10)` on a UUID string, yielding a truncated integer (e.g. `550` from `"550e8400-…"`). POST to `tender_enrichment` would fail with *"invalid input syntax for type uuid"* on first save. Both callers now pass the raw UUID string. `pipeline-resource.js`.
- **Fix import diff double-counting** — when a tender had both a stage change and a value change in the same import, it was pushed into both `stageChanged` and `valueChanged` arrays in `diffAgainstExisting`. The preview table counted it twice. Now stageChanged takes priority; the row appears once. `tender-parser.js`.
- **Wire `pipeline_enabled` from app_config** — pipeline nav items (`Pipeline` + `Resources`) are now hidden by default (`TENANT.PIPELINE_ENABLED = false`) and shown only when `app_config.pipeline_enabled = 'true'` for the tenant. Flip this row in Supabase when ready to go live. `app-state.js`.

Version stamps: `APP_VERSION = '3.4.90'`, SW cache `eq-field-v3.4.90`.

---

# v3.4.89 — Pipeline stage mover pills

**Date:** 2026-05-24
**Scope:** UX — move a tender between Watch / Likely / Won from within the enrichment panel without closing it.

- **Stage mover pills** in enrichment panel — current stage highlighted, tap another to move. Uses `onpointerdown` (iOS-safe). `pipeline.js:_panelHtml`, `moveStage()`.
- Fix `_openPanel` → `openPanel` typo in `_buildHtml` restore-panel path.

Version stamps: `APP_VERSION = '3.4.89'`, SW cache `eq-field-v3.4.89`.

---

# v3.4.88 — Pipeline value filter + timesheet Fill Week desktop banner

**Date:** 2026-05-24
**Scope:** Two independent improvements shipped together.

- **Pipeline value filter** — Kanban defaults to hiding tenders below $100k. Dropdown lets user switch to All / ≥$100k / ≥$250k / ≥$500k / ≥$1M. `pipeline.js`.
- **Fill Week desktop banner** — "Fill Week" confirmation banner now renders on desktop (was mobile-only). Always re-renders timesheet card after save to keep UI in sync. `timesheets.js`.

Version stamps: `APP_VERSION = '3.4.88'`, SW cache `eq-field-v3.4.88`.

---

# v3.4.87 — Resource Allocation + Import guardrail

**Date:** 2026-05-24
**Scope:** Pipeline Phase 4 — firm up Won tenders into confirmed jobs with resource planning; import guardrail for sub-$100k tenders.

- **Resource Allocation screen** (`pipeline-resource.js`) — new supervisor-gated page accessible from nav under Pipeline.
  - **Needs Allocation** — lists all Won tenders. Expand each row to fill in: start date, est. hours, duration (weeks), peak workers (auto-suggested from hours÷weeks÷38h), PM + Supervisor nominations. Save or Save & Confirm → moves stage to `confirmed`.
  - **Capacity Planning** — 26-week demand forecast bar chart. Each bar = total peak workers committed that week across all Won+Confirmed tenders with enrichment. Red threshold line at active headcount count. Gap weeks (demand > headcount) highlighted in red.
  - **Confirmed Jobs** — summary list of confirmed tenders with start date, workers, hours, PM. Running total value locked in.
- **Import guardrail** (`pipeline-import.js`) — sub-$100k tenders are now split before diff. Main diff only shows above-threshold rows. A "N tenders below $100k will be skipped" notice appears with an "Include anyway" toggle. Confirm button counts update when toggle is changed.
- Worker suggestion formula: `ceil(est_hours / (duration_weeks × 38))` — pre-fills peak workers field, user can override.

Version stamps: `APP_VERSION = '3.4.87'`, SW cache `eq-field-v3.4.87`.

---

# v3.4.86 — Hotfix: vendor SheetJS (CSP blocks CDN)

**Date:** 2026-05-24
**Scope:** Hotfix — SheetJS was lazy-loaded from `cdn.jsdelivr.net` which is blocked by the app's Content-Security-Policy `script-src` directive. Vendored `xlsx.full.min.js` locally instead.

- **Vendor xlsx.full.min.js** — `scripts/xlsx.full.min.js` (881KB, SheetJS v0.18.5). Reference in `pipeline-import.js` updated from CDN URL to `/scripts/xlsx.full.min.js`.
- **SW PRECACHE** — added `tender-parser.js`, `pipeline-import.js`, `pipeline.js` (were missing from v3.4.85 precache).

Version stamps: `APP_VERSION = '3.4.86'`, SW cache `eq-field-v3.4.86`.

---

# v3.4.85 — Tender Pipeline live UI

**Date:** 2026-05-24
**Scope:** Phase 3 — full pipeline UI wired to Supabase. Import screen, Kanban, enrichment panel, PM/supervisor nominations. Feature is supervisor-gated (edit-only nav). Migration applied to SKS prod in Phase 2 (same session).

- **Pipeline Kanban** — Watch / Likely / Won columns. Each card shows ref, job name, client, probability, due date, quote value, and any enrichment/nomination tags. Dept + vertical filters. Pipeline total value strip.
- **Import screen** — xlsx drag-drop or click to upload. Lazy-loads SheetJS from CDN. Parses with `SKS_TENDER_PARSER`, diffs against existing tenders, shows New / Changed / Missing preview table. Confirm → upsert to `tenders` + insert `tender_import_runs`.
- **Enrichment panel** — side panel on card click: est. hours, peak workers, start date (est), duration weeks, confidence notes. Saves to `tender_enrichment` (upsert).
- **Nominations** — PM (Project Management category) + Supervisor (Supervisor category) pickers in the same panel. Saves to `nominations` table.
- **ORG_TABLES** — `tenders` and `tender_import_runs` added so sbFetch auto-applies org_id filter on GET and stamps on POST.

Version stamps: `APP_VERSION = '3.4.85'`, SW cache `eq-field-v3.4.85`.

---

# v3.4.84 — Audit fixes + tender pipeline foundation

**Date:** 2026-05-24
**Scope:** Four code-quality findings from an internal audit, plus the schema and parser for the tender pipeline (dark — not yet wired into the UI or DB).

- **`netlify/functions/verify-pin.js` — constant-time HMAC compare.** Previous implementation used `===` string comparison, which leaks timing information and is susceptible to timing attacks on the PIN. Replaced with `crypto.timingSafeEqual()` using `Buffer.from()` on both sides, matching the pattern already in `approve-leave.js`.
- **`.gitignore` added.** Baseline patterns for OS/editor noise and the existing `__perm_test` file. Additive only — no files un-committed.
- **`PEOPLE_GROUPS` constant extracted to `scripts/app-state.js`.** Previously defined inline in 6 separate places across batch, people, roster, auth, and import-export. Now a single constant; all six sites import from `app-state.js`. Pure refactor — no semantic change.
- **Apprentices `skills_ratings` reads/writes routed through `sbFetch()`.** Two direct fetch calls in `scripts/apprentices.js` were bypassing the tenant's `TENANT_DISABLED_TABLES` gate and the offline IDB queue. Both calls now go through `sbFetch()`.
- **Tender pipeline — schema + parser (dark).** `migrations/2026-05-22_tender_pipeline.sql` defines 6 tables, 4 enums, 1 view, 2 trigger functions, and 25 RLS policies for the upstream labour-planning pipeline. `scripts/tender-parser.js` parses the SKS "Open 12m Tenders (State) - NSW" Smartsheet xlsx export into normalised tender rows. Neither file is wired into the app UI; the migration has not been applied to any Supabase project. Both ship in this release as inert code, pending Phase 2 (schema apply) and Phase 3 (UI build).

Version stamps: `APP_VERSION = '3.4.84'`, SW cache `eq-field-v3.4.84`.

---

# v3.4.83.3 — Docs sweep (Help tab + deploy.md)

**Date:** 2026-05-23
**Scope:** Doc-only release after Royce asked to update all relevant substrate and markdown files with the v3.4.83 → v3.4.83.2 changes. No functional code changes; version bumped purely for SW cache-bust consistency with the established pattern.

- **Help tab → Supervisor Guide → new "Timesheets on Your Phone" card.** Covers the v3.4.83 card-stack layout, the 📍/📝 schedule bubble (known site vs free-text roster cell), the `[8/4/0]` hours chip, and the two-tap + Undo Fill Week flow. Plain English per CLAUDE.md voice guide; no engineering jargon in user-facing copy.
- **`deploy.md` rewritten.** The previous version stopped at v3.3.5 and referenced "Demo site: eq-solves-field.netlify.app" alongside "Netlify auto-deploys both sites" — both stale since the eq-solves-field / SKS fork. New version documents:
  - The post-fork PR-to-main deploy flow (no demo branch in this repo).
  - The required per-release 4-file version bump (`app-state.js`, `sw.js`, `index.html`, `CHANGELOG.md`) and why the SW cache key is what forces phones to refetch.
  - The current Netlify env-var list (including the optional `EMAIL_FROM` added in v3.4.39).
  - Supabase edge functions (`supervisor-digest`, `tafe-weekly-fill`, `ts-reminder`) — previously absent from the doc entirely.
  - Smoke-test checks for both desktop and phone Timesheets, including the Fill Week two-tap + undo path.
  - Troubleshooting entries for the v3.4.83-era mobile gotchas (the `closest('tr, .ts-mday')` selector requirement; iOS `pointerdown` vs `touchstart`).
- **Memory substrate updated** in `~/.claude/projects/C--Projects-sks-nsw-labour/memory/` (out-of-repo, not shipped with the build): four new entries — `feedback-ui-safety-pattern`, `feedback-ios-touch-events`, `feedback-mobile-render-shared-handlers`, `project-timesheets-source-of-truth` — plus the index refresh.

Version stamps: `APP_VERSION = '3.4.83.3'`, SW cache `eq-field-v3.4.83.3`.

---

# v3.4.83.2 — Phase 4a live-test fixes + Fill Week safety model

**Date:** 2026-05-23
**Scope:** Two bugs caught by Royce on `sks-nsw-labour.netlify.app` immediately after v3.4.83.1 went live, plus the safety design for the new Fill Week affordance that those bugs were blocking him from reaching.

## Bug fixes

- **Hours quick-select chips fire on touch.** Tapping the `8` chip did nothing on iOS because the previous `ontouchstart="event.preventDefault()"` suppressed the synthesized `click` event entirely. Switched to a single `onpointerdown="event.preventDefault();_pickTsHoursChip(...)"` handler that fires for both mouse and touch *before* any blur/focus shift, then runs the pick directly. Same code path for desktop — slightly more robust there too. Symptom on phone: chip popover appeared, tap was visually acknowledged, but the hours input stayed empty and no save fired.
- **Mobile re-renders after every save.** `onTsCellChange` was calling `updateTsRowTotal` which only updates a desktop-only `#tst-<name>` element — on phone the card total / status icon / variance chip / **Fill Week banner** all stayed stale until you reloaded. Now `onTsCellChange` triggers a full `renderTimesheets()` if `_isPhoneViewport()` is true. Card-expansion state is preserved via the existing `_tsExpandedCards` Set so the supervisor's open row stays open. Desktop save path unchanged.

## Fill Week safety model

Royce wanted "easy but stops accidental clicking" on the Fill Week banner that appears once Monday is filled. Shipped three layers of protection — no modal prompts (fully reversible):

- **Two-tap arming on the button.** First tap → button label becomes "Tap again — confirm", background turns amber with a soft pulse. Second tap within 3s fires `fillTsWeekFromMon`. If you don't follow through, the button auto-disarms after 3s. No modal dialog blocking the flow.
- **Undo toast for 5s after the fill.** Floats above the bottom nav with "✓ Filled Mon → Fri (D5384)" and an Undo button. Tap Undo → Tue–Fri restored to whatever they held before the fill (captured per-day at fill time). Audit-logged on both sides. Same pattern as Gmail's Undo Send.
- **Skips leave/TAFE days.** The old `fillTsWeekFromMon` silently wrote a job into roster-muted Tuesday cells — a quiet bug (cell would carry data the UI never showed). Now consults `_tsDayStatus` and only touches workable days. Undo only restores those same days.
- **Audit log entry** for both the fill and the undo — recoverable forever via the v3.4.76 revert button if you miss the 5s window.

The previous `window.confirm` overwrite prompt was dropped — two-tap covers the "are you sure?" purpose without a modal, undo covers the "I clicked too fast" purpose, and audit log covers the "I noticed an hour later" case. Three guards, none of them block the common case.

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
