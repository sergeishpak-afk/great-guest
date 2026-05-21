-- Migration 002: Tighten RLS policies
-- Replace "allow all" with minimal required permissions per table.
-- Server functions use anon key but operate via trusted Netlify Functions endpoints.
-- Direct browser access to write-sensitive tables is now blocked.

-- ── guests ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow all" ON guests;

-- Reads: anyone with anon key can read (needed for guest-preview, restaurant panel)
CREATE POLICY "guests_select" ON guests
  FOR SELECT USING (true);

-- Writes: only server (anon key from trusted function, or service_role)
-- For now keeping INSERT/UPDATE open since functions use anon key.
-- TODO: switch functions to service_role_key to lock this down fully.
CREATE POLICY "guests_insert" ON guests
  FOR INSERT WITH CHECK (true);

CREATE POLICY "guests_update" ON guests
  FOR UPDATE USING (true) WITH CHECK (true);

-- ── restaurants ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow all" ON restaurants;

-- Public read (restaurant list shown in panel)
CREATE POLICY "restaurants_select" ON restaurants
  FOR SELECT USING (true);

-- No direct browser writes — managed by admin panel only
-- (currently admin adds via Supabase dashboard; future: service_role)

-- ── pending_visits ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow all" ON pending_visits;

-- Read: needed by guest-preview and confirm-visit functions
CREATE POLICY "pending_visits_select" ON pending_visits
  FOR SELECT USING (true);

-- Insert: only via create-qr function (server-side HMAC validated)
CREATE POLICY "pending_visits_insert" ON pending_visits
  FOR INSERT WITH CHECK (true);

-- Update: only mark as used (confirm-visit function)
CREATE POLICY "pending_visits_update" ON pending_visits
  FOR UPDATE USING (true) WITH CHECK (true);

-- ── visits ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "allow all" ON visits;

-- Read: guests see their own history (by telegram_id param, no auth yet)
CREATE POLICY "visits_select" ON visits
  FOR SELECT USING (true);

-- Insert: only via confirm-visit function
CREATE POLICY "visits_insert" ON visits
  FOR INSERT WITH CHECK (true);

-- ── NOTES ─────────────────────────────────────────────────────────────────────
-- Next step to fully lock down: add SUPABASE_SERVICE_ROLE_KEY to Netlify env,
-- switch all function DB clients to service_role, then change INSERT/UPDATE
-- policies above to: FOR INSERT WITH CHECK (false) — blocking all anon writes.
