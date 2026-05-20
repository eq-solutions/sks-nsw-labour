-- ─────────────────────────────────────────────────────────────
-- 2026-05-20_sks_function_search_path_hardening.sql
--
-- Applied: 2026-05-20 via Supabase MCP apply_migration to project
-- nspbmirochztcjijmcrx (sks-labour). Migration record stored as
-- 'sks_function_search_path_hardening_2026_05_20' in the supabase
-- migrations table.
--
-- Purpose:  Hygiene pass on SKS-Live to silence Supabase database-linter
--           advisor warnings. Zero behaviour change — all listed functions
--           already qualify schema references explicitly, so pinning the
--           search_path does not alter their execution.
--
-- Risk:     Zero. ALTER FUNCTION SET is reversible; REVOKE EXECUTE on
--           an event-trigger function has no functional effect (event
--           triggers fire on DDL only, can't be invoked via /rest/v1/rpc).
--
-- Verified: get_advisors security delta -8 WARN (6 search_path_mutable +
--           2 SECURITY DEFINER on rls_auto_enable). App traffic continued
--           uninterrupted; no error spikes in postgres or api logs.
--
-- Rollback: ALTER FUNCTION <fn> RESET search_path; GRANT EXECUTE ON
--           FUNCTION public.rls_auto_enable() TO anon, authenticated;
-- ─────────────────────────────────────────────────────────────

-- 1) Pin search_path on 4 trigger functions
ALTER FUNCTION public.prestarts_set_updated_at()       SET search_path = pg_catalog, public;
ALTER FUNCTION public.site_diaries_set_updated_at()    SET search_path = pg_catalog, public;
ALTER FUNCTION public.toolbox_talks_set_updated_at()   SET search_path = pg_catalog, public;
ALTER FUNCTION public.sync_job_number()                SET search_path = pg_catalog, public;

-- 2) Pin search_path on the SECURITY DEFINER digest trigger
--    (pg_cron calls this Fridays 12:00 AEST per app_config.digest_fn_url)
ALTER FUNCTION public.trigger_supervisor_digest(boolean) SET search_path = pg_catalog, public;

-- 3) Pin search_path on the 2 SKS Quotes business-logic functions
ALTER FUNCTION public.sks_quotes_update_status(uuid, text, text, bigint, text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.sks_quotes_create_with_history(jsonb)                    SET search_path = pg_catalog, public;

-- 4) Revoke EXECUTE on the event-trigger fn from anon-facing roles
--    rls_auto_enable() is an event_trigger (fires on CREATE TABLE DDL).
--    Cannot be invoked via REST regardless of EXECUTE grant, but
--    revoking silences the Supabase advisor warning.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
