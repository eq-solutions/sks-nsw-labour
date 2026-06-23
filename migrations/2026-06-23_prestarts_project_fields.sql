-- Add project_number, permit categories, and affects_other_trades to prestarts.
-- project_name and project_address are resolved from the sites table at runtime.

ALTER TABLE prestarts
  ADD COLUMN IF NOT EXISTS project_number       TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS permits_categories   JSONB   DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS affects_other_trades TEXT    DEFAULT '';
