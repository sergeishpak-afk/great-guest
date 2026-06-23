const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../src/status');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Basic UUID v4 format check — prevent arbitrary token enumeration attempts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// In-memory rate limit: max 60 scan attempts per IP per minute
const RL_MAP = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60_000;
  const entry = RL_MAP.get(ip) || { count: 0, reset: now + window };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + window; }
  entry.count++;
  RL_MAP.set(ip, entry);
  if (RL_MAP.size > 5000) {
    for (const [k, v] of RL_MAP) { if (v.reset < now) RL_MAP.delete(k); }
  }
  return entry.count > 60;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });

  const { token, restaurantId } = req.body || {};
  if (!token || !UUID_RE.test(token)) return res.status(400).json({ error: 'token required' });

  // Atomically claim the pending visit to prevent race conditions
  const { data: claimedVisit, error: claimError } = await supabase
    .from('pending_visits')
    .update({ used: true })
    .eq('token', token)
    .eq('used', false)  // atomic check
    .select()
    .single();

  if (claimError || !claimedVisit) {
    return res.status(409).json({ error: 'QR уже использован или не существует' });
  }

  // QR TTL: expire after 60 minutes (replay-attack + stale QR protection)
  const createdAt = claimedVisit.expires_at
    ? new Date(claimedVisit.expires_at)
    : new Date(claimedVisit.created_at ? new Date(claimedVisit.created_at).getTime() + 3600000 : 0);
  if (Date.now() > createdAt.getTime()) {
    // Already marked as used above, just return error
    return res.status(410).json({ error: 'QR-код истёк. Гость должен сгенерировать новый.' });
  }

  const pending = claimedVisit;

  // Use pending_visits.restaurant_id as the authoritative venue (set at QR generation time),
  // fall back to client-supplied restaurantId only for non-guestlist venues.
  const effectiveRestaurantId = claimedVisit.restaurant_id || restaurantId || null;

  // Fetch guest name + restaurant info in parallel
  const [guestResult, restResult] = await Promise.all([
    supabase.from('guests').select('first_name, last_name').eq('telegram_id', pending.telegram_id).single(),
    effectiveRestaurantId && UUID_RE.test(effectiveRestaurantId)
      ? supabase.from('restaurants').select('name, owner_telegram_id, classification_mode').eq('id', effectiveRestaurantId).single()
      : Promise.resolve({ data: null }),
  ]);

  if (!guestResult.data) return res.status(404).json({ error: 'Гость не найден' });
  if (effectiveRestaurantId && !UUID_RE.test(effectiveRestaurantId)) return res.status(400).json({ error: 'invalid restaurantId' });
  if (effectiveRestaurantId && !restResult.data) return res.status(404).json({ error: 'Ресторан не найден' });

  // Guestlist mode: deny entry if guest never confirmed RSVP
  if (restResult.data?.classification_mode === 'guestlist') {
    // Anonymous QR (generated via /qr command, no venue binding) — reject at guestlist venues
    if (!claimedVisit.restaurant_id) {
      return res.status(403).json({
        error: 'guestlist_requires_venue_qr',
        message: 'QR-код не привязан к мероприятию. Гость должен получить QR через ссылку события.',
      });
    }
    const { data: rsvpRow } = await supabase
      .from('rsvp')
      .select('id')
      .eq('venue_id', claimedVisit.restaurant_id)
      .eq('telegram_id', pending.telegram_id)
      .maybeSingle();

    if (!rsvpRow) {
      return res.status(403).json({
        error: 'not_on_guestlist',
        message: 'Гость не в списке приглашённых',
      });
    }
  }

  const guest = guestResult.data;
  const restaurantName = restResult.data?.name || 'ресторан-партнёр';

  // Atomic visit_count increment (prevents race condition on simultaneous scans)
  const { data: newCount, error: rpcError } = await supabase
    .rpc('increment_guest_visits', { p_telegram_id: pending.telegram_id });

  if (rpcError || newCount === null) {
    console.error('increment_guest_visits error:', rpcError?.message);
    return res.status(500).json({ error: 'Ошибка обновления счётчика' });
  }

  await supabase.from('visits').insert({ telegram_id: pending.telegram_id, restaurant_id: effectiveRestaurantId || null, visit_token: token });

  // Update persistent organizer contact base (fire-and-forget)
  if (effectiveRestaurantId && restResult.data?.owner_telegram_id) {
    supabase.rpc('upsert_organizer_contact', {
      p_org:   restResult.data.owner_telegram_id,
      p_guest: pending.telegram_id,
      p_first: guest.first_name || '',
      p_last:  guest.last_name  || '',
      p_user:  '',
      p_rsvp:  false,
    }).then().catch(() => {});
  }

  try {
    await bot.telegram.sendMessage(pending.telegram_id, `✅ *Визит подтверждён!*\n\n📍 ${restaurantName}\n\n${formatStatus(newCount)}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('Telegram notify error:', e.message); }

  return res.status(200).json({ success: true, guest: { name: `${guest.first_name} ${guest.last_name}`.trim(), visits: newCount } });
};
