-- ────────────────────────────────────────────────────────────
-- Migration: audit_log gets before/after + target metadata for revert
-- Project:   eq-field-app
-- Version:   3.4.76
-- Created:   2026-05-20
-- Applied:   EQ   (ktmjmdzqrogauaevbktn) — pending
--            SKS  (nspbmirochztcjijmcrx) — pending
-- ────────────────────────────────────────────────────────────
-- Field request:
--   Supervisor edited Monday by accident, pressed next-week, and
--   no longer knew what the previous value was. Local undo (Ctrl-Z
--   + topbar button) covers the immediate case; this migration adds
--   the DB-side capture so a row can be reverted from the audit log
--   modal even hours/days later, by a different supervisor.
--
-- Columns added (all nullable / safe-default — backward compatible
-- with rows written before this migration ran):
--   before_value  text     — pre-edit value as captured by caller
--   after_value   text     — post-edit value
--   target_table  text     — e.g. 'schedule' (only table supported
--                            for revert in v3.4.76)
--   target_id     text     — row id of the target. text so it
--                            works for both uuid (EQ) and bigint
--                            (SKS) PK tenants without a cast
--   target_field  text     — column on target_table (e.g. 'mon')
--   is_reverted   boolean  — true once a Revert has been applied
--                            against this audit row
--   reverted_by   bigint   — FK back into audit_log.id pointing
--                            at the Revert action that reversed it
--
-- Existing rows: before_value/after_value/target_* stay null and the
-- modal's Revert button simply isn't shown for them. is_reverted
-- defaults to false everywhere — no historical row is treated as
-- already-reverted.
--
-- Idempotent: every ADD/CREATE is guarded by IF NOT EXISTS so
-- re-running this script on an already-migrated DB is a no-op.
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS before_value text,
  ADD COLUMN IF NOT EXISTS after_value  text,
  ADD COLUMN IF NOT EXISTS target_table text,
  ADD COLUMN IF NOT EXISTS target_id    text,
  ADD COLUMN IF NOT EXISTS target_field text,
  ADD COLUMN IF NOT EXISTS is_reverted  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reverted_by  bigint;

-- Self-referencing FK (a revert action points back at the row it
-- reversed). ON DELETE SET NULL so cleaning up an old audit row
-- doesn't cascade-delete its later revert entry.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_log_reverted_by_fkey'
      AND conrelid = 'public.audit_log'::regclass
  ) THEN
    ALTER TABLE public.audit_log
      ADD CONSTRAINT audit_log_reverted_by_fkey
        FOREIGN KEY (reverted_by) REFERENCES public.audit_log(id)
        ON DELETE SET NULL;
  END IF;
END $$;

-- Lookup index for "find the most recent edit of this cell" queries.
-- Keeps the audit modal fast even with 50k+ rows.
CREATE INDEX IF NOT EXISTS audit_log_target_idx
  ON public.audit_log (target_table, target_id, target_field, created_at DESC);

COMMENT ON COLUMN public.audit_log.before_value IS
  'Pre-edit value of target_table.target_field. Captured by the writer; null on rows from before v3.4.76.';
COMMENT ON COLUMN public.audit_log.after_value IS
  'Post-edit value. Pair with before_value to reconstruct the change.';
COMMENT ON COLUMN public.audit_log.target_table IS
  'Table the edit modified. v3.4.76 only supports revert for ''schedule''.';
COMMENT ON COLUMN public.audit_log.target_id IS
  'Row id of the modified record. text to span uuid (EQ) and bigint (SKS) PK shapes.';
COMMENT ON COLUMN public.audit_log.target_field IS
  'Column on target_table that was edited (e.g. mon/tue/wed/...).';
COMMENT ON COLUMN public.audit_log.is_reverted IS
  'Set to true the moment a Revert is applied against this row, so the modal can show REVERTED instead of the Revert button.';
COMMENT ON COLUMN public.audit_log.reverted_by IS
  'Forward link to the audit_log row that captured the Revert action.';
