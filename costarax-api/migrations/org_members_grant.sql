-- Fix: GRANT SELECT on organization_members to authenticated role
-- Required by PostgREST: RLS policy alone is not enough — the table-level
-- permission must also be granted, otherwise the query returns 403/empty.
-- Re-runnable (GRANT is idempotent).

GRANT SELECT ON TABLE public.organization_members TO authenticated;
GRANT SELECT ON TABLE public.organization_members TO anon;

-- Ensure the self-read policy is in place (idempotent)
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_own" ON public.organization_members;
CREATE POLICY "org_members_read_own" ON public.organization_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
