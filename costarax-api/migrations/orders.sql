-- ──────────────────────────────────────────────────────────────────────────
-- Orders & spend tracking (extension of quote_requests)
-- ──────────────────────────────────────────────────────────────────────────
-- We treat a quote_request that has been "confirmed" as an order. To avoid
-- a new table (and a new Vercel function), we add the order-specific
-- columns directly to quote_requests. This keeps the data flow simple:
--
--   sent → replied → confirmed (= order) → fulfilled (= delivered)
--
-- total_amount_php is captured at confirm time so the platform can compute
-- real spend analytics — monthly spend, top suppliers by ₱, category mix
-- by ₱, savings opportunities, etc.

ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS total_amount_php numeric(12,2),
  ADD COLUMN IF NOT EXISTS confirmed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilled_at     timestamptz;

COMMENT ON COLUMN quote_requests.total_amount_php IS
  'Agreed total for this order in PHP, captured when the buyer confirms.';
COMMENT ON COLUMN quote_requests.confirmed_at IS
  'Timestamp when status moved to confirmed (= the buyer placed the order).';
COMMENT ON COLUMN quote_requests.fulfilled_at IS
  'Timestamp when status moved to fulfilled (= the supplier delivered).';

-- Index to make "this month spend" / "YTD spend" aggregations fast
CREATE INDEX IF NOT EXISTS idx_quote_requests_confirmed_at
  ON quote_requests(confirmed_at)
  WHERE confirmed_at IS NOT NULL;

-- Index for buyer-side spend queries (most common case)
CREATE INDEX IF NOT EXISTS idx_quote_requests_buyer_status
  ON quote_requests(buyer_business_id, status)
  WHERE status IN ('confirmed','fulfilled');
