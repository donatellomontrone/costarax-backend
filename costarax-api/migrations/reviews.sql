CREATE TABLE IF NOT EXISTS reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id uuid REFERENCES quote_requests(id) ON DELETE CASCADE,
  buyer_business_id uuid REFERENCES businesses(id),
  supplier_id uuid REFERENCES suppliers(id) ON DELETE CASCADE,
  rating int CHECK (rating >= 1 AND rating <= 5),
  order_rating int CHECK (order_rating >= 1 AND order_rating <= 5),
  delivery_rating int CHECK (delivery_rating >= 1 AND delivery_rating <= 5),
  comment text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(quote_id)
);

-- If table already exists, add the new columns
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS order_rating int CHECK (order_rating >= 1 AND order_rating <= 5),
  ADD COLUMN IF NOT EXISTS delivery_rating int CHECK (delivery_rating >= 1 AND delivery_rating <= 5),
  ALTER COLUMN rating DROP NOT NULL;

CREATE OR REPLACE FUNCTION update_supplier_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE suppliers
  SET
    rating = (SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE supplier_id = NEW.supplier_id),
    review_count = (SELECT COUNT(*) FROM reviews WHERE supplier_id = NEW.supplier_id)
  WHERE id = NEW.supplier_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_review_insert ON reviews;
CREATE TRIGGER after_review_insert
AFTER INSERT OR UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION update_supplier_rating();
