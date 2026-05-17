-- ──────────────────────────────────────────────────────────────────────────
-- Multi-supplier RFQ support
-- ──────────────────────────────────────────────────────────────────────────
-- When a buyer creates a single Request for Quote that goes to multiple
-- suppliers at once, we insert one row in quote_requests per supplier,
-- all sharing the same rfq_group_id so the buyer can compare responses
-- side-by-side later.

ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS rfq_group_id uuid;

COMMENT ON COLUMN quote_requests.rfq_group_id IS
  'Group ID linking quote_requests that originated from the same multi-RFQ. '
  'NULL means a single-supplier quote (legacy flow).';

CREATE INDEX IF NOT EXISTS idx_quote_requests_rfq_group
  ON quote_requests(rfq_group_id)
  WHERE rfq_group_id IS NOT NULL;
