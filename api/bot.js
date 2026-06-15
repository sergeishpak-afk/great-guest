/**
 * api/bot.js — Telegram bot webhook (Vercel Serverless)
 * Webhook URL: https://great-guest.vercel.app/api/bot
 */

const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const bot      = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const APP_URL   = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');
const MINI_APP  = `${APP_URL}/app.html`;
const ADMIN_APP = `${APP_URL}/admin.html`;

// ─── Levels ──────────────────────────────────────────────────────────────────
const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', min: 0,  reward: 'Добро пожаловать в программу' },
  { name: 'Silver',   emoji: '🥈', min: 5,  reward: 'Скидка 5% + приоритетная бронь' },
  { name: 'Gold',     emoji: '🥇', min: 15, reward: 'Скидка 10% + комплимент от шефа' },
  { name: 'Platinum', emoji: '💎', min: 30, reward: 'Скидка 15% + VIP-обслуживание' },
];
function getLevel(n) { return [...LEVELS].reverse().find(l => n >= l.min) || LEVELS[0]; }
function getNext(n)  { return LEVELS.find(l => l.min > n); }
function decl(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2,3,4].includes(n%10) && ![12,13,14].includes(n%100)) return 'а';
  return 'ов';
}
function fmtStatus(count) {
  const lvl  = getLevel(count);
  const next = getNext(count);
  let s = `${lvl.emoji} *${lvl.name}* — ${count} визит${decl(count)}\n_${lvl.reward}_`;
  if (next) s += `\n\nДо *${next.name}*: ещё ${next.min - count} визит${decl(next.min - count)}`;
  else      s += '\n\n🏆 Максимальный статус достигнут!';
  return s;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainKb = Markup.keyboard([
  ['🎫 Получить QR для визита'],
  ['⭐ Мой статус', '📋 История визитов'],
]).resize();

const openBtn  = Markup.inlineKeyboard([[Markup.button.webApp('🚀 Открыть Great Guest', MINI_APP)]]);
const adminBtn = Markup.inlineKeyboard([[Markup.button.webApp('🏪 Панель ресторатора', ADMIN_APP)]]);

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const u = ctx.from;
  await supabase.from('guests').upsert(
    { telegram_id: String(u.id), first_name: u.first_name || '', last_name: u.last_name || '', username: u.username || '' },
    { onConflict: 'telegram_id' }
  );
  await ctx.replyWithMarkdown(
    `👋 Привет, *${u.first_name}*!\n\nДобро пожаловать в *Great Guest* — единую программу лояльности для ресторанов.\n\nКаждый визит в ресторан-партнёр повышает статус:\n🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Platinum\n\nС каждым уровнем — больше привилегий во всех ресторанах сети.`,
    mainKb
  );
  await ctx.reply('👇 Открой приложение:', openBtn);
});

// ─── /app — открыть приложение гостя ─────────────────────────────────────────
bot.command('app', async (ctx) => {
  await ctx.reply('👇', openBtn);
});

// ─── /restaurant — панель ресторатора ────────────────────────────────────────
bot.command('restaurant', async (ctx) => {
  const telegramId = String(ctx.from.id);

  const { data: rest } = await supabase
    .from('restaurants')
    .select('name, subscription_status, subscription_expires_at')
    .eq('owner_telegram_id', telegramId)
    .single();

  if (!rest) {
    await ctx.replyWithMarkdown(
      `🏪 *Панель ресторатора Great Guest*\n\nПодключите ваш ресторан к глобальной сети лояльности.\n\n✅ *14 дней бесплатно*\nПосле пробного периода — 2 990 ₽/мес\n\n*Что вы получаете:*\n• Доступ к базе всех гостей сети\n• Фильтрация по статусу (Bronze / Silver / Gold / Platinum)\n• Персональные AI-предложения для гостей\n• Аналитика визитов вашего ресторана`,
      adminBtn
    );
  } else {
    const expires   = rest.subscription_expires_at ? new Date(rest.subscription_expires_at) : null;
    const daysLeft  = expires ? Math.max(0, Math.ceil((expires - Date.now()) / 86400000)) : 0;
    const isTrial   = rest.subscription_status === 'trial';
    const isActive  = (isTrial || rest.subscription_status === 'active') && daysLeft > 0;

    const badge = isTrial
      ? `⏳ Пробный период — осталось *${daysLeft} дн.*`
      : isActive
        ? `✅ Подписка активна — до ${expires?.toLocaleDateString('ru-RU')}`
        : `⛔ Подписка истекла`;

    await ctx.replyWithMarkdown(
      `🏪 *${rest.name}*\n\n${badge}\n\n👇 Открой панель управления:`,
      adminBtn
    );
  }
});

// ─── 🎫 QR для визита ─────────────────────────────────────────────────────────
bot.hears('🎫 Получить QR для визита', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const token = uuidv4();

  const { error } = await supabase.from('pending_visits').insert({ token, telegram_id: telegramId });
  if (error) return ctx.reply('Не удалось создать QR, попробуй ещё раз.');

  const visitUrl   = `${APP_URL}/restaurant.html?token=${token}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(visitUrl)}&ecc=H&margin=1`;

  await ctx.replyWithPhoto(qrImageUrl, {
    caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код сотруднику ресторана.\n_Код действителен для одного визита._`,
    parse_mode: 'Markdown',
  });
});

// ─── ⭐ Мой статус ────────────────────────────────────────────────────────────
bot.hears('⭐ Мой статус', async (ctx) => {
  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', String(ctx.from.id))
    .single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Статус, ${guest.first_name}*\n\n${fmtStatus(guest.visit_count)}`);
});

// ─── 📋 История визитов ───────────────────────────────────────────────────────
bot.hears('📋 История визитов', async (ctx) => {
  const { data: visits } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', String(ctx.from.id))
    .order('visited_at', { ascending: false })
    .limit(10);
  if (!visits?.length)
    return ctx.replyWithMarkdown('📋 *История пустая*\n\nПолучи QR-код и посети ресторан-партнёр!');
  const lines = visits.map((v, i) =>
    `${i+1}. ${v.restaurants?.name || 'Ресторан-партнёр'} — ${new Date(v.visited_at).toLocaleDateString('ru-RU')}`
  );
  await ctx.replyWithMarkdown(`📋 *Последние визиты*\n\n${lines.join('\n')}`);
});

// ─── Vercel handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');
  try {
    await bot.handleUpdate(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('Bot webhook error:', err);
    res.status(200).end();
  }
};
