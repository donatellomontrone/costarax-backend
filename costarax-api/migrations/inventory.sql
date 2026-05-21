-- ============================================================
-- Inventory tracking on supplier_prices
-- stock_qty NULL  → supplier does not track stock for this item ("contact")
-- stock_qty 0     → explicitly out of stock
-- stock_qty > 0   → quantity available in the product's default unit
-- ============================================================

ALTER TABLE supplier_prices
  ADD COLUMN IF NOT EXISTS stock_qty numeric;

-- Helpful index for "in stock only" buyer filters.
CREATE INDEX IF NOT EXISTS supplier_prices_stock_idx
  ON supplier_prices (active, stock_qty) WHERE active = true;
