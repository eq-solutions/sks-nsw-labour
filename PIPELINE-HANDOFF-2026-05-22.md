# Tender Pipeline — Handoff (2026-05-22, morning)

Royce was heading to work and asked me to make progress autonomously. This
file is the smooth-transition artifact. Read top to bottom; delete on next
commit once you're caught up.

## TL;DR

Two phases of work on this worktree branch (`claude/funny-satoshi-1408ae`):

**Phase 1 — Tender pipeline (morning):**
- `scripts/tender-parser.js` — IIFE module, ports the eq-field-pipeline
  bundle's parser to the SKS no-bundler stack. 26/26 smoke tests pass.
- `migrations/2026-05-22_tender_pipeline.sql` — SKS-native migration.
  **NOT APPLIED to any Supabase project.**

**Phase 2 — Audit follow-ups (Royce-at-work autonomous pass):**
- `netlify/functions/verify-pin.js` — fix HMAC compare to constant-time
  (matches the `approve-leave.js` pattern). 10/10 verification tests pass.
- `.gitignore` — new file; baseline patterns. Does not un-commit
  existing files (need explicit `git rm` per the global rule about
  deletes).
- `PEOPLE_GROUPS` constant extracted to `scripts/app-state.js`,
  6 duplication sites swept across batch/people/roster/auth/import-export.
- Apprentices `skills_ratings` direct fetches routed through `sbFetch()`
  (2 sites in `scripts/apprentices.js`).
- DST/timezone probe report — clean, no code changes (see "DST audit"
  section below).

7 atomic commits, **not pushed.** Branch tracks `origin/main`.

## What's done

| Step | Status | Notes |
|---|---|---|
| Audit the eq-field-pipeline bundle | ✅ | Bundle is fine as design substrate; non-portable as code. |
| Map SKS shape via Explore + migrations | ✅ | Mixed uuid/bigint, no `people.role`, RLS pattern is `anon SELECT(true) + INSERT/UPDATE/DELETE check org_id`. |
| Verify Smartsheet column headers | ✅ | All 12 expected columns present and exact in the real NSW export. Sample at `C:\Projects\eq-field-pipeline\samples\nsw-tenders-sample.xlsx`. |
| Lock scope decisions | ✅ | PM = managers WHERE category='Project Management'. Supervisor = managers WHERE category='Supervisor'. CM owner = `app_config.pipeline_review_cm_manager_id` picker. Flat $100k value floor. App-layer RLS. |
| Write parser | ✅ | `scripts/tender-parser.js`. Exposes `window.SKS_TENDER_PARSER`. |
| Write migration | ✅ | `migrations/2026-05-22_tender_pipeline.sql`. 6 tables, 4 enums, 1 view, 2 trigger functions, 25 RLS policies, 2 `app_config` rows seeded. Idempotent. |

## What's deliberately NOT done

| Step | Why deferred |
|---|---|
| Apply migration to Supabase | Hard rule: no DB writes without explicit go-ahead. |
| `git push` of this branch | Branch deploys could publish a deploy-preview to Netlify; out of scope for autonomous work. |
| SheetJS `<script src>` in `index.html` | Pairs with the import-screen build — wiring it now ships ~900 KB to every page load for code that isn't loaded yet. Add it when `scripts/pipeline-import.js` lands. |
| Demo seed file | The EQ tenant of this codebase is in SEED-demo mode (no live Supabase). The SKS Supabase is forbidden for demo data. Defer until you decide where demo data should live (e.g. a dedicated dev project). |
| Pipeline UI screens (5 modules) | UI conventions need your eye. Doing this without review = wasted churn. |
| `APP_VERSION` bump | The pipeline isn't shippable yet — bumping now would lie about what's released. Bump when the feature is whole. |
| `CHANGELOG.md` entry | Pairs with the version bump. |
| Pick CM review owner | Your call — pick from the supervisors list (managers WHERE category IN SUPERVISOR_CATEGORIES) when you're back. |
| Book the Tuesday 9am meeting | Calendar action; out of repo scope. **This is the highest-priority non-code task** — per the bundle's handover-and-abandonment.md, no meeting = no process = the system dies. |

## Risks still open (from the final audit earlier today)

1. **`set_updated_at()` function body.** Migration uses `CREATE OR REPLACE`.
   If SKS prod already has this function from older history, the body is
   replaced verbatim across every other table that uses it. My body is the
   standard `NEW.updated_at = now(); RETURN NEW;` — functionally identical
   to any reasonable implementation, so should be safe. **Verify** by
   running this against SKS Supabase **before** applying:

   ```sql
   SELECT prosrc FROM pg_proc WHERE proname = 'set_updated_at';
   ```

   Compare to the body in `migrations/2026-05-22_tender_pipeline.sql` ~line 90.
   If non-trivially different, decide whether to merge bodies before applying.

2. **The migration adds a function-replacement to a shared function.**
   If point 1 surfaces a meaningful difference, the safest fix is to drop
   the `CREATE OR REPLACE FUNCTION set_updated_at()` block from the
   migration and rely on the existing function. The triggers will still
   wire up against whatever `set_updated_at()` already exists.

3. **No Sentry wiring planned.** Per your global rules, all EQ apps have
   Sentry. The pipeline modules should report parser/import errors to
   Sentry, not just toast the user. Wire when the import screen lands.

4. **Two sources of truth for parser logic.** The bundle's
   `C:\Projects\eq-field-pipeline\src\lib\tender-parser.js` still exists.
   If you fix a bug in one, the other drifts. Recommend: mark the bundle
   parser as DEPRECATED with a pointer to `sks-nsw-labour/scripts/tender-parser.js`,
   or delete it (the bundle still has the migration + docs which are the
   real design substrate).

## Verification when you're back (5 min)

```bash
# From the repo root or any worktree:
git status                                                 # should be clean
git log --oneline origin/main..HEAD                        # 3 new commits
git diff origin/main..HEAD --stat                          # parser, migration, this handoff doc
```

If anything looks off, `git reset --hard origin/main` nukes the branch and
puts us back where we started. Nothing else needs cleanup.

## Next step menu (in roughly the right order)

1. **Read this handoff** (you are here).
2. **Glance at `migrations/2026-05-22_tender_pipeline.sql`.** The header
   block at the top covers every design decision. Disagree with anything,
   tell me and I'll rework before any apply.
3. **Decide CM review owner.** Pick from managers whose category is in
   SUPERVISOR_CATEGORIES = ['Executive','Operations','Project Management',
   'Construction','Supervisor','Internal','Other']. Hold the choice in
   your head — we'll set the `app_config.pipeline_review_cm_manager_id`
   row after the migration applies.
4. **Verify `set_updated_at()` body on SKS prod** (one-line SQL above).
5. **Apply the migration to SKS prod via Supabase MCP** (`apply_migration`).
   I can do this for you when you give the explicit go.
6. **Wire SheetJS + build the 5 screens.** This is a real chunk of work
   — probably needs its own focused session. Cowork or Code can take this
   off the back of the locked scope in the migration's header comment.
7. **Book the Tuesday 9am meeting.** Per the bundle's process docs, the
   meeting is the product. Schedule first, build to support it.

## Audit follow-up (Phase 2)

When you came back from the worktree state I left at the pipeline-only
checkpoint, you asked for a broader code audit, then asked me to
action the safe subset. Here's what I did:

| Commit | What | Risk | Verify |
|---|---|---|---|
| `5b6cdca` | `verify-pin.js` constant-time HMAC compare | Low — copies a verified pattern from `approve-leave.js`. Login still works (10/10 token verification tests pass). | Login on a deploy preview |
| `8ce71de` | New `.gitignore` (additive only — no deletes) | None — additive | `git check-ignore -v __perm_test` should show match |
| `e4fa378` | Extract `PEOPLE_GROUPS` constant; sweep 6 sites | Low — pure refactor, no semantic change | Open the roster, contacts, batch-fill modals; all groups render |
| `e088619` | Apprentices `skills_ratings` → `sbFetch()` | Low — gains TENANT_DISABLED_TABLES gating + offline IDB queue. EQ-tenant behaviour unchanged; SKS behaviour improved (404s become silent no-ops) | Open Apprentices on EQ tenant, save a self-rating |

What I deliberately did NOT do (deferred to you):
- **`git rm __perm_test screenshots/'my schedule.zip'`** — global rule
  says ask before deleting. The .gitignore now blocks future copies; you
  can run those two `git rm`s in 10 seconds.
- **PIN rate-limit moved to a Supabase counter table** — too big for
  autonomous (schema + code), needs your sign-off.
- **Team color hex validation** — subtle behaviour change in the
  roster UI; not worth doing without your eye.
- **Two env-var pair docs comment** — low-value; can pair with the next
  touch of verify-pin.

## DST audit (BATTLE-TEST coverage gap closed)

Read-only probe. Walked every date-arithmetic site in scripts/ and
supabase/functions/. **No DST bugs.** Sites checked, all clean:

| Site | Pattern |
|---|---|
| `scripts/utils.js:122` `getWeekDates` | `setDate(getDate()+i)` walks calendar days correctly across DST |
| `scripts/utils.js:109` `formatWeekLabel` | UTC midnight read locally; safe for AU users, latent for west-of-UTC |
| `scripts/timesheets.js:544` `_previousWeekKey` | 3-arg `Date` ctor = local midnight; `setDate(-7)` DST-safe |
| `scripts/timesheets.js:918` `_thisMondayStr` | Standard `setDate(getDate() - ((getDay()+6) % 7))` |
| `scripts/leave.js` business-day loops | Standard `setDate(getDate()+1)` walks |
| `supabase/functions/*` cron functions | `Date.UTC(...)` everywhere — explicit UTC |

Worth remembering (not bugs):
1. The `'dd.MM.yy'` week key is timezone-neutral by design — two clients
   in different TZs agree on the key for the same calendar Monday.
2. `new Date('YYYY-MM-DD')` (no time component) parses as UTC midnight
   in modern browsers. Safe for AU; would flip the day for users west
   of UTC. Prefer `new Date(y, m-1, d)` if international expansion ever
   matters.
3. The `supervisor-digest` cron is `0 2 * * 5` UTC — that's **12pm AEST
   in winter, 1pm AEDT in summer**. Send time drifts by 1h twice a year.
   Not a bug; just a thing to know if anyone asks.

## Files of interest

- Parser: `scripts/tender-parser.js`
- Migration: `migrations/2026-05-22_tender_pipeline.sql`
- Bundle (read-only reference): `C:\Projects\eq-field-pipeline\`
- Bundle's design docs:
  - `C:\Projects\eq-field-pipeline\docs\fortnightly-review-script.md`
  - `C:\Projects\eq-field-pipeline\docs\handover-and-abandonment.md`
  - `C:\Projects\eq-field-pipeline\docs\cowork-prompt-v3.md`
- Real Smartsheet sample: `C:\Projects\eq-field-pipeline\samples\nsw-tenders-sample.xlsx`

## What I touched (and didn't)

**Files created (Phase 1):**
- `scripts/tender-parser.js`
- `migrations/2026-05-22_tender_pipeline.sql`
- `PIPELINE-HANDOFF-2026-05-22.md` (this file)

**Files created (Phase 2):**
- `.gitignore`

**Files modified (Phase 2):**
- `netlify/functions/verify-pin.js` (constant-time HMAC)
- `scripts/app-state.js` (PEOPLE_GROUPS constant added)
- `scripts/batch.js`, `scripts/people.js`, `scripts/roster.js`,
  `scripts/auth.js`, `scripts/import-export.js` (PEOPLE_GROUPS sweep)
- `scripts/apprentices.js` (sbFetch routing)

**Files NOT touched:**
- `index.html` (no SheetJS wiring, no nav entry, no CHANGES block)
- `scripts/app-state.js` — `APP_VERSION` (no bump)
- `sw.js` (no cache key bump)
- `CHANGELOG.md` (no entry — paired with the version bump you'll do)
- `__perm_test` and `screenshots/my schedule.zip` — left in place;
  global rule says ask before deleting

**Supabase projects NOT touched** (zero queries, zero writes):
- `nspbmirochztcjijmcrx` (SKS live)
- `ktmjmdzqrogauaevbktn` (EQ demo)

Seven commits on this branch. None pushed. `git reset --hard origin/main`
puts the worktree back exactly where it started. No external state changed.
