-- ============================================================
-- Migration 005: owner_subscriptions table + atomic visit counter
-- Run: once on production Supabase
-- Date: 2026-06-21
-- ============================================================

-- ── 1. owner_subscriptions ──────────────────────────────────
CREATE TABLE IF NOT EXISTS owner_subscriptions (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id             TEXT        UNIQUE NOT NULL,
  plan                    TEXT        NOT NULL DEFAULT 'trial'
                            CHECK (plan IN ('trial', 'basic', 'network', 'empire')),
  max_venues              INTEGER     NOT NULL DEFAULT 1,
  subscription_status     TEXT        NOT NULL DEFAULT 'trial'
                            CHECK (subscription_status IN ('trial', 'active', 'expired', 'cancelled')),
  trial_started_at        TIMESTAMPTZ,
  subscription_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_subscriptions_telegram
  ON owner_subscriptions (telegram_id);

CREATE INDEX IF NOT EXISTS idx_owner_subscriptions_expires
  ON owner_subscriptions (subscription_expires_at);

-- RLS: only service_role can access (all API routes use service_role_key)
ALTER TABLE owner_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_owner_subscriptions" ON owner_subscriptions
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── 2. Atomic visit counter RPC ─────────────────────────────
-- Replaces SELECT → compute → UPDATE pattern in confirm-visit.js
-- Prevents double-increment race condition when two staff scan simultaneously
CREATE OR REPLACE FUNCTION increment_guest_visits(p_telegram_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE guests
  SET visit_count  = visit_count + 1,
      last_visit_at = NOW()
  WHERE telegram_id = p_telegram_id
  RETURNING visit_count INTO new_count;

  IF new_count IS NULL THEN
    RAISE EXCEPTION 'Guest not found: %', p_telegram_id;
  END IF;

  RETURN new_count;
END;
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION increment_guest_visits(TEXT) TO service_role;

-- ── 3. Composite index for offers dashboard query ───────────
CREATE INDEX IF NOT EXISTS idx_offers_restaurant_created
  ON offers (restaurant_id, created_at DESC);

-- ── Done ────────────────────────────────────────────────────
-- Verify:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'owner_subscriptions';
-- SELECT proname FROM pg_proc WHERE proname = 'increment_guest_visits';
