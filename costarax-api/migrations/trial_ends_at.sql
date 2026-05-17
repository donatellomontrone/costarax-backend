-- ──────────────────────────────────────────────────────────────────────────
-- Add explicit trial expiry to suppliers
-- ──────────────────────────────────────────────────────────────────────────
-- A supplier is in "trial" state when admin granted them visibility
-- (suppliers.active = true) without a paid subscription record.
-- This column lets the admin set a hard end date for that trial, after which
-- the GET /api/admin/suppliers endpoint auto-pauses them.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN suppliers.trial_ends_at IS
  'When admin-granted trial access ends. NULL = no trial set / indefinite. '
  'When past and supplier has no active subscription, GET /api/admin/suppliers '
  'will auto-set active=false.';

-- Partial index so admin dashboard queries by trial_ends_at stay fast even at scale
CREATE INDEX IF NOT EXISTS idx_suppliers_trial_ends_at
  ON suppliers(trial_ends_at)
  WHERE trial_ends_at IS NOT NULL;
