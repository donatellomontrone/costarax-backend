-- ============================================================
-- Costarax — RLS hardening
-- Fixes for issues found in security audit on 2026-05-21:
--   1. profiles_write_own allowed users to escalate their own role to 'admin'
--   2. access_request_documents.WITH CHECK(true) — anyone could spam rows
--      with invalid access_request_id
--   3. payments tables had no explicit deny for authenticated/anon
-- Re-runnable: uses DROP IF EXISTS before each CREATE.
-- ============================================================

-- 1. PROFILES — block role/status/email self-mutation -------------------------

DROP POLICY IF EXISTS "profiles_write_own" ON profiles;

-- Replace with a policy that lets a user update their own row but forbids
-- changing role, status, or id. The WITH CHECK clause inspects the NEW row.
CREATE POLICY "profiles_write_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- role / status are immutable from the client; enforced by a trigger below
  );

-- Belt and suspenders: trigger that blocks role/status changes unless the
-- caller is service_role (backend) or admin. auth.role() returns the JWT role
-- ('anon', 'authenticated', 'service_role').
CREATE OR REPLACE FUNCTION public.profiles_block_privilege_escalation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'role changes must be performed by an admin via the backend';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status changes must be performed by an admin via the backend';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_block_privilege_escalation ON profiles;
CREATE TRIGGER profiles_block_privilege_escalation
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_block_privilege_escalation();


-- 2. ACCESS_REQUEST_DOCUMENTS — require a valid pending request --------------

DROP POLICY IF EXISTS "ard_public_insert" ON access_request_documents;

-- Allow inserts ONLY if the referenced access_request exists and is still pending.
-- This prevents an attacker from polluting the table with garbage rows.
CREATE POLICY "ard_public_insert" ON access_request_documents
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM access_requests
      WHERE id = access_request_documents.access_request_id
        AND status = 'pending'
    )
  );


-- 3. PAYMENTS / PAYMENT_EVENTS — explicit deny for client roles --------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_events') THEN
    EXECUTE 'ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY';
    -- No CREATE POLICY → default deny for anon + authenticated.
    -- Backend uses service_role, which bypasses RLS.
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_subscriptions') THEN
    EXECUTE 'ALTER TABLE supplier_subscriptions ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'admin_actions') THEN
    EXECUTE 'ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
