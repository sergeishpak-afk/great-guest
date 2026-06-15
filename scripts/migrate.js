/**
 * scripts/migrate.js
 * Run: node scripts/migrate.js <DB_PASSWORD>
 *
 * Gets DB password from: Supabase → Settings → Database → Database Password
 */
const { Client } = require('pg');

const DB_PASSWORD = process.argv[2];
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/migrate.js <DB_PASSWORD>');
  process.exit(1);
}

const DB_HOST = 'db.wjlhaizrygeyeishbycp.supabase.co';
const DB_URL  = `postgresql://postgres:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:5432/postgres`;

const MIGRATIONS = [
  // ── v2: subscriptions + offers ──────────────────────────────────────────
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

  // ── v3: venue types (restaurant / event) ────────────────────────────────
  `ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS venue_type  TEXT DEFAULT 'restaurant',
    ADD COLUMN IF NOT EXISTS event_date  DATE,
    ADD COLUMN IF NOT EXISTS event_type  TEXT DEFAULT ''`,
];

async function run() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('✅ Connected to Supabase postgres\n');

    for (let i = 0; i < MIGRATIONS.length; i++) {
      const sql = MIGRATIONS[i].trim();
      const preview = sql.split('\n')[0].slice(0, 70);
      process.stdout.write(`[${i+1}/${MIGRATIONS.length}] ${preview}... `);
      try {
        await client.query(sql);
        console.log('✅');
      } catch(e) {
        console.log('⚠️  ' + e.message);
      }
    }

    // Verify final state
    const { rows } = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'restaurants'
      ORDER BY column_name
    `);
    console.log('\n📋 Restaurants columns:', rows.map(r => r.column_name).join(', '));

    const { rows: offerRows } = await client.query(`
      SELECT to_regclass('public.offers') as exists
    `);
    console.log('🎁 Offers table:', offerRows[0].exists ? '✅ exists' : '❌ missing');

    console.log('\n🚀 Migrations complete! Great Guest is ready to launch.');

  } catch(e) {
    console.error('\n❌ Connection failed:', e.message);
    console.error('Check: Supabase → Settings → Database → Database Password');
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
