-- ============================================================
-- Migration 009: Fix merge_guest_accounts race condition
-- Date: 2026-06-23
-- Adds FOR UPDATE row locks to prevent concurrent merges
-- from doubling visit counts.
-- ============================================================

CREATE OR REPLACE FUNCTION merge_guest_accounts(
  p_old_telegram_id TEXT,
  p_new_telegram_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  old_visits   INTEGER;
  new_visits   INTEGER;
  old_phone    TEXT;
  new_phone    TEXT;
  merged_count INTEGER;
BEGIN
  IF p_old_telegram_id = p_new_telegram_id THEN
    RETURN jsonb_build_object('error', 'same_account');
  END IF;

  -- Lock both rows to prevent concurrent merge of the same accounts.
  -- Order by telegram_id to avoid deadlock with a reversed concurrent call.
  IF p_old_telegram_id < p_new_telegram_id THEN
    SELECT visit_count, phone INTO old_visits, old_phone
      FROM guests WHERE telegram_id = p_old_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'old_not_found'); END IF;

    SELECT visit_count, phone INTO new_visits, new_phone
      FROM guests WHERE telegram_id = p_new_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'new_not_found'); END IF;
  ELSE
    SELECT visit_count, phone INTO new_visits, new_phone
      FROM guests WHERE telegram_id = p_new_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'new_not_found'); END IF;

    SELECT visit_count, phone INTO old_visits, old_phone
      FROM guests WHERE telegram_id = p_old_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'old_not_found'); END IF;
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

  -- Transfer RSVP records (new venue-specific guestlist entries)
  UPDATE rsvp
    SET telegram_id = p_new_telegram_id
    WHERE telegram_id = p_old_telegram_id
      AND NOT EXISTS (
        SELECT 1 FROM rsvp r2
        WHERE r2.telegram_id = p_new_telegram_id AND r2.venue_id = rsvp.venue_id
      );

  -- Merge organizer contacts (avoid duplicate organizer+guest pairs)
  DELETE FROM organizer_contacts
    WHERE guest_id = p_new_telegram_id
      AND organizer_id IN (
        SELECT organizer_id FROM organizer_contacts WHERE guest_id = p_old_telegram_id
      );

  UPDATE organizer_contacts
    SET guest_id = p_new_telegram_id
    WHERE guest_id = p_old_telegram_id;

  -- Prefer keeping existing phone on new account
  UPDATE guests SET
    visit_count = merged_count,
    phone = COALESCE(new_phone, old_phone)
  WHERE telegram_id = p_new_telegram_id;

  -- Remove the old account
  DELETE FROM guests WHERE telegram_id = p_old_telegram_id;

  RETURN jsonb_build_object('success', true, 'merged_visits', merged_count);
END;
$$;
