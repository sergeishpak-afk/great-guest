/**
 * api/bot.js — Telegram bot webhook (Vercel Serverless)
 * Webhook URL: https://great-guest.vercel.app/api/bot
 *
 * Handles dual-role users: guest + venue owner simultaneously.
 * 152-ФЗ: consent required before data collection.
 */

const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const bot      = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const APP_URL   = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');
const MINI_APP  = `${APP_URL}/app.html`;
const ADMIN_APP = `${APP_URL}/admin.html`;

const CONSENT_VERSION = '1.0';

// ─── Levels ──────────────────────────────────────────────────────────────────
const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', min: 1,  reward: 'Добро пожаловать в программу' },
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

function getLevel(n) {
  if (n === 0) return null; // No level at zero visits
  return [...LEVELS].reverse().find(l => n >= l.min) || LEVELS[0];
}
function getNext(n) { return LEVELS.find(l => l.min > n); }
function decl(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'а';
  return 'ов';
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '—';
}
function fmtStatus(count) {
  if (count === 0) {
    return `🎉 *Добро пожаловать!*\n_Получи QR-код и посети первый ресторан-партнёр — программа лояльности начнётся с первого визита._`;
  }
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

// ─── Consent keyboard ────────────────────────────────────────────────────────
const consentKb = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Принимаю условия', 'accept_consent')],
  [Markup.button.url('📄 Политика конфиденциальности', `${APP_URL}/privacy.html`)],
  [Markup.button.url('📋 Условия использования', `${APP_URL}/terms.html`)],
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
      { command: 'mydata',     description: '📊 Мои данные (152-ФЗ)' },
      { command: 'forget',     description: '🗑 Удалить мои данные' },
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

async function hasConsent(telegramId) {
  const { data } = await supabase
    .from('guests')
    .select('consent_at')
    .eq('telegram_id', telegramId)
    .single();
  return !!(data?.consent_at);
}

async function registerGuestWithConsent(u) {
  await supabase.from('guests').upsert(
    {
      telegram_id:      String(u.id),
      first_name:       u.first_name || '',
      last_name:        u.last_name  || '',
      username:         u.username   || '',
      consent_at:       new Date().toISOString(),
      consent_version:  CONSENT_VERSION,
    },
    { onConflict: 'telegram_id' }
  );
}

// ─── Renewal alert helper ────────────────────────────────────────────────────
async function checkAndSendRenewalAlert(telegramId, ownerSub) {
  if (!ownerSub) return;
  const expires = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  if (!expires) return;
  const daysLeft = Math.ceil((expires - Date.now()) / 86400000);
  // Alert at 7 days and 3 days
  if (daysLeft === 7 || daysLeft === 3) {
    try {
      const plan = PLANS[ownerSub.plan] || PLANS.trial;
      await bot.telegram.sendMessage(
        telegramId,
        `⚠️ *Подписка заканчивается через ${daysLeft} дн.*\n\n${plan.emoji} Тариф: ${plan.label}\nДата истечения: ${fmtDate(ownerSub.subscription_expires_at)}\n\nПродлите подписку, чтобы не потерять доступ к панели управления и базе гостей.`,
        { parse_mode: 'Markdown' }
      );
    } catch { /* non-critical — user may have blocked the bot */ }
  }
}

// ─── CONSENT REQUEST ─────────────────────────────────────────────────────────
async function sendConsentRequest(ctx) {
  await ctx.replyWithMarkdown(
    `👋 Привет, *${ctx.from.first_name}*!\n\nДобро пожаловать в *Great Guest* — единую программу лояльности для ресторанов.\n\n` +
    `Перед использованием сервиса нам необходимо ваше согласие на обработку персональных данных (Telegram ID, имя, история визитов) в соответствии с:\n` +
    `• Федеральным законом № 152-ФЗ «О персональных данных»\n` +
    `• Нашей [Политикой конфиденциальности](${APP_URL}/privacy.html)\n` +
    `• [Условиями использования](${APP_URL}/terms.html)\n\n` +
    `_Нажмите «Принимаю условия» для продолжения._`,
    consentKb
  );
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  ensureCommands();
  const u = ctx.from;

  // Check consent first — 152-ФЗ: must have consent before collecting data
  const consentGiven = await hasConsent(String(u.id));
  if (!consentGiven) {
    return sendConsentRequest(ctx);
  }

  // Already consented — update profile (name may have changed) and show welcome
  await registerGuestWithConsent(u);

  const ownerSub = await getOwnerSub(String(u.id));

  if (!ownerSub) {
    await ctx.replyWithMarkdown(
      `👋 Привет, *${u.first_name}*!\n\nДобро пожаловать в *Great Guest* — единую программу лояльности для ресторанов.\n\nКаждый визит в ресторан-партнёр повышает ваш статус:\n🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Platinum\n\nС каждым уровнем — больше привилегий во всех ресторанах сети.`,
      guestKb
    );
    await ctx.reply('👇 Открой приложение:', guestBtn);
  } else {
    const venueCount = await getVenueCount(String(u.id));
    const statusLine = ownerStatusLine(ownerSub);
    const plan       = PLANS[ownerSub.plan] || PLANS.trial;

    await checkAndSendRenewalAlert(String(u.id), ownerSub);

    await ctx.replyWithMarkdown(
      `👋 Привет, *${u.first_name}*!\n\nТы в *Great Guest* в двух ролях сразу:`,
      guestKb
    );
    await ctx.replyWithMarkdown(
      `🎁 *Гость программы лояльности*\n\nСтатус обновляется с каждым визитом к партнёрам сети. Получи QR → покажи в ресторане.`,
      guestBtn
    );
    await ctx.replyWithMarkdown(
      `🏪 *Партнёр Great Guest*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nЗаведений: ${venueCount} из ${ownerSub.max_venues}`,
      adminBtn
    );
  }
});

// ─── Consent callback ─────────────────────────────────────────────────────────
bot.action('accept_consent', async (ctx) => {
  const u = ctx.from;

  // Register with consent
  await registerGuestWithConsent(u);

  // Acknowledge consent acceptance
  await ctx.editMessageText(
    `✅ Спасибо! Согласие получено и зафиксировано.\n\n_Вы можете в любой момент отозвать согласие командой /forget_`,
    { parse_mode: 'Markdown' }
  );

  const ownerSub = await getOwnerSub(String(u.id));

  if (!ownerSub) {
    await ctx.replyWithMarkdown(
      `👋 Добро пожаловать в *Great Guest*, ${u.first_name}!\n\nКаждый визит в ресторан-партнёр повышает ваш статус:\n🥉 Bronze → 🥈 Silver → 🥇 Gold → 💎 Platinum\n\nС каждым уровнем — больше привилегий во всех ресторанах сети.`,
      guestKb
    );
    await ctx.reply('👇 Открой приложение:', guestBtn);
  } else {
    const venueCount = await getVenueCount(String(u.id));
    const statusLine = ownerStatusLine(ownerSub);
    const plan       = PLANS[ownerSub.plan] || PLANS.trial;

    await ctx.replyWithMarkdown(
      `👋 *${u.first_name}*, ты в *Great Guest* в двух ролях сразу:`,
      guestKb
    );
    await ctx.replyWithMarkdown(
      `🎁 *Гость программы лояльности*\n\nСтатус обновляется с каждым визитом. Получи QR → покажи в ресторане.`,
      guestBtn
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

  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const token   = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 60 min TTL
  const { error } = await supabase.from('pending_visits').insert({
    token,
    telegram_id: telegramId,
    expires_at: expiresAt,
  });
  if (error) return ctx.reply('Не удалось создать QR, попробуй ещё раз.');

  const visitUrl   = `${APP_URL}/restaurant.html?token=${token}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(visitUrl)}&ecc=H&margin=1`;

  await ctx.replyWithPhoto(qrImageUrl, {
    caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код сотруднику ресторана.\n_Код действителен 60 минут, только для одного визита._`,
    parse_mode: 'Markdown',
  });
});

// ─── /status ─────────────────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', telegramId)
    .single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Статус, ${guest.first_name}*\n\n${fmtStatus(guest.visit_count)}`);
});

// ─── /history ────────────────────────────────────────────────────────────────
bot.command('history', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const { data: visits } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', telegramId)
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
      `🏪 *Стать партнёром Great Guest*\n\nПодключите ваш ресторан или мероприятие к единой сети лояльности.\n\n✅ *14 дней бесплатно*\n\n*Что вы получаете:*\n• Весь список гостей сети (Bronze / Silver / Gold / Platinum)\n• ИИ-предложения для каждого гостя за 1 клик\n• Аналитика и история визитов\n• Добавление ресторанов и мероприятий`,
      adminBtn
    );
    return;
  }

  await checkAndSendRenewalAlert(telegramId, ownerSub);

  const venueCount = await getVenueCount(telegramId);
  const statusLine = ownerStatusLine(ownerSub);
  const plan       = PLANS[ownerSub.plan] || PLANS.trial;

  await ctx.replyWithMarkdown(
    `🏪 *Панель партнёра*\n\n${plan.emoji} Тариф: *${plan.label}*\n${statusLine}\nЗаведений: *${venueCount}* из ${ownerSub.max_venues}\n\n👇 Открой панель управления:`,
    adminBtn
  );
});

// ─── /mydata — Право на доступ к данным (152-ФЗ, ст. 14) ────────────────────
bot.command('mydata', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const { data: guest } = await supabase
    .from('guests')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (!guest) {
    return ctx.replyWithMarkdown(`ℹ️ *Данные не найдены*\n\nВы ещё не зарегистрированы в Great Guest. Нажмите /start.`);
  }

  const { count: visitCount } = await supabase
    .from('visits')
    .select('*', { count: 'exact', head: true })
    .eq('telegram_id', telegramId);

  const consentDate = guest.consent_at
    ? new Date(guest.consent_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'не зафиксировано';

  await ctx.replyWithMarkdown(
    `📊 *Ваши данные в Great Guest*\n\n` +
    `• **ID:** \`${guest.telegram_id}\`\n` +
    `• **Имя:** ${guest.first_name} ${guest.last_name || ''}`.trim() + `\n` +
    `• **Username:** @${guest.username || '—'}\n` +
    `• **Визитов:** ${guest.visit_count || 0} (${visitCount || 0} в истории)\n` +
    `• **Дата согласия:** ${consentDate}\n` +
    `• **Версия согласия:** ${guest.consent_version || '—'}\n\n` +
    `_Чтобы удалить все данные, используйте /forget_\n` +
    `_По вопросам: privacy@great-guest.ru_`
  );
});

// ─── /forget — Право на удаление (152-ФЗ, ст. 21) ──────────────────────────
bot.command('forget', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const { data: guest } = await supabase
    .from('guests')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .single();

  if (!guest) {
    return ctx.reply('Данные не найдены. Вы уже удалены или никогда не регистрировались.');
  }

  // Ask for confirmation
  await ctx.replyWithMarkdown(
    `🗑 *Удаление данных*\n\n` +
    `Вы запросили удаление всех ваших данных из Great Guest:\n` +
    `• Профиль гостя (имя, Telegram ID)\n` +
    `• История визитов\n` +
    `• Полученные предложения\n\n` +
    `⚠️ Это действие необратимо. Статус и история визитов будут удалены безвозвратно.\n\n` +
    `Нажмите кнопку для подтверждения:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑 Да, удалить все мои данные', `confirm_forget_${telegramId}`)],
      [Markup.button.callback('↩️ Отмена', 'cancel_forget')],
    ])
  );
});

bot.action('cancel_forget', async (ctx) => {
  await ctx.editMessageText('↩️ Удаление отменено. Ваши данные сохранены.');
});

bot.action(/^confirm_forget_(.+)$/, async (ctx) => {
  const telegramId = ctx.match[1];

  // Verify it's the same user
  if (String(ctx.from.id) !== telegramId) {
    return ctx.answerCbQuery('Ошибка подтверждения.');
  }

  try {
    // Anonymize instead of hard delete (keep visit records for analytics, anonymize PII)
    await supabase.from('pending_visits').delete().eq('telegram_id', telegramId);
    await supabase.from('visits').update({ telegram_id: `deleted_${telegramId}` }).eq('telegram_id', telegramId);
    await supabase.from('guests').delete().eq('telegram_id', telegramId);

    await ctx.editMessageText(
      `✅ *Данные удалены*\n\nВсе ваши персональные данные удалены из Great Guest в соответствии с требованиями 152-ФЗ.\n\n` +
      `Анонимная история визитов хранится в обезличенном виде для статистики.\n\n` +
      `Вы можете зарегистрироваться снова в любой момент командой /start.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('forget error:', e);
    await ctx.editMessageText('Произошла ошибка при удалении. Обратитесь на privacy@great-guest.ru');
  }
});

// ─── Keyboard handlers ────────────────────────────────────────────────────────
bot.hears('🎫 Получить QR для визита', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('pending_visits').insert({ token, telegram_id: telegramId, expires_at: expiresAt });
  if (error) return ctx.reply('Не удалось создать QR, попробуй ещё раз.');

  const visitUrl   = `${APP_URL}/restaurant.html?token=${token}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(visitUrl)}&ecc=H&margin=1`;

  await ctx.replyWithPhoto(qrImageUrl, {
    caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код сотруднику ресторана.\n_Код действителен 60 минут, только для одного визита._`,
    parse_mode: 'Markdown',
  });
});

bot.hears('⭐ Мой статус', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', telegramId)
    .single();
  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Статус, ${guest.first_name}*\n\n${fmtStatus(guest.visit_count)}`);
});

bot.hears('📋 История визитов', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  const { data: visits } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', telegramId)
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
