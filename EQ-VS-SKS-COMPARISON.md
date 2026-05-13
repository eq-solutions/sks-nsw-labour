# EQ Field vs SKS — App Comparison & SKS Update Plan

**Date**: 2026-05-13
**Author**: claude (post-BATTLE-TEST closeout)
**Purpose**: consolidate everything we've learned on demo into a concrete SKS update plan, fold in PostHog/Clarity insights once Royce shares them.

---

## 1. Status snapshot

| App                 | Tenant role        | Domain                          | Branch              | Version (deployed) | Supabase Project     |
|---------------------|--------------------|---------------------------------|---------------------|--------------------|----------------------|
| **EQ Field (demo)** | EQ — SEED demo     | eq-solves-field.netlify.app     | `demo` (+ v3.4.59 in PR #45) | 3.4.58 → 3.4.59 | `ktmjmdzqrogauaevbktn` (SEED-only writes; no real reads) |
| **SKS NSW Labour**  | SKS prod (real)    | sks-nsw-labour.netlify.app      | `main`              | **3.4.44**         | `nspbmirochztcjijmcrx` |

**The gap**: SKS is **15 versions behind** demo. Last sync was PR #29 (~2 weeks ago, before the battle-test loop). Every fix shipped during BATTLE-TEST has been demo-only by hard-rule.

---

## 2. What's new on demo, not yet on main

### Code added (new files)

| Path                                                | Lines | Purpose                                                              | Port to SKS?   |
|-----------------------------------------------------|-------|----------------------------------------------------------------------|----------------|
| `scripts/presence.js`                               | 179   | Real-time editor cell presence — "Royce is editing Mon" outline      | **Yes** — multi-supervisor feature is more valuable on SKS than EQ |
| `migrations/2026-04-29_roster_presence.sql`         | 72    | Backing table + RLS for presence + pg_cron cleanup                   | **Yes** — required for presence.js to work |
| `migrations/2026-04-30_eq_realtime_publication.sql` | 67    | Adds `schedule` + `leave_requests` to `supabase_realtime` publication | **VERIFY FIRST** — SKS likely already has them (realtime has worked there forever); migration is defensive (`IF NOT EXISTS`) so safe to run anyway |
| `migrations/2026-05-13_roster_presence_rls_tighten.sql` | 55 | INSERT policy gated on real manager_name                             | **Yes** — apply after roster_presence migration |
| `scripts/release.mjs`                               | 89    | Atomic version bumper (banner + APP_VERSION + sw.js CACHE)           | **Yes** — dev tooling, no runtime impact |
| `BATTLE-TEST-2026-04-29.md`, `MELBOURNE-SCALE-DESIGN.md` | ~3,200 | Internal docs                                                  | **No** — repo-only, doesn't deploy |

### Files modified (need cherry-pick / merge)

13 files touched. Net: +1,445 / -67 lines on demo vs main. Full diff: `git diff origin/main..origin/demo`.

---

## 3. Bug fixes pending port — by severity

### 🔴 Critical — ship to SKS immediately

| #    | Ver     | File              | What it fixes                                                                 | SKS exposure |
|------|---------|-------------------|-------------------------------------------------------------------------------|--------------|
| #22  | v3.4.53 | `managers.js`     | `removeManager` filter used strict `!==`, leaving ghost rows on bigint ids   | **HIGH** — SKS uses bigint ids; this fix IS the SKS bug, not just a defensive change |
| #27  | v3.4.55 | `people.js`       | `removePerson` id-coercion (find + filter) + idempotency                     | **HIGH** — same bigint exposure as #22 |
| #40  | v3.4.58 | `sw.js`           | Cache error responses → users stuck on cached 500/404 during deploys         | **MEDIUM** — affects anyone with flaky network during a deploy window |
| #48  | v3.4.59 | `scripts/tafe.js` | `tafeIsHolidayForDay` off-by-one in Aus timezones                            | **MEDIUM** — manual "🎓 Apply TAFE Day" button fills cells on actual holidays |

### 🟡 Important — bundle with critical batch

| #       | Ver     | File                  | What                                                                       |
|---------|---------|-----------------------|----------------------------------------------------------------------------|
| #20     | v3.4.52 | `roster.js`           | `fillWeek` consistency (4 post-write behaviours align with `updateCell`)   |
| #24     | v3.4.54 | `leave.js`            | Per-id inflight guard against iPad double-tap (duplicate audit + emails)   |
| #17     | v3.4.51 | `leave.js`            | Defensive HTML escaping for record fields in email bodies                   |
| #18     | v3.4.59 | `leave.js`            | Subject CRLF strip (header injection defence)                              |
| #36     | v3.4.57 | `digest-settings.js`  | Optimistic-render race kill — no more checkbox flicker on toggle           |
| #39     | v3.4.59 | `digest-settings.js`  | Inline `onchange` → `data-id` + delegated listener (XSS hardening)         |
| #30-35  | v3.4.56 | `audit.js`            | Visible write failures + portable UTC CSV export + ID column               |
| #41     | v3.4.58 | `sw.js`               | PRECACHE silent install failure → `console.warn` for DevTools visibility   |

### 🟡 Auth surface — Royce approved Round 1, but eyeball before merge

| #       | Ver     | File         | What                                                                       |
|---------|---------|--------------|----------------------------------------------------------------------------|
| #45     | v3.4.59 | `auth.js`    | Token mint awaited (was fire-and-forget) — adds 100-300ms login latency, eliminates fast-clicker silent-email-drop race |
| #47     | v3.4.59 | `auth.js`    | Outer catch clears PIN input (was leaving it in DOM on network error)      |

### 🟢 Already on SKS — DON'T port

| #       | Where                         | Why it's safe to skip on SKS                                                 |
|---------|-------------------------------|------------------------------------------------------------------------------|
| #6, #9  | EQ realtime + polling gates   | SKS never had these gates — realtime + polling have always worked there      |
| #10     | EQ offline banner             | SKS already shows the offline banner — gate was EQ-only                      |
| #11 META| EQ-as-SEED behaviour          | SKS IS real, not a SEED. Don't change SKS to behave like demo                |

---

## 4. Tenant-aware items needing decisions

### 4a. roster_presence table — apply order

If shipping presence to SKS:
1. Apply `migrations/2026-04-29_roster_presence.sql` to **SKS Supabase** (`nspbmirochztcjijmcrx`).
2. Then apply `migrations/2026-05-13_roster_presence_rls_tighten.sql` to **same** project.
3. Same pair, in same order, to **EQ Supabase** (`ktmjmdzqrogauaevbktn`).
4. Realtime publication for `roster_presence`: included in step 1 — no manual `ALTER PUBLICATION` needed.

Test: open SKS in two browsers, focus the same cell, confirm the other browser shows "X is editing" outline within ~2s.

### 4b. tafe_holidays config — SKS already seeded?

Per BATTLE-TEST finding #14: `tafe_holidays` config is per-tenant in `app_config`. Demo / EQ tenant doesn't have a row (no school holidays seeded). **Need to verify SKS has its row**:

```sql
-- Run on SKS Supabase via SQL editor:
SELECT key, value FROM app_config WHERE key = 'tafe_holidays' AND org_id = '<SKS-org-id>';
```

If empty: seed the NSW 2026 school holiday calendar (see `migrations/2026-04-16_tafe_day_and_holidays.sql`).

### 4c. SKS realtime publication — verify before re-applying

Per BATTLE-TEST: `migrations/2026-04-30_eq_realtime_publication.sql` ADDS `schedule` and `leave_requests` to the realtime publication. Migration is wrapped in `DO $$ IF NOT EXISTS … $$;` blocks so it's safe to re-run. But verify SKS state first:

```sql
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

Expected on SKS: `roster_presence` (after 4a), `schedule`, `leave_requests`. If `schedule` or `leave_requests` is missing, the migration adds them. If they're already there, the migration is a no-op.

---

## 5. PostHog & Clarity — fold-in points

Three places where insights should drive priority. **I need your data dump** to populate these — I haven't seen the actual events yet.

### 5a. Bug-fix prioritisation
If PostHog shows users hitting the cached-error path (finding #40 — SW serves 404/500 from cache during a deploy window), bump #40 above the other 🔴 in the port batch. If nobody hits it: still ship, but it's not the urgent one.

**Questions for the data**:
- Are there spikes of `error_*` or `unhandled_promise` events during deploy windows?
- Any users on iOS Brave seeing repeat failures?

### 5b. UX changes from Clarity heatmaps
Most-visited pages:
- Roster editor (week-grid)
- Leave (request + approve)
- Supervision (managers + digest)

**Questions for the heatmaps**:
- Where do users rage-click? Common spots: tiny dropdowns, narrow date pickers, the "approver" picker on leave.
- Which buttons get hovered-but-not-clicked? (Discoverability gap.)
- Where do sessions abandon? (Friction signal.)
- Are mobile sessions completing the same flows as desktop?

### 5c. Feature gaps from session recordings
Trying-to-do-but-can't:
- Search for a person by name across multiple pages (today's gate dropdown is one search, no global search)
- See a single person's full history (audit + leave + timesheet + roster — today they're 4 separate views)
- Bulk-edit a week (today it's cell-by-cell or "Fill Week" which is single-value)

**Questions for recordings**:
- What does a user do RIGHT BEFORE they close the tab without completing the visible workflow?
- Any patterns of opening / closing / opening the same modal? (Friction with the data structure.)
- Are supervisors flipping between weeks more than once per minute? (Suggests the forecast view from Melbourne design has demand even at SKS scale.)

---

## 6. Recommended SKS update plan

### Option A — single big bundle (recommended)
**One PR** to main that brings v3.4.45 → v3.4.59. Big merge but well-trodden — every commit on demo has been live for 2-14 days, has its own changelog block, and was reviewed by you en route to demo.

Pros:
- Catches up in one go.
- Atomic — SKS goes from 3.4.44 → 3.4.59 in one deploy.
- Easier to reason about ("SKS is now on demo's HEAD") than tracking a partial port.

Cons:
- Single big review surface (but each commit is small).
- Bisecting a regression means walking 15 commits.

### Option B — phased over 2-3 weeks
**Three PRs**:
1. **Critical batch** — #22, #27, #40, #48, #45, #47 (auth) + RLS migration. ~6 files, ~150 lines.
2. **Polish batch** — #17, #18, #20, #24, #30-35, #36, #39, #41. ~5 files, ~200 lines.
3. **Feature batch** — `presence.js` + presence migration + `release.mjs`. ~3 files, ~200 lines.

Pros:
- Easier to verify each phase in isolation.
- Lower per-PR risk.

Cons:
- 2-3 weeks of context switching.
- Critical fixes wait if PR 1 stalls behind something else.

### Option C — selective port (data-driven)
Wait for PostHog/Clarity dump, then port ONLY what insights say matters:
- If users aren't double-tapping leave → skip #24.
- If users aren't editing in pairs → skip presence.
- If iOS Brave never hits the cached-error path → skip #40 for now.

Pros:
- No wasted code on SKS.
- Effort matches user impact.

Cons:
- Most bugs aren't visible in analytics until they cause a support ticket. Skipping #22 / #27 because "we haven't seen ghost rows in PostHog" is dangerous — they're silent corruptions, not user-facing errors.

---

## 7. Open question for Royce

**Which path?** Recommend Option A (single bundle) for these reasons:
- The 15-version gap is uncomfortable already — a phased port doubles the time SKS is behind.
- Every commit on demo has been individually reviewed via PRs #34-44; the bundle is just "merge them all at once."
- PostHog/Clarity insights are better folded into a **second**, smaller wave AFTER the catch-up — that wave is where UX changes happen, not bug-fix backports.

**Suggested flow**:
1. **Today / this week**: ship Option A → SKS catches up to v3.4.59.
2. **Next week**: Royce shares PostHog/Clarity insights → consolidated UX-focused wave (v3.4.60-ish) targeting friction points seen in the data.
3. **Then**: start Wave 1 of Melbourne-scale (Projects table — pending §7 Q1 decision).

---

## 8. Appendix — full version log of demo vs main

| Ver     | Date        | What                                                          | On main? |
|---------|-------------|---------------------------------------------------------------|----------|
| 3.4.59  | 2026-05-13  | BATTLE-TEST Round 1 closeout (5 fixes + #48 + RLS migration)  | ❌ (PR #45 open) |
| 3.4.58  | 2026-05-12  | sw.js: don't cache error responses; visible PRECACHE fails    | ❌       |
| 3.4.57  | 2026-05-12  | digest toggle: kill optimistic-render race                    | ❌       |
| 3.4.56  | 2026-05-12  | audit.js: visible write failures + portable CSV export        | ❌       |
| 3.4.55  | 2026-05-11  | people.js removePerson: id-coercion + idempotency             | ❌       |
| 3.4.54  | 2026-05-11  | leave handlers: per-id inflight guard against double-tap      | ❌       |
| 3.4.53  | 2026-05-11  | managers.js removeManager: id-coercion fix on filter           | ❌       |
| 3.4.52  | 2026-05-10  | roster.js fillWeek consistency                                | ❌       |
| 3.4.51  | 2026-05-10  | leave email: defensive HTML escaping for record fields        | ❌       |
| 3.4.50  | 2026-05-10  | offline banner gate; surface EQ-as-SEED-demo finding          | ❌ (partially N/A on SKS) |
| 3.4.49  | 2026-05-09  | EQ tenant sync fully broken; fix polling gate                 | ❌ (N/A on SKS — gate was EQ-only) |
| 3.4.48  | 2026-05-09  | presence: fix focus/blur race, drop dead sendBeacon           | ❌ (presence not yet on SKS) |
| 3.4.47  | 2026-05-09  | real-time presence on the roster editor                       | ❌ (feature port) |
| 3.4.46  | 2026-05-08  | (banner-only fixup)                                           | ❌       |
| 3.4.45  | 2026-05-08  | misc                                                          | ❌       |
| 3.4.44  | 2026-04-29  | sync the version refs v3.4.40-43 missed                       | ✅ (main HEAD baseline) |
