-- Smart product indexing: collapse the same real product (written differently by
-- different suppliers, EN/Tagalog synonyms, word order, pack sizes) into ONE
-- canonical catalog row. The value is computed in lib/product-index.js (matchKey).
--
-- Run in Supabase SQL Editor. Catalog is empty, so there is nothing to backfill.

-- 1) the normalized identity key
alter table public.products add column if not exists match_key text;

-- 2) one canonical product per (identity, unit). The upload upserts on this:
--    two suppliers' "Bangus" and "Milkfish" -> same match_key -> one product,
--    each supplier keeps its own row in supplier_prices.
create unique index if not exists products_match_key_unit_uidx
  on public.products (match_key, default_unit);

-- Note: the old unique on (canonical_name, default_unit) can stay; match_key is
-- the stronger collapse and is what the upload now conflicts on.
