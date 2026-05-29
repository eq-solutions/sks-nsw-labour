-- Migration: pipeline_events table + triggers
-- Records tender stage changes as structured events for consumption by
-- the EQ Shell AI briefing (via pipeline-summary.js recent_events field).
--
-- Two triggers:
--   trg_tender_stage_events    — fires on tenders.stage UPDATE
--   trg_tender_verbal_events   — fires when is_high_confidence flips true
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS before each CREATE TRIGGER.
-- Applied: SKS (nspbmirochztcjijmcrx)

-- ─── pipeline_events table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id          bigserial   PRIMARY KEY,
  org_id      uuid        NOT NULL,
  event       text        NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_events_org_occurred
  ON public.pipeline_events (org_id, occurred_at DESC);

COMMENT ON TABLE public.pipeline_events IS
  'Audit log of tender state transitions for AI briefing context. Consumed by pipeline-summary.js recent_events field.';

COMMENT ON COLUMN public.pipeline_events.event IS
  'Event type: tender.stage_changed | tender.verbal_confirmed | tender.won | tender.confirmed | tender.lost';

ALTER TABLE public.pipeline_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pipeline_events' AND policyname = 'anon_select_pipeline_events') THEN
    CREATE POLICY anon_select_pipeline_events ON public.pipeline_events FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pipeline_events' AND policyname = 'anon_insert_pipeline_events') THEN
    CREATE POLICY anon_insert_pipeline_events ON public.pipeline_events FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
END $$;

-- ─── Stage change trigger ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.emit_pipeline_stage_event()
RETURNS TRIGGER AS $$
DECLARE
  _event   text;
  _payload jsonb;
BEGIN
  IF OLD.stage = NEW.stage THEN
    RETURN NEW;
  END IF;

  -- Specific event name for high-signal transitions; generic otherwise
  _event := CASE NEW.stage::text
    WHEN 'won'       THEN 'tender.won'
    WHEN 'confirmed' THEN 'tender.confirmed'
    WHEN 'lost'      THEN 'tender.lost'
    ELSE 'tender.stage_changed'
  END;

  _payload := jsonb_build_object(
    'external_ref', NEW.external_ref,
    'job_name',     NEW.job_name,
    'client',       NEW.client,
    'from_stage',   OLD.stage::text,
    'to_stage',     NEW.stage::text,
    'quote_value',  NEW.quote_value,
    'due_date',     NEW.due_date
  );

  INSERT INTO public.pipeline_events (org_id, event, payload)
  VALUES (NEW.org_id, _event, _payload);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_tender_stage_events ON public.tenders;
CREATE TRIGGER trg_tender_stage_events
  AFTER UPDATE OF stage ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.emit_pipeline_stage_event();

-- ─── Verbal agreement trigger ─────────────────────────────────
-- Fires when probability_pct crosses 90% on a 'likely' tender.

CREATE OR REPLACE FUNCTION public.emit_tender_verbal_event()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.is_high_confidence IS DISTINCT FROM true)
     AND NEW.is_high_confidence = true
     AND NEW.stage = 'likely'
  THEN
    INSERT INTO public.pipeline_events (org_id, event, payload)
    VALUES (
      NEW.org_id,
      'tender.verbal_confirmed',
      jsonb_build_object(
        'external_ref',     NEW.external_ref,
        'job_name',         NEW.job_name,
        'client',           NEW.client,
        'quote_value',      NEW.quote_value,
        'due_date',         NEW.due_date,
        'probability_pct',  NEW.probability_pct
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_tender_verbal_events ON public.tenders;
CREATE TRIGGER trg_tender_verbal_events
  AFTER UPDATE OF is_high_confidence ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.emit_tender_verbal_event();
