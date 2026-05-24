-- ============================================================
-- organization_members integrity guards
-- Safe to re-run.
-- ============================================================

create unique index if not exists org_members_user_supplier_unique
  on public.organization_members (user_id, supplier_id)
  where supplier_id is not null;

create unique index if not exists org_members_user_business_unique
  on public.organization_members (user_id, business_id)
  where business_id is not null;

create index if not exists org_members_supplier_idx
  on public.organization_members (supplier_id)
  where supplier_id is not null;

create index if not exists org_members_business_idx
  on public.organization_members (business_id)
  where business_id is not null;
