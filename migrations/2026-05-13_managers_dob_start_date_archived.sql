-- ────────────────────────────────────────────────────────────
-- Migration: managers gets dob/start_date + archive (both tables)
-- Project:   eq-field-app
-- Version:   3.4.70
-- Created:   2026-05-13
-- Applied:   EQ   (ktmjmdzqrogauaevbktn) — via MCP 2026-05-13
--            SKS  (nspbmirochztcjijmcrx) — via MCP 2026-05-13
-- ────────────────────────────────────────────────────────────
-- Royce flagged:
--   1. Supervisors have no birthday / start date fields. People do
--      (added in 2026-04-21_people_dob_start_date.sql). Mirroring
--      the same columns on managers so the supervision page can
--      surface anniversaries + birthdays the same way.
--   2. Archive vs hard delete. Today the soft-delete is via
--      `deleted_at` timestamp. Royce wants an "archive" semantic
--      that's reversible without losing the row. Mirrors the
--      leave_requests.archived pattern from 2026-04-16.
--
-- Backward-compatible. Existing rows get archived=false.
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.managers
  ADD COLUMN IF NOT EXISTS dob_day    smallint CHECK (dob_day   >= 1 AND dob_day   <= 31),
  ADD COLUMN IF NOT EXISTS dob_month  smallint CHECK (dob_month >= 1 AND dob_month <= 12),
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS archived   boolean NOT NULL DEFAULT false;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.managers.archived IS
  'Soft hide. Archived managers stay queryable + restorable but are filtered from default lists.';
COMMENT ON COLUMN public.people.archived IS
  'Soft hide. Same semantics as managers.archived.';
