-- Great Guest — RSVP migration
-- Run once in Supabase Dashboard > SQL Editor

-- 1. Invite message on each venue/event
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invite_message TEXT;

-- 2. RSVP confirmations table
CREATE TABLE IF NOT EXISTS rsvp (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id     UUID        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  telegram_id  TEXT        NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  username     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(venue_id, telegram_id)
);

ALTER TABLE rsvp ENABLE ROW LEVEL SECURITY;
