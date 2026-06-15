/**
 * api/import-guests.js
 * POST — Bulk import guests from restaurant's existing database (CSV)
 * Body: { initData, restaurantId, guests: [{first_name, phone?, last_name?}] }
 *
 * Flow:
 *  1. Owner uploads CSV → frontend parses → sends array
 *  2. We insert into imported_guests table
 *  3. When a guest registers via Telegram and their phone matches → auto-link
 *
 * Rate limit: 3 imports per hour per owner (prevents abuse)
 * Max 500 guests per request (chunked inserts)
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Phone normalizer — strips spaces, dashes, brackets; ensures +7 prefix for RU
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^\d+]/g, '');
  if (p.startsWith('8') && p.length === 11) p = '+7' + p.slice(1);
  if (p.startsWith('7') && p.length === 11) p = '+' + p;
  return p.length >= 10 ? p : null;
}

// Rate limit: 3 imports per owner per hour
const IMPORT_RL = new Map();
function checkImportRateLimit(ownerId) {
  const now = Date.now();
  const window = 3600_000; // 1 hour
  const limit = 3;
  const entry = IMPORT_RL.get(ownerId) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  IMPORT_RL.set(ownerId, entry);
  return entry.count <= limit;
}

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

// Insert in chunks of 100 to avoid Supabase PostgREST limits
async function insertChunked(rows) {
  const CHUNK = 100;
  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await db
      .from('imported_guests')
      .upsert(chunk, { onConflict: 'restaurant_id,phone', ignoreDuplicates: true })
      .select('id', { count: 'exact', head: true });
    if (error) { errors += chunk.length; console.error('import chunk error:', error); }
    else inserted += (count || chunk.length);
  }
  return { inserted, errors };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, restaurantId, guests } = req.body || {};

  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!restaurantId || !UUID_RE.test(restaurantId))
    return res.status(400).json({ error: 'valid restaurantId required' });
  if (!Array.isArray(guests) || guests.length === 0)
    return res.status(400).json({ error: 'guests array required' });
  if (guests.length > 500)
    return res.status(400).json({ error: 'max 500 guests per request' });

  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  if (!checkImportRateLimit(ownerId))
    return res.status(429).json({ error: 'too_many_requests', message: 'Максимум 3 импорта в час' });

  // Verify owner has an active subscription
  const { data: ownerSub } = await db
    .from('owner_subscriptions')
    .select('subscription_status, subscription_expires_at')
    .eq('telegram_id', ownerId)
    .single();

  const now     = new Date();
  const expires = ownerSub?.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const isActive = ownerSub && (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && expires && expires > now;
  if (!isActive) return res.status(403).json({ error: 'subscription_expired' });

  // Verify ownership of restaurant
  const { data: restaurant } = await db
    .from('restaurants')
    .select('id, name')
    .eq('id', restaurantId)
    .eq('owner_telegram_id', ownerId)
    .single();
  if (!restaurant) return res.status(403).json({ error: 'venue_not_found' });

  // Validate and normalize each guest row
  const rows = [];
  const skipped = [];

  for (const g of guests) {
    const firstName = String(g.first_name || g.name || '').trim().slice(0, 100);
    const lastName  = String(g.last_name || '').trim().slice(0, 100);
    const phone     = normalizePhone(g.phone);

    if (!firstName && !phone) { skipped.push(g); continue; }

    rows.push({
      restaurant_id:  restaurantId,
      first_name:     firstName || null,
      last_name:      lastName  || null,
      phone:          phone,
      invite_status:  'pending',
      telegram_id:    null,
      imported_by:    ownerId,
    });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'no_valid_guests', skipped: skipped.length });
  }

  const { inserted, errors } = await insertChunked(rows);

  return res.status(200).json({
    success: true,
    total:    guests.length,
    inserted,
    skipped:  skipped.length,
    errors,
    restaurant: restaurant.name,
  });
};
