/**
 * api/bot.js — Telegram bot webhook (Vercel Serverless)
 * Webhook URL: https://great-guest.vercel.app/api/bot
 *
 * Handles dual-role users: guest + venue owner simultaneously.
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
const PLANS = {
  trial:   { label: 'Старт (пробный)',  emoji: '🆓' },
  basic:   { label: 'Базовый',          emoji: '🔑' },
  network: { label: 'Сеть',             emoji: '🏢' },
  empire:  { label: 'Империя',          emoji: '👑' },
};

function getLevel(n) { return [...LEVELS].reverse().find(l => n >= l.min) || LEVELS[0]; }
function getNext(n)  { return LEVELS.find(l => l.min > n); }
function decl(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'а';
  return 'ов';
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '—';
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
const guestKb = Markup.keyboard([
  ['🎫 Получить QR для визита'],
  ['⭐ Мой статус', '📋 История визитов'],
]).resize();

const guestBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('🎁 Моя программа лояльности', MINI_APP),
]]);

const adminBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('🏪 Панель управления', ADMIN_APP),
]]);

const bothBtn = Markup.inlineKeyboard([
  [Markup.button.webApp('🎁 Моя программа лояльности', MINI_APP)],
  [Markup.button.webApp('🏪 Панель управления сетью', ADMIN_APP)],
]);

// ─── Set bot commands once per cold start ────────────────────────────────────
let commandsSet = false;
async function ensureCommands() {
  if (commandsSet) return;
  commandsSet = true;
  try {
    await bot.telegram.setMyCommands([
      { command: 'start',      description: '👋 Начать / Мой профиль гостя' },
      { command: 'qr',         description: '🎫 Получить QR-код для визита' },
      { command: 'status',     description: '⭐ Мой статус в программе' },
      { command: 'history',    description: '📋 История моих визитов' },
      { command: 'restaurant', description: '🏪 Открыть панель партнёра' },
    ]);
  } catch { /* non-critical */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function getOwnerSub(telegramId) {
  const { data } = await supabase
    .from('owner_subscriptions')
    .select('plan, subscription_status, subscription_expires_at, max_venues')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

async function getVenueCount(telegramId) {
  const { count } = await supabase
    .from('restaurants')
    .select('*', { count: 'exact', head: true })
    .eq('owner_telegram_id', telegramId);
  return count || 0;
}

function ownerStatusLine(ownerSub) {
  const expires  = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - Date.now()) / 86400000)) : 0;
  const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && daysLeft > 0;
  const plan     = PLANS[ownerSub.plan] || PLANS.trial;

  if (ownerSub.subscription_status === 'trial' && isActive) {
    return `⏳ Пробный период — осталось *${daysLeft} дн.*`;
  } else if (isActive) {
    return `✅ ${plan.emoji} ${plan.label} — до ${fmtDate(ownerSub.subscription_expires_at)}`;
  } else {
    return `⛔ Подписка истекла — оформите тариф`;
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  ensureCommands();
  const u = ctx.from;

  // Register as guest
  await supabase.from('guests').upsert(
    {
      telegram_id: String(u.id),
      first_name:  u.first_name || '',
      last_name:   u.last_name  || '',
      username:    u.username   || '',
    },
    { onConflict: 'telegram_id' }
  );

  // Check if also an owner
  const ownerSub = await getOwnerSub(String(u.id));

  if (!ownerSub) {
    // Pure guest — standard welcome
    await ctx.replyWithMarkdown(
      `👋 Привет, *${u.first_name}*!\n\nДобро пожаловать в *Great Guest* — единую программу лояльности для ресторанов.\n\nКаждый визит в ресторан-партнёр повышает ваш статус:\n🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Platinum\n\nС каждым уровнем — больше привилегий во всех ресторанах сети.`,
      guestKb
    );
    await ctx.reply('👇 Открой приложение:', guestBtn);
  } else {
    // Dual-role: guest + owner
    const venueCount = await getVenueCount(String(u.id));
    const statusLine = ownerStatusLine(ownerSub);
    const plan       = PLANS[ownerSub.plan] || PLANS.trial;

    await ctx.replyWithMarkdown(
      `👋 Привет, *${u.first_name}*!\n\nТы в *Great Guest* в двух ролях сразу:`,
      guestKb
    );

    await ctx.replyWithMarkdown(
      `🎁 *Гость программы лояльности*\n\nСтатус обновляется с каждым визитом к партнёрам сети. Получи QR → покажи в ресторане.`
    );

    await ctx.replyWithMarkdown(
      `🏪 *Партнёр Great Guest*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nЗаведений: ${venueCount} из ${ownerSub.max_venues}`,
      adminBtn
    );
  }
});

// ─── /qr — QR-код гостя ──────────────────────────────────────────────────────
bot.command('qr', async (ctx) => {
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

// ─── /status ─────────────────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', String(ctx.from.id))
    .single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Статус, ${guest.first_name}*\n\n${fmtStatus(guest.visit_count)}`);
});

// ─── /history ────────────────────────────────────────────────────────────────
bot.command('history', async (ctx) => {
  const { data: visits } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', String(ctx.from.id))
    .order('visited_at', { ascending: false })
    .limit(10);
  if (!visits?.length)
    return ctx.replyWithMarkdown('📋 *История пустая*\n\nПолучи QR-код и посети ресторан-партнёр!');
  const lines = visits.map((v, i) =>
    `${i + 1}. ${v.restaurants?.name || 'Ресторан-партнёр'} — ${new Date(v.visited_at).toLocaleDateString('ru-RU')}`
  );
  await ctx.replyWithMarkdown(`📋 *Последние визиты*\n\n${lines.join('\n')}`);
});

// ─── /restaurant — панель партнёра ───────────────────────────────────────────
bot.command('restaurant', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const ownerSub   = await getOwnerSub(telegramId);

  if (!ownerSub) {
    await ctx.replyWithMarkdown(
      `🏪 *Стать партнёром Great Guest*\n\nПодключите ваш ресторан или мероприятие к единой сети лояльности.\n\n✅ *14 дней бесплатно*\n\n*Что вы получаете:*\n• Весь список гостей сети (Bronze / Silver / Gold / Platinum)\n• AI-предложения для каждого гостя за 1 клик\n• Аналитика и история визитов\n• Добавление ресторанов и мероприятий`,
      adminBtn
    );
    return;
  }

  const venueCount = await getVenueCount(telegramId);
  const statusLine = ownerStatusLine(ownerSub);
  const plan       = PLANS[ownerSub.plan] || PLANS.trial;

  await ctx.replyWithMarkdown(
    `🏪 *Панель партнёра*\n\n${plan.emoji} Тариф: *${plan.label}*\n${statusLine}\nЗаведений: *${venueCount}* из ${ownerSub.max_venues}\n\n👇 Открой панель управления:`,
    adminBtn
  );
});

// ─── Keyboard handlers ────────────────────────────────────────────────────────
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

bot.hears('⭐ Мой статус', async (ctx) => {
  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', String(ctx.from.id))
    .single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Статус, ${guest.first_name}*\n\n${fmtStatus(guest.visit_count)}`);
});

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
    `${i + 1}. ${v.restaurants?.name || 'Ресторан-партнёр'} — ${new Date(v.visited_at).toLocaleDateString('ru-RU')}`
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
