# SKS → EQ Field — merge-time parity checklist

When the SKS tenant moves off the standalone `sks-nsw-labour` app onto the EQ Field
codebase, confirm each SKS-only feature below is present (or consciously dropped) in
EQ Field **before** cutover. These are features that live on the standalone SKS app and
have **no live users on EQ Field today** (field.eq.solutions carries deploy-preview
traffic only), so they were deliberately NOT ported when built — the merge is where they
must land, or SKS users regress.

sks-labour is the source of truth; the codebase-merge phase should carry SKS's timesheet
code across. This list exists so nothing gets silently lost if the merge reconciles
field-by-field instead of wholesale.

## Timesheets — v3.10.94 UX (SKS PR #61, 2026-07-12)

- [ ] **Hours-missing red flag.** A job number entered with the hours box left blank turns
      the box red with a `?` placeholder; empty boxes show `hrs`/`h`, never a phantom `8`.
      Live-toggled in `onTsCellChange` (`_tsHrsMissing` / `_tsToggleHrsFlag`), desktop + mobile.
      **EQ Field status:** absent (`ts-hrs-missing` = 0 refs). Desktop already uses `placeholder="h"`
      (not `8`), but the **mobile** card view still uses `placeholder="8"` — same trap on phones.
- [ ] **Weekend auto-show.** Any week that already has Sat/Sun data auto-reveals the weekend
      columns (`_showWE = tsShowWeekends || hasSat || hasSun`) so entered weekend hours are never
      hidden behind the toggle. **EQ Field status:** absent.
- [ ] **Sunday week-rollover fix.** The default week uses ISO `-((getDay()+6)%7)` so Sunday stays
      on the current Mon–Sun week and the app only advances Monday (the old `getDate()-getDay()+1`
      rolled to next week all day Sunday). **EQ Field status:** EQ Field has its own `loadFromSupabase`
      / week logic — **verify against its code, do not copy-paste.**

## Reliability parity (mostly landed 2026-07-12)

- [x] **Degraded-sync observability + preserve-on-failure** — SKS v3.10.93 (#60) ported to EQ Field
      v3.5.304 (#459). One table's failure can't freeze the app; degraded syncs emit a `sync_degraded`
      analytics event + toast.
- [x] **`order=id` fix for id-less tables** — `team_members` / `timesheet_locks` — EQ Field v3.5.305 (#460).
- [ ] **Fail-loud `sbFetchAll`** — SKS v3.10.95 (#63). The helper throws when a caller passes no
      `orderBy` and the path has no `order=`, instead of silently defaulting to `order=id` (the latent
      trap behind the v3.10.90–92 outage). **Deliberately NOT ported to EQ Field now** — audited
      2026-07-12: EQ Field can't freeze (core boot wraps every fetch in `_loadSafe` → `.catch([])`, so a
      stray 400 degrades one feature, observably, not the whole app), and its only un-`orderBy`'d id-less
      caller (`project_targets`, `scripts/supabase.js`) is `try/catch`-guarded, Enterprise-tier-only, and
      the table doesn't exist on eq-canonical or ehow. Land it at the codebase-merge phase (SKS code
      carries it across); do the fail-loud sweep against EQ Field's own callers then, not speculatively now.
- [ ] **Degrade email alert** — SKS v3.10.95 (#63). `_alertSyncDegraded` sends a throttled
      (1/device/day) email to `leaveCCList` via the `send-email` function when a sync degrades, SKS-tenant
      only, self-guarded. **Deliberately NOT ported to EQ Field now** — no live users to alert
      (deploy-preview traffic only) and degrades are already observable via `sync_degraded` (#459). It
      earns its keep the moment SKS users are on EQ Field — wire it (tenant-gated, EQ ops distribution)
      at cutover.

## How to use

The full feature-sync ledger lives in the `project-sks-eqfield-sync` memory and `sks/pending.md`.
This file is the **cutover gate** — the last check before the SKS tenant goes live on EQ Field.
Add a row here whenever an SKS-only feature ships that EQ Field lacks.
