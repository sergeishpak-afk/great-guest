const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../src/status');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { token, restaurantId } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });

  const { data: pending } = await supabase.from('pending_visits').select('*').eq('token', token).eq('used', false).single();
  if (!pending) return res.status(404).json({ error: 'QR не найден или уже использован' });

  const { data: guest } = await supabase.from('guests').select('*').eq('telegram_id', pending.telegram_id).single();
  if (!guest) return res.status(404).json({ error: 'Гость не найден' });

  const newCount = guest.visit_count + 1;
  let restaurantName = 'ресторан-партнёр';
  if (restaurantId) {
    const { data: rest } = await supabase.from('restaurants').select('name').eq('id', restaurantId).single();
    if (rest) restaurantName = rest.name;
  }

  await supabase.from('visits').insert({ telegram_id: pending.telegram_id, restaurant_id: restaurantId || null, visit_token: token });
  await supabase.from('guests').update({ visit_count: newCount }).eq('telegram_id', pending.telegram_id);
  await supabase.from('pending_visits').update({ used: true }).eq('token', token);

  try {
    await bot.telegram.sendMessage(pending.telegram_id, `✅ *Визит подтверждён!*\n\n📍 ${restaurantName}\n\n${formatStatus(newCount)}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('Telegram notify error:', e.message); }

  return res.status(200).json({ success: true, guest: { name: `${guest.first_name} ${guest.last_name}`.trim(), visits: newCount } });
};
