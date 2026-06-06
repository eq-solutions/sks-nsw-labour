# Cards → Field SSO + sks-canonical consolidation — runbook

**Status:** Part 1 (Shell SSO) — sks-labour slice in build. Cross-repo pieces specced, not yet built.
**Owner:** Royce / EQ. **Last verified live:** 2026-06-06.
**Scope rule:** EQ owns the code; SKS is a separate entity. Never cross-deploy EQ↔SKS. No deploy without explicit instruction.

---

## Why (verified ground truth, live wins over docs)

The deployed app `sks-nsw-labour.netlify.app`:

- Connects to **sks-labour `nspbmirochztcjijmcrx`** for *both* auth-config and data, via the public anon key. `auth.users = 0` — there is **no GoTrue / per-user auth**.
- Login = shared client-side code (`2026` staff / `SKSNSW` supervisor), then the user picks their **name** from a dropdown. Identity downstream is the **name string** (`eq_logged_in_name`), resolved to a `people` row by name (`home.js getLoggedInName`, `roster.js`, `timesheets.js`).
- `people` carries `canonical_id` + `canonical_synced_at`; **49/60 populated** by an external canonical→people sync, but **no app code reads them** (grep: zero matches). The bridge data exists; the read path doesn't use it.
- A Shell SSO path exists (`#sh=<token>` → `verify-pin.js` action `verify-shell-token`, HMAC w/ `EQ_SECRET_SALT`) but only sets a session name+role.

**Contradicts the platform docs:** SKS does **not** run on sks-canonical `ehowgjardagevnrluult`; browser readers are **not** on eq-canonical; phone is **not** the join key (name is). sks-canonical currently hosts **EQ Quotes + CRM + `sks_staff` (19)** — it has **no Field schema**.

**Decision:** join key becomes a **stable UUID** (`people.canonical_id`), never the name string. Identity stays in eq-canonical; Field data stays on sks-labour now and consolidates onto sks-canonical later.

---

## ⚠ CORRECTION — verified live 2026-06-06 (supersedes the "Why" assumptions below)

Direct DB checks overturned two load-bearing premises. **Live wins.**

1. **The crew's canonical identity is `public.workers` (36 rows) in eq-canonical, linked by PHONE — not `shell_control.users`.** `shell_control.users` has only **5** rows (suite operators/admins). **28 of 59** sks-labour `people.phone` match `public.workers.phone` (last-9 normalised). Cards onboards into `workers` / `worker_invites` (56) / `worker_credentials` (737).
2. **`people.canonical_id` is ORPHANED.** All 49 populated values match **nothing** — not `workers.id`, not `workers.user_id`, not `shell_control.users.id`, not `worker_invites.id`, not `cards_field_approvals` (which has only 2 rows), and nothing in sks-canonical. They are pre-allocated placeholder UUIDs, not a live cross-system link.

**Consequence:** the resolver shipped in v3.10.58 (resolve `people` by `canonical_id`) is the right *shape* but cannot be driven end-to-end until `canonical_id` holds **real** ids that Shell can also mint. Two ways forward — see "Join-key decision" below. The real, verifiable bridge **today** is `people.phone → workers.phone`.

### Join-key decision (was: "Shell carries shell_control.users.id")
- **Option A — fix `canonical_id` (preferred long-term):** re-sync `people.canonical_id := workers.id` (match by phone) on the eq-canonical/sks side. Then v3.10.58's resolver works unchanged and Shell mints a token carrying `workers.id`. Clean UUID join. Prereq: a corrected sync + confirm coverage (28 matchable now; chase the other ~31).
- **Option B — join by phone (bootstrap / works sooner):** Shell token carries the worker's phone; Field resolver matches `people.phone` (last-9 normalised). No re-sync needed, but phone formatting / reuse / 31 unmatched make it messier. Good as the bridge that *builds* Option A.

Until this is settled, **A1/B below are on hold** — their original id assumption is wrong.

---

## Dependency chain

```
Gate 0 (env)  →  A (token plumbing)  →  B (provisioning invariant)  →  C (read-path cutover)  →  D (sunset code gate)
                                                                                                  └─→  M1…M6 (migrate to sks-canonical)
```

A–C ship the working 10/10. M* only starts once `canonical_id` is the live join key.

---

## Part 1 — Shell SSO (canonical_id as join key)

### Gate 0 — env precondition · repo: **this app / Netlify**
`app-state.js` has a stale comment claiming `verify-pin` isn't deployed here; it **is** (`netlify/functions/verify-pin.js`) and `auth.js` calls it. Confirm on the `sks-nsw-labour` Netlify site:
- `verify-pin` function deployed.
- `EQ_SECRET_SALT` set **and identical** to the eq-shell signer (linchpin).
- `STAFF_CODE`, `MANAGER_CODE` set.
If `EQ_SECRET_SALT` differs, every shell token is rejected and the `#sh=` path is silently dead.

### Phase A — token plumbing
- **A1 · repo: eq-shell** — add `canonical_user_id` to the minted shell-token payload (with `kind:'shell-token'`, `name`, `role`, `tenant_slug:'sks'`, `exp` ~60s), signed with `EQ_SECRET_SALT`. Launch Field with `#sh=<token>`.
- **A2 · repo: this app** — `verify-pin.js`: carry `canonical_id` through the `verify-shell-token` response and bake it into the 7-day session token so it survives reload. **(BUILT — see Build status.)**

### Phase B — provisioning invariant (49/60 → 100%) · repo: eq-shell + eq-canonical
- **B1** — `cards-approve-staff` must **guarantee** a sks-labour `people` row with `canonical_id` at approval time (create-or-link by phone, then stamp `canonical_id`). Backfill the 11 unsynced.
- **B2** — dedupe `people` to one row per `canonical_id` (the name-keyed past may have produced duplicates).
- **Invariant:** "approved in Cards" ⇒ exactly one resolvable Field `people` row.

### Phase C — read-path cutover · repo: this app
- **C1** — `_consumeShellToken` stores `canonical_id` in `sessionStorage` (`eq_canonical_id`); `checkAccess` token-restore does the same. **(BUILT.)**
- **C2** — at `initApp`, after `loadFromSupabase()`, resolve `eq_canonical_id` → `people` row and overwrite `eq_logged_in_name` with that row's exact `name`. Bridges canonical_id → the name the roster is keyed on, so **no roster/timesheet rewrite**. **(BUILT.)**
- **C3** — fallback: no `canonical_id` ⇒ today's name-pick + shared code, untouched. **(BUILT — resolver no-ops without canonical_id.)**
- **C4 — acceptance:** (a) Shell-launched Cards worker lands on their schedule, zero taps; (b) rename `people.name` (canonical_id constant) → still resolves.

### Phase D — sunset · repo: this app (only after 100% coverage + Shell access for all active workers)
Demote shared code to break-glass (supervisor-only / drop staff code), keep audit.

---

## Part 2 — Migrate Field to sks-canonical `ehowgjardagevnrluult` (follow-on; depends on Part 1)

Honestly scoped: sks-canonical today has **no Field schema** — it hosts `sks_quotes_*`, `sks_contacts/customers`, `sks_staff (19)`, `auth.users = 1`. This is a consolidation, not a repoint.

- **M1 · eq-canonical migration** — stand up full Field schema (organisations, people, managers, sites, schedule, timesheets, leave_requests, job_numbers, teams/team_members, prestarts/toolbox_talks, push_subscriptions, app_config…), mirroring the `org_id` model + RLS.
- **M2 — identity reconciliation (hard part)** — map Field `people`/`managers` ↔ `sks_staff`/`sks_contacts` by `canonical_id` → phone → email. Decide merge vs parallel (19 vs 27 vs 60 won't line up).
- **M3 — data copy** sks-labour → ehowgjard preserving `canonical_id`. **PK shape risk:** `supabase.js _isRealDbId` treats SKS ids as **bigint**; new tables must keep bigint PKs or the validator + every PATCH/POST path needs updating, or edits duplicate rows.
- **M4 — repoint** `TENANT_SUPABASE.sks.url/key` → ehowgjard (`app-state.js`). Auth path unchanged because reads are canonical_id-based.
- **M5 — parity window** — dual-read/verify; keep sks-labour as rollback until sign-off (sks-labour stays source-of-truth through the merge).
- **M6 — docs** — correct eq-context routing target to reality.

**Risk register:** bigint↔uuid PK shift vs `_isRealDbId`; RLS rebuilt from scratch; Quotes/CRM co-tenancy widens blast radius; unresolved dupes/unsynced multiply on copy — so **B1/B2 must finish before M3**.

---

## Build status (sks-labour slice)

| Item | Repo | State |
|---|---|---|
| A2 verify-pin canonical_id passthrough | this app | built |
| C1 capture eq_canonical_id | this app | built |
| C2 resolver overwrites eq_logged_in_name | this app | built |
| C3 fallback to code gate | this app | built (resolver no-ops) |
| Gate 0 env parity check | Netlify | **pending — manual** |
| A1 shell-token mint carries canonical_user_id | eq-shell | **pending — other repo** |
| B1/B2 provisioning + dedupe | eq-shell + eq-canonical | **pending — other repo** |

The slice is **forward-compatible and inert** until eq-shell A1 lands: with no `canonical_user_id` in the token, `eq_canonical_id` is never set, the resolver no-ops, and the shared-code gate behaves exactly as before.
