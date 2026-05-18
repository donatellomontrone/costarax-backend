-- Add updated_at tracking to supplier_prices
ALTER TABLE supplier_prices ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Backfill existing rows
UPDATE supplier_prices SET updated_at = now() WHERE updated_at IS NULL;

-- Trigger to keep updated_at fresh on every price change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_prices_set_updated_at ON supplier_prices;
CREATE TRIGGER supplier_prices_set_updated_at
  BEFORE UPDATE ON supplier_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
