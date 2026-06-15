/**
 * api/restaurant-register.js
 * POST — register a restaurant/event for multi-venue owner
 * Subscription is now on owner level (owner_subscriptions table)
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

  const { initData, name, address, city, cuisine, venue_type, event_date, event_type } = req.body || {};
  if (!initData || !name) return res.status(400).json({ error: 'initData and name required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  // 1. Get or create owner_subscription
  let { data: ownerSub, error: subError } = await db
    .from('owner_subscriptions')
    .select('*')
    .eq('telegram_id', ownerId)
    .single();

  if (subError && subError.code === 'PGRST116') {
    // Not found — create new trial subscription
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const { data: newSub, error: insertError } = await db
      .from('owner_subscriptions')
      .insert({
        telegram_id: ownerId,
        plan: 'trial',
        max_venues: 1,
        subscription_status: 'trial',
        trial_started_at: now.toISOString(),
        subscription_expires_at: trialEnd.toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('owner_subscriptions insert error:', insertError);
      return res.status(500).json({ error: 'DB error', detail: insertError.message });
    }
    ownerSub = newSub;
  } else if (subError) {
    console.error('owner_subscriptions select error:', subError);
    return res.status(500).json({ error: 'DB error', detail: subError.message });
  }

  // 2. Check if subscription is active
  const now = new Date();
  const expires = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active')
    && expires && expires > now;

  if (!isActive) {
    return res.status(403).json({
      error: 'subscription_expired',
      message: 'Пробный период завершён. Выберите тариф для продолжения.',
    });
  }

  // 3. Count existing venues for this owner
  const { count: venueCount, error: countError } = await db
    .from('restaurants')
    .select('*', { count: 'exact', head: true })
    .eq('owner_telegram_id', ownerId);

  if (countError) {
    console.error('restaurants count error:', countError);
    return res.status(500).json({ error: 'DB error', detail: countError.message });
  }

  const currentCount = venueCount || 0;

  // 4. Check venue limit
  if (currentCount >= ownerSub.max_venues) {
    const upgradePlans = [];
    const planKeys = ['network', 'empire'];
    for (const key of planKeys) {
      if (PLANS[key].max_venues > ownerSub.max_venues) {
        upgradePlans.push(key);
      }
    }

    return res.status(403).json({
      error: 'limit_reached',
      current: currentCount,
      max: ownerSub.max_venues,
      plan: ownerSub.plan,
      upgrade_plans: upgradePlans,
    });
  }

  // 5. Insert new restaurant (no subscription fields on restaurant row)
  const { data: restaurant, error: insertError } = await db
    .from('restaurants')
    .insert({
      name:              name.trim(),
      address:           (address || '').trim(),
      city:              (city || 'Москва').trim(),
      cuisine:           (cuisine || '').trim(),
      venue_type:        venue_type || 'restaurant',
      event_date:        event_date || null,
      event_type:        (event_type || '').trim(),
      owner_telegram_id: ownerId,
    })
    .select()
    .single();

  if (insertError) {
    console.error('restaurants insert error:', insertError);
    return res.status(500).json({ error: 'DB error', detail: insertError.message });
  }

  return res.status(201).json({
    restaurant,
    owner_subscription: ownerSub,
  });
};
