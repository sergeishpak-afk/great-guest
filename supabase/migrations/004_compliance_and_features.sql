-- ============================================================
-- Migration 004: 152-ФЗ Compliance + Product Features
-- Run: once on production Supabase
-- Date: 2026-06-15
-- ============================================================

-- ── 1. guests: add consent fields (152-ФЗ) ─────────────────
ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS consent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_version   TEXT DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS last_visit_at     TIMESTAMPTZ;

-- Index for finding guests who haven't given consent (cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_guests_no_consent ON guests (telegram_id)
  WHERE consent_at IS NULL;

-- ── 2. pending_visits: add TTL support ─────────────────────
ALTER TABLE pending_visits
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Backfill: set expires_at = created_at + 60 minutes for existing rows
UPDATE pending_visits
  SET expires_at = created_at + INTERVAL '60 minutes'
  WHERE expires_at IS NULL AND created_at IS NOT NULL;

-- Auto-cleanup old/expired QR codes (run via pg_cron or manually)
-- DELETE FROM pending_visits WHERE expires_at < NOW() - INTERVAL '7 days';

-- ── 3. visits: add visit_type for bonus visits ──────────────
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS visit_type  TEXT DEFAULT 'regular' CHECK (visit_type IN ('regular', 'bonus', 'imported'));

-- ── 4. imported_guests: CSV import table ────────────────────
CREATE TABLE IF NOT EXISTS imported_guests (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  first_name     TEXT,
  last_name      TEXT,
  phone          TEXT,
  email          TEXT,
  invite_status  TEXT DEFAULT 'pending' CHECK (invite_status IN ('pending', 'invited', 'joined', 'declined')),
  telegram_id    TEXT,               -- filled when guest joins via invite
  imported_by    TEXT NOT NULL,      -- owner telegram_id
  imported_at    TIMESTAMPTZ DEFAULT NOW(),
  joined_at      TIMESTAMPTZ,
  UNIQUE (restaurant_id, phone)      -- prevent duplicate imports per venue
);

CREATE INDEX IF NOT EXISTS idx_imported_guests_restaurant ON imported_guests (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_imported_guests_phone      ON imported_guests (phone);
CREATE INDEX IF NOT EXISTS idx_imported_guests_status     ON imported_guests (invite_status);

-- RLS for imported_guests
ALTER TABLE imported_guests ENABLE ROW LEVEL SECURITY;

-- Owners can only see/manage their own venue's imported guests
CREATE POLICY "owner_select_imported_guests" ON imported_guests
  FOR SELECT USING (
    imported_by = current_setting('request.jwt.claims', true)::jsonb->>'sub'
    OR EXISTS (
      SELECT 1 FROM restaurants r
      WHERE r.id = imported_guests.restaurant_id
        AND r.owner_telegram_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'
    )
  );

CREATE POLICY "owner_insert_imported_guests" ON imported_guests
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM restaurants r
      WHERE r.id = imported_guests.restaurant_id
        AND r.owner_telegram_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'
    )
  );

-- Service role can do everything (used by API)
CREATE POLICY "service_role_all_imported_guests" ON imported_guests
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── 5. offers: ensure we have all needed columns ────────────
-- (created_at should already exist, but ensure it)
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- ── 6. Indexes for performance ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_visits_restaurant_visited ON visits (restaurant_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_telegram_visited   ON visits (telegram_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_guests_visit_count        ON guests (visit_count DESC);
CREATE INDEX IF NOT EXISTS idx_pending_visits_expires    ON pending_visits (expires_at) WHERE used = false;

-- ── 7. Consent audit log (optional, for 152-ФЗ traceability) ─
CREATE TABLE IF NOT EXISTS consent_log (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id    TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('granted', 'revoked', 'updated')),
  consent_version TEXT,
  ip_hint        TEXT,            -- partial IP for audit (e.g. "95.79.x.x")
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_log_telegram ON consent_log (telegram_id, created_at DESC);

-- RLS: service_role only
ALTER TABLE consent_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_consent_log" ON consent_log
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

-- ── 8. Data retention helper view ───────────────────────────
-- Shows guests who haven't visited in 3 years (for GDPR-style cleanup)
CREATE OR REPLACE VIEW stale_guests AS
  SELECT telegram_id, first_name, last_name, visit_count, last_visit_at, consent_at
  FROM guests
  WHERE last_visit_at < NOW() - INTERVAL '3 years'
     OR (last_visit_at IS NULL AND consent_at < NOW() - INTERVAL '3 years');

-- ── Done ────────────────────────────────────────────────────
-- Verify with:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'guests';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'pending_visits';
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
