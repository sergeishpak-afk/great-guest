/**
 * api/superadmin.js
 * Super-admin dashboard — only accessible to owner Telegram IDs.
 * Protected by OWNER_IDS env var (comma-separated list of telegram IDs).
 *
 * POST { initData }              — returns platform stats + all organizers
 * POST { initData, action, ... } — actions: extend_sub, change_plan
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLANS = {
  trial:   { label: 'Старт',    max_venues: 1,   price: 0 },
  basic:   { label: 'Базовый',  max_venues: 1,   price: 2990 },
  network: { label: 'Сеть',     max_venues: 5,   price: 7990 },
  empire:  { label: 'Империя',  max_venues: 999, price: 19990 },
};

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

function isOwner(telegramId) {
  const ids = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(String(telegramId));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, action } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params    = new URLSearchParams(initData);
  const tgUser    = JSON.parse(params.get('user') || '{}');
  const callerId  = String(tgUser.id);

  if (!isOwner(callerId)) return res.status(403).json({ error: 'Доступ запрещён' });

  // ── action: extend_sub — add N days to organizer subscription ────────────
  if (action === 'extend_sub') {
    const { targetId, days } = req.body;
    if (!targetId || !/^\d+$/.test(targetId)) return res.status(400).json({ error: 'invalid targetId' });
    const d = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const { data: sub } = await db.from('owner_subscriptions').select('subscription_expires_at, subscription_status').eq('telegram_id', targetId).single();
    if (!sub) return res.status(404).json({ error: 'Organizer not found' });
    const base = sub.subscription_expires_at
      ? Math.max(new Date(sub.subscription_expires_at).getTime(), Date.now())
      : Date.now();
    const newExpiry = new Date(base + d * 86400000).toISOString();
    await db.from('owner_subscriptions').update({ subscription_expires_at: newExpiry, subscription_status: 'active' }).eq('telegram_id', targetId);
    return res.status(200).json({ success: true, new_expiry: newExpiry });
  }

  // ── action: change_plan — change organizer plan ───────────────────────────
  if (action === 'change_plan') {
    const { targetId, plan } = req.body;
    if (!targetId || !/^\d+$/.test(targetId)) return res.status(400).json({ error: 'invalid targetId' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'invalid plan' });
    await db.from('owner_subscriptions').update({
      plan,
      max_venues: PLANS[plan].max_venues,
    }).eq('telegram_id', targetId);
    return res.status(200).json({ success: true });
  }

  // ── Default: return full platform stats ───────────────────────────────────
  const [
    { count: totalOrganizers },
    { count: totalGuests },
    { count: totalVenues },
    { count: totalVisits },
    { data: organizers },
  ] = await Promise.all([
    db.from('owner_subscriptions').select('*', { count: 'exact', head: true }),
    db.from('guests').select('*', { count: 'exact', head: true }),
    db.from('restaurants').select('*', { count: 'exact', head: true }),
    db.from('visits').select('*', { count: 'exact', head: true }),
    db.from('owner_subscriptions').select('*').order('created_at', { ascending: false }),
  ]);

  // Enrich each organizer with venue count
  const telegramIds = (organizers || []).map(o => o.telegram_id);
  const { data: venueCounts } = await db
    .from('restaurants')
    .select('owner_telegram_id')
    .in('owner_telegram_id', telegramIds.length ? telegramIds : ['__none__']);

  const venueMap = {};
  (venueCounts || []).forEach(v => {
    venueMap[v.owner_telegram_id] = (venueMap[v.owner_telegram_id] || 0) + 1;
  });

  const enriched = (organizers || []).map(o => ({
    ...o,
    venue_count: venueMap[o.telegram_id] || 0,
    plan_label: PLANS[o.plan]?.label || o.plan,
  }));

  return res.status(200).json({
    stats: {
      total_organizers: totalOrganizers || 0,
      total_guests:     totalGuests     || 0,
      total_venues:     totalVenues     || 0,
      total_visits:     totalVisits     || 0,
    },
    organizers: enriched,
  });
};
