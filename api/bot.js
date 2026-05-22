const { Telegraf } = require('telegraf');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const { formatStatus } = require('../src/status');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

bot.start(async (ctx) => {
  const tgUser = ctx.from;
  await supabase.from('guests').upsert({ telegram_id: String(tgUser.id), first_name: tgUser.first_name || '', last_name: tgUser.last_name || '', username: tgUser.username || '' }, { onConflict: 'telegram_id' });
  await ctx.replyWithMarkdown(`👋 Привет, *${tgUser.first_name}*!\n\nДобро пожаловать в *Great Guest*.\n\nКаждый визит в ресторан-партнёр повышает твой статус.`, { reply_markup: { keyboard: [['🎫 Получить QR для визита'], ['⭐ Мой статус', '📋 История визитов']], resize_keyboard: true } });
});

bot.hears('🎫 Получить QR для визита', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const visitToken = uuidv4();
  await supabase.from('pending_visits').insert({ token: visitToken, telegram_id: telegramId });
  const qrBuffer = await QRCode.toBuffer(visitToken, { errorCorrectionLevel: 'H', width: 400, margin: 2 });
  await ctx.replyWithPhoto({ source: qrBuffer }, { caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код администратору. Код действителен для одного визита.`, parse_mode: 'Markdown' });
});

bot.hears('⭐ Мой статус', async (ctx) => {
  const { data: guest } = await supabase.from('guests').select('visit_count, first_name').eq('telegram_id', String(ctx.from.id)).single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Твой статус, ${guest.first_name}*\n\n${formatStatus(guest.visit_count)}`);
});

bot.hears('📋 История визитов', async (ctx) => {
  const { data: visits } = await supabase.from('visits').select('visited_at, restaurants(name)').eq('telegram_id', String(ctx.from.id)).order('visited_at', { ascending: false }).limit(10);
  if (!visits?.length) return ctx.replyWithMarkdown('📋 *История пустая*\n\nПолучи QR и посети ресторан-партнёр!');
  const lines = visits.map((v, i) => `${i + 1}. ${v.restaurants?.name || 'Ресторан'} — ${new Date(v.visited_at).toLocaleDateString('ru-RU')}`);
  await ctx.replyWithMarkdown(`📋 *Последние визиты*\n\n${lines.join('\n')}`);
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  } catch (e) {
    console.error('Bot error:', e);
    return res.status(500).send('Error');
  }
};
