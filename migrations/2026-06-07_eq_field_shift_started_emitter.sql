-- Migration: eq_field_shift_started_emitter
-- Created: 2026-06-07
-- Target:  SKS LIVE operational DB (nspbmirochztcjijmcrx)
-- Purpose: Durable emitter for the EQ Shell AI-briefing "On Shift Now" panel.
--          Computes today's SKS roster (Australia/Sydney) via
--          eq_field_shift_payload, then cross-posts a shift.started canonical
--          event to the eq-shell canonical-api, which routes to the
--          sks-canonical data plane (ehowgjardagevnrluult) and stamps
--          app_source=field, tenant=sks from the bearer key + X-Tenant header.
--
-- Depends on: 2026-06-07_eq_field_shift_payload.sql
--
-- INERT UNTIL CONFIGURED. The post is a guarded no-op until two app_config rows
-- exist, so the daily cron never error-spams before the key is added. To
-- activate (run once, with the real key from eq-shell's Netlify env var
-- CANONICAL_API_KEY_FIELD):
--
--   INSERT INTO app_config (key, value) VALUES
--     ('canonical_api_url',       'https://core.eq.solutions/.netlify/functions/canonical-api'),
--     ('canonical_api_key_field', '<CANONICAL_API_KEY_FIELD value>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Inspect today's payload without posting:  SELECT public.eq_field_emit_shift_started(true);
-- Fire manually (real post):                SELECT public.eq_field_emit_shift_started(false);
-- Disable temporarily:                      SELECT cron.unschedule('eq-field-shift-started-daily');

-- Required extensions (no-ops if already enabled).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.eq_field_emit_shift_started(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_now_syd timestamp := (now() AT TIME ZONE 'Australia/Sydney');
  v_day     text := lower(to_char(v_now_syd, 'Dy'));
  v_week    text := to_char((date_trunc('week', v_now_syd))::date, 'DD.MM.YY');
  v_payload jsonb;
  v_url     text := (SELECT value FROM public.app_config WHERE key = 'canonical_api_url'       LIMIT 1);
  v_key     text := (SELECT value FROM public.app_config WHERE key = 'canonical_api_key_field' LIMIT 1);
  v_req     bigint;
BEGIN
  v_payload := public.eq_field_shift_payload(v_week, v_day);

  -- Nobody rostered (weekend / public holiday / week not entered): emit nothing.
  IF coalesce((v_payload->>'scheduled_count')::int, 0) = 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_one_rostered',
                              'week', v_week, 'day', v_day);
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'week', v_week, 'day', v_day,
                              'payload', v_payload);
  END IF;

  -- Guard: stay inert until the cross-app url + key are configured.
  IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
    RAISE NOTICE 'eq_field_emit_shift_started: canonical_api_url/key not configured - skipping post';
    RETURN jsonb_build_object('skipped', true, 'reason', 'not_configured',
                              'week', v_week, 'day', v_day);
  END IF;

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'X-Tenant',      'sks',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object(
                 'resource', 'events',
                 'event',    'shift.started',
                 'payload',  v_payload
               ),
    timeout_milliseconds := 30000
  ) INTO v_req;

  RETURN jsonb_build_object('posted', true, 'request_id', v_req,
                            'week', v_week, 'day', v_day,
                            'scheduled_count', v_payload->'scheduled_count');
END;
$$;

COMMENT ON FUNCTION public.eq_field_emit_shift_started(boolean) IS
  'Computes today''s SKS roster (eq_field_shift_payload, Australia/Sydney) and '
  'cross-posts a shift.started canonical event to the eq-shell canonical-api as '
  'app_source=field, tenant=sks. Guarded no-op until canonical_api_url + '
  'canonical_api_key_field exist in app_config. Pass TRUE for a dry run (returns '
  'the payload without posting). Skips when no one is rostered.';

REVOKE ALL ON FUNCTION public.eq_field_emit_shift_started(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eq_field_emit_shift_started(boolean) TO service_role;

-- Remove any previous schedule under this name so re-applying is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'eq-field-shift-started-daily';
EXCEPTION WHEN OTHERS THEN
  -- cron.job may not exist on very fresh projects; ignore.
  NULL;
END $$;

-- 19:30 UTC daily = 05:30 AEST (06:30 AEDT) - lands before the morning brief.
-- Running cron in UTC means Sydney drifts an hour across daylight saving; the
-- function recomputes "today" in Australia/Sydney, so the correct day is always
-- emitted. Accepted trade-off vs DST-aware scheduling in pg_cron.
SELECT cron.schedule(
  'eq-field-shift-started-daily',
  '30 19 * * *',
  $cron$ SELECT public.eq_field_emit_shift_started(false); $cron$
);
