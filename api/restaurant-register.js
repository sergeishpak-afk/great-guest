/**
 * api/restaurant-register.js
 * POST — register a restaurant/event for multi-venue owner
 * Subscription is now on owner level (owner_subscriptions table)
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// In-memory rate limit: max 10 registration attempts per IP per hour
const RL_MAP = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 3_600_000;
  const entry = RL_MAP.get(ip) || { count: 0, reset: now + window };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + window; }
  entry.count++;
  RL_MAP.set(ip, entry);
  if (RL_MAP.size > 2000) {
    for (const [k, v] of RL_MAP) { if (v.reset < now) RL_MAP.delete(k); }
  }
  return entry.count > 10;
}

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });

  // ── DELETE: remove a venue owned by the requesting organizer ────────────────
  if (req.method === 'DELETE') {
    const { initData: delInitData, venueId } = req.body || {};
    if (!delInitData || !venueId) return res.status(400).json({ error: 'initData and venueId required' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!validateInitData(delInitData, process.env.BOT_TOKEN))
      return res.status(401).json({ error: 'Invalid signature' });
    const delParams = new URLSearchParams(delInitData);
    const ownerId = String(JSON.parse(delParams.get('user') || '{}').id || '');
    if (!ownerId) return res.status(401).json({ error: 'No user' });
    const { data: venue, error: fetchErr } = await db
      .from('restaurants').select('id, name, owner_telegram_id').eq('id', venueId).single();
    if (fetchErr || !venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    await db.from('offers').delete().eq('restaurant_id', venueId);
    await db.from('visits').delete().eq('restaurant_id', venueId);
    await db.from('pending_visits').delete().eq('restaurant_id', venueId);
    const { error: delErr } = await db.from('restaurants').delete().eq('id', venueId);
    if (delErr) return res.status(500).json({ error: 'Delete failed', detail: delErr.message });
    return res.status(200).json({ success: true, deleted: venue.name });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, name, address, city, cuisine, venue_type, event_date, event_type, invite_message, referredBy, classification_mode } = req.body || {};
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

  const isNewOwner = subError && subError.code === 'PGRST116';
  if (isNewOwner) {
    // Not found — create new trial subscription
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const validRef = referredBy && /^\d+$/.test(referredBy) && referredBy !== ownerId ? referredBy : null;

    const { data: newSub, error: insertError } = await db
      .from('owner_subscriptions')
      .insert({
        telegram_id: ownerId,
        plan: 'trial',
        max_venues: 1,
        subscription_status: 'trial',
        trial_started_at: now.toISOString(),
        subscription_expires_at: trialEnd.toISOString(),
        referred_by: validRef,
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
      name:                name.trim(),
      address:             (address || '').trim(),
      city:                (city || 'Москва').trim(),
      cuisine:             (cuisine || '').trim(),
      venue_type:          venue_type || 'restaurant',
      event_date:          event_date || null,
      event_type:          (event_type || '').trim(),
      invite_message:      (invite_message || '').trim().slice(0, 1000),
      owner_telegram_id:   ownerId,
      classification_mode: ['loyalty','guestlist','open'].includes(classification_mode) ? classification_mode : 'loyalty',
    })
    .select()
    .single();

  if (insertError) {
    console.error('restaurants insert error:', insertError);
    return res.status(500).json({ error: 'DB error', detail: insertError.message });
  }

  // Credit referrer +30 days when a brand new organizer completes first registration
  if (isNewOwner && ownerSub.referred_by) {
    try {
      const { data: referrerSub } = await db
        .from('owner_subscriptions')
        .select('subscription_expires_at, subscription_status, referral_rewarded_count')
        .eq('telegram_id', ownerSub.referred_by)
        .single();

      if (referrerSub) {
        const base = referrerSub.subscription_expires_at
          ? Math.max(new Date(referrerSub.subscription_expires_at).getTime(), Date.now())
          : Date.now();
        const newExpiry = new Date(base + 30 * 24 * 60 * 60 * 1000);

        await db.from('owner_subscriptions').update({
          subscription_expires_at: newExpiry.toISOString(),
          subscription_status: 'active',
          referral_rewarded_count: (referrerSub.referral_rewarded_count || 0) + 1,
        }).eq('telegram_id', ownerSub.referred_by);

        // Notify referrer via bot (fire-and-forget)
        const { Telegraf } = require('telegraf');
        const botInst = new Telegraf(process.env.BOT_TOKEN);
        botInst.telegram.sendMessage(
          ownerSub.referred_by,
          `🎉 *+1 месяц бесплатно!*\n\nВаш друг зарегистрировался в Great Guest по вашей реферальной ссылке.\n\nПодписка продлена до *${newExpiry.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}*.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    } catch { /* non-critical — don't fail registration */ }
  }

  return res.status(201).json({
    restaurant,
    owner_subscription: ownerSub,
  });
};
