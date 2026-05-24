-- ============================================================
-- Admin audit log
-- Safe to re-run.
-- ============================================================

create table if not exists public.admin_actions (
  id          bigserial primary key,
  admin_id    uuid not null references public.profiles(id) on delete cascade,
  action_type text not null,
  target_id   text,
  notes       text,
  created_at  timestamptz not null default now()
);

create index if not exists admin_actions_admin_idx
  on public.admin_actions (admin_id, created_at desc);

create index if not exists admin_actions_action_idx
  on public.admin_actions (action_type, created_at desc);

alter table public.admin_actions enable row level security;

drop policy if exists "admin_actions_admin_read" on public.admin_actions;
drop policy if exists "admin_actions_service_insert" on public.admin_actions;

create policy "admin_actions_admin_read" on public.admin_actions
  for select to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'));

-- Writes are expected to happen through service_role from the backend.
