-- ============================================================
-- Costarax — Row Level Security policies
-- Run this once in Supabase SQL editor
-- Safe to re-run: uses DROP IF EXISTS before each CREATE
-- ============================================================

-- Helper: get the current user's role from profiles table
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- SUPPLIERS
-- ============================================================
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "suppliers_read_marketplace"   ON suppliers;
DROP POLICY IF EXISTS "suppliers_read_own"           ON suppliers;
DROP POLICY IF EXISTS "suppliers_read_admin"         ON suppliers;

-- Buyers + public: read active+approved only (marketplace)
CREATE POLICY "suppliers_read_marketplace" ON suppliers
  FOR SELECT TO authenticated
  USING (active = true AND status = 'approved');

-- Supplier: can read their own record regardless of status
CREATE POLICY "suppliers_read_own" ON suppliers
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT supplier_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Admin: read all
CREATE POLICY "suppliers_read_admin" ON suppliers
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- SUPPLIER_PRICES
-- ============================================================
ALTER TABLE supplier_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_prices_read_authenticated" ON supplier_prices;
DROP POLICY IF EXISTS "supplier_prices_read_own"           ON supplier_prices;

-- All authenticated users: read prices (needed for price comparison)
CREATE POLICY "supplier_prices_read_authenticated" ON supplier_prices
  FOR SELECT TO authenticated
  USING (true);

-- Supplier: read/manage their own prices (for future self-service)
CREATE POLICY "supplier_prices_write_own" ON supplier_prices
  FOR ALL TO authenticated
  USING (
    supplier_id IN (
      SELECT supplier_id FROM organization_members WHERE user_id = auth.uid()
    )
  );


-- ============================================================
-- PRODUCTS
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_read_authenticated" ON products;

CREATE POLICY "products_read_authenticated" ON products
  FOR SELECT TO authenticated
  USING (true);


-- ============================================================
-- QUOTE_REQUESTS
-- ============================================================
ALTER TABLE quote_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_requests_buyer_read"        ON quote_requests;
DROP POLICY IF EXISTS "quote_requests_buyer_email_read"  ON quote_requests;
DROP POLICY IF EXISTS "quote_requests_supplier_read"     ON quote_requests;
DROP POLICY IF EXISTS "quote_requests_admin_read"        ON quote_requests;
DROP POLICY IF EXISTS "quote_requests_buyer_insert"      ON quote_requests;

-- Buyer: read own quotes via org membership
CREATE POLICY "quote_requests_buyer_read" ON quote_requests
  FOR SELECT TO authenticated
  USING (
    buyer_business_id IN (
      SELECT business_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Buyer: read own quotes via business contact_email (fallback)
CREATE POLICY "quote_requests_buyer_email_read" ON quote_requests
  FOR SELECT TO authenticated
  USING (
    buyer_business_id IN (
      SELECT id FROM businesses WHERE contact_email = auth.email()
    )
  );

-- Supplier: read quotes directed at them
CREATE POLICY "quote_requests_supplier_read" ON quote_requests
  FOR SELECT TO authenticated
  USING (
    supplier_id IN (
      SELECT supplier_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Admin: read all
CREATE POLICY "quote_requests_admin_read" ON quote_requests
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- Buyer: insert own quote requests (needed for direct Supabase insert path)
CREATE POLICY "quote_requests_buyer_insert" ON quote_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    buyer_business_id IN (
      SELECT business_id FROM organization_members WHERE user_id = auth.uid()
    )
    OR buyer_business_id IN (
      SELECT id FROM businesses WHERE contact_email = auth.email()
    )
  );


-- ============================================================
-- REVIEWS
-- ============================================================
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reviews_buyer_read"    ON reviews;
DROP POLICY IF EXISTS "reviews_supplier_read" ON reviews;
DROP POLICY IF EXISTS "reviews_admin_read"    ON reviews;
DROP POLICY IF EXISTS "reviews_buyer_write"   ON reviews;

-- Buyer: read their own reviews
CREATE POLICY "reviews_buyer_read" ON reviews
  FOR SELECT TO authenticated
  USING (
    buyer_business_id IN (
      SELECT business_id FROM organization_members WHERE user_id = auth.uid()
    )
    OR buyer_business_id IN (
      SELECT id FROM businesses WHERE contact_email = auth.email()
    )
  );

-- Supplier: read reviews for their supplier
CREATE POLICY "reviews_supplier_read" ON reviews
  FOR SELECT TO authenticated
  USING (
    supplier_id IN (
      SELECT supplier_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Admin: read all
CREATE POLICY "reviews_admin_read" ON reviews
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- BUSINESSES
-- ============================================================
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "businesses_read_own"   ON businesses;
DROP POLICY IF EXISTS "businesses_read_admin" ON businesses;

-- Buyer: read their own business record
CREATE POLICY "businesses_read_own" ON businesses
  FOR SELECT TO authenticated
  USING (
    contact_email = auth.email()
    OR id IN (
      SELECT business_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Admin: read all
CREATE POLICY "businesses_read_admin" ON businesses
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- ACCESS_REQUESTS
-- ============================================================
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "access_requests_public_insert" ON access_requests;
DROP POLICY IF EXISTS "access_requests_admin_all"     ON access_requests;
DROP POLICY IF EXISTS "access_requests_own_read"      ON access_requests;

-- Anyone (anon + authenticated): can submit a new access request
CREATE POLICY "access_requests_public_insert" ON access_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Admin: full access
CREATE POLICY "access_requests_admin_all" ON access_requests
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin');

-- Applicant: can read their own pending request by email
CREATE POLICY "access_requests_own_read" ON access_requests
  FOR SELECT TO authenticated
  USING (contact_email = auth.email());


-- ============================================================
-- ACCESS_REQUEST_DOCUMENTS
-- ============================================================
ALTER TABLE access_request_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ard_public_insert" ON access_request_documents;
DROP POLICY IF EXISTS "ard_admin_read"    ON access_request_documents;

-- Anyone: can upload documents (linked to access_request_id)
CREATE POLICY "ard_public_insert" ON access_request_documents
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Admin: read all documents
CREATE POLICY "ard_admin_read" ON access_request_documents
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- ORGANIZATION_MEMBERS
-- ============================================================
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_own"   ON organization_members;
DROP POLICY IF EXISTS "org_members_admin_read" ON organization_members;

-- User: read their own membership
CREATE POLICY "org_members_read_own" ON organization_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Admin: read all
CREATE POLICY "org_members_admin_read" ON organization_members
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- PROFILES
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_read_own"   ON profiles;
DROP POLICY IF EXISTS "profiles_admin_read" ON profiles;
DROP POLICY IF EXISTS "profiles_write_own"  ON profiles;

-- User: read and update their own profile
CREATE POLICY "profiles_read_own" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "profiles_write_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- Admin: read all profiles
CREATE POLICY "profiles_admin_read" ON profiles
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');


-- ============================================================
-- NOTE: service_role (used by backend) bypasses ALL RLS.
-- These policies only affect the anon/authenticated frontend client.
-- ============================================================
