/**
 * api/run-migration.js — ONE-TIME DB migration endpoint
 * POST /api/run-migration  { "secret": "great-guest-migrate-2026" }
 * Tries all Supabase pooler regions to find the right one.
 */
const { Client } = require('pg');

const PROJECT_REF = 'wjlhaizrygeyeishbycp';
const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ca-central-1', 'sa-east-1',
];

const MIGRATIONS = [
  `ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS owner_telegram_id         TEXT,
    ADD COLUMN IF NOT EXISTS subscription_status       TEXT DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS trial_started_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS subscription_expires_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cuisine                   TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS description               TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS venue_type                TEXT DEFAULT 'restaurant',
    ADD COLUMN IF NOT EXISTS event_date                DATE,
    ADD COLUMN IF NOT EXISTS event_type                TEXT DEFAULT ''`,

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
   END; $$`,

  `DROP TRIGGER IF EXISTS trg_last_visit_at ON visits`,

  `CREATE TRIGGER trg_last_visit_at
     AFTER INSERT ON visits
     FOR EACH ROW EXECUTE FUNCTION update_last_visit_at()`,
];

async function tryConnect(url) {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { secret } = req.body || {};
  if (secret !== process.env.MIGRATE_SECRET)
    return res.status(401).json({ error: 'Invalid secret' });

  const pw = process.env.DB_PASSWORD;
  if (!pw) return res.status(500).json({ error: 'DB_PASSWORD not set' });

  // Try all regions to find the one that works
  let client = null;
  let connectedRegion = null;
  const tried = [];

  // First try direct connection
  const directUrl = `postgresql://postgres:${pw}@db.${PROJECT_REF}.supabase.co:5432/postgres`;
  try {
    client = await tryConnect(directUrl);
    connectedRegion = 'direct';
  } catch(e) {
    tried.push({ url: 'direct', error: e.message.slice(0,60) });
  }

  // Try pooler regions
  if (!client) {
    for (const region of REGIONS) {
      const url = `postgresql://postgres.${PROJECT_REF}:${pw}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
      try {
        client = await tryConnect(url);
        connectedRegion = region;
        break;
      } catch(e) {
        tried.push({ region, error: e.message.slice(0,60) });
      }
    }
  }

  if (!client) {
    return res.status(500).json({
      error: 'Could not connect to any Supabase endpoint',
      tried,
    });
  }

  const results = [];
  try {
    for (const sql of MIGRATIONS) {
      const label = sql.trim().replace(/\s+/g, ' ').slice(0, 80);
      try {
        await client.query(sql);
        results.push({ ok: true, sql: label });
      } catch(e) {
        results.push({ ok: false, sql: label, error: e.message });
      }
    }

    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurants' ORDER BY column_name`
    );
    const { rows: offerCheck } = await client.query(
      `SELECT to_regclass('public.offers') as tbl`
    );

    return res.status(200).json({
      done: true,
      connectedVia: connectedRegion,
      results,
      restaurants_columns: cols.map(r => r.column_name),
      offers_table: !!offerCheck[0]?.tbl,
    });
  } finally {
    await client.end().catch(() => {});
  }
};
