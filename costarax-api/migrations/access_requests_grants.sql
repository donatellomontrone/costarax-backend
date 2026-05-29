-- ============================================================
-- Costarax — access_requests table-level grants
-- Run in Supabase SQL editor (SQL > New query > paste > Run)
-- Safe to re-run: all statements are idempotent
-- ============================================================
--
-- The admin dashboard's "Access requests" tab queries
-- public.access_requests directly via the supabase-js client. The
-- table already has an "access_requests_admin_all" RLS policy
-- (see rls_policies.sql:210), but in PostgREST a policy alone is
-- not enough — the role also needs a table-level GRANT. Without
-- the grant the query returns empty / 403 and the admin sees zero
-- pending signups even when there are some.
--
-- Public form submissions still work because POST goes through
-- /api/access-requests (service role), bypassing both RLS and
-- table grants.

GRANT SELECT, UPDATE ON TABLE public.access_requests TO authenticated;
GRANT INSERT          ON TABLE public.access_requests TO anon;
GRANT SELECT          ON TABLE public.access_request_documents TO authenticated;
GRANT INSERT          ON TABLE public.access_request_documents TO anon;

-- Verify by selecting as an authenticated session in the SQL editor:
-- SELECT count(*) FROM access_requests WHERE status = 'pending';
