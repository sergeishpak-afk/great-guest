const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../src/status');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Basic UUID v4 format check — prevent arbitrary token enumeration attempts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

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

  const { data: guest } = await supabase.from('guests').select('*').eq('telegram_id', pending.telegram_id).single();
  if (!guest) return res.status(404).json({ error: 'Гость не найден' });

  const newCount = guest.visit_count + 1;
  let restaurantName = 'ресторан-партнёр';
  if (restaurantId) {
    if (!UUID_RE.test(restaurantId)) return res.status(400).json({ error: 'invalid restaurantId' });
    const { data: rest } = await supabase.from('restaurants').select('name').eq('id', restaurantId).single();
    if (!rest) return res.status(404).json({ error: 'Ресторан не найден' });
    restaurantName = rest.name;
  }

  await supabase.from('visits').insert({ telegram_id: pending.telegram_id, restaurant_id: restaurantId || null, visit_token: token });
  await supabase.from('guests').update({ visit_count: newCount }).eq('telegram_id', pending.telegram_id);
  // pending_visits already marked as used atomically above

  try {
    await bot.telegram.sendMessage(pending.telegram_id, `✅ *Визит подтверждён!*\n\n📍 ${restaurantName}\n\n${formatStatus(newCount)}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('Telegram notify error:', e.message); }

  return res.status(200).json({ success: true, guest: { name: `${guest.first_name} ${guest.last_name}`.trim(), visits: newCount } });
};
