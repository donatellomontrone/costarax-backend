-- Atomic supplier relinking for admin flows.
-- Keeps exactly one supplier membership for the target user and, when linking,
-- transfers ownership of the target supplier away from any previously linked user.

create or replace function public.admin_replace_supplier_link(
  p_user_id uuid,
  p_supplier_id uuid default null
)
returns table (
  user_id uuid,
  supplier_id uuid,
  displaced_user_ids uuid[],
  removed_supplier_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_displaced_user_ids uuid[] := '{}';
  v_removed_supplier_ids uuid[] := '{}';
  v_linked_supplier_id uuid := null;
begin
  select coalesce(array_agg(distinct om.supplier_id) filter (where om.supplier_id is not null), '{}')
    into v_removed_supplier_ids
  from public.organization_members om
  where om.user_id = p_user_id;

  if p_supplier_id is not null then
    select coalesce(array_agg(distinct om.user_id) filter (where om.user_id <> p_user_id), '{}')
      into v_displaced_user_ids
    from public.organization_members om
    where om.supplier_id = p_supplier_id;
  end if;

  delete from public.organization_members om
  where om.user_id = p_user_id
    and om.supplier_id is not null;

  if p_supplier_id is not null then
    delete from public.organization_members om
    where om.supplier_id = p_supplier_id
      and om.user_id <> p_user_id;

    insert into public.organization_members (user_id, supplier_id)
    values (p_user_id, p_supplier_id)
    on conflict do nothing;
  end if;

  select om.supplier_id
    into v_linked_supplier_id
  from public.organization_members om
  where om.user_id = p_user_id
    and om.supplier_id is not null
  order by om.supplier_id
  limit 1;

  if coalesce(p_supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)
     <> coalesce(v_linked_supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'Supplier link verification failed';
  end if;

  return query
  select
    p_user_id,
    v_linked_supplier_id,
    v_displaced_user_ids,
    v_removed_supplier_ids;
end;
$$;

grant execute on function public.admin_replace_supplier_link(uuid, uuid) to service_role;
