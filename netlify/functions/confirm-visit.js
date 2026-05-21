const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../../src/status');

const bot = new Telegraf(process.env.BOT_TOKEN);
// service_role — все записи в БД только через сервер
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { token, restaurantId } = JSON.parse(event.body || '{}');
  if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'token required' }) };

  const { data: pending } = await supabase
    .from('pending_visits').select('*').eq('token', token).eq('used', false).single();
  if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'QR не найден или уже использован' }) };

  const { data: guest } = await supabase
    .from('guests').select('*').eq('telegram_id', pending.telegram_id).single();
  if (!guest) return { statusCode: 404, body: JSON.stringify({ error: 'Гость не найден' }) };

  const newCount = guest.visit_count + 1;

  let restaurantName = 'ресторан-партнёр';
  if (restaurantId) {
    const { data: rest } = await supabase.from('restaurants').select('name').eq('id', restaurantId).single();
    if (rest) restaurantName = rest.name;
  }

  await supabase.from('visits').insert({ telegram_id: pending.telegram_id, restaurant_id: restaurantId || null, visit_token: token });
  await supabase.from('guests').update({ visit_count: newCount }).eq('telegram_id', pending.telegram_id);
  await supabase.from('pending_visits').update({ used: true }).eq('token', token);

  // 🔔 Уведомляем гостя в Telegram
  try {
    await bot.telegram.sendMessage(
      pending.telegram_id,
      `✅ *Визит подтверждён!*\n\n📍 ${restaurantName}\n\n${formatStatus(newCount)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Telegram notify error:', e.message);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, guest: { name: `${guest.first_name} ${guest.last_name}`.trim(), visits: newCount } }),
  };
};
