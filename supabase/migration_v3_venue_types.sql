-- migration_v3: venue types (restaurant / event)
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS venue_type TEXT DEFAULT 'restaurant',
  ADD COLUMN IF NOT EXISTS event_date DATE,
  ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT '';
