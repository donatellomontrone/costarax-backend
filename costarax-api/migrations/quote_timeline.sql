-- Extend quote_requests with logistics timeline timestamps
-- Status flow: sent → replied → confirmed → preparing → dispatched → fulfilled

ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS preparing_at  timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- If the status column has a CHECK constraint, extend it.
-- Run this only if your DB uses an enum or CHECK; otherwise it's a no-op.
-- You can verify with: \d quote_requests

-- Defensive: try to add new values to an enum type if one exists.
-- This is idempotent — duplicate values are silently ignored by Postgres 14+.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'quote_status'
  ) THEN
    BEGIN ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'preparing'; EXCEPTION WHEN others THEN NULL; END;
    BEGIN ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'dispatched'; EXCEPTION WHEN others THEN NULL; END;
  END IF;
END $$;
