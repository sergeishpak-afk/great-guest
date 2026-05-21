-- Add web-app columns to restaurants
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Index for quick owner lookup
CREATE INDEX IF NOT EXISTS idx_restaurants_owner ON restaurants(owner_user_id);

-- Update RLS: restaurant owners can read their own restaurant
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow all" ON restaurants;

-- Public read (for bot and mini-app)
CREATE POLICY "public read restaurants"
  ON restaurants FOR SELECT
  USING (true);

-- Owner can update their own restaurant
CREATE POLICY "owner update restaurant"
  ON restaurants FOR UPDATE
  USING (auth.uid() = owner_user_id);

-- Insert for authenticated users (register flow)
CREATE POLICY "authenticated insert restaurant"
  ON restaurants FOR INSERT
  WITH CHECK (auth.uid() = owner_user_id OR auth.uid() IS NOT NULL);

-- Visits RLS (keep public but add index)
CREATE INDEX IF NOT EXISTS idx_visits_restaurant ON visits(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_visits_telegram ON visits(telegram_id);
CREATE INDEX IF NOT EXISTS idx_visits_at ON visits(visited_at DESC);
