# EQ Field at Melbourne scale — design document

**Purpose**: a phased design path from today's ~50-person SMB shape (SKS NSW Labour) to Melbourne-size (~577 people, 12+ projects, 52-week forecast), incorporating the v3.4.50 finding that the EQ tenant is currently a SEED demo (not a real Supabase-backed tenant). Companion to `BATTLE-TEST-2026-04-29.md` "Tier analysis" section.

**Reading order**: Section 7 (Open questions) is the most decision-load-bearing — read first if you only have 5 minutes. The other sections describe HOW; section 7 asks what you actually want.

**Sources**:
- Live EQ Supabase schema (queried via MCP, project `ktmjmdzqrogauaevbktn`)
- Melbourne reference workbook `2025 VIC Construction Labour Program V1.xlsm`
- BATTLE-TEST-2026-04-29.md tier-analysis entries

---

## Section 1 — Data-model diff

### What's there today

The relevant tables on EQ Supabase right now (sample columns; uuid PKs throughout):

```
people          (id, org_id, name, phone, email, group, licence,
                 agency, pin, year_level, tafe_day, deleted_at, …)
sites           (id, org_id, name, abbr, address, site_lead,
                 site_lead_phone, site_lead_email,
                 track_hours, budget_hours, deleted_at, …)
schedule        (id, org_id, person_id, name, week,
                 mon, tue, wed, thu, fri, sat, sun, deleted_at, …)
managers        (id, org_id, name, role, category, phone, email,
                 digest_opt_in, deleted_at, …)
organisations   (id, slug, name, primary_colour, accent_colour,
                 logo_url, worker_groups[], active, …)
leave_requests  (id, org_id, requester_name, leave_type,
                 date_start, date_end, individual_days, note,
                 approver_name, status, response_note,
                 responded_by, responded_at, archived, …)
```

Two surprises worth flagging up-front:

1. **`schedule.person_id uuid` already exists** — nullable, no FK constraint, no code references. Looks like a half-finished migration from a previous architectural iteration. Free to wire it up properly without adding a column.
2. **`organisations.worker_groups text[]`** with default `{Direct, Apprentice, Labour Hire}` — there's already a per-org "what groups exist" knob. Tenant-customisable employment categories are partly built.

### What Melbourne needs that's missing

Per the spreadsheet inspection (BATTLE-TEST doc "Reference: Melbourne VIC labour program"):

| Need | Today | Melbourne example |
|---|---|---|
| Project hierarchy above sites | Flat sites only | Airtrunk Shell L (345 ppl), NEXTDC M3S4, MEL02 STACK… |
| Employment-type beyond `group` | `group` is single-purpose | FT, PT, Casual, FT Apprentice, LH Apprentice, FT App On Loan, LH (7+ types) |
| Apprentice training org (RTO/GTO) | None | NECA, Yanda, AGA, MAG, G-Force, MAXIM, Frontline |
| Multi-region | One org_id per tenant | NSW + VIC + QLD + WA as siblings under one parent |
| Schedule keyed by person identity | Keyed by `name` text | Two "John Smith" entries can't coexist |

### Proposed schema diff (concrete SQL)

#### 1. `projects` table (new)

```sql
CREATE TABLE public.projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  region_id     uuid     REFERENCES public.regions(id),     -- see §2
  name          text NOT NULL,                              -- "Airtrunk Shell L"
  abbr          text NOT NULL,                              -- "AIRTL", short code on roster
  client_name   text,                                       -- "Airtrunk", for grouping
  status        text NOT NULL DEFAULT 'Active'              -- Active / Won / Tendering / Complete
                CHECK (status IN ('Active','Won','Tendering','Complete','Lost','OnHold')),
  start_date    date,
  expected_end  date,
  budget_hours  numeric,                                    -- forecast headcount × 38h × weeks
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (org_id, abbr)                                     -- abbr unique within an org
);

-- Sites belong to projects (1 project : N sites). Add nullable FK first
-- (so existing sites without a project keep working).
ALTER TABLE public.sites
  ADD COLUMN project_id uuid REFERENCES public.projects(id);
CREATE INDEX ON public.sites (project_id);
```

**Why a separate `projects` table** instead of just adding columns to `sites`:

- Melbourne's spreadsheet has projects at the top of the forecast (rows) and weeks across (columns). Sites are sub-units of projects (e.g. "Airtrunk Shell L" is the project, "AIRTL-DC1" / "AIRTL-DC2" are sites within it).
- Headcount targets and budgets live at the project level, not the site level. A 345-person project might have 8 sites; managing that on the site rows would be 8 places to update.
- Reporting roll-ups (project × week → headcount) become trivial JOINs.

#### 2. `regions` table (new) + `region_id` on people, sites, projects

```sql
CREATE TABLE public.regions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  code      text NOT NULL,                                  -- "NSW", "VIC", "QLD"
  name      text NOT NULL,                                  -- "New South Wales"
  timezone  text NOT NULL DEFAULT 'Australia/Sydney',       -- Used by audit display + leave calendar
  created_at timestamptz DEFAULT now(),
  UNIQUE (org_id, code)
);

ALTER TABLE public.people  ADD COLUMN region_id uuid REFERENCES public.regions(id);
ALTER TABLE public.sites   ADD COLUMN region_id uuid REFERENCES public.regions(id);
-- (projects.region_id added in §1 above)

CREATE INDEX ON public.people  (region_id);
CREATE INDEX ON public.sites   (region_id);
CREATE INDEX ON public.projects(region_id);
```

**Why a `regions` table** rather than just a `region text` column on each row:

- Per-region timezone (already flagged in BATTLE-TEST #32 — audit log groups by browser locale today; tenant timezone is a foundation feature).
- Per-region holiday calendars (TAFE seeds today are NSW-specific — `migrations/2026-04-16_tafe_day_and_holidays.sql`).
- Per-region pricing (tier-analysis open question — recommended: keep one tenant, regions are sub-units; per-region pricing as a v2).
- Per-region managers (a NSW supervisor approves NSW leave; a VIC supervisor approves VIC leave).

#### 3. `employment_type` on `people`

```sql
-- Today: people.group ∈ {Direct, Apprentice, Labour Hire}
-- Promote `group` to "what they DO" (Direct/Apprentice/Labour Hire stays) and add
-- a separate "how they're ENGAGED" axis.
ALTER TABLE public.people
  ADD COLUMN employment_type text DEFAULT 'FT'
    CHECK (employment_type IN ('FT','PT','Casual','LH','FTApprentice',
                               'PTApprentice','LHApprentice',
                               'FTApprenticeOnLoan','Contractor'));

-- Backfill: most existing people are FT. Apprentices get FTApprentice unless
-- their `agency` field is set, in which case LHApprentice.
UPDATE public.people
SET employment_type = CASE
  WHEN "group" = 'Apprentice' AND agency IS NOT NULL THEN 'LHApprentice'
  WHEN "group" = 'Apprentice'                         THEN 'FTApprentice'
  WHEN "group" = 'Labour Hire'                        THEN 'LH'
  ELSE 'FT'
END
WHERE employment_type IS NULL OR employment_type = 'FT';
```

**Why** keep `group` AND add `employment_type` rather than collapsing them: today's `group` is the renderer's category for the roster grid (apprentices have a 🎓 strip, labour hire has a 🔧 strip). Don't break that. `employment_type` is the HR/payroll axis — it intersects but doesn't replace.

#### 4. RTO/GTO field on `people`

```sql
ALTER TABLE public.people
  ADD COLUMN rto text                                       -- 'NECA' | 'AGA' | 'GForce' | …
    CHECK (rto IS NULL OR rto IN
      ('NECA','AGA','Yanda','MAG','GForce','MAXIM','Frontline','Other'));
ALTER TABLE public.people
  ADD COLUMN hire_company text;                             -- free text — "Core", "Atom" etc.
                                                            -- For LH employment_type, this
                                                            -- duplicates `agency` — see migration
                                                            -- path in §3.

CREATE INDEX ON public.people (rto) WHERE rto IS NOT NULL;
```

`hire_company` overlaps with the existing `agency` field. Migration path: rename `agency` → `hire_company` (one ALTER), update the form labels, done. Existing data preserved.

#### 5. Wire up `schedule.person_id` (use the column that's already there)

```sql
-- 5a. Backfill schedule.person_id from name match.
UPDATE public.schedule s
   SET person_id = p.id
  FROM public.people p
 WHERE s.org_id = p.org_id
   AND s.name   = p.name
   AND s.person_id IS NULL;

-- 5b. After backfill stabilises, add the FK constraint + a not-null guard
-- (in a separate migration, after the app code is updated to write person_id
-- on every schedule row insert/update).
ALTER TABLE public.schedule
  ADD CONSTRAINT schedule_person_id_fkey
    FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

-- 5c. Eventually deprecate schedule.name (it's denormalised from people.name).
-- Done as a v3 migration once the code base no longer references s.name.
```

This solves BATTLE-TEST #29 (schedule keyed by name → namesake collision risk at scale).

### How the SEED-demo path coexists

The v3.4.50 finding (BATTLE-TEST #11): the EQ tenant runs from `SEED.*` in-memory data, ignoring its Supabase project for reads. Adding new tables / columns to EQ Supabase doesn't break the SEED demo because the SEED short-circuit at `index.html:1810` doesn't query Supabase.

For the design's coexistence story:

- **Starter tier = SEED-demo extended.** Today's EQ tenant becomes the "Starter" tier — pre-canned data, instant access, no real persistence. SEED is updated to include sample `projects`, sample `regions`, sample `employment_type` so demo users can SEE the new shape. Writes still go to Supabase (audit log) but reads stay in-memory.
- **Paid tiers = real Supabase reads.** A `TENANT.IS_SEED_DEMO` flag (read from `organisations` row) controls whether `loadFromSupabase` short-circuits or actually queries. Default `true` for the EQ tenant; flip to `false` per paying tenant during onboarding.
- **One code path serves both.** All UI shapes (project hierarchy, forecast view, multi-region) gate behind `TENANT.IS_SEED_DEMO === false` AND tier-feature flags. Starter sees a stripped UI; paid tenants see the full surface.

Concrete schema for the flag:

```sql
ALTER TABLE public.organisations
  ADD COLUMN is_seed_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN tier         text    NOT NULL DEFAULT 'Starter'
    CHECK (tier IN ('Starter','SMB','Enterprise'));

-- EQ tenant gets the SEED flag flipped on; SKS stays off.
UPDATE public.organisations SET is_seed_demo = true,  tier = 'Starter' WHERE slug = 'eq';
UPDATE public.organisations SET is_seed_demo = false, tier = 'SMB'     WHERE slug = 'sks';
```

### What this unlocks (the practical "after" picture)

After all five additions land:

- **Project × week aggregation** — `SELECT project_id, week, count(*) FROM schedule JOIN sites USING (id) … GROUP BY 1,2` produces the Melbourne-style forecast table. Section 2 expands.
- **Headcount roll-ups by employment_type, by region, by project** — direct GROUP BY queries.
- **Apprentice ratio compliance** — `count(employment_type LIKE '%Apprentice%') / count(employment_type IN ('FT','PT'))` per region per week. Tier-analysis enterprise feature surfaced in Pass 4 / 11.
- **Namesake collision fixed** — schedule rows FK person_id, not match name.
- **Multi-region tenant** — one organisations row, multiple regions, supervisors scoped per region (RLS extension covered in §3).

### What this does NOT do

- **Doesn't introduce SSO** — auth surface stays as-is (PIN + tenant code). SSO is a parallel workstream (§7 open question).
- **Doesn't introduce sub-org admin** — a "VIC office admin" who can edit VIC people but not NSW people requires per-region role grants. RLS extension only; no schema change beyond region_id which is enough to write the policies.
- **Doesn't enforce ratios server-side** — apprentice ratio compliance is a query / dashboard widget, not a constraint. Soft signal, not hard block. (Per Australian state rules, hard-block would need legal review per state — out of scope here.)

### Effort estimate

S = small (under a day)  ·  M = medium (1-3 days)  ·  L = large (1+ week)

| Step | Effort | Risk |
|---|---|---|
| Add `projects` table + `sites.project_id` | S | Low — additive |
| Add `regions` table + `region_id` cols | M | Low — additive, but per-region RLS needs care |
| Add `employment_type` + backfill | S | Medium — backfill is data-dependent, run on staging first |
| Add `rto` / rename `agency`→`hire_company` | S | Low — text col + label rename |
| Wire up `schedule.person_id` (backfill, FK, deprecate name) | M | Medium — denormalisation removal needs code path updates |
| `is_seed_demo` flag + UI gating | M | Low — additive flag, gating is feature-flag work |

Total: ~2 weeks of focused engineering for the schema migration alone. UI work to expose the new shape is Section 5; performance work is Section 6.

---

## Section 2 — Forecast view design

### Why this is the headline feature

Today EQ Field answers "where are my people THIS week?". Melbourne's spreadsheet (per the Reference table in BATTLE-TEST-2026-04-29.md) answers "where will my 577 people be deployed across 12+ projects over the next 12 months?". That's not a bigger version of the roster — it's a different shape of product. Adding the data-model from Section 1 without exposing it via a forecast UI gets you compliance gains (apprentice ratios) and that's it. The forecast view IS what makes the schema change earn its keep.

### Wireframe (boxes-and-arrows, ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Forecast · VIC Construction · 52 weeks ahead          [⇐ This week] [⇒ Roster]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Region [VIC ▼]  Status [Active ▼]  Employment [All ▼]  ⏳ Showing wks 18-30  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Project              │ Wk18 │ Wk19 │ Wk20 │ Wk21 │ Wk22 │ Wk23 │ Wk24 │ … │
│                      │ 04/05│ 11/05│ 18/05│ 25/05│ 01/06│ 08/06│ 15/06│   │
├──────────────────────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼───┤
│ ▶ Airtrunk Shell L   │ 283  │ 305  │ 322  │ 322  │ 330  │ 345  │ 359  │ … │
│    target            │ 300  │ 300  │ 330  │ 340  │ 340  │ 350  │ 360  │ … │
│    delta             │ ⚠-17 │  +5  │  -8  │ ⚠-18 │ -10  │  -5  │  -1  │ … │
├──────────────────────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼───┤
│ ▶ NEXTDC M3S4        │   0  │   0  │   0  │   0  │   0  │  12  │  18  │ … │
│ ▶ MEL02 STACK        │  20  │  20  │  20  │  20  │  25  │  25  │  25  │ … │
│ ▶ Darwin DC1 (D1S2)  │   0  │   0  │   8  │  15  │  20  │  20  │  20  │ … │
│ ▶ DES (Design Office)│  15  │  15  │  16  │  16  │  16  │  16  │  18  │ … │
├──────────────────────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼───┤
│ TOTAL deployed       │ 318  │ 340  │ 366  │ 373  │ 391  │ 418  │ 440  │ … │
│ Total target         │ 350  │ 350  │ 380  │ 395  │ 395  │ 425  │ 450  │ … │
│ Available pool       │ 410  │ 410  │ 410  │ 410  │ 410  │ 415  │ 415  │ … │
│ Apprentice ratio     │ 3.4  │ 3.5  │ 3.6  │ 3.6  │ 3.5  │ 3.5  │ 3.4  │ … │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key elements**:

- **Top bar** — region / status / employment filters (multi-select), week range nav (default: current + 12 ahead, expand on demand to 52).
- **Project rows** with collapsed/expanded state. Expanded reveals `target` row (editable inline) and `delta` row (computed). Sites under each project nest inside the expand — clicking ▶ on Airtrunk shows its constituent sites (AIRTL-DC1, AIRTL-DC2, …).
- **Cells** are the actual deployed headcount derived from `schedule` rows (count of distinct `person_id` whose schedule cell for the week names a site that belongs to this project).
- **Delta row** highlights gaps with ⚠ when |delta| ≥ 10% of target — these are the "you'll be short next week" signals.
- **Bottom rail** — TOTAL deployed, TOTAL target, available pool (people whose `employment_type` allows them to be deployed but who are not assigned this week), apprentice ratio (compliance number, surfaces here as well as on its own dashboard).
- **Top right buttons** — "⇐ This week" jumps back to the current-week roster editor; "⇒ Roster" stays on a project to show its current-week roster filtered to that project's sites only.

### Aggregation queries

#### Actuals: project × week → headcount

The schedule cells store a SITE abbreviation per day (e.g. `AIRT` in mon column means "this person is on Airtrunk on Monday"). A person is "deployed to a project this week" if ANY of their mon-fri cells reference a site that belongs to that project. Implemented as a CTE:

```sql
-- Helper view: unnest the 5-day cell array into one row per (person, week, day, site_abbr).
-- Materialise this if the un-cached query is slow at scale; refresh on schedule writes.
CREATE OR REPLACE VIEW v_schedule_cells AS
  SELECT s.org_id, s.person_id, s.name, s.week,
         day, abbr
    FROM public.schedule s,
         LATERAL (VALUES
           ('mon', s.mon), ('tue', s.tue), ('wed', s.wed),
           ('thu', s.thu), ('fri', s.fri))
         AS d(day, abbr)
   WHERE s.deleted_at IS NULL
     AND abbr IS NOT NULL
     AND abbr <> '';

-- Forecast: project × week → distinct headcount
SELECT
  c.week,
  p.id        AS project_id,
  p.name      AS project_name,
  count(DISTINCT c.person_id) AS actual_headcount
FROM v_schedule_cells c
JOIN public.sites si
  ON si.org_id = c.org_id AND si.abbr = c.abbr AND si.deleted_at IS NULL
JOIN public.projects p
  ON p.id = si.project_id AND p.deleted_at IS NULL
WHERE c.org_id = $1
  AND c.week = ANY($2)              -- array of week keys e.g. ARRAY['04.05.26','11.05.26',…]
GROUP BY 1, 2, 3
ORDER BY p.name, c.week;
```

At Melbourne scale (~577 people × 52 weeks × ~12 projects) the un-cached query touches ~150k cell rows — fast (<200ms) on indexed columns, but every page load doing this is wasteful. Materialise:

```sql
CREATE MATERIALIZED VIEW mv_project_week_actuals AS
  SELECT … (same SELECT as above without WHERE org_id) …;
CREATE INDEX ON mv_project_week_actuals (org_id, week, project_id);

-- Refresh after schedule writes via trigger OR every 5 min via pg_cron.
-- Trigger is more responsive but expensive at write scale; cron is simpler.
SELECT cron.schedule('refresh_project_week_actuals', '*/5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_project_week_actuals;$$);
```

#### Targets: new table

Forecast targets per project per week are user input (project manager sets them); they're not derived. New table:

```sql
CREATE TABLE public.project_targets (
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  week           text NOT NULL,                  -- 'DD.MM.YY' to match schedule.week
  target_headcount integer NOT NULL CHECK (target_headcount >= 0),
  notes          text,
  set_by         text,                           -- manager_name who entered it
  set_at         timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, week)
);

-- RLS: same shape as schedule — anon role read/write within own org.
ALTER TABLE public.project_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "targets_select_org" ON public.project_targets
  FOR SELECT USING (project_id IN (SELECT id FROM public.projects WHERE org_id = current_setting('request.jwt.claim.org_id', true)::uuid));
-- (similar for INSERT/UPDATE/DELETE — see §3 for the org-scoping pattern)
```

#### The forecast cell value (target + actual + delta)

Combined in one query for the UI:

```sql
SELECT
  p.id                                 AS project_id,
  p.name                               AS project_name,
  weeks.week                           AS week,
  COALESCE(a.actual_headcount, 0)      AS actual,
  COALESCE(t.target_headcount, NULL)   AS target,
  CASE WHEN t.target_headcount IS NULL THEN NULL
       ELSE COALESCE(a.actual_headcount, 0) - t.target_headcount
  END                                  AS delta
FROM public.projects p
CROSS JOIN unnest($2::text[]) AS weeks(week)        -- e.g. ARRAY['04.05.26','11.05.26',…]
LEFT JOIN mv_project_week_actuals a
       ON a.project_id = p.id AND a.week = weeks.week AND a.org_id = $1
LEFT JOIN public.project_targets t
       ON t.project_id = p.id AND t.week = weeks.week
WHERE p.org_id = $1
  AND p.status IN ('Active','Won','Tendering')
  AND p.deleted_at IS NULL
ORDER BY p.name, weeks.week;
```

Returns a row per (project, week) with NULL targets where none have been entered yet.

### Empty-state UX

A starter / SMB tenant just installing the upgrade will have:
- 0 projects (haven't created any)
- 0 targets

Forecast view should NOT show an empty grid — that's user-hostile. Instead:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Forecast — get a 52-week view of your labour deployment                     │
│                                                                              │
│   Step 1: Create your first project                          [+ New project]│
│   Step 2: Group your sites under a project                                  │
│   Step 3: Set headcount targets for the next 12 weeks                       │
│                                                                              │
│   Why use this? Your roster shows "this week"; the forecast shows           │
│   "where will I need 50 people in 6 months." Useful when you're tendering   │
│   for a project that needs 30 sparkies in August — does my pool have that?  │
│                                                                              │
│  [Watch 90-second walkthrough]   [Skip — I'll do this later]                │
└──────────────────────────────────────────────────────────────────────────────┘
```

After Step 1 (one project exists), the forecast grid renders with that project as the only row. After Step 3 (targets entered), the grid is fully populated. Each step removes itself from the empty-state checklist as it completes.

### Navigation between current-week roster and forecast

Today: roster page IS the current-week editor. There's no "future weeks" affordance beyond clicking ⟨ ⟩ to step a week at a time.

After this lands, navigation looks like:

```
   Sidebar                     Current view
   ┌────────────┐              ┌──────────────────────────┐
   │ Dashboard  │              │ ROSTER                   │
   │ My Schedule│              │ (week-by-week editor)    │
   │ Calendar   │              │ ⟨ ⟩ to step weeks         │
   │ Forecast ✨│ ─── click ──> [⇒ Forecast] zooms out    │
   │ Contacts   │              └──────────────────────────┘
   │ Supervision│                            ↑
   │ Sites      │                            │ click a project row
   │ Roster     │                            │
   │ Timesheets │              ┌──────────────────────────┐
   │ …          │              │ FORECAST                 │
   └────────────┘              │ (project × week grid)    │
                               │ filters, totals,         │
                               │ apprentice ratio         │
                               │ [⇐ This week] zooms back │
                               └──────────────────────────┘
```

- New "Forecast" sidebar entry; ✨ badge on first introduction (clear after first visit).
- Bidirectional zoom: ⇒ Forecast zooms out from current week, ⇐ This week zooms in.
- Project row click → "current-week roster filtered to this project's sites" — same roster page, narrowed lens.
- Cell click → drill-down panel showing the actual people deployed that week to that project.

### Editing forecast targets inline

Cells in the `target` row are editable:

- Click cell → number input replaces the value.
- Enter / blur → save target via PATCH on `project_targets`.
- Tab → move to next week's target on the same project.
- Shift+click range → "fill range with this value".
- Right-click cell → context menu: "copy to all weeks", "extrapolate from last 4 weeks" (linear), "lock target" (prevents future edits without unlocking — nice for finalised contracts).

### Mobile

The 52-week grid does not fit on mobile. Mobile forecast view collapses to:

```
┌──────────────────────┐
│ Forecast · VIC       │
│ ⇄ Wk24 (15/06)       │ ← swipe left/right to change week
├──────────────────────┤
│ Airtrunk Shell L     │
│   359 / target 360   │ ← red if delta ≥ 10%
│   ─1                 │
├──────────────────────┤
│ NEXTDC M3S4          │
│   18 / target 25     │
│   ⚠ -7               │
├──────────────────────┤
│ TOTAL  402 / 425     │
│ Apprentice ratio 3.4 │
└──────────────────────┘
```

One week at a time, swipe to navigate. Same data, mobile-friendly density. Project supervisors on iPad / phone get the headline picture without horizontal scroll.

### Effort

| Step | Effort | Risk |
|---|---|---|
| `v_schedule_cells` view + `mv_project_week_actuals` | S | Low — one query, indexed |
| `project_targets` table + RLS | S | Low — additive |
| Forecast page React-equivalent (vanilla JS in this stack) | L | Medium — new render path, edit interactions |
| Aggregation refresh strategy (cron vs trigger) | S | Low — cron simpler, latency 5 min |
| Mobile layout | M | Low — separate small renderer |
| Empty-state walkthrough | S | Low — static content |
| Sidebar entry + navigation wiring | S | Low — additive |

Total Section 2 surface: ~1-2 weeks of UI work + a few hours of SQL + materialised view setup.

---

## Section 3 — Migration path

### Principles

1. **Every step is reversible until the last one.** Each migration ships with a `down` script. The "last one" is the deprecation of `schedule.name` (denormalised name column) — that's the only irreversible step, and it comes after months of dual-write validation.
2. **Additive before destructive.** All schema changes are NEW columns / NEW tables / NEW indexes for the first 3 phases. Drop / rename steps are deferred to phase 4 once the new shape has bedded in.
3. **EQ Supabase first, SKS Supabase second.** Always. EQ is in SEED-demo mode (per finding #11), so changes there have zero user impact — perfect for canary. SKS gets the migration only after EQ has run a full week without issues.
4. **Per-tenant feature flag gates the UI.** Schema changes don't change UI by themselves. Each tenant's `organisations.tier` field controls which UI surface is visible. Schema can land in production weeks before the UI is enabled for any paying tenant.
5. **Backfills run in batches with `LIMIT 1000` cursors**, not as a single statement, so a long-running backfill doesn't lock writes.

### Migration order (chronological)

#### Phase A — Foundations (week 1)

These are pure additives. No backfills. No code changes required. No UI changes. EQ + SKS get them on the same day.

```
A1. CREATE TABLE regions  — new table, no FK from anything yet
A2. CREATE TABLE projects — new table, no FK from anything yet
A3. ALTER TABLE organisations ADD is_seed_demo, tier
    UPDATE organisations SET is_seed_demo='true', tier='Starter' WHERE slug='eq';
    UPDATE organisations SET is_seed_demo='false', tier='SMB'    WHERE slug='sks';
A4. ALTER TABLE projects, sites, people ADD region_id (nullable, no FK enforced yet)
A5. ALTER TABLE sites ADD project_id (nullable, no FK enforced yet)
A6. CREATE INDEX on each new FK column WHERE col IS NOT NULL
```

**Rollback**: each table / column drops cleanly. Five `DROP TABLE` / `DROP COLUMN` statements. ~30 seconds.

**Verification**: `SELECT count(*) FROM information_schema.columns WHERE table_name IN ('projects','regions','organisations') AND column_name IN ('id','region_id','project_id','tier','is_seed_demo')` returns the expected count on both Supabase projects.

**Why no FK enforcement yet**: existing rows have NULL region_id / project_id. Enforcing the FK would require backfilling all rows first, which is Phase B. Splitting the schema add from the FK enforcement keeps each migration small + reversible.

#### Phase B — Backfill (week 2)

Now the new columns get populated. Code is still operating on the OLD shape — these backfills are invisible to users.

```
B1. INSERT regions for each existing tenant
    -- e.g. for SKS: INSERT INTO regions (org_id, code, name, timezone)
    --                VALUES (sks_org_id, 'NSW', 'New South Wales', 'Australia/Sydney');
B2. UPDATE people SET region_id = (SELECT id FROM regions WHERE code='NSW' AND org_id=people.org_id)
    WHERE org_id = sks_org_id AND region_id IS NULL;
    -- (run in 1000-row batches if people > 5000 rows; here SKS has ~50 so trivial)
B3. UPDATE sites SET region_id = … same pattern …
B4. CREATE a "Default Project" per tenant for sites that don't have one
    INSERT INTO projects (org_id, region_id, name, abbr, status)
    VALUES (sks_org_id, nsw_region_id, 'Default Project', 'DEFAULT', 'Active');
B5. UPDATE sites SET project_id = default_project_id WHERE project_id IS NULL;
B6. ALTER TABLE people    ADD employment_type text DEFAULT 'FT';
B7. UPDATE people SET employment_type = CASE … WHEN group='Apprentice' AND agency IS NOT NULL THEN 'LHApprentice' … END;
B8. ALTER TABLE people    ADD rto text, ADD hire_company text;
B9. UPDATE people SET hire_company = agency WHERE agency IS NOT NULL;
B10. UPDATE schedule SET person_id = … (Section 1 §5 backfill query) …
```

**Rollback for Phase B**: each step is data-only. Reverting means setting the new columns back to NULL or dropping the seeded rows. Two-step rollback:
```
DELETE FROM projects WHERE name = 'Default Project';
UPDATE sites SET project_id = NULL, region_id = NULL;
UPDATE people SET region_id = NULL, employment_type = NULL, rto = NULL, hire_company = NULL;
UPDATE schedule SET person_id = NULL;
DELETE FROM regions;
-- then Phase A's drops if needed
```

**Verification**: `SELECT count(*) FROM people WHERE region_id IS NULL` returns 0 for tenants that have been backfilled. Spot-check ~5 random rows — `region_id`, `employment_type`, `hire_company` all populated correctly.

**Code state during Phase B**: app continues to read/write the OLD shape. The new columns are populated but ignored. This is the safe-rollback window — if anything goes wrong, drop the new columns and the app keeps working.

#### Phase C — FK enforcement + dual-write (week 3-4)

Now the code starts USING the new columns. But it doesn't STOP using the old ones. Both are written; only the old is read by default.

```
C1. ALTER TABLE sites ALTER COLUMN region_id SET NOT NULL;
    -- (only safe after Phase B verified region_id is populated everywhere)
C2. ALTER TABLE sites ADD CONSTRAINT sites_region_fk
    FOREIGN KEY (region_id) REFERENCES regions(id);
C3. (similar for sites.project_id, people.region_id)
C4. CODE ROLLOUT: saveCellToSB / savePersonToSB / saveSiteToSB now write the new columns
    on every UPDATE/INSERT. Existing data already populated by Phase B; new data writes
    through both old and new columns simultaneously.
C5. CODE ROLLOUT: schedule.person_id is now written on every saveCellToSB call. The old
    schedule.name column is ALSO still written (denormalised). Both kept in sync.
```

**Rollback for Phase C**: drop the FK constraints (one ALTER per FK). Code rollout rollback is a deploy of the previous version. If a bug surfaces in the new column writes, OLD column reads still work — feature is invisible to users.

**Verification**: after C4 deploy, check `SELECT count(*) FROM schedule WHERE person_id IS NULL AND created_at > '2026-04-30'` — should be 0 (all new schedule rows written by the new code have person_id populated).

#### Phase D — Switch reads + drop denormalised columns (week 5+)

After 1-2 weeks of dual-write at C5, confidence is high. Time to flip:

```
D1. CODE ROLLOUT: queries that previously used schedule.name + sites.abbr text matching
    now use schedule.person_id + sites.project_id JOINs. UI starts showing the new shape
    (forecast view goes live behind tier='Enterprise' flag).
D2. CODE ROLLOUT: stop writing the OLD denormalised schedule.name on saves (still readable
    for backward compat).
D3. (After 1 more week with no rollback) ALTER TABLE schedule DROP COLUMN name;
    -- THE ONLY IRREVERSIBLE STEP. Defer until you have backups + are sure.
D4. (After people.agency → people.hire_company rename has settled, ~2 weeks)
    ALTER TABLE people DROP COLUMN agency;
    -- Also irreversible; rename has been live as both columns for the dual-write period.
```

**Rollback for D1-D2**: deploy previous version. Old columns still in DB.

**Rollback for D3-D4**: there isn't one without restoring from backup. That's why these come last and only after verification windows.

### EQ first, SKS second — concrete sequence

```
Day 0    Apply Phase A to EQ Supabase (project ktmjmdzqrogauaevbktn)
         Smoke test: presence still works, schedule still reads, no console errors.
         Run for 24h.

Day 1    Apply Phase A to SKS Supabase (project nspbmirochztcjijmcrx)
         Smoke test on sks-nsw-labour.netlify.app for 24h.

Day 7    Apply Phase B (backfill) to EQ. Inspection. Reversal-test on a copy.
Day 9    Apply Phase B to SKS.

Day 14   Phase C1-C3 (FK constraints) on EQ.
Day 14   Code deploy to demo branch with C4-C5 dual-write.
Day 15   Same to main branch (SKS production).

Day 28   Phase D1 — code deploy that READS new columns. EQ first (demo branch).
Day 30   D1 → SKS (main branch). Forecast UI feature-flagged behind tier='Enterprise'.

Day 42   Phase D2 — stop writing old denormalised columns. Both tenants.
Day 56   Phase D3-D4 — DROP COLUMN. Both tenants. Backups taken first.
```

Total: ~8 weeks from kick-off to fully cleaned-up schema. Most of that is verification windows, not engineering time.

### Backup strategy

Supabase has automatic daily backups by default. Before each phase:

1. **Phase A (additive)** — no backup needed, fully reversible by ALTER TABLE DROP.
2. **Phase B (backfill)** — take a manual `pg_dump --schema-only` of the affected tables, store in the project's GitHub repo under `migrations/snapshots/`. Backfill is reversible by setting NEW columns to NULL.
3. **Phase C (FK enforcement)** — full Supabase point-in-time backup before running. Takes ~2 minutes for the project size.
4. **Phase D (DROP COLUMN)** — full Supabase backup + a `pg_dump --data-only` of the column being dropped, stored offline. The column is gone from the live DB but recoverable from the dump if needed within 90 days.

### Risk list

| Risk | Mitigation |
|---|---|
| Phase B backfill takes longer than expected at scale | Run on EQ first (small data), measure, extrapolate. Use 1000-row LIMIT cursors so writes can interleave. |
| Code rollout in Phase C breaks something subtle | Deploy to demo first, observe for 24h. Demo-tenant SEED short-circuit means EQ users don't see the change until tier flag flips, so a buggy Phase C code on demo affects ~0 paying users. |
| Schema FK constraint added on a table with NULL rows | C1 explicitly checks `count(*) WHERE col IS NULL = 0` before running ALTER. If non-zero, halt and re-run B. |
| Forecast view exposes data the user shouldn't see (RLS gap) | RLS on `projects` mirrors `sites`: `org_id = current_setting('jwt.claim.org_id')`. Verified by querying as anon role pre-launch. |
| User has the OLD app cached and writes via OLD code path during Phase D | Service worker cache key includes APP_VERSION (per v3.4.45+ pattern). Phase D's deploy bumps version → SW invalidates → user gets new code on next page load. |

### What actually goes into source control

- 6 new migration files in `migrations/` (one per phase step that touches schema):
  - `2026-MM-DD_phase_a1_create_regions.sql`
  - `2026-MM-DD_phase_a2_create_projects.sql`
  - … etc
- Each migration file has a header noting `Applied: EQ ✓ DD/MM/YYYY · SKS ✓ DD/MM/YYYY` (matching the existing convention from `2026-04-16_tafe_day_and_holidays.sql`).
- Code rollouts ride normal release versions (v3.5.0 for Phase C feature flag, v3.5.1 for D1 read switchover, etc).

### Effort

| Phase | Engineering | Verification | Calendar |
|---|---|---|---|
| A — additive schema | 4h | 1 day | Day 0-1 |
| B — backfill | 6h | 1 week | Day 7-14 |
| C — FK + dual-write code | 1 week | 2 weeks | Day 14-28 |
| D — read switch + cleanup | 1 week | 2 weeks | Day 28-56 |

Total wall-clock: ~8 weeks. Total engineering: ~3 weeks of focused work, the rest is verification windows.

---

## Section 4 — Phasing

### Distinguishing this from Section 3

Section 3 = the schema migration plumbing. Internal to engineering. User sees nothing change.
Section 4 = the product roadmap. What user-visible capabilities ship, in what order, gated by what flags.

The two are loosely coupled: schema migrations finish in ~8 weeks (Section 3), but feature waves can extend over 6+ months. The schema arrives once; the features ship in waves as engineering capacity allows and the tier model justifies.

### What ships first — Wave 1: Projects (~3-4 weeks)

The minimum viable product hierarchy. Just enough to make the rest of the design earn its keep without committing to forecast or multi-region.

**User-visible capability**: assign sites to projects; see "Airtrunk Shell L · 23 people" instead of "AIRT · 23 people" on dashboards and rosters.

**Schema delivered** (Section 3 phases A, B, C subset):
- `projects` table created
- `sites.project_id` column wired and FK enforced
- `mv_project_week_actuals` materialised view created (5-min refresh)

**UI delivered**:
- New "Projects" sidebar entry below "Sites"
- Add Project / Edit Project modal (same shape as Sites)
- Site form: dropdown to assign a project (nullable; default "Default Project" for legacy)
- Dashboard widget: per-project headcount (this week)
- Roster row chips show site abbr AND project abbr ("AIRT · DC1") when project is set

**Tier gating**: `tier IN ('SMB', 'Enterprise')`. Starter (EQ today's SEED) hides the Projects sidebar entry entirely.

**Decision point at end of Wave 1**: was project hierarchy useful to SKS in practice? If supervisors don't use it, the rest of the roadmap is theoretical. Talk to Royce + Mark + the project managers; if they say "yes, this is what was missing", proceed to Wave 2. If "we don't really group sites by projects" — the rest of the roadmap pivots toward employment-type analytics instead.

### Wave 2: Forecast view (~4-6 weeks after Wave 1)

The Section 2 design lands as a real page.

**User-visible capability**: 52-week horizon grid; project managers can set headcount targets and see actual vs target per project per week.

**Schema delivered**: project_targets table; v_schedule_cells view; mv_project_week_actuals already exists from Wave 1.

**UI delivered**:
- New "Forecast" sidebar entry between "Roster" and "Timesheets"
- Full grid + filters + edit interactions per Section 2
- Empty-state walkthrough for tenants with 0 projects (already covered in Wave 1)
- Mobile single-week swipe view

**Tier gating**: `tier = 'Enterprise'` only. SMB sees no Forecast entry. Starter / SMB tenants who want a peek can ask Royce to flip a per-tenant feature flag (`organisations.features.forecast = true`) for evaluation.

**Decision point at end of Wave 2**: how complete is the apprentice-ratio compliance picture? If the bottom rail's "Apprentice ratio: 3.4" is enough for state regulators, ratio compliance is done. If not, Wave 3 expands into a dedicated compliance module.

### Wave 3: Employment type + RTO/GTO + apprentice-ratio compliance dashboard (~3-4 weeks after Wave 2)

The HR-shaped axis lands.

**User-visible capability**: filter rosters by employment type; see "12 FT, 4 LH, 3 FTApprentice" headcount strips; per-region apprentice-ratio compliance widget.

**Schema delivered**: `people.employment_type`, `people.rto`, `people.hire_company` (rename from `agency`).

**UI delivered**:
- People form gets two new dropdowns (employment type, RTO)
- Person card shows employment type as a badge alongside today's group icon
- Roster filter dropdown adds employment-type filter
- New compliance dashboard widget on Dashboard page: "Apprentice ratio per region · this week · last 4 weeks trend"
- Optional alert when ratio drops below state threshold (state-specific — NSW = 1:3 max, configurable per region)

**Tier gating**: `tier IN ('SMB', 'Enterprise')`. Compliance is valuable at SMB scale too — SKS today would benefit.

### Wave 4: Multi-region (~6-8 weeks after Wave 3)

The hardest wave, by a margin. Touches auth, RLS, UI everywhere.

**User-visible capability**: a single tenant can have NSW + VIC + QLD + WA as siblings. Supervisors are scoped to a region; cross-region admins can see all.

**Schema delivered**: regions table (already there from Section 3), region_id columns (already there), region-aware RLS policies.

**UI delivered**:
- Region picker in the sidebar (above "My Schedule")
- People form gets region dropdown
- Sites form gets region dropdown (constrained to project's region)
- Forecast view filterable by region (already in Section 2 design)
- Audit log filter by region
- Per-region timezone display (closes BATTLE-TEST #32)

**Schema bonus**: tenant-timezone field on regions enables correct audit-log grouping cross-state.

**Tier gating**: `tier = 'Enterprise'` only. Default for SMB is single implicit region (current behaviour).

**Decision point**: at end of Wave 4, the schema work is fully exposed. From here on, the question shifts from "can we model Melbourne's data?" to "can we sell to Melbourne?" — different conversation.

### Wave 5+: Surface-area expansion (each ~2-4 weeks)

Once the core shape is in, additional waves can run in parallel or stage:

- **Self-serve onboarding** (Starter tier path): hosted sign-up form provisions a tenant + first user + sample SEED data. Replaces the current "ask Royce to spin up a Supabase project" workflow.
- **Magic-link approve from email** (already chipped earlier): tokenised approve/reject in the leave email + Friday digest. Cross-tier value.
- **Bulk operations**: assign 50 people to a project in one action; copy a full week's roster to a future week as a template; bulk import people via CSV with the new employment_type column.
- **Reporting / export**: weekly project headcount CSV for payroll integration; per-region compliance report PDF.
- **Integrations**: Xero / MYOB payroll handoff (per-person hours by week); Google Calendar leave sync.

### Parallel vs sequential delivery

```
Wave 1 (Projects) ─┬─> Wave 2 (Forecast) ─┐
                   │                       ├─> Wave 4 (Multi-region) ─> Wave 5+
                   └─> Wave 3 (HR axis) ───┘
```

Wave 2 and Wave 3 can run in parallel — they touch different data + UI surfaces. Wave 4 needs both done first because RLS policies have to know about region_id on every query Wave 2 / 3 introduce.

Practical engineer-allocation:
- 1 engineer: sequential. ~28 weeks total (~7 months).
- 2 engineers: Wave 1 sequential, Waves 2+3 in parallel, Wave 4 sequential. ~20 weeks total (~5 months).
- 3 engineers: Wave 1 sequential, then 3 parallel tracks (Wave 2 / Wave 3 / Wave 5+ early starts), Wave 4 sequential. ~16 weeks total (~4 months).

Royce's current development cadence is 1 person (Royce + Claude). Practical estimate: ~5-7 months from kickoff to all 4 waves done, assuming ~10 hours/week of focused engineering and verification.

### Decision points (the gates between waves)

| End of | Decision | Question to answer | If "no" → |
|---|---|---|---|
| Wave 1 | Was project hierarchy actually used? | Talk to Mark + project managers. Are they grouping sites by project? | Pivot Waves 2+ toward HR-axis analytics; skip forecast altogether |
| Wave 2 | Is forecast accurate enough? | Compare 4-week-out forecast actuals to targets. Within 10%? | Add target-history table (forecast accuracy report); maybe iterate UX before Wave 3 |
| Wave 3 | Compliance widget adopted? | Do supervisors check ratio before approving leave? | Move ratio into a hard-block rule on the leave form (state regs require it); needs legal review |
| Wave 4 | Multi-region complete? | Can a NSW supervisor approve a NSW request without seeing VIC requests? | Wave 4.5: tighten per-region RLS more before opening to multi-state customers |

### Tier mapping (cross-reference with BATTLE-TEST tier analysis)

| Tier | Waves visible | Examples |
|---|---|---|
| Starter (1-10 ppl, SEED-demo) | 0 | EQ tenant today (rebrand as Starter). No projects, no forecast, no employment_type advanced fields. |
| SMB (10-50, SKS today) | 0 + 1 + 3 | Add projects + employment_type + compliance widget. SKS's current Friday digest + leave + roster + supervision all stay. |
| Enterprise (50-500+, Melbourne) | 0 + 1 + 2 + 3 + 4 | Full surface — projects, forecast, employment_type, compliance, multi-region. |

Wave numbers map cleanly onto the tier model. Each tier *adds* waves, doesn't remove them. Progressive disclosure in the UI handles the visibility gating (covered in Section 5).

### Effort + calendar (consolidated)

| Wave | Engineering effort | Calendar (1 engineer) | Tier delivered |
|---|---|---|---|
| 1 — Projects | 3-4 weeks | Month 1 | SMB |
| 2 — Forecast | 4-6 weeks | Month 2-3 | Enterprise |
| 3 — HR axis + compliance | 3-4 weeks | Month 4 | SMB |
| 4 — Multi-region | 6-8 weeks | Month 5-6 | Enterprise |
| 5+ — Surface expansion | 2-4 weeks each | Month 7+ | All tiers |

Total to fully deliver Enterprise: ~6 months, 1 engineer. Faster with parallel tracks.

**The single most important sentence in this section**: Wave 1 ships first. Don't try to design or build Wave 2-4 before Wave 1 is in production and validated. Every wave-1 lesson (UI nits, RLS fights, perf surprises) compounds into better Wave 2-4 delivery. Resist the temptation to pre-build.

---

## Section 5 — UI shape

### Principle: progressive disclosure

The same codebase serves a 5-person Starter tenant and a 600-person Enterprise tenant. The Starter tenant should NOT see Projects, Forecast, Regions, employment_type filters, RTO field, or any of the Enterprise-tier surfaces — they'd be overwhelming and pointless at 5 people.

The Enterprise tenant should NOT see "Hide BETA tabs" toggles or simplified empty-state walkthroughs designed for a one-person electrical contractor — those are training wheels they don't need.

**Tier-driven feature flags** at the `organisations` row determine what the user sees. Three switches today, more added per Section 4 wave:

```sql
-- Already in the schema diff (Section 1)
-- organisations.tier text NOT NULL DEFAULT 'Starter'
--   CHECK (tier IN ('Starter','SMB','Enterprise'))

-- Added per wave:
ALTER TABLE public.organisations ADD COLUMN feature_projects_enabled boolean DEFAULT false;
ALTER TABLE public.organisations ADD COLUMN feature_forecast_enabled boolean DEFAULT false;
ALTER TABLE public.organisations ADD COLUMN feature_employment_type_enabled boolean DEFAULT false;
ALTER TABLE public.organisations ADD COLUMN feature_multi_region_enabled boolean DEFAULT false;
```

Two sources of truth: `tier` is the customer-facing pricing band (Starter / SMB / Enterprise); `feature_*_enabled` are individual toggles for rollout / per-tenant overrides. Default mapping:

| Tier | projects | forecast | employment_type | multi_region |
|---|---|---|---|---|
| Starter | off | off | off | off |
| SMB | on | off | on | off |
| Enterprise | on | on | on | on |

Per-tenant overrides (e.g. SKS asks for forecast preview before Enterprise upgrade) flip the individual flag without changing tier.

### What each tier sees

#### Starter (1-10 people, EQ today, the SEED-demo tier)

Sidebar is **minimal**:

```
┌──────────────┐
│  EQ Solves   │
│  Field       │
├──────────────┤
│ FORECAST     │
│ ◇ Dashboard  │
│ 🕐 My Schedule│
│ 📅 Calendar  │
│ ☎ Contacts   │  (50)
│ 🏠 Sites     │
│ 📋 Roster    │
│              │
│ MANAGE       │
│ ＋ Add Person │
│ ⇆ Import/Exp │
│ ❓ Help      │
└──────────────┘
```

Hidden vs SMB+: no Supervision panel, no Timesheets, no Apprentices, no BETA tabs, no Projects, no Forecast, no Region picker.

Default-collapsed sections in the navbar (already a tier-analysis entry — "Starter · S · Default-collapsed Leave/Timesheets"). The simplest possible "track 5 people on a roster" front door.

Settings → Advanced: shows a "Upgrade to SMB to unlock supervision, leave management, and project hierarchy" panel with a CTA button. Click → tenant tier is updated (manually for now, self-serve in Wave 5 hosted-onboarding).

#### SMB (10-50, SKS today)

Sidebar is **today's SKS sidebar** plus a new "Projects" entry below "Sites":

```
┌──────────────┐
│  SKS         │
├──────────────┤
│ FORECAST     │
│ ◇ Dashboard  │
│ 🕐 My Schedule│
│ 📅 Calendar  │
│ ☎ Contacts   │  (50)
│ 👥 Supervision│ (17)
│ 🏠 Sites     │
│ 📋 Projects  │ ← new in Wave 1
│ 📋 Roster    │
│ 📋 Weekly Roster
│ 📋 Timesheets │
│              │
│ MANAGE       │
│ ＋ Add Person │
│ ⇆ Import/Exp │
│ ❓ Help      │
│              │
│ TESTING      │
│ 🔢 Job Numbers BETA
│ 🏖 Leave BETA   │
│ 🎓 Apprentices BETA
│ 🆕 Trial Dashboard NEW
└──────────────┘
```

Same as today plus Projects, plus the Apprentice-ratio dashboard widget on Dashboard (Wave 3), plus employment_type filter on Roster + Contacts pages (Wave 3). No Forecast (Enterprise gate), no Regions picker (Enterprise gate).

#### Enterprise (50-500+, Melbourne size)

Adds **two more sidebar items** (Forecast, region picker) and exposes the full settings panel:

```
┌──────────────────┐
│ SKS Group        │
│ [Region: VIC ▼]  │ ← new
├──────────────────┤
│ FORECAST         │
│ ◇ Dashboard      │
│ 🕐 My Schedule   │
│ 📅 Calendar      │
│ ☎ Contacts       │  (350+)
│ 👥 Supervision   │
│ 🏠 Sites         │
│ 📋 Projects      │
│ 📋 Roster        │
│ 📈 Forecast      │ ← new in Wave 2
│ 📋 Weekly Roster │
│ 📋 Timesheets    │
│                  │
│ ANALYTICS        │ ← new section, Enterprise only
│ 📊 Apprentice Ratio
│ 📊 Compliance    │
│                  │
│ MANAGE           │
│ ＋ Add Person     │
│ 🌏 Regions       │ ← Enterprise admin
│ ⚙ Settings       │
└──────────────────┘
```

### Implementation pattern

In the existing vanilla-JS shape, gating happens in two places:

**1. Sidebar render** — `index.html` has the sidebar markup hardcoded today. Replace the Projects / Forecast / Regions / Analytics entries with conditional renders:

```js
// scripts/sidebar.js (new) — runs after loadTenantConfig populates TENANT
function renderSidebar() {
  const tier = TENANT.tier || 'Starter';
  const features = TENANT.features || {};

  const items = [
    { id: 'dashboard',     label: '◇ Dashboard',     visible: true },
    { id: 'my-schedule',   label: '🕐 My Schedule',  visible: true },
    { id: 'calendar',      label: '📅 Calendar',     visible: true },
    { id: 'contacts',      label: '☎ Contacts',      visible: true },
    { id: 'supervision',   label: '👥 Supervision',  visible: tier !== 'Starter' },
    { id: 'sites',         label: '🏠 Sites',        visible: true },
    { id: 'projects',      label: '📋 Projects',     visible: features.projects_enabled === true },
    { id: 'roster',        label: '📋 Roster',       visible: true },
    { id: 'forecast',      label: '📈 Forecast',     visible: features.forecast_enabled === true },
    { id: 'timesheets',    label: '📋 Timesheets',   visible: tier !== 'Starter' },
    // …
  ];

  document.getElementById('sidebar-nav').innerHTML = items
    .filter(i => i.visible)
    .map(i => `<a class="nav-item" data-page="${i.id}">${i.label}</a>`)
    .join('');
}
```

**2. Page-level guards** — every page's render function checks the feature flag at top:

```js
function renderForecast() {
  if (!TENANT.features?.forecast_enabled) {
    document.getElementById('forecast-content').innerHTML =
      `<div class="empty">
         <div class="empty-icon">📈</div>
         <p>Forecast is an Enterprise tier feature.</p>
         <p style="font-size:12px;color:var(--ink-3)">
           Talk to Royce about upgrading.
         </p>
       </div>`;
    return;
  }
  // … real forecast render …
}
```

This handles direct URL navigation (e.g. someone bookmarks `/#forecast` from when they were trial-Enterprise; tier downgrades; they get a friendly empty-state instead of a broken page).

### Settings panel

A new modal at Settings → Tier & Features (visible to tenant admins only) shows:

```
┌─────────────────────────────────────────────────────────────┐
│ Tier & Features                                       [✕]  │
├─────────────────────────────────────────────────────────────┤
│ Current tier: SMB                          [Upgrade to ENT]│
├─────────────────────────────────────────────────────────────┤
│ Features                                                    │
│   ☑ Project hierarchy           (SMB+)                     │
│   ☐ 52-week forecast view       (Enterprise) [Try preview] │
│   ☑ Employment-type filtering   (SMB+)                     │
│   ☐ Multi-region                (Enterprise) [Try preview] │
│   ☑ Apprentice ratio compliance (SMB+)                     │
│                                                             │
│ Tip: previews give you 14 days to evaluate at no charge.   │
│      Click "Try preview" — Royce gets pinged + flag flips. │
└─────────────────────────────────────────────────────────────┘
```

Disabled checkboxes for unavailable features show a "(Enterprise)" tag and a `[Try preview]` button that opens a server endpoint to flip the feature flag for 14 days. Royce gets emailed on every preview activation so he can follow up with the tenant about a real upgrade.

### Default-collapsed sections (Starter polish)

Tier-analysis entry already noted this for Starter: first-load surface should be Roster + Contacts only; Leave / Timesheets / Apprentices appear collapsed under a "Show more →" sidebar control. Click expand → those sections render. Reduces "what does all this do" friction for solo operators.

For SMB and Enterprise, expanded by default (today's behaviour).

```js
// In the sidebar items, add a 'collapsed_in_starter' flag:
{ id: 'leave',       label: '🏖 Leave',     visible: tier !== 'Starter', collapsed_in_starter: true }
```

Tenant admins can override per-tenant (Settings → Layout → "Show all sections by default").

### Region picker (Enterprise)

When `feature_multi_region_enabled = true` AND there's more than one region in the tenant, a region picker appears in the sidebar header:

- Default selection: user's home region (from `users.region_id` if added in Wave 4, or the first region for the tenant).
- Switching region: re-runs `loadFromSupabase` filtered to that region, repaints all pages.
- "All regions" option: cross-region admin view (audit log shows everything; roster aggregates).
- Picker is hidden entirely if the tenant has 0 or 1 regions (no point showing it).

Region scoping respects RLS: a user with `users.region_id = vic_id` and not flagged as cross-region admin literally cannot see NSW data — the SELECT returns nothing. UI hides the picker for those users.

### "Show all features" admin override

There's always a per-tenant admin who needs to see EVERYTHING for support / debugging — Royce on SKS today, eventually a Customer Success manager per Enterprise customer. Add a `users.is_super_admin` boolean (Wave 4 alongside multi-region):

```sql
ALTER TABLE public.users  -- assuming a users table by then
  ADD COLUMN is_super_admin boolean DEFAULT false;
```

Super-admins see all sections regardless of tier flags + a "Tier override (debug)" picker in the sidebar that lets them simulate a Starter tenant view, etc. Useful for diagnosing UI complaints from real customers. Hidden from non-super-admins entirely.

### Mobile

Sidebar collapses to a bottom-tab bar on mobile (already current behaviour). Same gating logic — invisible items just don't appear in the tab bar. Forecast view shows the mobile collapsed layout from Section 2.

### Effort

| Surface | Engineering | Risk |
|---|---|---|
| sidebar.js + renderSidebar conditional | M | Low — additive, replaces hardcoded markup |
| Page-level guards (per page) | S × ~5 pages | Low |
| Tier & Features settings modal | M | Low — standard form modal pattern |
| `[Try preview]` 14-day feature flag flip | M | Medium — needs an admin endpoint, audit log entry |
| Default-collapsed sections for Starter | S | Low |
| Region picker (Enterprise, Wave 4) | M | Medium — affects every page's data load |
| Super-admin tier-override picker | S | Low — power-user feature only |

Total: ~2-3 weeks of UI work, spread across waves. Each wave's engineering effort already includes its own page-level guards.

---

## Section 6 — Render performance at scale

### Today's numbers vs Melbourne's

| Surface | SKS today (~50 ppl) | Melbourne scale (~577 ppl) | Multiplier |
|---|---|---|---|
| Editor cells in DOM | ~50 × 7 = 350 | ~577 × 7 = 4,039 | 11.5× |
| Schedule rows on page load | ~50 × 4 weeks = 200 | ~577 × 52 weeks = 30,004 | 150× |
| Realtime messages / hour during active editing | ~20 (one supervisor) | ~200 (10 supervisors × 20 each) | 10× |
| Initial sbFetch payload (uncompressed) | ~50KB | ~3MB | 60× |

The 150× initial-load multiplier is the headline number. 30k schedule rows is too much to ship to the browser on every page load — both bandwidth and the subsequent DOM render would suffer.

### Three independent perf workstreams

These are largely orthogonal — work can run in parallel:

1. **Editor virtualisation** — render only the visible rows in the DOM, lazy-render the rest on scroll.
2. **Initial-load scoping** — don't ship 52 weeks of schedule data on every load; fetch the visible week range only.
3. **Realtime channel scoping** — don't subscribe to ALL schedule changes; subscribe per-region or per-week.

### Workstream 1 — Editor virtualisation

#### What today's render does

`renderEditor` in `scripts/roster.js` builds the entire DOM as a string concatenation, then writes it to `editor-content.innerHTML` in one shot. For 50 people × 7 cell-inputs each = 350 input elements, that's fine — modern browsers parse + lay out 350 elements in ~30ms.

For 577 people × 7 = 4,000 inputs, the same code path produces a ~4× slower paint (parse + reflow + paint). Anecdotally on iPad Safari this becomes a 200-400ms hang on every editor open or week navigation.

#### The choice: roll-our-own vs library

| Approach | Pros | Cons |
|---|---|---|
| **Roll-our-own intersection-observer-based** | Zero dependencies (matches the codebase ethos), full control, can lazy-render exactly what's needed | ~2 days engineering, edge cases (jump-to-row, search-highlight) need attention |
| **Clusterize.js** (3KB, no deps) | Drop-in, minimal complexity, designed exactly for this case | Still a dependency, slightly heavier markup, less customisable |
| **virtual-scroller / react-window equivalent for vanilla JS** | Battle-tested at scale | Heavier dependency footprint, framework-shaped |

Recommendation: **roll-our-own** to match the codebase. The pattern is well-understood and the editor is a controlled surface — fixed row height, no nested scroll, no dynamic row sizing. Cheap enough to write that the dependency cost outweighs the engineering hours saved.

#### Concrete approach

```js
// scripts/editor-virtual.js (new)
//
// Pattern:
//   - Render a "spacer" div sized to total-rows × row-height
//   - Render only rows visible in the viewport (+ 5 row buffer above/below)
//   - On scroll, recalculate visible range and re-render
//   - Each row keyed by (group, person.id) so renders don't churn unnecessarily

const ROW_HEIGHT_PX = 64;
const BUFFER_ROWS   = 5;
let _visibleRange = { start: 0, end: 0 };

function renderEditorVirtual() {
  const container = document.getElementById('editor-content');
  const groups    = ['Direct', 'Apprentice', 'Labour Hire'];
  const allPeople = groups.flatMap(g => STATE.people.filter(p => p.group === g));
  const totalRows = allPeople.length + groups.length;  // +1 for each group strip

  // Render skeleton: total-height spacer + a positioned "viewport" div
  container.innerHTML = `
    <div class="editor-spacer" style="height:${totalRows * ROW_HEIGHT_PX}px;position:relative">
      <div id="editor-rows" style="position:absolute;top:0;left:0;right:0"></div>
    </div>`;

  function renderVisible() {
    const scrollTop = container.scrollTop;
    const viewportH = container.clientHeight;
    const startRow  = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - BUFFER_ROWS);
    const endRow    = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT_PX) + BUFFER_ROWS);

    if (startRow === _visibleRange.start && endRow === _visibleRange.end) return;
    _visibleRange = { start: startRow, end: endRow };

    const rows = document.getElementById('editor-rows');
    rows.style.transform = `translateY(${startRow * ROW_HEIGHT_PX}px)`;
    rows.innerHTML = allPeople
      .slice(startRow, endRow)
      .map((p, i) => renderPersonRow(p, /* absolute idx */ startRow + i))
      .join('');
  }

  container.addEventListener('scroll', renderVisible, { passive: true });
  renderVisible();
}
```

Numbers: at 577 people, viewport shows ~10 rows at a time. With 5-row buffer = 20 rows in DOM at any moment instead of 577. **30× fewer DOM nodes.**

Key edge cases:

- **Search/jump-to-row**: scrollIntoView equivalent — set `container.scrollTop = personIndex × ROW_HEIGHT_PX`, then renderVisible repaints.
- **Edit-in-progress preservation**: if the user is typing in a cell that scrolls out of view, save the value to STATE before the row is removed from the DOM. On scroll back, the row re-renders with the preserved value.
- **Realtime updates**: when a remote write changes a cell that's currently NOT in the viewport, just update STATE — no DOM work needed. When it scrolls back into view, it renders with the new value.
- **Print / export**: bypass virtualisation, render all rows. Print-only CSS already handles the page-break layout.

Per the BATTLE-TEST finding #21 (input-attribute coupling presence.js ↔ roster.js), virtualisation needs to maintain the same `data-name` / `data-week` / `data-day` attributes so presence outlines keep working.

#### Effort

~2-3 days for the core. Another ~1-2 days for edge cases (search, edit preservation, presence interop). Test plan: load a synthesised 600-person SEED on demo and check editor responsiveness.

### Workstream 2 — Initial-load scoping

#### What today's load does

`loadFromSupabase` in `index.html:1665` fetches ALL schedule rows for the tenant in one shot:

```js
sbFetch('schedule?select=*'),
```

At Melbourne scale: 577 people × ~52 weeks of forward + 4 weeks of past = ~32,000 rows × ~120 bytes each = ~4MB JSON over the wire. On a 4G connection that's ~5 seconds of just waiting for the schedule load.

#### The fix: visible-week scoping + lazy expand

```js
// Instead of `?select=*`, fetch only the visible week range:
const currentMonday = mondayKey(new Date());
const weeksAhead = 12;  // default range
const weeksList = [];
for (let i = -2; i <= weeksAhead; i++) {
  weeksList.push(mondayKeyPlus(currentMonday, i));
}

sbFetch('schedule?select=*&week=in.(' + weeksList.map(encodeURIComponent).join(',') + ')')
```

- Default load: 14 weeks (2 past + 12 ahead).
- At 577 people × 14 weeks = ~8,000 rows = ~1MB. Acceptable on first paint.
- User clicks "show more weeks ahead" → lazy-fetch the next 12 weeks via additional sbFetch, append to STATE.schedule.
- "Show full year" loads all 52 weeks but at user request, with a loading spinner. Forecast page does this proactively because it needs the full range.

#### Pagination on people / contacts list

Same pattern for `?select=*&order=name` on people:

- Default load: first 100 rows ordered by name.
- Pagination controls at bottom: "Showing 1-100 of 577 · [Next 100]".
- Search field at top filters across the full set via `?name=ilike.*…*` queries (server-side filter).

577 people fits in memory comfortably (~700KB of JSON), so this is more about render speed than memory. But if we ever hit 5000+ people tenants, the pagination already exists.

#### Effort

~1-2 days. Mostly modifying loadFromSupabase + the renderRoster / renderContacts pagination affordances. Code change is small; testing is what takes time (need to verify week navigation, deep-linking, realtime merges still work with partial schedule in memory).

### Workstream 3 — Realtime channel scoping

#### What today's subscription does

`scripts/realtime.js` `_rtJoinChannel` subscribes to a postgres_changes channel filtered by `org_id`:

```js
const topic = 'realtime:public:schedule:org_id=eq.' + TENANT.ORG_UUID;
```

This means every supervisor receives EVERY schedule change for the entire tenant. At SKS today (50 people, 1-3 supervisors), that's maybe 20 messages/hour during peak. Trivial.

At Melbourne scale (577 people, 10-20 supervisors editing concurrently): ~200 messages/hour per supervisor × 20 supervisors = 4000 messages/hour fan-out. Network and battery cost on iPads becomes noticeable.

#### Three scoping options

**Option A — per-week scoping**:

```js
// Subscribe only to the current visible week
const topic = `realtime:public:schedule:org_id=eq.${TENANT.ORG_UUID}:week=eq.${STATE.currentWeek}`;
```

- Pro: drastically reduces traffic — supervisors only get changes for the week they're looking at.
- Pro: matches user mental model — when I'm editing wk24, I only care about wk24 changes.
- Con: changing weeks requires re-subscribing (channel teardown + new join). ~50ms latency on week-change but invisible.
- Con: cross-week aggregations (forecast view) need a separate broader subscription.

**Option B — per-region scoping** (Wave 4 multi-region):

```js
const topic = `realtime:public:schedule:org_id=eq.${TENANT.ORG_UUID}:region_id=eq.${STATE.currentRegion}`;
```

- A NSW supervisor doesn't get VIC roster changes. Lines up with the multi-region UI gating.
- Doesn't help inside a single region — VIC alone is still ~350 people.

**Option C — per-project scoping** (Wave 1 projects):

```js
const topic = `realtime:public:schedule:org_id=eq.${TENANT.ORG_UUID}:project_id=eq.${VIEWING_PROJECT}`;
```

- Only useful if the user is drilled into a specific project.
- Not the default view, so this is an opportunistic optimization.

**Recommendation**: Option A (per-week) as the default in Wave 2 (when forecast view stabilises which weeks the user touches). Option B layers cleanly on top in Wave 4. Option C as a small optimization for the project-drill-down view.

Combined: subscribe to `org_id + region_id + week_in_visible_range`. With 14-week visible range and one region, supervisor receives ~1/4 of org-wide traffic instead of 100%.

#### Effort

~3-4 days. The Phoenix protocol implementation in `scripts/realtime.js` already supports filtered topics — extending the filter syntax is small. Bigger work is handling channel resubscription on week-change / region-change without dropping events during the transition.

### Render performance — auxiliary concerns

#### Editor scroll performance on iPad Safari

iPad Safari has historically been the weakest renderer in the EQ Field user base. Even after virtualisation, scroll performance can degrade if:

- Cell `<input>` elements have `box-shadow` or `border-radius` (composite layer triggers).
- Inline `style` attributes on every cell (they are, today — hot pink `style="color:..."` per cell).

Mitigation: convert hot inline styles to CSS classes in a follow-up pass. Already a lurking issue today; becomes urgent at 600-row scale.

#### Service worker pre-cache budget

`sw.js` PRECACHE list grows with every new feature. At Melbourne scale we'll have added: editor-virtual.js, sidebar.js, forecast.js, regions.js, compliance.js. Each ~3-5KB compressed. Total ~30KB of new JS in PRECACHE — negligible.

#### Materialised view refresh latency

The `mv_project_week_actuals` from Section 2 refreshes every 5 minutes via pg_cron. At Melbourne scale with frequent edits, the forecast view could be up to 5 min stale. Two options:

- Accept 5min staleness (forecast is a planning tool, not real-time).
- Trigger-based refresh on schedule writes (more responsive, more DB load).
- Hybrid: trigger refresh when the most recent schedule write is older than 30s, throttled.

Recommendation: 5min cron is fine for v1. Tighten later if users complain.

### Performance budget per page

Concrete targets to validate against during Wave 2-4:

| Page | Time-to-interactive (4G iPad Safari) | Cells in DOM | Schedule rows in memory |
|---|---|---|---|
| Roster (Starter, ~10 ppl) | <500ms | ~70 | ~140 (14 wks × 10 ppl) |
| Roster (SMB, ~50 ppl) | <800ms | ~350 | ~700 (14 wks × 50 ppl) |
| Roster (Enterprise, ~600 ppl) | <1500ms | ~140 (virtualised) | ~8000 (14 wks × 577 ppl) |
| Forecast (Enterprise) | <2000ms (initial), <100ms (cached) | ~400 (12 wks × ~30 visible projects+rows) | (uses materialised view, not raw schedule) |
| Editor week-change | <300ms | re-renders visible range only | unchanged in memory |

These budgets become acceptance criteria for Wave 2 and Wave 4 PRs.

### Effort summary

| Workstream | Engineering | Calendar |
|---|---|---|
| Editor virtualisation | 4-5 days | Week of Wave 1 launch |
| Initial-load scoping | 1-2 days | Same week |
| Realtime channel scoping | 3-4 days | Wave 2 |
| Inline-style → CSS-class cleanup | 2-3 days | Background |
| Materialised view tuning | 1 day | Wave 2 |

Total: ~2 weeks of focused perf work, spread across the wave delivery. Most of it is week-of-Wave-2 — when the forecast view ships, performance becomes the gating factor.

---

## Section 7 — Open questions

**These are the decisions only you can make.** Sections 1-6 describe HOW to build the thing; Section 7 asks WHAT you actually want. Read this first if you only have 10 minutes — answers here unblock the rest of the roadmap.

Eight questions. Each has a recommendation + reasoning, but the recommendations are mine, not yours. Disagree freely.

### Q1. EQ tenant — keep as SEED demo, or transition to a real tenant?

**Recommendation**: Keep EQ as the **Starter tier SEED demo** permanently. Make this the official "try before you commit" front door for new prospects.

**Reasoning**:
- Today's behaviour (loadFromSupabase short-circuits to SEED for the EQ tenant — finding #11) already IS a SEED demo, just unintentionally. We can rebrand intent.
- The Melbourne sales motion needs a "click here, see it work in 30 seconds" demo. Today that's eq-solves-field.netlify.app. Don't break that pattern.
- A second persistent demo tenant (where actions stick) is useful for a different reason — extended trial. Could ship later as `trial.eq-solves-field.netlify.app` pointing to a different Supabase project with `is_seed_demo=false` and a 14-day data wipe schedule.
- Keeps the investment focused on SMB / Enterprise paths where revenue lives.

**Cost of NOT deciding now**: every new feature we build has to handle the EQ-as-SEED case anyway (because EQ Supabase exists and has live data accumulating). The 6 EQ-vs-demo gates audited in finding #12 are the visible artefact. If we decide "Starter = SEED forever", those gates are intentional and correct. If we decide "EQ becomes real", we have to remove them all in a careful sweep.

### Q2. Per-region pricing tiers — yes or no?

**Recommendation**: **No** for v1. One tenant subscribes once at one tier; regions are sub-units that share the tier. Revisit at 50+ paying tenants.

**Reasoning**:
- Per-region pricing is a billing complication. Stripe handles it but each step (sign-up, upgrade, downgrade, region added/removed) becomes a multi-step billing change.
- The Melbourne archetype customer doesn't want to think "is VIC on Enterprise but NSW on SMB?" — they want one bill.
- Sub-org admin (Q3) handles the "VIC office shouldn't see NSW data" axis without billing complexity.
- If a customer specifically asks for per-region pricing, that's a signal they should buy multiple tenant subscriptions instead.

**Cost of saying no**: simpler billing. Cleaner UX. Fewer edge cases.

### Q3. Sub-org admin model — global supervisors only, or per-region admins?

**Recommendation**: **Per-region admins** in Wave 4 (multi-region). RLS already requires `region_id` scoping for the data; layering a `users.region_id_admin` role onto that costs little extra.

**Reasoning**:
- Melbourne's reality: the VIC office runs VIC; the NSW office runs NSW. A NSW supervisor who can edit a VIC roster is the wrong shape.
- Implementation: add `users.role text` (`viewer` / `supervisor` / `admin`) and `users.region_id` (the region they admin). Cross-region admins flagged separately (`is_super_admin` from Section 5) for finance / IT roles.
- Doesn't replace global supervisors — those are users with `region_id = NULL` and `role = 'admin'`.

**Cost of NOT doing this**: tenants with multiple regions will share the supervisor PIN across the whole company, including data they shouldn't be editing. Privacy / governance issues.

### Q4. Labour-hire vendor portal — in scope or v3+?

**Recommendation**: **v3+** (out of Wave 1-4 scope). Treat as a separate product / SKU.

**Reasoning**:
- Labour-hire agencies (NECA, AGA, GForce, etc) want visibility into where their workers are deployed and how many hours have been worked. This is a real ask.
- BUT the user shape is fundamentally different — agency users are external to the tenant, need their own auth (vendor login), see only their workers' data (very narrow RLS), see no other tenant data (cross-tenant boundary).
- That's a separate product surface — different login, different navigation, different data model. Should not be tucked into EQ Field's existing surface.
- Could ship as `agency.eq.solutions` later — a thin portal that reads the same Supabase tables but with vendor-scoped RLS.

**Cost of saying yes-now**: the Wave 1-4 timeline doubles. Agency auth + UI is its own 2-3 month workstream. Better delivered AFTER the tenant-side platform is solid.

### Q5. Compliance / SOC 2 timeline — when?

**Recommendation**: **Don't pursue SOC 2 until you have a paying Enterprise customer asking for it.** Get the technical foundations right NOW (audit log retention, encrypted secrets, MFA-ready auth), but skip the formal certification process until a deal needs it.

**Reasoning**:
- SOC 2 Type 1 costs ~$15-30k AUD + 3-6 months of preparation. Type 2 costs more and takes 6-12 months of operating with controls in place.
- A first paying Enterprise customer would justify the investment + give specific guidance on which controls matter most.
- The technical work that DOES matter regardless: tighten the lax RLS (BATTLE-TEST #4 — `roster_presence USING(true)`), add user-level audit logging beyond current manager-level, add a secrets vault for service role tokens (BATTLE-TEST #11 implications), formalise the backup retention policy.
- Royce is solo — running through SOC 2 paperwork without a paying customer to fund it is a 3-month distraction from Wave 2 / Wave 3.

**Cost of NOT pursuing now**: missing some Enterprise tenders that explicitly require SOC 2 certification. Mitigation: be honest in sales conversations — "SOC 2 in progress" with a credible 6-month timeline once a deal is on the table.

### Q6. Hosted onboarding for Starter — yes when?

**Recommendation**: **Wave 5** (~Month 7). Defer self-serve until the Wave 1-4 surface is stable and customer feedback proves Starter is a real tier worth investing in.

**Reasoning**:
- Self-serve onboarding requires: sign-up form, Supabase project provisioning automation, email verification, billing integration, abuse / spam prevention.
- Per current scale (1 paying customer, SKS), manual onboarding is fine — Royce spins up Supabase projects when prospects ask.
- Once Wave 1-4 lands and the product appeals to small electrical contractors, build self-serve. Until then, every prospect IS a sales conversation, which is more useful for product feedback than self-serve sign-ups.

**Alternative**: a "request access" form on eq-solves-field.netlify.app's marketing page that emails Royce and creates a calendar invite. Lighter-weight than full self-serve, captures lead intent, doesn't block on automation.

### Q7. SSO — when does PIN auth get replaced?

**Recommendation**: **Wave 5+** for SAML/OAuth, but design Wave 4's auth changes to be SSO-compatible. Today's PIN works at SMB scale; Enterprise customers (>200 employees) typically demand SSO as a deal-blocker.

**Reasoning**:
- Today's PIN auth (per CLAUDE.md memory: plaintext compare via env vars, no salt-hash) works for SMB scale where everyone shares a code.
- Enterprise customers with 200+ employees want individual login (audit trail, deprovisioning, password rotation) which PIN doesn't support.
- SAML implementation is well-understood (Supabase has SAML support built-in for Enterprise tier of Supabase itself). Plumbing it through EQ Field is ~1-2 weeks engineering.
- Design implication for Wave 4: when adding `users` table for multi-region admin (Q3), structure it so SSO identity providers can populate it — `users.email` as the unique key, `users.external_idp_id` as a future column.
- BATTLE-TEST findings #43-47 (auth review) flagged the "remember me stores raw access code" issue. SSO replacement is the proper long-term fix.

**Cost of NOT doing now**: an Enterprise prospect could tender require SSO and we say "Q3 next year" → lose deal. Mitigation: same as SOC 2 — credible roadmap commitment when a deal demands it.

### Q8. Forecast accuracy target — how close before we declare it working?

**Recommendation**: **±15% at 4-week horizon, ±25% at 12-week horizon, no target for 12+ weeks.** Build the dashboards to show actual-vs-target accuracy retrospectively; if SKS / Melbourne use the forecast and the accuracy meets these bounds, ship to Wave 3.

**Reasoning**:
- Construction forecasts beyond 12 weeks are fundamentally guesses — clients change scope, projects delay, weather. ±25% is honest.
- ±15% at 4 weeks aligns with "next month is fairly visible". Tighter than that requires daily updates, which becomes operational overhead.
- The accuracy metric itself is valuable — Melbourne can use "our 4-week forecast accuracy is ±10%" as a credibility signal in tenders.
- Implementation: store target snapshots (project_targets is one row per project per week, but we could keep `target_history` with `set_at` timestamps) so retrospective accuracy queries work.

**Cost of NOT setting a target**: forecast view ships, supervisors enter targets, but nobody knows if the targets are good. Without the accuracy dashboard, the feature has no feedback loop.

### Summary table

| # | Question | Recommendation | Decision date |
|---|---|---|---|
| 1 | EQ → SEED forever or real? | Starter SEED forever | Before Wave 1 starts |
| 2 | Per-region pricing? | No (v1) | Wave 4 design phase |
| 3 | Sub-org admin model? | Per-region admins | Wave 4 (~Month 5) |
| 4 | Labour-hire vendor portal? | v3+ separate product | After Wave 4 ships |
| 5 | SOC 2 certification? | When a customer asks | When a deal demands |
| 6 | Self-serve onboarding? | Wave 5 (Month 7+) | After Waves 1-4 stable |
| 7 | SSO replacement for PIN? | Wave 5+, design for it earlier | When Enterprise deal requires |
| 8 | Forecast accuracy target? | ±15% / ±25% / no-target by horizon | Wave 2 launch |

The single most decision-blocking item: **Q1 (EQ as SEED forever)**. It's the foundation for the tier model, the migration path, the UI gating — everything in Sections 1-6 has a coexistence clause that depends on this answer. Decide Q1 first, then everything else falls into place.

---

## Doc done. Sections 1-7 complete.

Sections 1, 2, 3, 4, 5, 6, 7 — total ~1,800 lines covering schema diff with concrete SQL, forecast view design with wireframe + aggregation queries, zero-downtime migration path with rollback per step, five-wave product roadmap with decision points, tier-driven progressive disclosure UI design, render performance approach for 500+ rows / 30k schedule rows / per-week realtime scoping, and 8 open questions.

Status of work outside this doc:
- `BATTLE-TEST-2026-04-29.md` — 47 findings across 13 passes, 16 fixes shipped (v3.4.40-58), tier-analysis section populated.
- Live demo on `eq-solves-field.netlify.app` shipping at v3.4.58.
- Working branch `claude/festive-roentgen-60761d` clean.
- Open PRs to merge: none (last one merged at iteration 12).
- No pending Supabase migrations beyond what's already live.
- Royce on holidays. SKS prod untouched.

