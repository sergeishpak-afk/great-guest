-- migration-contacts.sql
-- Run manually in Supabase Dashboard → SQL Editor

-- 1. Таблица постоянной базы контактов организатора
CREATE TABLE IF NOT EXISTS organizer_contacts (
  organizer_id  TEXT        NOT NULL,
  guest_id      TEXT        NOT NULL,
  first_name    TEXT        NOT NULL DEFAULT '',
  last_name     TEXT        NOT NULL DEFAULT '',
  username      TEXT        NOT NULL DEFAULT '',
  total_visits  INT         NOT NULL DEFAULT 0,
  rsvp_count    INT         NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organizer_id, guest_id)
);

ALTER TABLE organizer_contacts ENABLE ROW LEVEL SECURITY;

-- 2. Атомарный upsert (вызывается из бота при каждом чекине/RSVP)
CREATE OR REPLACE FUNCTION upsert_organizer_contact(
  p_org    TEXT,
  p_guest  TEXT,
  p_first  TEXT,
  p_last   TEXT,
  p_user   TEXT,
  p_rsvp   BOOLEAN DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO organizer_contacts
    (organizer_id, guest_id, first_name, last_name, username, total_visits, rsvp_count)
  VALUES
    (p_org, p_guest, p_first, p_last, p_user,
     CASE WHEN p_rsvp THEN 0 ELSE 1 END,
     CASE WHEN p_rsvp THEN 1 ELSE 0 END)
  ON CONFLICT (organizer_id, guest_id) DO UPDATE SET
    first_name   = EXCLUDED.first_name,
    last_name    = EXCLUDED.last_name,
    username     = EXCLUDED.username,
    last_seen_at = NOW(),
    total_visits = organizer_contacts.total_visits + CASE WHEN p_rsvp THEN 0 ELSE 1 END,
    rsvp_count   = organizer_contacts.rsvp_count   + CASE WHEN p_rsvp THEN 1 ELSE 0 END;
END;
$$;

-- 3. Бэкфилл из существующих визитов
INSERT INTO organizer_contacts
  (organizer_id, guest_id, first_name, last_name, username, total_visits, first_seen_at, last_seen_at)
SELECT
  r.owner_telegram_id,
  v.telegram_id,
  COALESCE(g.first_name, ''),
  COALESCE(g.last_name, ''),
  COALESCE(g.username, ''),
  COUNT(*)::INT,
  MIN(v.visited_at),
  MAX(v.visited_at)
FROM visits v
JOIN restaurants r ON r.id = v.restaurant_id
LEFT JOIN guests g ON g.telegram_id = v.telegram_id
GROUP BY r.owner_telegram_id, v.telegram_id, g.first_name, g.last_name, g.username
ON CONFLICT (organizer_id, guest_id) DO UPDATE SET
  total_visits  = EXCLUDED.total_visits,
  first_seen_at = LEAST(organizer_contacts.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at  = GREATEST(organizer_contacts.last_seen_at, EXCLUDED.last_seen_at);

-- 4. Бэкфилл из существующих RSVP
INSERT INTO organizer_contacts
  (organizer_id, guest_id, first_name, last_name, username, rsvp_count, first_seen_at, last_seen_at)
SELECT
  r.owner_telegram_id,
  rv.telegram_id,
  COALESCE(rv.first_name, ''),
  COALESCE(rv.last_name, ''),
  COALESCE(rv.username, ''),
  COUNT(*)::INT,
  MIN(rv.created_at),
  MAX(rv.created_at)
FROM rsvp rv
JOIN restaurants r ON r.id = rv.venue_id
GROUP BY r.owner_telegram_id, rv.telegram_id, rv.first_name, rv.last_name, rv.username
ON CONFLICT (organizer_id, guest_id) DO UPDATE SET
  rsvp_count   = organizer_contacts.rsvp_count + EXCLUDED.rsvp_count,
  first_name   = CASE WHEN organizer_contacts.first_name = '' THEN EXCLUDED.first_name ELSE organizer_contacts.first_name END,
  last_name    = CASE WHEN organizer_contacts.last_name  = '' THEN EXCLUDED.last_name  ELSE organizer_contacts.last_name  END,
  username     = CASE WHEN organizer_contacts.username   = '' THEN EXCLUDED.username   ELSE organizer_contacts.username   END,
  last_seen_at = GREATEST(organizer_contacts.last_seen_at, EXCLUDED.last_seen_at);
