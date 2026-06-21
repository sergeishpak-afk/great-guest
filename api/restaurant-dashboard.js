/**
 * api/restaurant-dashboard.js
 * POST — returns dashboard data for restaurant owner (multi-venue):
 *   - owner subscription info
 *   - all venues with individual stats
 *   - global guest list (ALL guests in network)
 *   - sent offers history across all venues
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PLANS = {
  trial:   { label: 'Старт',   max_venues: 1,   price: 0,     price_label: 'Бесплатно 14 дней' },
  basic:   { label: 'Базовый', max_venues: 1,   price: 2990,  price_label: '2 990 ₽/мес' },
  network: { label: 'Сеть',    max_venues: 5,   price: 7990,  price_label: '7 990 ₽/мес' },
  empire:  { label: 'Империя', max_venues: 999, price: 19990, price_label: '19 990 ₽/мес' },
};

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    // Reject requests older than 1 hour (replay-attack protection)
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  // 1. Get owner subscription
  let { data: ownerSub, error: subError } = await db
    .from('owner_subscriptions')
    .select('*')
    .eq('telegram_id', ownerId)
    .single();

  // 2. Get all venues for this owner
  const { data: venues, error: venuesError } = await db
    .from('restaurants')
    .select('*')
    .eq('owner_telegram_id', ownerId)
    .order('created_at', { ascending: true })
    .limit(20);

  if (venuesError) {
    console.error('restaurants select error:', venuesError);
    return res.status(500).json({ error: 'DB error', detail: venuesError.message });
  }

  const venuesList = venues || [];

  // 3. Handle not registered case
  if (!ownerSub && venuesList.length === 0) {
    return res.status(404).json({ error: 'not_registered' });
  }

  // 4. Legacy case: venues exist but no subscription — auto-create expired trial
  if (!ownerSub && venuesList.length > 0) {
    const now = new Date();
    const { data: newSub, error: insertError } = await db
      .from('owner_subscriptions')
      .insert({
        telegram_id: ownerId,
        plan: 'trial',
        max_venues: 1,
        subscription_status: 'trial',
        trial_started_at: now.toISOString(),
        subscription_expires_at: now.toISOString(), // Expired immediately
      })
      .select()
      .single();

    if (insertError) {
      console.error('owner_subscriptions insert error:', insertError);
      return res.status(500).json({ error: 'DB error', detail: insertError.message });
    }
    ownerSub = newSub;
  }

  // 5. Build owner info
  const now = new Date();
  const expires = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
  const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && daysLeft > 0;

  const ownerInfo = {
    plan: ownerSub.plan,
    max_venues: ownerSub.max_venues,
    subscription_status: ownerSub.subscription_status,
    days_left: daysLeft,
    is_active: isActive,
    subscription_expires_at: ownerSub.subscription_expires_at,
  };

  // 6. Get stats for each venue (parallel queries)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const venueIds = venuesList.map(v => v.id);

  const venuesWithStats = await Promise.all(
    venuesList.map(async (venue) => {
      const [visits30dResult, totalVisitsResult, offersCountResult] = await Promise.all([
        // Visits in last 30 days
        db
          .from('visits')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id)
          .gte('visited_at', thirtyDaysAgo),
        // Total visits
        db
          .from('visits')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id),
        // Offers count
        db
          .from('offers')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id),
      ]);

      return {
        ...venue,
        stats: {
          visits30d: visits30dResult.count || 0,
          totalVisits: totalVisitsResult.count || 0,
          offersCount: offersCountResult.count || 0,
        },
      };
    })
  );

  // 7. Get global guests and offers only if subscription is active
  let globalGuests = [];
  let offers = [];

  if (isActive && venueIds.length > 0) {
    // Get distinct guest IDs who have visited this owner's venues (scoped, not global)
    const { data: visitRows } = await db
      .from('visits')
      .select('telegram_id')
      .in('restaurant_id', venueIds);

    const uniqueGuestIds = [...new Set((visitRows || []).map(v => v.telegram_id))];

    const [guestsResult, offersResult] = await Promise.all([
      // Own venue guests only
      uniqueGuestIds.length > 0
        ? db
            .from('guests')
            .select('telegram_id, first_name, last_name, visit_count, last_visit_at')
            .in('telegram_id', uniqueGuestIds)
            .order('visit_count', { ascending: false })
            .limit(200)
        : Promise.resolve({ data: [] }),
      // Offers across all venues (last 100)
      db
        .from('offers')
        .select('id, restaurant_id, guest_telegram_id, offer_text, status, created_at')
        .in('restaurant_id', venueIds)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    globalGuests = guestsResult.data || [];
    offers = offersResult.data || [];
  }

  // 8. Build targeted IDs set from all offers
  const targetedIds = new Set((offers || []).map(o => o.guest_telegram_id));

  // 9. Return response
  return res.status(200).json({
    owner: ownerInfo,
    venues: venuesWithStats,
    globalGuests: globalGuests.map(g => ({
      ...g,
      alreadyTargeted: targetedIds.has(g.telegram_id),
    })),
    offers: offers || [],
  });
};
