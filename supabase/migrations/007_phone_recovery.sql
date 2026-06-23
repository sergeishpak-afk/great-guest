-- ============================================================
-- Migration 007: Phone-based account recovery + guest merge
-- Date: 2026-06-23
-- ============================================================

-- ── 1. Add phone column to guests ──────────────────────────
ALTER TABLE guests ADD COLUMN IF NOT EXISTS phone TEXT;

-- Partial unique index: phone must be unique when set (NULL allowed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_phone
  ON guests (phone)
  WHERE phone IS NOT NULL;

-- ── 2. merge_guest_accounts RPC ────────────────────────────
-- Atomically merges old telegram account into new one.
-- Transfers: visit_count, visits, pending_visits, organizer_contacts, phone.
-- Called by: bot (self-service via phone) and admin panel (organizer assist).

CREATE OR REPLACE FUNCTION merge_guest_accounts(
  p_old_telegram_id TEXT,
  p_new_telegram_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  old_visits INTEGER;
  new_visits INTEGER;
  old_phone  TEXT;
  new_phone  TEXT;
  merged_count INTEGER;
BEGIN
  -- Prevent self-merge
  IF p_old_telegram_id = p_new_telegram_id THEN
    RETURN jsonb_build_object('error', 'same_account');
  END IF;

  -- Fetch old guest
  SELECT visit_count, phone INTO old_visits, old_phone
    FROM guests WHERE telegram_id = p_old_telegram_id;
  IF old_visits IS NULL THEN
    RETURN jsonb_build_object('error', 'old_not_found');
  END IF;

  -- Fetch new guest (create minimal record if missing — new Telegram, hasn't started bot yet)
  SELECT visit_count, phone INTO new_visits, new_phone
    FROM guests WHERE telegram_id = p_new_telegram_id;
  IF new_visits IS NULL THEN
    RETURN jsonb_build_object('error', 'new_not_found');
  END IF;

  merged_count := COALESCE(old_visits, 0) + COALESCE(new_visits, 0);

  -- Transfer confirmed visits
  UPDATE visits
    SET telegram_id = p_new_telegram_id
    WHERE telegram_id = p_old_telegram_id;

  -- Transfer unused QR codes
  UPDATE pending_visits
    SET telegram_id = p_new_telegram_id
    WHERE telegram_id = p_old_telegram_id AND used = false;

  -- Transfer organizer contacts:
  -- First delete new-account rows that conflict with old-account rows
  -- (same organizer can't have two rows for same guest)
  DELETE FROM organizer_contacts nc
  USING organizer_contacts oc
  WHERE nc.guest_id    = p_new_telegram_id
    AND oc.guest_id    = p_old_telegram_id
    AND nc.organizer_id = oc.organizer_id;

  -- Now reassign old-account rows to new account
  UPDATE organizer_contacts
    SET guest_id = p_new_telegram_id
    WHERE guest_id = p_old_telegram_id;

  -- Update new guest record: merged count + carry over phone if new has none
  UPDATE guests SET
    visit_count = merged_count,
    phone       = COALESCE(new_phone, old_phone)
  WHERE telegram_id = p_new_telegram_id;

  -- Remove old guest record
  DELETE FROM guests WHERE telegram_id = p_old_telegram_id;

  RETURN jsonb_build_object(
    'success',        true,
    'merged_visits',  merged_count,
    'old_id',         p_old_telegram_id,
    'new_id',         p_new_telegram_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION merge_guest_accounts(TEXT, TEXT) TO service_role;

-- ── Verify ──────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns WHERE table_name='guests' AND column_name='phone';
-- SELECT proname FROM pg_proc WHERE proname='merge_guest_accounts';
