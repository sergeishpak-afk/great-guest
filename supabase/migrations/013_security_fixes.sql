-- Migration 013: Security fixes
-- К-7: Fix payments FK to allow guest deletion (152-ФЗ compliance)
-- К-5: Restore SELECT ... FOR UPDATE in merge_guest_accounts to prevent race condition

-- 1. Allow payments.telegram_id to be NULL (needed for ON DELETE SET NULL)
ALTER TABLE payments ALTER COLUMN telegram_id DROP NOT NULL;

-- 2. Re-create payments FK with ON DELETE SET NULL so guests can be deleted
--    (payment records are kept for accounting, guest PII removed)
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_telegram_id_fkey;
ALTER TABLE payments
  ADD CONSTRAINT payments_telegram_id_fkey
  FOREIGN KEY (telegram_id) REFERENCES guests(telegram_id) ON DELETE SET NULL;

-- 3. Restore merge_guest_accounts with SELECT ... FOR UPDATE (prevents race condition)
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
  old_email    TEXT;
  new_email    TEXT;
  merged_count INTEGER;
BEGIN
  IF p_old_telegram_id = p_new_telegram_id THEN
    RETURN jsonb_build_object('error', 'same_account');
  END IF;

  -- Lock rows in consistent order to prevent deadlock
  IF p_old_telegram_id < p_new_telegram_id THEN
    SELECT visit_count, phone, email INTO old_visits, old_phone, old_email
      FROM guests WHERE telegram_id = p_old_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'old_not_found'); END IF;
    SELECT visit_count, phone, email INTO new_visits, new_phone, new_email
      FROM guests WHERE telegram_id = p_new_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'new_not_found'); END IF;
  ELSE
    SELECT visit_count, phone, email INTO new_visits, new_phone, new_email
      FROM guests WHERE telegram_id = p_new_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'new_not_found'); END IF;
    SELECT visit_count, phone, email INTO old_visits, old_phone, old_email
      FROM guests WHERE telegram_id = p_old_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'old_not_found'); END IF;
  END IF;

  merged_count := COALESCE(old_visits, 0) + COALESCE(new_visits, 0);

  UPDATE visits SET telegram_id = p_new_telegram_id WHERE telegram_id = p_old_telegram_id;

  UPDATE pending_visits
    SET telegram_id = p_new_telegram_id
    WHERE telegram_id = p_old_telegram_id AND used = false;

  DELETE FROM organizer_contacts
    WHERE guest_id = p_new_telegram_id
      AND organizer_id IN (
        SELECT organizer_id FROM organizer_contacts WHERE guest_id = p_old_telegram_id
      );

  UPDATE organizer_contacts SET guest_id = p_new_telegram_id WHERE guest_id = p_old_telegram_id;

  UPDATE guests SET
    visit_count = merged_count,
    phone       = COALESCE(new_phone, old_phone),
    email       = COALESCE(new_email, old_email)
  WHERE telegram_id = p_new_telegram_id;

  DELETE FROM guests WHERE telegram_id = p_old_telegram_id;

  RETURN jsonb_build_object(
    'success',       true,
    'merged_visits', merged_count,
    'old_id',        p_old_telegram_id,
    'new_id',        p_new_telegram_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION merge_guest_accounts(TEXT, TEXT) TO service_role;
