alter table public.products
  add column if not exists producer text,
  add column if not exists brand text,
  add column if not exists cut_type text,
  add column if not exists grade_spec text,
  add column if not exists origin_series text,
  add column if not exists form_factor text,
  add column if not exists pack_weight text;
