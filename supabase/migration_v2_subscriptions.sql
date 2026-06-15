-- ═══════════════════════════════════════════════════════════════
-- Great Guest — Migration v2: Subscription System + Offers
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Enhance restaurants table
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS owner_telegram_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none',  -- none | trial | active | expired
  ADD COLUMN IF NOT EXISTS trial_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS address            TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS description        TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS cuisine            TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS city               TEXT DEFAULT 'Москва';

-- 2. Add last_visit_at to guests for smart targeting
ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';

-- 3. Offers table (restaurant → guest personalized offers)
CREATE TABLE IF NOT EXISTS offers (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id     UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  guest_telegram_id TEXT NOT NULL REFERENCES guests(telegram_id) ON DELETE CASCADE,
  offer_text        TEXT NOT NULL,
  status            TEXT DEFAULT 'sent',   -- sent | accepted | declined
  created_at        TIMESTAMPTZ DEFAULT now(),
  responded_at      TIMESTAMPTZ
);

-- 4. RLS for offers (service_role has full access)
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_offers" ON offers;
CREATE POLICY "service_role_offers" ON offers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Useful indexes
CREATE INDEX IF NOT EXISTS idx_restaurants_owner  ON restaurants(owner_telegram_id);
CREATE INDEX IF NOT EXISTS idx_guests_visit_count ON guests(visit_count DESC);
CREATE INDEX IF NOT EXISTS idx_guests_last_visit  ON guests(last_visit_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_offers_guest       ON offers(guest_telegram_id);
CREATE INDEX IF NOT EXISTS idx_offers_restaurant  ON offers(restaurant_id);

-- 6. Auto-update last_visit_at on new visit (trigger)
CREATE OR REPLACE FUNCTION update_guest_last_visit()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE guests SET last_visit_at = NOW() WHERE telegram_id = NEW.telegram_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_last_visit ON visits;
CREATE TRIGGER trg_update_last_visit
  AFTER INSERT ON visits
  FOR EACH ROW EXECUTE FUNCTION update_guest_last_visit();

-- Done!
SELECT 'Migration v2 complete ✅' as result;
