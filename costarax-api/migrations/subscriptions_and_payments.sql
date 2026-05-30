-- ============================================================
-- Costarax — subscriptions + payment_events tables
-- Run in Supabase SQL editor (SQL > New query > paste > Run)
-- Safe to re-run: every CREATE / ALTER uses IF NOT EXISTS
-- ============================================================
--
-- These tables are written/read by:
--   - api/payments.js (creates a subscription row when a checkout
--     session is minted; upserts on supplier_id)
--   - api/webhooks/paymongo.js (records the inbound event in
--     payment_events for idempotency + audit, then flips the matching
--     subscriptions row to status='active' on payment.paid)
--   - lib/admin-routes/payments/index.js (read both tables to render the
--     admin Payments tab)
--   - lib/admin-routes/suppliers/index.js (joins suppliers ← subscriptions
--     for the "Manage Suppliers" membership column)
--
-- Without these tables every PayMongo charge succeeds at the bank but
-- our DB fails to persist the result, the webhook can't find the
-- session, and the supplier never auto-activates.

-- ── subscriptions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id                   uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  plan                          text NOT NULL CHECK (plan IN ('basic','pro','corporate')),
  status                        text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','active','past_due','cancelled','expired')),
  provider                      text NOT NULL DEFAULT 'paymongo',
  provider_checkout_session_id  text UNIQUE,
  provider_subscription_id      text UNIQUE,
  last_payment_at               timestamptz,
  last_payment_status           text,
  current_period_end            timestamptz,
  cancel_at_period_end          boolean NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- One active subscription row per supplier — the upsert in payments.js
-- relies on ON CONFLICT(supplier_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_supplier_id_unique
  ON public.subscriptions(supplier_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON public.subscriptions(status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_current_period_end
  ON public.subscriptions(current_period_end)
  WHERE status IN ('active','past_due');

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION public.touch_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_subscriptions_updated_at();

COMMENT ON TABLE public.subscriptions IS
  'Supplier paid subscriptions. One row per supplier (UNIQUE supplier_id). '
  'Created in pending state when a checkout session is minted, flipped to '
  'active by the webhook on payment.paid, suspended on payment_failed.';

-- ── payment_events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_event_id   text NOT NULL,
  event_type          text NOT NULL,
  livemode            boolean NOT NULL DEFAULT false,
  payload             jsonb NOT NULL,
  processed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotency lookup in webhooks/paymongo.js
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_event
  ON public.payment_events(provider, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_event_type
  ON public.payment_events(event_type);

CREATE INDEX IF NOT EXISTS idx_payment_events_created_at
  ON public.payment_events(created_at DESC);

COMMENT ON TABLE public.payment_events IS
  'Raw webhook payloads from payment providers (PayMongo today). Used '
  'for idempotency (UNIQUE provider+event_id) and for the admin Payments '
  'tab audit log.';

-- ── RLS / grants ────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events  ENABLE ROW LEVEL SECURITY;

-- Service-role bypass — backend writes happen via the service key.
-- No anon/authenticated policies needed because the admin Payments tab
-- queries through /api/admin/payments (also service-role), not via
-- direct supabase-js calls.

DROP POLICY IF EXISTS "subscriptions_admin_select" ON public.subscriptions;
CREATE POLICY "subscriptions_admin_select" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin','super_admin')
    )
  );

DROP POLICY IF EXISTS "subscriptions_owner_select" ON public.subscriptions;
CREATE POLICY "subscriptions_owner_select" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.user_id = auth.uid() AND om.supplier_id = subscriptions.supplier_id
    )
  );

DROP POLICY IF EXISTS "payment_events_admin_select" ON public.payment_events;
CREATE POLICY "payment_events_admin_select" ON public.payment_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin','super_admin')
    )
  );

GRANT SELECT ON public.subscriptions  TO authenticated;
GRANT SELECT ON public.payment_events TO authenticated;
