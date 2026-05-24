-- ============================================================
-- Costarax — GRANTS + FK fix
-- Run in Supabase SQL editor (SQL > New query > paste > Run)
-- Safe to re-run: all statements are idempotent
-- ============================================================

-- 1. Grant table-level SELECT to authenticated role.
--    PostgREST requires BOTH a table-level GRANT and an RLS policy.
--    The policy alone is not enough — without the GRANT the query
--    returns 403 / empty, which is the root cause of "Active · 0".
GRANT SELECT ON TABLE public.products              TO authenticated;
GRANT SELECT ON TABLE public.supplier_prices       TO authenticated;
GRANT SELECT ON TABLE public.suppliers             TO authenticated;
GRANT SELECT ON TABLE public.organization_members  TO authenticated;
GRANT SELECT ON TABLE public.profiles              TO authenticated;
GRANT SELECT ON TABLE public.quote_requests        TO authenticated;
GRANT SELECT ON TABLE public.reviews               TO authenticated;
GRANT SELECT ON TABLE public.businesses            TO authenticated;
GRANT SELECT ON TABLE public.supplier_price_history TO authenticated;
GRANT INSERT ON TABLE public.quote_requests        TO authenticated;

-- 2. Foreign key: supplier_prices.product_id → products.id
--    Required for PostgREST embedded resource joins like:
--      .select('..., products(id, canonical_name, ...)')
--    If the FK already exists, this is a no-op (DO block catches the error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_type = 'FOREIGN KEY'
      AND table_name = 'supplier_prices'
      AND constraint_name = 'supplier_prices_product_id_fkey'
  ) THEN
    ALTER TABLE public.supplier_prices
      ADD CONSTRAINT supplier_prices_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3. Foreign key: supplier_prices.supplier_id → suppliers.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_type = 'FOREIGN KEY'
      AND table_name = 'supplier_prices'
      AND constraint_name = 'supplier_prices_supplier_id_fkey'
  ) THEN
    ALTER TABLE public.supplier_prices
      ADD CONSTRAINT supplier_prices_supplier_id_fkey
      FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4. Refresh PostgREST schema cache so new FKs take effect immediately
--    (no server restart needed; NOTIFY pg_notify triggers the reload)
NOTIFY pgrst, 'reload schema';
