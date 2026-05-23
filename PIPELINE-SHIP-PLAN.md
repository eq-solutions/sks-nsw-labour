# Pipeline → SKS live — Ship plan

Written 2026-05-22 evening for tomorrow-Royce. Goal: **tender pipeline
live on SKS NSW Labour with a CM running fortnightly reviews against
it.**

Read [PIPELINE-HANDOFF-2026-05-22.md](PIPELINE-HANDOFF-2026-05-22.md)
first if you haven't already — that covers WHERE we are. This doc
covers HOW to get to live.

## TL;DR

Strategy: **phased ship behind a runtime feature flag in `app_config`**.
Six ship events, ~2-3 weeks elapsed, ~1 focused day of UI work in the
middle. Each phase independently revertable.

**First action tomorrow:** Phase 0 below. 60-90 minutes. Gets the
branch clean and verifies SKS state before any DB touch. No deploys
happen in Phase 0.

## Why phased + feature flag, not one big PR?

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **One big PR** | One review, one deploy, one rollback target | Hard to review 1000+ lines of new code + a migration + parser + screens in one sitting. Risk concentrated. Blocks delivery until everything is done. | ❌ |
| **Phased (no flag)** | Each PR small + reviewable | UI ships in pieces — broken half-builds visible to SKS users between phases | ❌ |
| **Phased + feature flag** ★ | Each PR small. Code lands on main but stays dark for users until you flip the switch. Iterate live without redeploys. Soft-launch to one user, then expand. | Adds ~10 lines of flag-plumbing infrastructure. SKS doesn't have this pattern today — first user of it. | ✅ |

The flag plumbing is genuinely small: one `app_config` key
(`pipeline_enabled`), read at boot in `loadTenantConfig()`, exposed as
`TENANT.PIPELINE_ENABLED`. Nav entry + route gates on it. ~10 lines
total. Pays for itself the first time you need to disable the feature
without a rollback deploy.

## The 6 phases

### Phase 0 — Integration prep (60-90 min, no deploys, no DB writes)

Cleanup before any irreversible action.

1. **Read** [migrations/2026-05-20_sks_function_search_path_hardening.sql](migrations/2026-05-20_sks_function_search_path_hardening.sql) — the SKS hardening pattern that landed while you were at work.
2. **Patch the tender migration** to match the hardening pattern:
   ```sql
   CREATE OR REPLACE FUNCTION public.set_updated_at()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = now(); RETURN NEW; END;
   $$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;   -- ← add this line

   CREATE OR REPLACE FUNCTION public.set_is_high_confidence()
   RETURNS TRIGGER AS $$
   BEGIN NEW.is_high_confidence = (NEW.probability_pct IS NOT NULL AND NEW.probability_pct >= 90); RETURN NEW; END;
   $$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;   -- ← add this line
   ```
   Without these, `get_advisors` will add 2 new WARNs after Phase 2.
3. **Rebase this branch onto `origin/main`:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Expected: zero conflicts. My commits touch parser + migration + auth files; v3.4.83 touched timesheets + roster bubble.
4. **Rename version stamps** v3.4.83 → v3.4.84:
   - `migrations/2026-05-22_tender_pipeline.sql` header (line ~4)
   - `PIPELINE-HANDOFF-2026-05-22.md` references
   - `PIPELINE-SHIP-PLAN.md` (this file)
5. **Smoke-test audit fixes locally:**
   - Open the app in a Netlify deploy preview (push branch + read the preview URL)
   - PIN login → should work (verify-pin HMAC change)
   - Roster page → groups render (PEOPLE_GROUPS refactor)
   - Skip apprentices test — SKS doesn't show that UI
6. **Decide commit shape for Phase 1:**
   - **Option A (recommended):** keep 4 separate audit commits as-is — clean history, easy individual revert
   - Option B: squash into one `v3.4.84 — Audit fixes (4 findings)` commit — terser log

**Output of Phase 0:** branch rebased, version renamed, ready to ship audit fixes. No production change yet.

### Phase 1 — Audit fixes ship (30 min)

Ship the 4 audit fixes alone so they're not blocked on the pipeline being done.

1. Add CHANGELOG entry: `v3.4.84 — Audit-driven fixes (constant-time HMAC + 3 hygiene)`. ~30 lines covering all 4 commits.
2. `node scripts/release.mjs 3.4.84` — bumps `APP_VERSION` and `sw.js` CACHE key.
3. Commit version bump + CHANGELOG in one commit on the branch.
4. **`git push -u origin claude/funny-satoshi-1408ae`** — pushes branch, doesn't deploy main yet.
5. Open PR on GitHub. Self-review.
6. Merge to `main` (squash or merge — your call). **Netlify auto-deploys to sks-nsw-labour.netlify.app on push to main.**
7. Watch Sentry + the sidebar version badge for ~5 min. Confirm v3.4.84 shows on the live app. PIN-login still works for both staff and supervisor codes.

**Output of Phase 1:** audit fixes live on SKS. Branch is now main + nothing pipeline-related. Continue pipeline work on a fresh branch.

### Phase 2 — Schema applied to Supabase (30 min)

Apply the migration. **No code deploy needed; this is DB-only.**

1. **Pre-flight on SKS:**
   ```sql
   SELECT count(*) FROM pg_proc WHERE proname = 'set_updated_at';
   -- expect 0 (SKS uses per-table funcs)
   SELECT slug FROM public.organisations;
   -- confirm 'sks' is there
   ```
2. **Apply to EQ demo first** (zero blast-radius validation): Supabase MCP `apply_migration` against project `ktmjmdzqrogauaevbktn` with `migrations/2026-05-22_tender_pipeline.sql`.
3. **Run the verification SELECTs** from the migration's section 11 (commented block at the bottom). All should pass.
4. **Apply to SKS prod**: same MCP call against `nspbmirochztcjijmcrx`.
5. **Re-run verification SELECTs** on SKS.
6. **`get_advisors` snapshot:** confirm 0 new warns (search_path pin from Phase 0 is what prevents new WARNs here).
7. **Optional: trigger a manual Supabase backup** via the `workers/supabase-backup` worker (or just confirm last weekly snapshot is recent).

**Output of Phase 2:** schema is live on SKS prod. No code change. No UI change. Tables are empty, ready for code that uses them.

### Phase 3 — Pipeline code ships dark behind flag (6-10 hrs focused)

This is the big one. Single PR, large but coherent. Stays dark via the feature flag.

**Add the flag plumbing first** (do this before any screens):

```js
// scripts/app-state.js — extend TENANT default
let TENANT = {
  ORG_SLUG: 'eq',
  ORG_UUID: null,
  ORG_NAME: 'EQ Solves — Field',
  PIPELINE_ENABLED: false,   // ← new
};

// scripts/app-state.js — extend loadTenantConfig's app_config loop
if (row.key === 'pipeline_enabled') TENANT.PIPELINE_ENABLED = (row.value === 'true');
```

Then build the 5 screens, in this order (each one is a vertical slice that tests something):

| Screen | Path | Tests | Hours |
|---|---|---|---|
| Import | `/pipeline/import` | xlsx upload → parser → diff → preview → write. Validates SheetJS, parser, RLS, org_id stamping end-to-end. | 2 |
| Kanban | `/pipeline` | Read tenders grouped by stage. Validates the kanban data shape. | 1 |
| Enrichment panel | (modal off tender card) | Edit hours_estimated, peak_workers, etc. Tests update flow. | 1.5 |
| Nominations | (sub-panel on tender card) | Pencil managers, surface clashes via the `nomination_clashes` view. | 2 |
| Review | `/pipeline/review` | Fortnightly meeting screen. Read decisions, write notes, promote/escalate/kill. | 1.5 |
| Confirm-curve | `/pipeline/:id/confirm` | Promote Won → Confirmed. Auto-generates `pending_schedule`. CM-only. | 2 |

**Cross-cutting wiring:**
- SheetJS via cdnjs with SRI hash (lazy-load only on `/pipeline/import` route to avoid 900 KB on every page).
- Nav entry: "Pipeline" item, gated on `TENANT.PIPELINE_ENABLED && permGate.has('supervisor')`.
- PostHog: 8 events from the bundle's [docs/cowork-prompt-v3.md](C:/Projects/eq-field-pipeline/docs/cowork-prompt-v3.md).
- Sentry: wrap parser + import POST in `Sentry.captureException` on failure.
- Audit log: every nomination change + confirm-curve action writes to `audit_log`.
- CHANGELOG: `v3.4.85 — Tender Pipeline (Phase 1: dark behind flag)`.
- `node scripts/release.mjs 3.4.85`.

**Output of Phase 3:** code is on SKS production. Flag is `false`. **Zero user-visible change.** You can navigate to `/pipeline` via a URL hack to dogfood, but no nav surface exists for users.

### Phase 4 — Beta on EQ demo (1-2 days elapsed)

Test end-to-end against the EQ tenant before opening on SKS.

1. Set `app_config.pipeline_enabled = 'true'` on EQ Supabase (`ktmjmdzqrogauaevbktn`) via SQL editor or MCP `execute_sql`.
2. Open `eq-solves-field.netlify.app` (or `?tenant=eq` on the SKS host) → nav now shows Pipeline.
3. Walk the full flow with the bundle's sample Smartsheet (`C:\Projects\eq-field-pipeline\samples\nsw-tenders-sample.xlsx`):
   - Upload → diff preview shows ~300 new + 0 changes
   - Confirm → tenders kanban populates
   - Pencil a PM + a supervisor → clashes view surfaces a yellow
   - Promote one tender Won → Confirmed → pending_schedule rows generate
   - Confirm curve → audit_log entry appears
4. Iterate the UI based on what's awkward. Each iteration = a small PR on a new branch, no flag change.

**Output of Phase 4:** the UX is good enough to put in front of a real CM.

### Phase 5 — Operationalisation prep (1-2 days elapsed)

The process is the product (per bundle's handover-and-abandonment.md). Without this phase, the schema rusts.

1. **Pick a CM owner.** Pull `managers WHERE category IN SUPERVISOR_CATEGORIES`. Pick one — likely a supervisor or operations role. You + them, ideally.
2. **Book the recurring meeting.** Tuesday 9:00 fortnightly, 30 min, recurring forever. Attendees: CM owner + Royce. Optional: project managers as needed.
3. **Walk the CM through [docs/fortnightly-review-script.md](C:/Projects/eq-field-pipeline/docs/fortnightly-review-script.md).** This is the social/process onboarding, not the UI training. The script explains why pencilling doesn't have history, why yellow clashes are normal, why the CM has to manually confirm curves.
4. **Set CM owner in DB:**
   ```sql
   UPDATE public.app_config
     SET value = '<manager_id_of_CM>'
     WHERE key = 'pipeline_review_cm_manager_id';
   ```
5. **Soft-launch decision:** allowlist by manager name first, or go full SKS? Recommend going full SKS — the pipeline is supervisor-gated already, so blast radius is bounded.

**Output of Phase 5:** human + calendar + DB are all set to use the pipeline.

### Phase 6 — Turn on SKS (5 min + ongoing)

The actual go-live.

1. `UPDATE public.app_config SET value = 'true' WHERE key = 'pipeline_enabled';` on SKS.
2. Open `sks-nsw-labour.netlify.app` → Pipeline nav entry appears for supervisors.
3. Do the first import yourself using the real Smartsheet export.
4. Tuesday at 9am: first fortnightly review meeting happens.
5. Watch Sentry + PostHog for errors. Fix forward.

**Output of Phase 6:** pipeline is live on SKS.

## Risks & mitigations per phase

| Phase | Risk | Mitigation |
|---|---|---|
| 0 | Rebase conflicts | Likely zero (different files). If any, take the v3.4.83 version for shared files and merge manually. |
| 1 | Audit fix breaks login | Smoke-test on deploy preview BEFORE merging to main. The 10/10 token tests passed in isolation but a real browser-driven login covers more ground. |
| 2 | Migration breaks SKS due to schema drift | Idempotent migration (every CREATE IF NOT EXISTS). Apply to EQ first. If something goes wrong, rollback SQL: drop the 6 tables + 4 enums + 1 view + 2 functions. Pre-flight `get_advisors` snapshot + post-flight comparison surfaces unexpected impact. |
| 3 | Screen bug visible to SKS users mid-deploy | Feature flag is `false` until Phase 6. Even if a screen file ships broken, no user sees it because no nav entry renders. |
| 3 | SheetJS CDN outage | Lazy-load only when import screen opens, with a vendored fallback shipped in the repo (~900 KB cost only at import-time). |
| 4 | EQ demo doesn't match SKS data shape closely enough to find bugs | True — EQ demo has fake data. Mitigation: also dogfood on SKS via URL hack (`/pipeline` directly) before flipping the flag. |
| 5 | No CM owner found / nobody wants to run the meeting | This is the existential risk. Per bundle docs, the system dies without the meeting. If you can't lock a CM in Phase 5, **stop** — don't flip Phase 6. Better to leave the feature dark than ship dead-on-arrival. |
| 6 | First real import surfaces parser bugs | The parser already fails loud on column drift. Sentry catches everything else. Worst case: import fails, user re-tries after fix. |

## Decisions to lock before Phase 3

| Decision | Recommendation | Why |
|---|---|---|
| SheetJS delivery | **CDN (cdnjs) with SRI hash, lazy-load on `/pipeline/import` only** | 900 KB at the right moment vs 900 KB on every page. SRI prevents CDN tampering. |
| Updated_at function shape | **Shared `set_updated_at()` with search_path pinned** | SKS has per-table convention but a shared function is also valid and lower maintenance. The search_path pin is the actually-important hardening. |
| Soft-launch allowlist | **Full org from day 1** | Pipeline is already supervisor-gated. Allowlisting individual names adds infra you don't need. |
| App version | **v3.4.84 = audit fixes; v3.4.85 = pipeline dark; v3.4.86 = if/when something material changes after Phase 6** | Clean separation between the audit work and the pipeline work. |
| Realtime publication | **Skip for v1** | Pipeline isn't a collaborative real-time editing surface. The 30s poll covers it. Add to `supabase_realtime` later if multi-supervisor concurrent editing becomes a real workflow. |
| Demo seed | **Apply to EQ tenant, not SKS** | EQ is sandbox. SKS gets real data from the first real import. Don't pollute SKS with sample tenders. |

## First action when you sit down

1. Pour coffee.
2. Read this doc + [PIPELINE-HANDOFF-2026-05-22.md](PIPELINE-HANDOFF-2026-05-22.md).
3. Open Phase 0 above. Execute step by step.
4. By lunch, you should be at "branch rebased, version renamed, audit fixes ready to merge."
5. After lunch: Phase 1 (audit fixes merge) + Phase 2 (schema apply).
6. Phase 3 is its own focused session — block a half-day, no interruptions.

## Appendix A — Phase 0 verbatim commands

```bash
# 0.1 Verify current state
git status                                              # should be clean
git log --oneline origin/main..HEAD                     # 8 commits
git fetch origin
git log --oneline HEAD..origin/main                     # 4 commits behind

# 0.2 Read the hardening migration
cat migrations/2026-05-20_sks_function_search_path_hardening.sql

# 0.3 Patch the tender migration (manually edit, see plan body)
$EDITOR migrations/2026-05-22_tender_pipeline.sql

# 0.4 Rebase
git rebase origin/main
# Expected: zero conflicts. If any, take origin/main version for non-pipeline files.

# 0.5 Rename version stamps (3 files)
$EDITOR migrations/2026-05-22_tender_pipeline.sql       # header v3.4.83 → v3.4.84
$EDITOR PIPELINE-HANDOFF-2026-05-22.md
$EDITOR PIPELINE-SHIP-PLAN.md                            # this file

# 0.6 Push branch (does NOT auto-deploy main; only branch deploy preview)
git push -u origin claude/funny-satoshi-1408ae

# 0.7 Open deploy preview URL, smoke-test login + roster + groups
# (Netlify will post the preview URL on the PR or in branch deploys)
```

## Appendix B — Phase 6 rollback (worst-case)

If something goes pear-shaped after flipping the flag:

```sql
-- Instant kill (no deploy needed)
UPDATE public.app_config SET value = 'false' WHERE key = 'pipeline_enabled';
```

If the data is bad (e.g. a botched import):

```sql
-- Wipe pipeline data, keep schema
TRUNCATE public.tender_review_decisions, public.tender_import_runs,
         public.pending_schedule, public.nominations,
         public.tender_enrichment, public.tenders CASCADE;
```

If the schema itself needs to come out (extremely unlikely):

```sql
-- Full rollback — drops all pipeline objects
DROP VIEW IF EXISTS public.nomination_clashes;
DROP TABLE IF EXISTS public.tender_review_decisions CASCADE;
DROP TABLE IF EXISTS public.tender_import_runs     CASCADE;
DROP TABLE IF EXISTS public.pending_schedule       CASCADE;
DROP TABLE IF EXISTS public.nominations            CASCADE;
DROP TABLE IF EXISTS public.tender_enrichment      CASCADE;
DROP TABLE IF EXISTS public.tenders                CASCADE;
DROP TYPE IF EXISTS public.review_decision_kind;
DROP TYPE IF EXISTS public.nomination_status;
DROP TYPE IF EXISTS public.nomination_role;
DROP TYPE IF EXISTS public.pipeline_stage;
DROP FUNCTION IF EXISTS public.set_is_high_confidence();
-- Leave set_updated_at() alone if other tables use it.
DELETE FROM public.app_config WHERE key IN
  ('pipeline_value_floor', 'pipeline_review_cm_manager_id', 'pipeline_enabled');
```

## Open questions for tomorrow-Royce to think about

1. **Who's the CM?** Without an answer here, Phase 5 stalls. Think about it during the day.
2. **Is the Smartsheet export workflow stable enough to script?** Currently a manual download → upload. Could become an automated pull via Smartsheet API later, but only worth doing once Phase 6 has proved value.
3. **Apprentice ratio compliance** — the Melbourne reference work flagged this. Out of scope for this ship, but worth deciding if it's a v2 of pipeline or its own future module.
4. **EQ-side fate of the pipeline.** Long-term: does EQ Field also get pipeline? Or is this an SKS-only feature? Decision deferred until SKS is live and stable.
