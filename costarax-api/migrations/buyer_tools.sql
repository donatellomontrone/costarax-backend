-- ============================================================
-- Buyer engagement tools — watchlist, order templates, budgets
-- ============================================================

-- ── 1. Watchlist ──────────────────────────────────────────────
-- Buyers star products they care about; we surface alerts when
-- any supplier's price for that product drops significantly.
CREATE TABLE IF NOT EXISTS public.buyer_watchlist (
  id           BIGSERIAL PRIMARY KEY,
  business_id  UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES public.products(id)   ON DELETE CASCADE,
  threshold_php NUMERIC,  -- alert when any supplier price <= this; null = relative drop only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, product_id)
);

CREATE INDEX IF NOT EXISTS bwl_business_idx
  ON public.buyer_watchlist (business_id);

ALTER TABLE public.buyer_watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bwl_owner_read"   ON public.buyer_watchlist;
DROP POLICY IF EXISTS "bwl_owner_write"  ON public.buyer_watchlist;

CREATE POLICY "bwl_owner_read" ON public.buyer_watchlist
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "bwl_owner_write" ON public.buyer_watchlist
  FOR ALL TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_watchlist TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.buyer_watchlist_id_seq TO authenticated;


-- ── 2. Saved order templates ─────────────────────────────────
-- "My usuals" — a saved RFQ basket the buyer can re-fire with one click.
CREATE TABLE IF NOT EXISTS public.order_templates (
  id           BIGSERIAL PRIMARY KEY,
  business_id  UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ot_business_idx
  ON public.order_templates (business_id, updated_at DESC);

ALTER TABLE public.order_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ot_owner_read"   ON public.order_templates;
DROP POLICY IF EXISTS "ot_owner_write"  ON public.order_templates;

CREATE POLICY "ot_owner_read" ON public.order_templates
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "ot_owner_write" ON public.order_templates
  FOR ALL TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_templates TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.order_templates_id_seq TO authenticated;


-- ── 3. Buyer budgets (per category, monthly) ─────────────────
CREATE TABLE IF NOT EXISTS public.buyer_budgets (
  id           BIGSERIAL PRIMARY KEY,
  business_id  UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  amount_php   NUMERIC NOT NULL,
  period       TEXT NOT NULL DEFAULT 'monthly',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, category, period)
);

CREATE INDEX IF NOT EXISTS bb_business_idx
  ON public.buyer_budgets (business_id);

ALTER TABLE public.buyer_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bb_owner_read"   ON public.buyer_budgets;
DROP POLICY IF EXISTS "bb_owner_write"  ON public.buyer_budgets;

CREATE POLICY "bb_owner_read" ON public.buyer_budgets
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "bb_owner_write" ON public.buyer_budgets
  FOR ALL TO authenticated
  USING (
    business_id IN (
      SELECT business_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_budgets TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.buyer_budgets_id_seq TO authenticated;
