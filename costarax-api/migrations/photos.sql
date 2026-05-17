-- ──────────────────────────────────────────────────────────────────────────
-- Photo support: supplier logos + product images
-- ──────────────────────────────────────────────────────────────────────────

-- 1) Schema columns ────────────────────────────────────────────────────────
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS logo_url text;
COMMENT ON COLUMN suppliers.logo_url IS
  'Public URL of the supplier logo image stored in the supplier-assets bucket.';

ALTER TABLE products  ADD COLUMN IF NOT EXISTS image_url text;
COMMENT ON COLUMN products.image_url  IS
  'Public URL of the canonical product image stored in the product-images bucket.';

-- 2) Storage bucket: supplier-assets (logos + cover photos) ────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'supplier-assets',
  'supplier-assets',
  true,                                              -- public read
  2097152,                                           -- 2 MB cap per file
  ARRAY['image/png','image/jpeg','image/webp','image/svg+xml']::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies: anyone may read; only authenticated supplier/admin uploads.
-- (Upload itself is performed by the service-role key from our API, so we
-- only need a permissive read policy here. Direct client uploads are blocked.)
DROP POLICY IF EXISTS "supplier-assets read" ON storage.objects;
CREATE POLICY "supplier-assets read" ON storage.objects
  FOR SELECT USING (bucket_id = 'supplier-assets');

-- 3) Storage bucket: product-images ───────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  2097152,
  ARRAY['image/png','image/jpeg','image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "product-images read" ON storage.objects;
CREATE POLICY "product-images read" ON storage.objects
  FOR SELECT USING (bucket_id = 'product-images');
