-- ============================================================
-- Super-admin role
-- - Adds 'super_admin' to user_role enum
-- - super_admin inherits all admin permissions
-- - Adds is_super_admin() helper for delete-account restriction
-- - Promotes donatellomont@gmail.com to super_admin (first one)
-- Re-runnable.
-- ============================================================

-- 1. Extend enum (ALTER TYPE … ADD VALUE is idempotent in PG14+ with IF NOT EXISTS)
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';

-- 2. Make existing admin policies see super_admin AS admin (no policy churn).
--    Any policy using `public.current_user_role() = 'admin'` keeps working.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text AS $$
  SELECT CASE WHEN role = 'super_admin' THEN 'admin' ELSE role::text END
  FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 3. Helper for super-admin-only checks (account deletion, role promotion to super_admin)
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean AS $$
  SELECT role = 'super_admin' FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 4. Promote the first super-admin (bypass the priv-escalation trigger).
ALTER TABLE profiles DISABLE TRIGGER profiles_block_privilege_escalation;

UPDATE profiles
SET role = 'super_admin'
WHERE id = (SELECT id FROM auth.users WHERE email = 'donatellomont@gmail.com');

ALTER TABLE profiles ENABLE TRIGGER profiles_block_privilege_escalation;
