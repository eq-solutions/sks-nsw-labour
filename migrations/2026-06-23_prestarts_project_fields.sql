-- Add project name / number / address to prestarts
-- Allows the Word export to match the SKS Daily Pre-Start template exactly.

ALTER TABLE prestarts
  ADD COLUMN IF NOT EXISTS project_name    TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_number  TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS project_address TEXT DEFAULT '';
