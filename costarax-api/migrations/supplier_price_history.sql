-- Price history — append-only ticker of every price change on supplier_prices.
-- Powers "stock market" style delta chips, sparklines and market movers.

CREATE TABLE IF NOT EXISTS public.supplier_price_history (
  id           BIGSERIAL PRIMARY KEY,
  supplier_id  UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES public.products(id)  ON DELETE CASCADE,
  price_php    NUMERIC NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sph_supplier_product_idx
  ON public.supplier_price_history (supplier_id, product_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS sph_product_idx
  ON public.supplier_price_history (product_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS sph_recorded_at_idx
  ON public.supplier_price_history (recorded_at DESC);

-- Trigger: record a row every time price_php changes (or on insert).
CREATE OR REPLACE FUNCTION public.record_supplier_price_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') OR (TG_OP = 'UPDATE' AND OLD.price_php IS DISTINCT FROM NEW.price_php) THEN
    INSERT INTO public.supplier_price_history (supplier_id, product_id, price_php, recorded_at)
    VALUES (NEW.supplier_id, NEW.product_id, NEW.price_php, COALESCE(NEW.updated_at, now()));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_supplier_prices_history ON public.supplier_prices;
CREATE TRIGGER trg_supplier_prices_history
AFTER INSERT OR UPDATE ON public.supplier_prices
FOR EACH ROW EXECUTE FUNCTION public.record_supplier_price_change();

-- Seed: one history row per existing active price, so the chart has at least 1 anchor point.
INSERT INTO public.supplier_price_history (supplier_id, product_id, price_php, recorded_at)
SELECT supplier_id, product_id, price_php, COALESCE(updated_at, now())
FROM public.supplier_prices
WHERE active = true;

-- RLS — public read (the marketplace is meant to be transparent),
-- writes only via trigger / service role.
ALTER TABLE public.supplier_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sph_public_read" ON public.supplier_price_history;
CREATE POLICY "sph_public_read" ON public.supplier_price_history
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Supabase quirk: the policy isn't enough — anon/authenticated also need
-- the table-level SELECT grant or PostgREST returns 403 Forbidden.
GRANT SELECT ON public.supplier_price_history TO anon;
GRANT SELECT ON public.supplier_price_history TO authenticated;
