-- ──────────────────────────────────────────────────────────────────────────
-- Subscription plans for suppliers (basic / pro / corporate)
-- ──────────────────────────────────────────────────────────────────────────
-- The platform's commercial layer. Different tiers unlock different levels
-- of visibility, analytics, RFQ priority and procurement intelligence.
--
-- Tier semantics (logic enforced in the app, not in the DB):
--   basic      — ₱2,500/mo, baseline visibility, up to 100 indexed products,
--                no insights, standard search ranking.
--   pro        — ₱7,500/mo, unlimited products, analytics dashboard, priority
--                search placement, featured supplier badge.
--   corporate  — ₱20–35k/mo, homepage placement, sponsored category, AI
--                pricing recommendations, procurement intelligence reports,
--                premium search ranking + priority RFQ exposure.
--
-- subscription_plan is independent from trial_ends_at / current_period_end:
-- a trialing supplier still has a target tier (default 'basic') so that
-- feature flags resolve consistently before they convert to paid.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS subscription_plan text
  DEFAULT 'basic'
  CHECK (subscription_plan IN ('basic','pro','corporate'));

UPDATE suppliers SET subscription_plan = 'basic' WHERE subscription_plan IS NULL;

COMMENT ON COLUMN suppliers.subscription_plan IS
  'Commercial tier driving feature gates and search ranking. One of: '
  'basic, pro, corporate. Default basic. Independent from trial_ends_at — '
  'a trialing supplier still has a target plan.';

-- Index for plan-based search ranking queries
CREATE INDEX IF NOT EXISTS idx_suppliers_subscription_plan
  ON suppliers(subscription_plan)
  WHERE active = true;
