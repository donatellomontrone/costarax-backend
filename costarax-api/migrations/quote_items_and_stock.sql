-- ============================================================
-- Costarax — quote_items table + stock auto-decrement trigger
-- Run in Supabase SQL editor. Safe to re-run.
-- ============================================================
--
-- Today every quote_request stores its line items as a single
-- `products_summary` free-text column. That works for display but
-- prevents three things we want to ship next:
--   1. Structured order totals (admin All Quotes detail modal
--      shows "no line items recorded" because the table didn't exist)
--   2. Per-item supplier reply / counter-offer flow later
--   3. Stock decrement when an order goes to status='confirmed' — we
--      need to know which product_id × qty to subtract.
--
-- This migration:
--   - Creates public.quote_items
--   - Backfills nothing (existing quotes stay free-text only)
--   - Adds a trigger that decrements supplier_prices.stock_qty whenever
--     a quote_request flips from any non-confirmed status to confirmed,
--     using the rows in quote_items. Idempotent: re-confirming a row
--     that's already confirmed is a no-op.

CREATE TABLE IF NOT EXISTS public.quote_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id    uuid NOT NULL REFERENCES public.quote_requests(id) ON DELETE CASCADE,
  product_id          uuid REFERENCES public.products(id) ON DELETE SET NULL,
  product_name        text NOT NULL,         -- snapshot of the canonical name at quote-creation time
  quantity            numeric(12,3),
  unit                text,
  price_php           numeric(12,2),         -- supplier's offered unit price (filled when the reply lands)
  line_total_php      numeric(14,2) GENERATED ALWAYS AS (
                        COALESCE(quantity, 0) * COALESCE(price_php, 0)
                      ) STORED,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_items_quote_request_id
  ON public.quote_items(quote_request_id);

CREATE INDEX IF NOT EXISTS idx_quote_items_product_id
  ON public.quote_items(product_id) WHERE product_id IS NOT NULL;

-- ── Stock auto-decrement trigger ────────────────────────────────────────
-- Fires AFTER UPDATE on quote_requests when status flips to 'confirmed'.
-- For each quote_items row that has a product_id + quantity + matched
-- the same supplier, subtract qty from supplier_prices.stock_qty (clamped
-- at 0 so we never go negative).
CREATE OR REPLACE FUNCTION public.quote_confirm_decrement_stock()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire when status TRANSITIONS to 'confirmed' (avoids decrementing
  -- on every UPDATE of an already-confirmed row).
  IF NEW.status <> 'confirmed' OR (OLD.status IS NOT NULL AND OLD.status = 'confirmed') THEN
    RETURN NEW;
  END IF;

  UPDATE public.supplier_prices sp
    SET stock_qty = GREATEST(0, COALESCE(sp.stock_qty, 0) - COALESCE(qi.quantity, 0)::int)
    FROM public.quote_items qi
    WHERE qi.quote_request_id = NEW.id
      AND qi.product_id      = sp.product_id
      AND sp.supplier_id     = NEW.supplier_id
      AND sp.unit            = qi.unit
      AND sp.stock_qty IS NOT NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_confirm_decrement_stock ON public.quote_requests;
CREATE TRIGGER trg_quote_confirm_decrement_stock
  AFTER UPDATE OF status ON public.quote_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.quote_confirm_decrement_stock();

-- ── RLS + GRANTs ────────────────────────────────────────────────────────
ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_items_buyer_select" ON public.quote_items;
CREATE POLICY "quote_items_buyer_select" ON public.quote_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.quote_requests qr
      JOIN public.organization_members om ON om.business_id = qr.buyer_business_id
      WHERE qr.id = quote_items.quote_request_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "quote_items_supplier_select" ON public.quote_items;
CREATE POLICY "quote_items_supplier_select" ON public.quote_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.quote_requests qr
      JOIN public.organization_members om ON om.supplier_id = qr.supplier_id
      WHERE qr.id = quote_items.quote_request_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "quote_items_admin_select" ON public.quote_items;
CREATE POLICY "quote_items_admin_select" ON public.quote_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin','super_admin')
    )
  );

GRANT SELECT ON public.quote_items TO authenticated;

COMMENT ON TABLE public.quote_items IS
  'Structured line items inside a quote_request. Created by the RFQ '
  'wizard alongside products_summary (kept for backwards compat). '
  'Used by the admin quote-detail modal and by the stock-decrement '
  'trigger when an order is confirmed.';
