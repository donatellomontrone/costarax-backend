-- Cross-supplier comparison grouping.
-- comparison_key collapses the SAME real product sold under different
-- supplier names/brands (e.g. all "Grana Padano DOP wheel" SKUs) into one group
-- so the buyer compare view can show every supplier's price side by side.
-- Distinct from match_key, which is intentionally STRICT (per-supplier SKU).
alter table public.products add column if not exists comparison_key text;
create index if not exists products_comparison_key_idx on public.products (comparison_key);

-- When the AI grouping pass last refined this product's comparison_key.
-- NULL = seeded at upload (deterministic) but not yet AI-refined → the daily
-- cron and the admin "Build comparison groups" button pick it up. This is what
-- makes grouping automatic and self-healing without per-category code.
alter table public.products add column if not exists comparison_key_ai_at timestamptz;
create index if not exists products_ck_ai_at_idx on public.products (comparison_key_ai_at) where comparison_key_ai_at is null;
