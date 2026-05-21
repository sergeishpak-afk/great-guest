-- Migration 003: Lock anon writes — service_role only
-- Run AFTER SUPABASE_SERVICE_ROLE_KEY is set in Netlify and deployed.
-- All INSERT/UPDATE now go through server functions with service_role.
-- Direct anon-key writes from any browser are blocked.

-- ── guests ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "guests_insert" ON guests;
DROP POLICY IF EXISTS "guests_update" ON guests;

-- Block all anon INSERT/UPDATE (functions use service_role, bypass RLS)
CREATE POLICY "guests_insert" ON guests
  FOR INSERT WITH CHECK (false);

CREATE POLICY "guests_update" ON guests
  FOR UPDATE USING (false) WITH CHECK (false);

-- ── pending_visits ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pending_visits_insert" ON pending_visits;
DROP POLICY IF EXISTS "pending_visits_update" ON pending_visits;

CREATE POLICY "pending_visits_insert" ON pending_visits
  FOR INSERT WITH CHECK (false);

CREATE POLICY "pending_visits_update" ON pending_visits
  FOR UPDATE USING (false) WITH CHECK (false);

-- ── visits ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "visits_insert" ON visits;

CREATE POLICY "visits_insert" ON visits
  FOR INSERT WITH CHECK (false);

-- ── Result ────────────────────────────────────────────────────────────────────
-- anon key: SELECT only (guests, pending_visits, visits, restaurants)
-- service_role: full access (used exclusively by Netlify Functions)
-- Direct browser → Supabase writes: BLOCKED
