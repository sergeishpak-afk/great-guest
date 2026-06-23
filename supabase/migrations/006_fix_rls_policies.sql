-- ============================================================
-- Migration 006: Fix RLS policies
-- Problem: Migration 001 "allow all" policy is permissive FOR ALL roles.
-- Permissive policies are OR-d, so "allow all" wins over the blocking
-- policies added in migration 003. This migration drops "allow all" and
-- replaces with correct minimal-access policies.
-- Run: once on production Supabase
-- Date: 2026-06-23
-- ============================================================

-- ── Drop broken "allow all" policies ────────────────────────
DROP POLICY IF EXISTS "allow all" ON guests;
DROP POLICY IF EXISTS "allow all" ON restaurants;
DROP POLICY IF EXISTS "allow all" ON pending_visits;
DROP POLICY IF EXISTS "allow all" ON visits;

-- Also drop migration 003 policies (were ineffective, replacing cleanly)
DROP POLICY IF EXISTS "guests_insert"        ON guests;
DROP POLICY IF EXISTS "guests_update"        ON guests;
DROP POLICY IF EXISTS "pending_visits_insert" ON pending_visits;
DROP POLICY IF EXISTS "pending_visits_update" ON pending_visits;
DROP POLICY IF EXISTS "visits_insert"        ON visits;

-- ── guests: anon has NO access ───────────────────────────────
-- All guest reads/writes go through server-side API (service_role bypasses RLS)
CREATE POLICY "guests_service_role_only" ON guests
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── pending_visits: anon has NO access ───────────────────────
CREATE POLICY "pending_visits_service_role_only" ON pending_visits
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── visits: anon has NO access ───────────────────────────────
CREATE POLICY "visits_service_role_only" ON visits
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── restaurants: anon can SELECT only ────────────────────────
-- restaurant.html uses anon key to populate the scanner dropdown (id, name).
-- Writes go through server-side API only.
CREATE POLICY "restaurants_anon_select" ON restaurants
  FOR SELECT
  USING (true);

CREATE POLICY "restaurants_service_role_write" ON restaurants
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── Verify ───────────────────────────────────────────────────
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies WHERE tablename IN ('guests','restaurants','pending_visits','visits')
-- ORDER BY tablename, policyname;
