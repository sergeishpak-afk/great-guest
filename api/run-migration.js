/**
 * api/run-migration.js
 * ONE-TIME endpoint to apply all DB migrations.
 * Call: POST /api/run-migration  { "secret": "great-guest-migrate-2026" }
 * Delete this file after successful run.
 */
const { Client } = require('pg');

const MIGRATIONS = [
  // ── v2: subscriptions ──────────────────────────────────────────────────
  `ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS owner_telegram_id         TEXT,
    ADD COLUMN IF NOT EXISTS subscription_status       TEXT DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS trial_started_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS subscription_expires_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cuisine                   TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS description               TEXT DEFAULT ''`,

  `ALTER TABLE guests
    ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS city          TEXT DEFAULT ''`,

  `CREATE TABLE IF NOT EXISTS offers (
    id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    restaurant_id     UUID        REFERENCES restaurants(id) ON DELETE CASCADE,
    guest_telegram_id TEXT        NOT NULL REFERENCES guests(telegram_id) ON DELETE CASCADE,
    offer_text        TEXT        NOT NULL,
    status            TEXT        DEFAULT 'sent',
    created_at        TIMESTAMPTZ DEFAULT now(),
    responded_at      TIMESTAMPTZ
  )`,

  `CREATE OR REPLACE FUNCTION update_last_visit_at()
   RETURNS TRIGGER LANGUAGE plpgsql AS $$
   BEGIN
     UPDATE guests SET last_visit_at = NEW.visited_at WHERE telegram_id = NEW.telegram_id;
     RETURN NEW;
   END;
   $$`,

  `DROP TRIGGER IF EXISTS trg_last_visit_at ON visits`,

  `CREATE TRIGGER trg_last_visit_at
     AFTER INSERT ON visits
     FOR EACH ROW EXECUTE FUNCTION update_last_visit_at()`,

  // ── v3: venue types ────────────────────────────────────────────────────
  `ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS venue_type TEXT DEFAULT 'restaurant',
    ADD COLUMN IF NOT EXISTS event_date DATE,
    ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT ''`,
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { secret } = req.body || {};
  if (secret !== process.env.MIGRATE_SECRET)
    return res.status(401).json({ error: 'Invalid secret' });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return res.status(500).json({ error: 'DATABASE_URL not set' });

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const results = [];

  try {
    await client.connect();

    for (const sql of MIGRATIONS) {
      const label = sql.trim().split('\n')[0].slice(0, 80);
      try {
        await client.query(sql);
        results.push({ ok: true, sql: label });
      } catch(e) {
        results.push({ ok: false, sql: label, error: e.message });
      }
    }

    // Verify
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurants' ORDER BY column_name`
    );
    const { rows: offerCheck } = await client.query(
      `SELECT to_regclass('public.offers') as tbl`
    );

    return res.status(200).json({
      done: true,
      results,
      restaurants_columns: cols.map(r => r.column_name),
      offers_table: !!offerCheck[0]?.tbl,
    });

  } catch(e) {
    return res.status(500).json({ error: 'Connection failed', detail: e.message });
  } finally {
    await client.end().catch(() => {});
  }
};
