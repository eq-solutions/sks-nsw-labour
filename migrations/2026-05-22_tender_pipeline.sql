-- ────────────────────────────────────────────────────────────
-- Migration: tender pipeline (new schema for upstream labour planning)
-- Project:   eq-field-app (SKS-Live clone)
-- Version:   3.4.83 (Tender Pipeline — Phase 1: schema + parser)
-- Created:   2026-05-22
-- Applied:   SKS  (nspbmirochztcjijmcrx) — pending
-- ────────────────────────────────────────────────────────────
-- The "before" layer of labour planning. Mirrors SKS's Open 12m
-- Tenders Smartsheet into the app, lets the Construction Manager
-- pencil PMs/supervisors against likely jobs, surfaces double-
-- bookings, and runs a fortnightly review meeting against it.
--
-- Origin: bundle at C:\Projects\eq-field-pipeline\ was designed
-- for eq-solves-field demo (uuid PKs, eq_role enum on people,
-- Supabase-auth-driven RLS). This is the SKS-native rewrite
-- against the actual SKS shape:
--   - Mixed PKs (organisations.id uuid, managers/people/sites/
--     job_numbers.id bigint)
--   - No people.role — PM/Supervisor identity lives in managers
--     filtered by managers.category
--   - App-layer org_id stamping (no auth.uid()); RLS policies
--     match the existing SKS pattern of anon SELECT(true) +
--     anon INSERT/UPDATE/DELETE with org_id NOT NULL check
--
-- KEY DESIGN DECISIONS (do not change without re-reading the
-- bundle's handover-and-abandonment.md):
--   1. No nomination history — pencillings are mutable straight
--      updates. Moving people on/off slots leaves no audit trail.
--      Intentional: lowers social weight of speculative pencilling.
--   2. nominations.person_id nullable + capacity_tag column —
--      future-proofs v1.5 "any data centre supervisor" pencilling.
--   3. Yellow clashes (both pencilled) have neutral UI styling.
--      They are the system working — not a warning.
--   4. CM manually confirms the labour curve when promoting a Won
--      tender to Confirmed. The friction is the feature.
--   5. UI says "Notes", DB says "decisions" (table:
--      tender_review_decisions). Lowers social weight of logging.
--   6. PM nominees:        managers WHERE category = 'Project Management'
--      Supervisor nominees: managers WHERE category = 'Supervisor'
--      CM review owner:     app_config row pipeline_review_cm_manager_id
--      (picker drawn from managers filtered by SUPERVISOR_CATEGORIES)
--   7. Flat $100k value floor across all departments. AV depts
--      intentionally excluded at this floor (confirmed 2026-05-22).
--      Configurable via app_config row pipeline_value_floor.
--
-- Idempotent: every CREATE / ALTER / INSERT guarded with IF NOT
-- EXISTS / ON CONFLICT so re-running is a no-op.
-- ────────────────────────────────────────────────────────────

-- ─── 1. Enums ────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pipeline_stage') THEN
    CREATE TYPE public.pipeline_stage AS ENUM (
      'tracked',    -- 0-25% — in DB, not surfaced in pipeline view
      'watch',      -- 50% Shortlisted
      'likely',     -- 70-90% In Negotiation / Verbal Agreement
      'won',        -- 100% Won, awaiting promotion to Confirmed
      'confirmed',  -- CM promoted; labour curve drafted/applied
      'lost'        -- archived (Smartsheet status=Lost OR missing for 2 imports)
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nomination_role') THEN
    CREATE TYPE public.nomination_role AS ENUM ('pm', 'supervisor');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nomination_status') THEN
    CREATE TYPE public.nomination_status AS ENUM ('pencilled', 'confirmed');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_decision_kind') THEN
    CREATE TYPE public.review_decision_kind AS ENUM (
      'escalate',
      'kill',
      'promote',
      'hold',
      'resolve_clash'
    );
  END IF;
END $$;

-- ─── 2. Shared trigger functions ─────────────────────────────
-- set_updated_at(): generic updated_at-bumper. Safe to CREATE OR
-- REPLACE — if any pre-existing migration created it with a
-- different body, the body is replaced verbatim across all
-- tables that already reference it. The body below is the
-- standard one: it must remain functionally identical to any
-- existing implementation to avoid breaking other triggers.
--
-- set_is_high_confidence(): pipeline-specific; flips tenders
-- .is_high_confidence to true when probability_pct >= 90.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.set_is_high_confidence()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_high_confidence = (NEW.probability_pct IS NOT NULL AND NEW.probability_pct >= 90);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. tenders ──────────────────────────────────────────────
-- Mirror of SKS's "Open 12m Tenders (State) - NSW" Smartsheet.
-- One row per (org_id, external_ref). On re-import the row is
-- UPDATEd; missing_import_count bumps when external_ref is
-- absent from an import; stage flips to 'lost' at 2 misses.

CREATE TABLE IF NOT EXISTS public.tenders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  external_ref          text NOT NULL,                       -- e.g. "SKS-16404"
  job_name              text NOT NULL,
  client                text,
  estimator             text,
  vertical              text,                                -- "Data Centres"
  department            text,                                -- "Projects - Elec", "Projects - AV", "Client Services - …"
  entity                text,                                -- "SKS Technologies" / "SKS Indigenous Technologies"
  site_address          text,
  quote_value           numeric,
  due_date              date,
  tender_status         text,                                -- "Currently Tendering", "Pending", "Pipeline", "Revised"
  probability_pct       smallint CHECK (probability_pct BETWEEN 0 AND 100),
  probability_label     text,                                -- "70% - In Negotiation" raw
  stage                 public.pipeline_stage NOT NULL DEFAULT 'tracked',
  is_high_confidence    boolean NOT NULL DEFAULT false,      -- true when probability_pct >= 90 (set by trigger)
  below_threshold       boolean NOT NULL DEFAULT false,      -- quote_value < pipeline_value_floor
  archived_at           timestamptz,
  missing_import_count  smallint NOT NULL DEFAULT 0,
  job_number_id         bigint REFERENCES public.job_numbers(id),  -- linked at Confirmed
  site_id               bigint REFERENCES public.sites(id),        -- linked at Confirmed
  first_imported_at     timestamptz NOT NULL DEFAULT now(),
  last_imported_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenders_ref_per_org_unique UNIQUE (org_id, external_ref)
);

CREATE INDEX IF NOT EXISTS tenders_org_stage_idx       ON public.tenders (org_id, stage) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS tenders_org_department_idx  ON public.tenders (org_id, department);
CREATE INDEX IF NOT EXISTS tenders_external_ref_idx    ON public.tenders (external_ref);

ALTER TABLE public.tenders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tenders' AND policyname='anon_select_tenders') THEN
    CREATE POLICY anon_select_tenders ON public.tenders FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tenders' AND policyname='anon_insert_tenders') THEN
    CREATE POLICY anon_insert_tenders ON public.tenders FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tenders' AND policyname='anon_update_tenders') THEN
    CREATE POLICY anon_update_tenders ON public.tenders FOR UPDATE USING (org_id IS NOT NULL) WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tenders' AND policyname='anon_delete_tenders') THEN
    CREATE POLICY anon_delete_tenders ON public.tenders FOR DELETE USING (org_id IS NOT NULL);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tenders_updated_at      ON public.tenders;
CREATE TRIGGER trg_tenders_updated_at
  BEFORE UPDATE ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_tenders_high_confidence ON public.tenders;
CREATE TRIGGER trg_tenders_high_confidence
  BEFORE INSERT OR UPDATE OF probability_pct ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.set_is_high_confidence();

COMMENT ON TABLE public.tenders IS
  'SKS Smartsheet tender mirror. Surfaces in pipeline view when stage in (watch, likely, won) and below_threshold = false.';
COMMENT ON COLUMN public.tenders.missing_import_count IS
  'Increments each import run where this external_ref is absent from the file. Stage flips to lost at 2 misses (one miss could be a Smartsheet export glitch).';
COMMENT ON COLUMN public.tenders.below_threshold IS
  'True when quote_value < the org-configurable floor (default $100k via app_config.pipeline_value_floor). Filtered out of pipeline view by default toggle.';

-- ─── 4. tender_enrichment ────────────────────────────────────
-- Planning fields added in-app, not from Smartsheet. One row per
-- tender (CASCADE deletes when tender goes). needs_review flips
-- true when the underlying tender row changes after enrichment,
-- so the fortnightly review can surface "review this enrichment".

CREATE TABLE IF NOT EXISTS public.tender_enrichment (
  tender_id             uuid PRIMARY KEY REFERENCES public.tenders(id) ON DELETE CASCADE,
  hours_estimated       numeric,
  start_date_estimated  date,
  duration_weeks        smallint CHECK (duration_weeks > 0),
  peak_workers          smallint CHECK (peak_workers >= 0),
  confidence_notes      text NOT NULL DEFAULT '',
  needs_review          boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            bigint REFERENCES public.managers(id)
);

ALTER TABLE public.tender_enrichment ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_enrichment' AND policyname='anon_select_tender_enrichment') THEN
    CREATE POLICY anon_select_tender_enrichment ON public.tender_enrichment FOR SELECT USING (true);
  END IF;
  -- Enrichment writes use the parent tender's org_id for the gate (joined at app layer).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_enrichment' AND policyname='anon_insert_tender_enrichment') THEN
    CREATE POLICY anon_insert_tender_enrichment ON public.tender_enrichment FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_enrichment' AND policyname='anon_update_tender_enrichment') THEN
    CREATE POLICY anon_update_tender_enrichment ON public.tender_enrichment FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_enrichment' AND policyname='anon_delete_tender_enrichment') THEN
    CREATE POLICY anon_delete_tender_enrichment ON public.tender_enrichment FOR DELETE USING (true);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tender_enrichment_updated_at ON public.tender_enrichment;
CREATE TRIGGER trg_tender_enrichment_updated_at
  BEFORE UPDATE ON public.tender_enrichment
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.tender_enrichment IS
  'Planning fields added in-app, not from Smartsheet. needs_review surfaces in fortnightly review when underlying tender changed after enrichment was saved.';

-- ─── 5. nominations ──────────────────────────────────────────
-- Soft assignment of PM/supervisor to a tender. Whole-job
-- granularity (week-level start/end). NO HISTORY KEPT — see
-- design decision #1.
--
-- person_id references managers(id), NOT people(id). PMs and
-- supervisors are managers (filtered by managers.category).
-- The workers placed on the labour curve are people(id); that
-- FK lives on pending_schedule.person_id below.

CREATE TABLE IF NOT EXISTS public.nominations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  person_id     bigint REFERENCES public.managers(id),                 -- nullable for v1.5 capacity_tag
  capacity_tag  text,                                                  -- v1.5: "data centre supervisor" / "any electrician"; null in v1
  role          public.nomination_role NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  status        public.nomination_status NOT NULL DEFAULT 'pencilled',
  start_week    date,                                                  -- Monday-snapped
  end_week      date,                                                  -- Monday-snapped
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint REFERENCES public.managers(id),
  CONSTRAINT nominations_person_or_tag CHECK (person_id IS NOT NULL OR capacity_tag IS NOT NULL),
  CONSTRAINT nominations_per_person_unique UNIQUE (tender_id, person_id, role),
  CONSTRAINT nominations_week_order CHECK (start_week IS NULL OR end_week IS NULL OR start_week <= end_week),
  CONSTRAINT nominations_start_monday CHECK (start_week IS NULL OR EXTRACT(DOW FROM start_week) = 1),
  CONSTRAINT nominations_end_monday   CHECK (end_week   IS NULL OR EXTRACT(DOW FROM end_week)   = 1)
);

CREATE INDEX IF NOT EXISTS nominations_person_idx ON public.nominations (person_id);
CREATE INDEX IF NOT EXISTS nominations_tender_idx ON public.nominations (tender_id);
CREATE INDEX IF NOT EXISTS nominations_weeks_idx  ON public.nominations (start_week, end_week) WHERE start_week IS NOT NULL;

ALTER TABLE public.nominations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nominations' AND policyname='anon_select_nominations') THEN
    CREATE POLICY anon_select_nominations ON public.nominations FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nominations' AND policyname='anon_insert_nominations') THEN
    CREATE POLICY anon_insert_nominations ON public.nominations FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nominations' AND policyname='anon_update_nominations') THEN
    CREATE POLICY anon_update_nominations ON public.nominations FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nominations' AND policyname='anon_delete_nominations') THEN
    CREATE POLICY anon_delete_nominations ON public.nominations FOR DELETE USING (true);
  END IF;
END $$;

COMMENT ON TABLE public.nominations IS
  'PM/supervisor pencilling against a tender. PM nominees: managers.category=''Project Management''. Supervisor nominees: managers.category=''Supervisor''. Whole-job granularity (v1). NO HISTORY KEPT BY DESIGN — nominations are mutable straight updates. See bundle handover-and-abandonment.md.';
COMMENT ON COLUMN public.nominations.person_id IS
  'FK to managers(id), NOT people(id). Nominees are managers (PMs/supervisors). The labour-curve workers are people(id) on pending_schedule.';
COMMENT ON COLUMN public.nominations.capacity_tag IS
  'v1.5 hook: pencil a role rather than a person, e.g. "data centre supervisor". Null in v1 UI.';

-- ─── 6. pending_schedule ─────────────────────────────────────
-- Draft labour curve, auto-generated when CM promotes Won →
-- Confirmed. CM reviews + assigns placeholders to real people,
-- then "Confirm and push" copies rows into the live schedule
-- table. Stays as a parallel record after confirmation
-- (confirmed_at set) so the curve history is auditable.

CREATE TABLE IF NOT EXISTS public.pending_schedule (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  org_id                   uuid NOT NULL,
  person_id                bigint REFERENCES public.people(id),   -- workers, not managers
  person_name_placeholder  text,                                  -- "Worker 1", "Worker 2" until CM assigns
  week                     text NOT NULL,                         -- matches schedule.week text format
  mon                      text, tue text, wed text, thu text, fri text, sat text, sun text,
  confirmed_at             timestamptz,                           -- set on CM confirm; rows copy to schedule then
  confirmed_by             bigint REFERENCES public.managers(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_schedule_tender_idx       ON public.pending_schedule (tender_id);
CREATE INDEX IF NOT EXISTS pending_schedule_unconfirmed_idx  ON public.pending_schedule (tender_id) WHERE confirmed_at IS NULL;

ALTER TABLE public.pending_schedule ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pending_schedule' AND policyname='anon_select_pending_schedule') THEN
    CREATE POLICY anon_select_pending_schedule ON public.pending_schedule FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pending_schedule' AND policyname='anon_insert_pending_schedule') THEN
    CREATE POLICY anon_insert_pending_schedule ON public.pending_schedule FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pending_schedule' AND policyname='anon_update_pending_schedule') THEN
    CREATE POLICY anon_update_pending_schedule ON public.pending_schedule FOR UPDATE USING (org_id IS NOT NULL) WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pending_schedule' AND policyname='anon_delete_pending_schedule') THEN
    CREATE POLICY anon_delete_pending_schedule ON public.pending_schedule FOR DELETE USING (org_id IS NOT NULL);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_pending_schedule_updated_at ON public.pending_schedule;
CREATE TRIGGER trg_pending_schedule_updated_at
  BEFORE UPDATE ON public.pending_schedule
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.pending_schedule IS
  'Auto-generated draft labour curve when tender promoted Likely → Confirmed. CM reviews + confirms; on confirm, rows copy into schedule and confirmed_at is set. Day fields match schedule.text format (site abbrs).';
COMMENT ON COLUMN public.pending_schedule.person_name_placeholder IS
  'Used when peak_workers exceeds named nominees. CM assigns real people.id before final confirm.';

-- ─── 7. tender_import_runs ───────────────────────────────────
-- Audit trail per Smartsheet upload. Powers the
-- "what changed since last review" panel.

CREATE TABLE IF NOT EXISTS public.tender_import_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL,
  imported_at             timestamptz NOT NULL DEFAULT now(),
  imported_by             bigint REFERENCES public.managers(id),
  file_name               text,
  rows_total              integer NOT NULL DEFAULT 0,
  rows_new                integer NOT NULL DEFAULT 0,
  rows_stage_changed      integer NOT NULL DEFAULT 0,
  rows_value_changed      integer NOT NULL DEFAULT 0,
  rows_missing            integer NOT NULL DEFAULT 0,
  rows_below_threshold    integer NOT NULL DEFAULT 0,
  notes                   text
);

CREATE INDEX IF NOT EXISTS tender_import_runs_org_date_idx ON public.tender_import_runs (org_id, imported_at DESC);

ALTER TABLE public.tender_import_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_import_runs' AND policyname='anon_select_tender_import_runs') THEN
    CREATE POLICY anon_select_tender_import_runs ON public.tender_import_runs FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_import_runs' AND policyname='anon_insert_tender_import_runs') THEN
    CREATE POLICY anon_insert_tender_import_runs ON public.tender_import_runs FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
  -- No UPDATE / DELETE policy: import runs are append-only audit rows.
END $$;

COMMENT ON TABLE public.tender_import_runs IS
  'Append-only audit log per Smartsheet upload. Powers the "what changed since last review" panel in the fortnightly review screen.';

-- ─── 8. tender_review_decisions ──────────────────────────────
-- Fortnightly meeting log. session_id groups decisions made in
-- one sitting (set by "Start Review Session" button).
-- UI says "Notes" everywhere; table name is the technical truth.

CREATE TABLE IF NOT EXISTS public.tender_review_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  session_id    uuid,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  tender_id     uuid NOT NULL REFERENCES public.tenders(id),
  decision      public.review_decision_kind NOT NULL,
  notes         text,
  decided_by    bigint REFERENCES public.managers(id)
);

CREATE INDEX IF NOT EXISTS tender_review_decisions_tender_idx  ON public.tender_review_decisions (tender_id);
CREATE INDEX IF NOT EXISTS tender_review_decisions_session_idx ON public.tender_review_decisions (session_id);
CREATE INDEX IF NOT EXISTS tender_review_decisions_date_idx    ON public.tender_review_decisions (org_id, reviewed_at DESC);

ALTER TABLE public.tender_review_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_review_decisions' AND policyname='anon_select_tender_review_decisions') THEN
    CREATE POLICY anon_select_tender_review_decisions ON public.tender_review_decisions FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_review_decisions' AND policyname='anon_insert_tender_review_decisions') THEN
    CREATE POLICY anon_insert_tender_review_decisions ON public.tender_review_decisions FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tender_review_decisions' AND policyname='anon_update_tender_review_decisions') THEN
    CREATE POLICY anon_update_tender_review_decisions ON public.tender_review_decisions FOR UPDATE USING (org_id IS NOT NULL) WITH CHECK (org_id IS NOT NULL);
  END IF;
  -- No DELETE policy: review notes are an immutable log.
  -- Editing a note via UPDATE is allowed; removing one is not.
END $$;

COMMENT ON TABLE public.tender_review_decisions IS
  'Fortnightly review meeting log. UI labels this "Notes" everywhere — the table name is internal. session_id groups decisions captured in one sitting.';

-- ─── 9. nomination_clashes view ──────────────────────────────
-- Pairs of overlapping nominations for the same manager, with
-- severity tier. Red = both confirmed (impossible — needs
-- resolution); Amber = one confirmed + one pencilled; Yellow =
-- both pencilled (normal — the system working).
--
-- Capacity-tag nominations (person_id NULL) are excluded — they
-- cannot clash until assigned to a real manager.
-- Archived managers are excluded.

CREATE OR REPLACE VIEW public.nomination_clashes AS
SELECT
  n1.person_id,
  m.name AS person_name,
  n1.id          AS nom_a_id,
  n1.tender_id   AS tender_a_id,
  n1.status      AS nom_a_status,
  n1.start_week  AS nom_a_start,
  n1.end_week    AS nom_a_end,
  n2.id          AS nom_b_id,
  n2.tender_id   AS tender_b_id,
  n2.status      AS nom_b_status,
  n2.start_week  AS nom_b_start,
  n2.end_week    AS nom_b_end,
  GREATEST(n1.start_week, n2.start_week) AS overlap_start,
  LEAST(n1.end_week, n2.end_week)        AS overlap_end,
  CASE
    WHEN n1.status = 'confirmed' AND n2.status = 'confirmed' THEN 'red'
    WHEN n1.status = 'confirmed' OR  n2.status = 'confirmed' THEN 'amber'
    ELSE 'yellow'
  END AS severity
FROM public.nominations n1
JOIN public.nominations n2
  ON n1.person_id   = n2.person_id
  AND n1.id          < n2.id
  AND n1.start_week IS NOT NULL AND n2.start_week IS NOT NULL
  AND n1.start_week <= n2.end_week
  AND n2.start_week <= n1.end_week
JOIN public.managers m ON m.id = n1.person_id
WHERE m.archived = false;

COMMENT ON VIEW public.nomination_clashes IS
  'Overlapping nomination pairs per manager, with severity. Red = both confirmed (resolve now). Amber = one confirmed + one pencilled (drop the pencilling or find a backup). Yellow = both pencilled (normal; resolve when one tender wins). Capacity-tag nominations excluded — they cannot clash until assigned.';

-- ─── 10. app_config seed rows — DEFERRED to per-tenant manual INSERT ─
-- The 3 pipeline config rows are NOT seeded by this migration because
-- public.app_config has an org_id column (see 2026-04-16_tafe_day_and
-- _holidays.sql and 2026-04-16_tier1_features_schema.sql for the
-- per-tenant insert convention) and the value of pipeline_value_floor
-- can legitimately differ between tenants ($100k on SKS, possibly
-- different on EQ).
--
-- After applying this migration, run these PER TENANT via the SQL
-- editor (replacing the org_id literal with the right tenant's UUID):
--
--   -- SKS prod (org_id 1eb831f9-aeae-4e57-b49e-9681e8f51e15)
--   INSERT INTO public.app_config (key, value, org_id) VALUES
--     ('pipeline_enabled',              'false',  '1eb831f9-aeae-4e57-b49e-9681e8f51e15'),
--     ('pipeline_value_floor',          '100000', '1eb831f9-aeae-4e57-b49e-9681e8f51e15'),
--     ('pipeline_review_cm_manager_id', '',       '1eb831f9-aeae-4e57-b49e-9681e8f51e15')
--   ON CONFLICT (key, org_id) DO NOTHING;
--
--   -- EQ demo: look up its org_id first and substitute.
--
-- Keys:
--   pipeline_enabled              — runtime feature flag. Nav entry +
--                                   /pipeline routes gate on this.
--   pipeline_value_floor          — flat $ floor for the import filter.
--   pipeline_review_cm_manager_id — managers.id (text) of the CM running
--                                   the fortnightly review. Picker
--                                   filters by managers.category IN
--                                   ('Executive','Operations',
--                                    'Project Management','Construction',
--                                    'Supervisor','Internal','Other').

-- ─── 11. Verification (run manually after the migration) ─────
-- All non-mutating. Each should return the expected count.
--
--   -- 1) Enums present
--   SELECT typname FROM pg_type
--    WHERE typname IN ('pipeline_stage','nomination_role','nomination_status','review_decision_kind')
--    ORDER BY typname;
--   -- Expect 4 rows.
--
--   -- 2) Tables present + RLS on
--   SELECT tablename, rowsecurity
--     FROM pg_tables
--    WHERE schemaname = 'public'
--      AND tablename IN ('tenders','tender_enrichment','nominations',
--                        'pending_schedule','tender_import_runs',
--                        'tender_review_decisions')
--    ORDER BY tablename;
--   -- Expect 6 rows, rowsecurity=true on every row.
--
--   -- 3) Policies present (4 per table on writable tables, 2 on append-only)
--   SELECT tablename, COUNT(*)
--     FROM pg_policies
--    WHERE schemaname='public'
--      AND tablename IN ('tenders','tender_enrichment','nominations',
--                        'pending_schedule','tender_import_runs',
--                        'tender_review_decisions')
--    GROUP BY tablename ORDER BY tablename;
--   -- Expect:
--   --   tenders                   4
--   --   tender_enrichment         4
--   --   nominations               4
--   --   pending_schedule          4
--   --   tender_import_runs        2  (append-only — no update/delete)
--   --   tender_review_decisions   3  (immutable log — no delete)
--
--   -- 4) View compiles
--   SELECT count(*) FROM public.nomination_clashes;
--   -- Expect 0 (no nominations yet).
--
--   -- 5) Triggers wired
--   SELECT trigger_name, event_object_table
--     FROM information_schema.triggers
--    WHERE event_object_table IN ('tenders','tender_enrichment','pending_schedule')
--    ORDER BY event_object_table, trigger_name;
--   -- Expect: trg_pending_schedule_updated_at, trg_tender_enrichment_updated_at,
--   --         trg_tenders_high_confidence, trg_tenders_updated_at.
--
--   -- 6) high_confidence trigger smoke
--   INSERT INTO public.tenders (org_id, external_ref, job_name, probability_pct)
--     VALUES ((SELECT id FROM public.organisations WHERE slug='sks'),
--             'SMOKE-001','smoke-test', 70);
--   SELECT is_high_confidence FROM public.tenders WHERE external_ref='SMOKE-001';
--   -- Expect false.
--   UPDATE public.tenders SET probability_pct = 90 WHERE external_ref='SMOKE-001';
--   SELECT is_high_confidence FROM public.tenders WHERE external_ref='SMOKE-001';
--   -- Expect true.
--   DELETE FROM public.tenders WHERE external_ref='SMOKE-001';
--
--   -- 7) app_config seeded
--   SELECT key, value FROM public.app_config
--    WHERE key IN ('pipeline_value_floor','pipeline_review_cm_manager_id')
--    ORDER BY key;
--   -- Expect 2 rows; value 100000 for pipeline_value_floor; empty string for the CM id.

-- ─── End of migration ────────────────────────────────────────
