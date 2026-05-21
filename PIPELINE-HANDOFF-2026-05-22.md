# Tender Pipeline — Handoff (2026-05-22, morning)

Royce was heading to work and asked me to make progress autonomously. This
file is the smooth-transition artifact. Read top to bottom; delete on next
commit once you're caught up.

## TL;DR

Two new files staged on this worktree branch (`claude/funny-satoshi-1408ae`):

- `scripts/tender-parser.js` — IIFE module, ports the eq-field-pipeline
  bundle's parser to the SKS no-bundler stack. Verified against the real
  NSW Smartsheet sample (26/26 smoke tests pass).
- `migrations/2026-05-22_tender_pipeline.sql` — SKS-native migration
  (mixed uuid/bigint FKs, SKS RLS policy pattern, configurable value
  floor in `app_config`). **NOT APPLIED to any Supabase project.**

Both committed to this branch. **Not pushed.** Branch tracks `origin/main`.

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

**Files created:**
- `scripts/tender-parser.js`
- `migrations/2026-05-22_tender_pipeline.sql`
- `PIPELINE-HANDOFF-2026-05-22.md` (this file)

**Files NOT touched:**
- `index.html` (no SheetJS wiring, no nav entry, no CHANGES block)
- `scripts/app-state.js` (no APP_VERSION bump)
- `sw.js` (no cache key bump)
- `CHANGELOG.md` (no entry)
- Any existing migration
- Any existing script

**Supabase projects NOT touched** (zero queries, zero writes):
- `nspbmirochztcjijmcrx` (SKS live)
- `ktmjmdzqrogauaevbktn` (EQ demo)

Three commits on this branch. None pushed. `git reset --hard origin/main`
puts the worktree back exactly where it started. No external state changed.
