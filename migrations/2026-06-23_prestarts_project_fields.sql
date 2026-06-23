-- Add project fields + permit categories + affects_other_trades to prestarts
-- Enables Word export to match the SKS Daily Pre-Start template exactly.

ALTER TABLE prestarts
  ADD COLUMN IF NOT EXISTS project_name         TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_number       TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_address      TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS permits_categories   JSONB   DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS affects_other_trades TEXT    DEFAULT '';
