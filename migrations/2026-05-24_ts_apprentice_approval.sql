-- ────────────────────────────────────────────────────────────
-- Migration: timesheets — apprentice approval columns
-- Project:   eq-field-app (SKS-Live)
-- Version:   3.10.7
-- Created:   2026-05-24
-- ────────────────────────────────────────────────────────────
-- Adds per-row approval tracking to the timesheets table.
-- Apprentice hours are cross-checked against the employer/training
-- portal each week; supervisors mark them approved here so everyone
-- can see who has been signed off and who hasn't.
--
-- approved     — boolean flag, default false
-- approved_by  — display name of the supervisor who approved
-- approved_at  — timestamp of approval (cleared on un-approve)
--
-- Idempotent: every ALTER guarded with IF NOT EXISTS check.
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS approved    boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.timesheets.approved    IS 'True once a supervisor has cross-checked hours against the employer portal. v3.10.7.';
COMMENT ON COLUMN public.timesheets.approved_by IS 'Display name of the supervisor who marked approved.';
COMMENT ON COLUMN public.timesheets.approved_at IS 'Timestamp of approval. NULL when not yet approved or after un-approval.';
