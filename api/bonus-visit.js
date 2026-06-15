/**
 * api/bonus-visit.js
 * POST — Award a bonus visit to a guest (owner action)
 * Body: { initData, guestTelegramId, restaurantId, reason? }
 *
 * Used when a guest has a large check or other discretionary bonus.
 * Adds visit_type='bonus' to visits table and increments visit_count.
 */
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../src/status');

const db  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// In-memory rate limit: max 60 bonus-visits per owner per minute
const RL_MAP = new Map();
function checkRateLimit(ownerId) {
  const now = Date.now();
  const window = 60_000;
  const limit = 60;
  const entry = RL_MAP.get(ownerId) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  RL_MAP.set(ownerId, entry);
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, guestTelegramId, restaurantId, reason } = req.body || {};
  if (!initData || !guestTelegramId)
    return res.status(400).json({ error: 'initData and guestTelegramId required' });
  if (restaurantId && !UUID_RE.test(restaurantId))
    return res.status(400).json({ error: 'invalid restaurantId' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  if (!checkRateLimit(ownerId))
    return res.status(429).json({ error: 'too_many_requests' });

  // Verify owner subscription is active
  const { data: ownerSub } = await db
    .from('owner_subscriptions')
    .select('*')
    .eq('telegram_id', ownerId)
    .single();

  const now     = new Date();
  const expires = ownerSub?.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const isActive = ownerSub && (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && expires && expires > now;
  if (!isActive) return res.status(403).json({ error: 'subscription_expired' });

  // Verify ownership of the restaurant
  let venueQuery = db.from('restaurants').select('*').eq('owner_telegram_id', ownerId);
  if (restaurantId) venueQuery = venueQuery.eq('id', restaurantId);
  const { data: restaurant } = await venueQuery.single();
  if (!restaurant) return res.status(403).json({ error: 'venue_not_found' });

  // Get guest
  const { data: guest } = await db
    .from('guests')
    .select('*')
    .eq('telegram_id', guestTelegramId)
    .single();
  if (!guest) return res.status(404).json({ error: 'guest_not_found' });

  const newCount = guest.visit_count + 1;

  // Record bonus visit + increment counter (parallel)
  await Promise.all([
    db.from('visits').insert({
      telegram_id:   guestTelegramId,
      restaurant_id: restaurant.id,
      visit_type:    'bonus',
      visit_token:   null,
    }),
    db.from('guests').update({ visit_count: newCount }).eq('telegram_id', guestTelegramId),
  ]);

  // Notify guest via bot
  const bonusNote = reason ? `\n💬 _${reason}_` : '';
  try {
    await bot.telegram.sendMessage(
      guestTelegramId,
      `🎁 *Бонус-визит начислен!*\n\n📍 ${restaurant.name}${bonusNote}\n\n${formatStatus(newCount)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) { console.error('Bonus notify error:', e.message); }

  return res.status(200).json({
    success: true,
    newVisitCount: newCount,
    guest: { name: `${guest.first_name} ${guest.last_name || ''}`.trim(), visits: newCount },
  });
};
