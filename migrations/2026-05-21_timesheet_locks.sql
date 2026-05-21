-- ────────────────────────────────────────────────────────────
-- Migration: timesheet_locks (per-week lock for accounts sign-off)
-- Project:   eq-field-app (SKS-Live clone)
-- Version:   3.4.82  (Timesheets Phase 3 — Accounts Review mode)
-- Created:   2026-05-21
-- Applied:   SKS  (nspbmirochztcjijmcrx) — pending
-- ────────────────────────────────────────────────────────────
-- Phase 3 of the Timesheets rework. Polish (v3.4.79+v3.4.80) made
-- the page READ better. Smart fills (v3.4.81) made supervisor ENTRY
-- faster. This release adds the ACCOUNTS workflow — a way to lock
-- a week's timesheets once they've been reviewed and approved, so
-- a supervisor can't change historical entries by mistake.
--
-- One row per (week, org). Presence == locked. Absence == unlocked.
-- Lifecycle:
--   - Accounts (or any supervisor) locks → row inserted
--   - Any supervisor unlocks → row deleted (audited via auditLog)
--   - Re-locking after unlock just inserts again with a new
--     locked_at + locked_by
--
-- The supervisor-facing app behaviour is implemented client-side:
--   - timesheets.js refuses to save into a locked week
--   - A locked-week banner offers a "Request unlock" affordance
-- These guardrails are UI, not RLS — RLS still allows writes if
-- you'd somehow bypass the client. The intent is workflow help,
-- not security boundary.
--
-- Idempotent: every CREATE / ALTER guarded with IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.timesheet_locks (
  week_key   text NOT NULL,
  org_id     uuid NOT NULL,
  locked_at  timestamptz NOT NULL DEFAULT now(),
  locked_by  text,
  reason     text,
  PRIMARY KEY (week_key, org_id)
);

CREATE INDEX IF NOT EXISTS timesheet_locks_org_idx ON public.timesheet_locks (org_id);

ALTER TABLE public.timesheet_locks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='timesheet_locks' AND policyname='anon_select_timesheet_locks') THEN
    CREATE POLICY anon_select_timesheet_locks ON public.timesheet_locks
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='timesheet_locks' AND policyname='anon_insert_timesheet_locks') THEN
    CREATE POLICY anon_insert_timesheet_locks ON public.timesheet_locks
      FOR INSERT WITH CHECK (org_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='timesheet_locks' AND policyname='anon_delete_timesheet_locks') THEN
    CREATE POLICY anon_delete_timesheet_locks ON public.timesheet_locks
      FOR DELETE USING (org_id IS NOT NULL);
  END IF;
  -- No UPDATE policy: lock state is binary. Re-locking deletes the
  -- existing row + inserts a new one. Keeps the row-version history
  -- via the audit_log entries we drop on each lock/unlock action.
END $$;

COMMENT ON TABLE public.timesheet_locks IS
  'One row per locked week. Presence means the week is locked for editing. Absence means it is open. v3.4.82.';
COMMENT ON COLUMN public.timesheet_locks.week_key IS
  'Monday-of-week key matching STATE.currentWeek format (DD.MM.YY).';
COMMENT ON COLUMN public.timesheet_locks.locked_by IS
  'Display name of the supervisor who locked the week. From sessionStorage.eq_logged_in_name.';
COMMENT ON COLUMN public.timesheet_locks.reason IS
  'Optional free-text note (e.g. "Approved by Webb Financial 21 May").';
