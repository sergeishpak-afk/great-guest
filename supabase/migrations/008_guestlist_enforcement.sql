-- ============================================================
-- Migration 008: Guestlist enforcement + super-admin setup
-- Date: 2026-06-23
-- ============================================================

-- ── 1. RLS policy for rsvp table (was missing — only ENABLE RLS existed) ──
DROP POLICY IF EXISTS "rsvp_service_role_only" ON rsvp;
CREATE POLICY "rsvp_service_role_only" ON rsvp
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── 2. Add restaurant_id to pending_visits ─────────────────────────────────
-- Allows confirming which event a QR belongs to (needed for guestlist check)
ALTER TABLE pending_visits
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pending_visits_restaurant
  ON pending_visits (restaurant_id) WHERE restaurant_id IS NOT NULL;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- SELECT policyname FROM pg_policies WHERE tablename = 'rsvp';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'pending_visits' AND column_name = 'restaurant_id';
