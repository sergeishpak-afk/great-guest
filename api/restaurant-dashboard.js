/**
 * api/restaurant-dashboard.js
 * POST — returns dashboard data for restaurant owner:
 *   - their restaurant info + subscription status
 *   - their visit stats
 *   - global guest list (ALL guests in network, filtered by status)
 *   - sent offers history
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TRIAL_DAYS = 14;

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

function subscriptionInfo(restaurant) {
  const now = new Date();
  const expires = restaurant.subscription_expires_at ? new Date(restaurant.subscription_expires_at) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
  const isActive = (restaurant.subscription_status === 'trial' || restaurant.subscription_status === 'active') && daysLeft > 0;
  return { daysLeft, isActive, status: restaurant.subscription_status };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  // 1. Get restaurant for this owner
  const { data: restaurant } = await db
    .from('restaurants')
    .select('*')
    .eq('owner_telegram_id', ownerId)
    .single();

  if (!restaurant) return res.status(404).json({ error: 'not_registered' });

  const sub = subscriptionInfo(restaurant);

  // 2. My restaurant stats (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: recentVisits } = await db
    .from('visits')
    .select('telegram_id, visited_at')
    .eq('restaurant_id', restaurant.id)
    .gte('visited_at', thirtyDaysAgo);

  const totalVisits30d  = recentVisits?.length || 0;
  const uniqueGuests30d = new Set(recentVisits?.map(v => v.telegram_id) || []).size;

  const { count: totalVisitsAll } = await db
    .from('visits')
    .select('*', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.id);

  // 3. Global guest list (requires active subscription)
  let globalGuests = [];
  if (sub.isActive) {
    const { data: guests } = await db
      .from('guests')
      .select('telegram_id, first_name, last_name, visit_count, last_visit_at')
      .gt('visit_count', 0)
      .order('visit_count', { ascending: false })
      .limit(200);
    globalGuests = guests || [];
  }

  // 4. Offers sent by this restaurant
  const { data: offers } = await db
    .from('offers')
    .select('id, guest_telegram_id, offer_text, status, created_at')
    .eq('restaurant_id', restaurant.id)
    .order('created_at', { ascending: false })
    .limit(50);

  // 5. Already targeted guests (to avoid spam)
  const targetedIds = new Set((offers || []).map(o => o.guest_telegram_id));

  return res.status(200).json({
    restaurant,
    subscription: sub,
    stats: {
      visits30d: totalVisits30d,
      guests30d: uniqueGuests30d,
      totalVisits: totalVisitsAll || 0,
    },
    globalGuests: globalGuests.map(g => ({
      ...g,
      alreadyTargeted: targetedIds.has(g.telegram_id),
    })),
    offers: offers || [],
  });
};
