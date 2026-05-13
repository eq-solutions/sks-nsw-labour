-- ────────────────────────────────────────────────────────────
-- Migration: add leave_requests to supabase_realtime publication
-- Project:   eq-field-app
-- Version:   3.4.59
-- Created:   2026-05-13 (BATTLE-TEST Round 1 closeout)
-- Applied:   Demo  (ktmjmdzqrogauaevbktn) — applied via Supabase MCP
--                                            on 2026-05-13 (combined
--                                            with schedule via
--                                            2026-04-30_eq_realtime_publication.sql)
--            Prod  (nspbmirochztcjijmcrx) — applied via Supabase MCP
--                                            on 2026-05-13
-- ────────────────────────────────────────────────────────────
-- BATTLE-TEST finding #49 (NEW, surfaced post-Round 1 during the
-- demo→main port verification): when SKS Supabase publication state
-- was probed via `pg_publication_tables`, only `schedule` was in
-- the supabase_realtime publication. `leave_requests` was missing
-- from BOTH projects (EQ caught by 2026-04-30 migration; SKS had
-- never been added).
--
-- Symptom: when supervisor A approves a leave request on SKS, other
-- connected supervisors don't see the badge tick down (or the row
-- move from "pending" to "approved" in the list) until the next
-- 30-second poll. With realtime publication enabled they'd see it
-- within ~1-2 seconds.
--
-- This file documents what was applied; the actual ALTER PUBLICATION
-- was performed via Supabase MCP on 2026-05-13 against the SKS
-- project. Idempotent (uses IF NOT EXISTS) so re-applying is safe.
-- ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'leave_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.leave_requests;
  END IF;
END $$;
