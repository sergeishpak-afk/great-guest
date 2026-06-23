-- ============================================================
-- Migration 010: Payments table for ЮKassa integration
-- Date: 2026-06-24
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   TEXT UNIQUE NOT NULL,
  telegram_id  TEXT NOT NULL REFERENCES guests(telegram_id),
  plan         TEXT NOT NULL,
  amount       INTEGER NOT NULL, -- kopecks (RUB × 100)
  months       INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | canceled
  created_at   TIMESTAMPTZ DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_service_role_only" ON payments
  FOR ALL
  USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  )
  WITH CHECK (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
  );

CREATE INDEX IF NOT EXISTS payments_telegram_id_idx ON payments(telegram_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
