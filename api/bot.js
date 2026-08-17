/**
 * api/bot.js — Telegram bot webhook (Vercel Serverless)
 * Webhook URL: https://great-guest.ru/api/bot
 *
 * Handles dual-role users: guest + venue owner simultaneously.
 * 152-ФЗ: consent required before data collection.
 */

const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const bot      = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const APP_URL   = (process.env.APP_URL || 'https://great-guest.ru').replace(/\/$/, '');
const MINI_APP  = `${APP_URL}/app.html`;
const ADMIN_APP = `${APP_URL}/admin.html?v=20260624`;

const CONSENT_VERSION = '1.0';

// ─── Levels (canonical source: src/status.js) ────────────────────────────────
const { getEffectiveStatus, getNextLevel } = require('../src/status');
const PLANS = {
  trial:   { label: 'Старт (пробный)',  emoji: '🆓' },
  basic:   { label: 'Базовый',          emoji: '🔑' },
  network: { label: 'Сеть',             emoji: '🏢' },
  empire:  { label: 'Империя',          emoji: '👑' },
};

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
    return `🎉 *Добро пожаловать!*\n_Получи QR-код и зарегистрируй первое посещение — твой статус гостя начнётся с первого визита._`;
  }
  const lvl  = getEffectiveStatus(count);
  const next = getNextLevel(count);
  let s = `${lvl.emoji} *${lvl.name}* — ${count} визит${decl(count)}\n_${lvl.reward}_`;
  if (next) s += `\n\nДо *${next.name}*: ещё ${next.minVisits - count} визит${decl(next.minVisits - count)}`;
  else      s += '\n\n🏆 Максимальный статус достигнут!';
  return s;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const guestKb = Markup.keyboard([
  ['🎫 Получить QR для визита'],
  ['⭐ Мой статус', '📋 История визитов'],
]).resize();

const guestBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('⭐ Мой статус гостя', MINI_APP),
]]);

const adminBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('🗂 Панель управления', ADMIN_APP),
]]);

const ownerKb = Markup.keyboard([
  ['🗂 Панель управления'],
  ['🎫 Получить QR для визита', '⭐ Мой статус'],
  ['📋 История визитов'],
]).resize();

const createClubBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('🚀 Создать клуб / мероприятие', ADMIN_APP),
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
      { command: 'start',      description: '👋 Главное меню' },
      { command: 'qr',         description: '🎫 Мой QR-код для входа на событие' },
      { command: 'status',     description: '⭐ Мой статус гостя' },
      { command: 'history',    description: '📋 История посещений' },
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
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '💳 Продлить подписку', web_app: { url: `${APP_URL}/payment.html` } },
          ]]},
        }
      );
    } catch { /* non-critical — user may have blocked the bot */ }
  }
}

// ─── CONSENT REQUEST ─────────────────────────────────────────────────────────
async function sendConsentRequest(ctx) {
  await ctx.replyWithMarkdown(
    `👋 Привет, *${ctx.from.first_name}*!\n\n` +
    `Добро пожаловать в *Great Guest* — платформу для закрытых клубов и мероприятий.\n\n` +
    `Создавайте события, управляйте гостями, сканируйте QR на входе и рассылайте приглашения.\n\n` +
    `Перед использованием необходимо согласие на обработку персональных данных (Telegram ID, имя) в соответствии с:\n` +
    `• ФЗ № 152-ФЗ «О персональных данных»\n` +
    `• [Политикой конфиденциальности](${APP_URL}/privacy.html)\n` +
    `• [Условиями использования](${APP_URL}/terms.html)\n\n` +
    `_Нажмите «Принимаю» — и сразу создадим ваш первый клуб или мероприятие._`,
    consentKb
  );
}

// ─── Venue entry: handle QR scan + consent + checkin ─────────────────────────
async function recordVenueCheckin(ctx, venue) {
  const u = ctx.from;
  const telegramId = String(u.id);

  await registerGuestWithConsent(u); // upsert ensures guest row exists

  const { data: newCount, error: rpcErr } = await supabase
    .rpc('increment_guest_visits', { p_telegram_id: telegramId });

  if (rpcErr) {
    console.error('checkin rpc error:', rpcErr.message);
    return ctx.replyWithMarkdown(`✅ *Вход подтверждён!*\n\n📍 ${venue.name}\n\nДобро пожаловать!`, guestKb);
  }

  await supabase.from('visits').insert({
    telegram_id: telegramId,
    restaurant_id: venue.id,
    visit_token: uuidv4(),
  });

  // Persist guest into organizer's permanent contact base
  if (venue.owner_telegram_id) {
    supabase.rpc('upsert_organizer_contact', {
      p_org: venue.owner_telegram_id, p_guest: telegramId,
      p_first: u.first_name || '', p_last: u.last_name || '',
      p_user: u.username || '', p_rsvp: false,
    }).then().catch(() => {});
  }

  const lvl  = getEffectiveStatus(newCount);
  const next = getNextLevel(newCount);
  const lvlLine = lvl
    ? `${lvl.emoji} *${lvl.name}* — ${newCount} визит${decl(newCount)}\n_${lvl.reward}_`
    : `🥉 Первый визит — начало пути!`;
  const nextLine = next ? `\nДо *${next.name}*: ещё ${next.minVisits - newCount} визит${decl(next.minVisits - newCount)}` : '';

  await ctx.replyWithMarkdown(
    `✅ *Чек-ин подтверждён!*\n\n📍 ${esc(venue.name)}\n\n${lvlLine}${nextLine}`,
    guestKb
  );
}

function esc(s) { return String(s || '').replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&'); }

async function handleVenueEntry(ctx, venueId) {
  const u = ctx.from;
  const { data: venue } = await supabase
    .from('restaurants')
    .select('id, name, venue_type, event_type, owner_telegram_id')
    .eq('id', venueId)
    .single();

  if (!venue) return ctx.reply('QR-код недействителен или мероприятие не найдено.');

  const label = venue.venue_type === 'event' ? (venue.event_type || 'Мероприятие') : 'Ресторан';

  if (!(await hasConsent(String(u.id)))) {
    return ctx.replyWithMarkdown(
      `👋 Привет, *${u.first_name}*!\n\n` +
      `Вы сканируете вход на *${venue.name}* (${label}).\n\n` +
      `Для чек-ина необходимо ваше согласие на обработку персональных данных (Telegram ID, имя, история визитов) согласно ФЗ-152.\n\n` +
      `_Нажмите кнопку — и вы сразу попадёте в список участников._`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Принимаю и отмечаюсь на входе', `accept_consent_v_${venueId}`)],
        [Markup.button.url('📄 Политика конфиденциальности', `${APP_URL}/privacy.html`)],
        [Markup.button.url('📋 Условия использования', `${APP_URL}/terms.html`)],
      ])
    );
  }

  await recordVenueCheckin(ctx, venue);
}

// ─── RSVP: invite link confirmation ──────────────────────────────────────────
async function recordRsvp(ctx, venue) {
  const u = ctx.from;
  const telegramId = String(u.id);

  await registerGuestWithConsent(u);

  await supabase.from('rsvp').upsert(
    {
      venue_id:    venue.id,
      telegram_id: telegramId,
      first_name:  u.first_name || '',
      last_name:   u.last_name  || '',
      username:    u.username   || '',
    },
    { onConflict: 'venue_id,telegram_id' }
  );

  // Persist guest into organizer's permanent contact base
  if (venue.owner_telegram_id) {
    supabase.rpc('upsert_organizer_contact', {
      p_org: venue.owner_telegram_id, p_guest: telegramId,
      p_first: u.first_name || '', p_last: u.last_name || '',
      p_user: u.username || '', p_rsvp: true,
    }).then().catch(() => {});

    // Notify venue owner about new RSVP
    const guestName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Гость';
    const guestLabel = guestName + (u.username ? ` (@${u.username})` : '') + ` [${telegramId}]`;
    bot.telegram.sendMessage(
      venue.owner_telegram_id,
      `🔔 *Новая заявка на участие*\n\n📍 ${esc(venue.name)}\n👤 ${esc(guestLabel)}\n\nОткройте панель → Гостевой список для одобрения.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  const dateStr = venue.event_date
    ? `📅 ${fmtDate(venue.event_date)}\n`
    : '';
  const locStr = venue.address
    ? `📍 ${esc(venue.address)}${venue.city ? ', ' + esc(venue.city) : ''}\n`
    : venue.city
    ? `📍 ${esc(venue.city)}\n`
    : '';

  await ctx.replyWithMarkdown(
    `✅ *Участие подтверждено!*\n\n` +
    `🎉 *${esc(venue.name)}*\n` +
    `${dateStr}${locStr}\n` +
    `Сохраните этот чат — на входе покажите QR организатору для регистрации прихода.\n\n` +
    `_Чтобы открыть QR: нажмите «🎫 Получить QR для визита»_`,
    guestKb
  );
}

async function handleRsvp(ctx, venueId) {
  const u = ctx.from;
  const { data: venue } = await supabase
    .from('restaurants')
    .select('id, name, venue_type, event_type, event_date, address, city, owner_telegram_id')
    .eq('id', venueId)
    .single();

  if (!venue) return ctx.reply('Ссылка недействительна или мероприятие не найдено.');

  if (!(await hasConsent(String(u.id)))) {
    const dateStr = venue.event_date ? ` (${fmtDate(venue.event_date)})` : '';
    return ctx.replyWithMarkdown(
      `👋 Привет, *${esc(u.first_name)}*!\n\n` +
      `Вы подтверждаете участие в *${esc(venue.name)}*${dateStr}.\n\n` +
      `Для регистрации необходимо ваше согласие на обработку персональных данных согласно ФЗ-152.\n\n` +
      `_Нажмите — и вы сразу попадёте в список гостей._`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Принимаю и подтверждаю участие', `accept_consent_r_${venueId}`)],
        [Markup.button.url('📄 Политика конфиденциальности', `${APP_URL}/privacy.html`)],
      ])
    );
  }

  await recordRsvp(ctx, venue);
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  ensureCommands();
  const u = ctx.from;

  // Venue entry via QR scan: ?start=v_UUID
  const payload = ctx.startPayload || '';
  if (payload.startsWith('v_')) {
    const venueId = payload.slice(2);
    return handleVenueEntry(ctx, venueId);
  }

  // RSVP confirmation via invite link: ?start=rsvp_UUID
  if (payload.startsWith('rsvp_')) {
    const venueId = payload.slice(5);
    return handleRsvp(ctx, venueId);
  }

  // QR-код для входа с инвайт-страницы: ?start=qr_UUID
  if (payload.startsWith('qr_')) {
    const venueId = payload.slice(3);
    return handleQrRequest(ctx, venueId);
  }

  // Referral invite: ?start=ref_REFERRERID
  if (payload.startsWith('ref_')) {
    const referrerId = payload.slice(4);
    if (referrerId === String(u.id)) {
      // Can't refer yourself
    } else {
      const consentOk = await hasConsent(String(u.id));
      if (!consentOk) {
        return ctx.replyWithMarkdown(
          `👋 Привет, *${esc(u.first_name)}*!\n\n` +
          `Вас пригласили в *Great Guest* — платформу для закрытых клубов и мероприятий.\n\n` +
          `*14 дней бесплатно* — без карты, без обязательств.\n\n` +
          `Для начала нужно ваше согласие на обработку персональных данных (ФЗ-152).`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Принимаю условия', `accept_consent_ref_${referrerId}`)],
            [Markup.button.url('📄 Политика', `${APP_URL}/privacy.html`)],
          ])
        );
      }
      await registerGuestWithConsent(u);
      const adminWithRef = `${APP_URL}/admin.html?ref=${referrerId}`;
      await ctx.replyWithMarkdown(
        `👋 Привет, *${esc(u.first_name)}*!\n\n` +
        `Вас пригласили в *Great Guest*.\n\n` +
        `Создайте первый клуб или мероприятие — *14 дней бесплатно!*`
      );
      return ctx.reply('👇', Markup.inlineKeyboard([[Markup.button.webApp('🚀 Создать событие', adminWithRef)]]));
    }
  }

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
      `👋 Привет, *${esc(u.first_name)}*!\n\n` +
      `*Great Guest* — платформа для закрытых клубов и мероприятий.\n\n` +
      `Что вы получаете:\n` +
      `🎟 Страница события со ссылкой-приглашением\n` +
      `📷 QR-сканер для регистрации гостей на входе\n` +
      `👥 База гостей с уровнями и историей\n` +
      `📣 Рассылка приглашений по базе\n\n` +
      `*14 дней бесплатно* — без карты, без обязательств.`
    );
    await ctx.reply('👇 Создайте первое событие прямо сейчас:', createClubBtn);
  } else {
    const venueCount = await getVenueCount(String(u.id));
    const statusLine = ownerStatusLine(ownerSub);
    const plan       = PLANS[ownerSub.plan] || PLANS.trial;

    await checkAndSendRenewalAlert(String(u.id), ownerSub);

    const expires  = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
    const daysLeft = expires ? Math.max(0, Math.ceil((expires - Date.now()) / 86400000)) : 0;
    const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && daysLeft > 0;

    await ctx.replyWithMarkdown(
      `👋 Привет, *${esc(u.first_name)}*!\n\n*Great Guest* — ваши события и гости под рукой.`,
      ownerKb
    );

    if (isActive) {
      await ctx.replyWithMarkdown(
        `🗂 *Панель организатора*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nСобытий: ${venueCount} из ${ownerSub.max_venues}`,
        adminBtn
      );
    } else {
      await ctx.replyWithMarkdown(
        `🗂 *Панель организатора*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nСобытий: ${venueCount} из ${ownerSub.max_venues}\n\n⛔ *Доступ заблокирован.* Оформите подписку для продолжения работы.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '💳 Оформить подписку', web_app: { url: `${APP_URL}/payment.html` } }],
          [{ text: '⚙️ Открыть панель', web_app: { url: ADMIN_APP } }],
        ]}}
      );
    }
  }
});

// ─── Consent callback ─────────────────────────────────────────────────────────
// ─── Consent + referral ──────────────────────────────────────────────────────
bot.action(/^accept_consent_ref_(.+)$/, async (ctx) => {
  const referrerId = ctx.match[1];
  const u = ctx.from;
  await registerGuestWithConsent(u);
  await ctx.editMessageText('✅ Согласие получено! Добро пожаловать в Great Guest.', { parse_mode: 'Markdown' });
  const adminWithRef = `${APP_URL}/admin.html?ref=${referrerId}`;
  await ctx.replyWithMarkdown(
    `✨ *14 дней бесплатно!*\n\nСоздайте первый клуб или мероприятие — ваш коллега уже внутри.`
  );
  await ctx.reply('👇', Markup.inlineKeyboard([[Markup.button.webApp('🚀 Создать событие', adminWithRef)]]));
});

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
      `✨ *Добро пожаловать, ${esc(u.first_name)}!*\n\n` +
      `Создайте свой первый клуб или мероприятие — *бесплатно на 14 дней*.\n\n` +
      `Что доступно сразу:\n` +
      `🎟 Страница события со ссылкой для гостей\n` +
      `📷 QR-сканер для регистрации на входе\n` +
      `👥 База гостей с уровнями и историей\n` +
      `📣 Рассылка приглашений по базе`
    );
    await ctx.reply('👇 Нажмите — откроется панель создания:', createClubBtn);
  } else {
    const venueCount = await getVenueCount(String(u.id));
    const statusLine = ownerStatusLine(ownerSub);
    const plan       = PLANS[ownerSub.plan] || PLANS.trial;
    const expires    = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
    const daysLeft   = expires ? Math.max(0, Math.ceil((expires - Date.now()) / 86400000)) : 0;
    const isActive   = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && daysLeft > 0;

    if (isActive) {
      await ctx.replyWithMarkdown(
        `🗂 *Ваша панель Great Guest*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nСобытий: ${venueCount} из ${ownerSub.max_venues}`,
        adminBtn
      );
    } else {
      await ctx.replyWithMarkdown(
        `🗂 *Ваша панель Great Guest*\n\n${plan.emoji} Тариф: ${plan.label}\n${statusLine}\nСобытий: ${venueCount} из ${ownerSub.max_venues}\n\n⛔ *Доступ заблокирован.* Оформите подписку для продолжения работы.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '💳 Оформить подписку', web_app: { url: `${APP_URL}/payment.html` } }],
          [{ text: '⚙️ Открыть панель', web_app: { url: ADMIN_APP } }],
        ]}}
      );
    }
  }
});

// ─── Consent + venue checkin (via QR scan) ───────────────────────────────────
bot.action(/^accept_consent_v_(.+)$/, async (ctx) => {
  const venueId = ctx.match[1];
  const u = ctx.from;

  await ctx.editMessageText(
    `✅ Согласие получено и зафиксировано.\n\n_Отзыв — командой /forget_`,
    { parse_mode: 'Markdown' }
  );

  const { data: venue } = await supabase
    .from('restaurants')
    .select('id, name, venue_type, event_type, owner_telegram_id')
    .eq('id', venueId)
    .single();

  if (!venue) return ctx.reply('Ошибка: мероприятие не найдено.');

  await recordVenueCheckin(ctx, venue);
});

// ─── Consent + RSVP (via invite link) ────────────────────────────────────────
bot.action(/^accept_consent_r_(.+)$/, async (ctx) => {
  const venueId = ctx.match[1];

  await ctx.editMessageText(
    `✅ Согласие получено и зафиксировано.\n\n_Отзыв — командой /forget_`,
    { parse_mode: 'Markdown' }
  );

  const { data: venue } = await supabase
    .from('restaurants')
    .select('id, name, venue_type, event_type, event_date, address, city, owner_telegram_id')
    .eq('id', venueId)
    .single();

  if (!venue) return ctx.reply('Ошибка: мероприятие не найдено.');
  await recordRsvp(ctx, venue);
});

// ─── QR-код для входа с инвайт-страницы ─────────────────────────────────────
const UUID_RE_BOT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sendQrForVenue(ctx, u, venueId) {
  const telegramId = String(u.id);
  await registerGuestWithConsent(u);

  const { data: venue } = await supabase
    .from('restaurants')
    .select('id, name, event_type, event_date, city')
    .eq('id', venueId)
    .single();

  if (!venue) return ctx.reply('Мероприятие не найдено — возможно, оно было удалено.');

  // Guestlist mode: if venue has any RSVP rows, treat it as invite-only
  const { count: rsvpCount } = await supabase
    .from('rsvp')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId);

  if (rsvpCount > 0) {
    const { data: rsvpRow } = await supabase
      .from('rsvp')
      .select('id, status')
      .eq('venue_id', venueId)
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (!rsvpRow) {
      return ctx.replyWithMarkdown(
        `⛔ *Вход только для приглашённых*\n\n` +
        `*${esc(venue.name)}* — закрытое мероприятие.\n` +
        `Вас нет в списке гостей.\n\n` +
        `Запросите персональную ссылку у организатора, перейдите по ней и подтвердите участие.\n\n` +
        `После того как организатор *одобрит* вашу заявку — QR-код станет доступен.`
      );
    }

    if (rsvpRow.status !== 'approved') {
      return ctx.replyWithMarkdown(
        `⏳ *Заявка на рассмотрении*\n\n` +
        `Вы подали заявку на *${esc(venue.name)}*.\n\n` +
        `QR-код будет доступен только после того, как организатор *одобрит* вашу заявку.\n` +
        `Вы получите уведомление в этот бот — просто ждите. 🙏`
      );
    }
  }

  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('pending_visits').insert({
    token, telegram_id: telegramId, expires_at: expiresAt, restaurant_id: venueId,
  });
  if (error) return ctx.reply('Не удалось создать QR-код. Попробуйте ещё раз.');

  const visitUrl   = `${APP_URL}/restaurant.html?token=${token}&v=${venueId}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(visitUrl)}&ecc=H&margin=1`;
  const label      = venue.event_date
    ? new Date(venue.event_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    : '';

  await ctx.replyWithPhoto(qrImageUrl, {
    caption: `🎫 *QR-код для входа*\n\n*${venue.name}*${label ? '\n📅 ' + label : ''}${venue.city ? '\n📍 ' + venue.city : ''}\n\n_Покажите этот код организатору на входе.\nКод действителен 60 минут._`,
    parse_mode: 'Markdown',
  });
}

async function handleQrRequest(ctx, venueId) {
  if (!UUID_RE_BOT.test(venueId)) return ctx.reply('Неверная ссылка.');
  const telegramId = String(ctx.from.id);

  if (!(await hasConsent(telegramId))) {
    return ctx.replyWithMarkdown(
      `📱 *QR-код для входа*\n\nЧтобы получить QR-код, нужно ваше согласие на обработку персональных данных (152-ФЗ).`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Принимаю и получить QR', `accept_consent_qr_${venueId}`)],
        [Markup.button.url('📄 Политика конфиденциальности', `${APP_URL}/privacy.html`)],
      ])
    );
  }
  await sendQrForVenue(ctx, ctx.from, venueId);
}

bot.action(/^accept_consent_qr_(.+)$/, async (ctx) => {
  const venueId = ctx.match[1];
  await registerGuestWithConsent(ctx.from);
  await ctx.editMessageText('✅ Согласие получено — генерируем QR-код…');
  await sendQrForVenue(ctx, ctx.from, venueId);
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

// ─── /admin — owner-only panel ───────────────────────────────────────────────
const ADMIN_ID = (process.env.ADMIN_TELEGRAM_ID || '').trim();
const isAdmin = (ctx) => String(ctx.from?.id) === ADMIN_ID;

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Нет доступа');

  const ownerSub = await getOwnerSub(String(ctx.from.id));
  const plan   = ownerSub?.plan || '—';
  const status = ownerSub?.subscription_status || '—';
  const exp    = ownerSub?.subscription_expires_at
    ? new Date(ownerSub.subscription_expires_at).toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' })
    : '—';

  await ctx.replyWithMarkdown(
    `👑 *Панель администратора*\n\n📋 Тариф: *${plan}*\n📊 Статус: *${status}*\n📅 До: *${exp}*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💎 Empire навсегда (себе)', 'adm_empire_self')],
      [Markup.button.callback('👤 Управление пользователем', 'adm_manage_user')],
    ])
  );
});

bot.action('adm_empire_self', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  await supabase.from('owner_subscriptions').upsert({
    telegram_id: String(ctx.from.id),
    plan: 'empire',
    max_venues: 999,
    subscription_status: 'active',
    subscription_expires_at: '2099-12-31T23:59:59+00:00',
  }, { onConflict: 'telegram_id' });
  await ctx.editMessageText('✅ *Empire до 2099 — установлен!* Перезапусти мини-апп.', { parse_mode: 'Markdown' });
});

bot.action('adm_manage_user', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  await ctx.reply('Введите ID пользователя:\n\n`/admin_user 123456789`', { parse_mode: 'Markdown' });
});

bot.command('admin_user', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Нет доступа');

  const targetId = (ctx.message.text || '').split(' ')[1];
  if (!targetId || !/^\d+$/.test(targetId)) return ctx.reply('Укажите ID: `/admin_user 123456789`', { parse_mode: 'Markdown' });

  const { data: sub } = await supabase.from('owner_subscriptions').select('*').eq('telegram_id', targetId).single();
  if (!sub) return ctx.reply(`❌ Пользователь *${targetId}* не найден в системе`, { parse_mode: 'Markdown' });

  const exp = sub.subscription_expires_at
    ? new Date(sub.subscription_expires_at).toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' })
    : '—';

  await ctx.replyWithMarkdown(
    `👤 *ID: ${targetId}*\n\n📋 Тариф: *${sub.plan}*\n📊 Статус: *${sub.subscription_status}*\n📅 До: *${exp}*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💎 Empire до 2099', `adm_empire_${targetId}`)],
      [Markup.button.callback('➕ +30 дней', `adm_add30_${targetId}`)],
      [Markup.button.callback('➕ +1 год', `adm_add365_${targetId}`)],
    ])
  );
});

bot.action(/^adm_empire_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  const tid = ctx.match[1];
  await supabase.from('owner_subscriptions').update({ plan:'empire', max_venues:999, subscription_status:'active', subscription_expires_at:'2099-12-31T23:59:59+00:00' }).eq('telegram_id', tid);
  await ctx.editMessageText(`✅ Empire до 2099 установлен для *${tid}*`, { parse_mode: 'Markdown' });
});

bot.action(/^adm_add30_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  const tid = ctx.match[1];
  const { data: s } = await supabase.from('owner_subscriptions').select('subscription_expires_at').eq('telegram_id', tid).single();
  const base = s?.subscription_expires_at ? Math.max(new Date(s.subscription_expires_at).getTime(), Date.now()) : Date.now();
  const newExp = new Date(base + 30 * 24 * 60 * 60 * 1000);
  await supabase.from('owner_subscriptions').update({ subscription_status:'active', subscription_expires_at: newExp.toISOString() }).eq('telegram_id', tid);
  await ctx.editMessageText(`✅ +30 дней для *${tid}*. До: *${newExp.toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'})}*`, { parse_mode: 'Markdown' });
});

bot.action(/^adm_add365_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  const tid = ctx.match[1];
  const { data: s } = await supabase.from('owner_subscriptions').select('subscription_expires_at').eq('telegram_id', tid).single();
  const base = s?.subscription_expires_at ? Math.max(new Date(s.subscription_expires_at).getTime(), Date.now()) : Date.now();
  const newExp = new Date(base + 365 * 24 * 60 * 60 * 1000);
  await supabase.from('owner_subscriptions').update({ subscription_status:'active', subscription_expires_at: newExp.toISOString() }).eq('telegram_id', tid);
  await ctx.editMessageText(`✅ +1 год для *${tid}*. До: *${newExp.toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'})}*`, { parse_mode: 'Markdown' });
});

// ─── Owner keyboard button ────────────────────────────────────────────────────
bot.hears('🗂 Панель управления', async (ctx) => {
  await ctx.reply('👇 Откройте панель:', adminBtn);
});

// ─── /restaurant — редирект на /start (команда устарела) ─────────────────────
bot.command('restaurant', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const ownerSub   = await getOwnerSub(telegramId);

  if (!ownerSub) {
    await ctx.replyWithMarkdown(
      `🚀 *Great Guest — платформа для клубов и мероприятий*\n\n✅ *14 дней бесплатно*\n\nЧто получаете:\n• Страница события со ссылкой-приглашением\n• QR-сканер для регистрации гостей на входе\n• База гостей с уровнями и историей\n• Рассылка приглашений`,
      createClubBtn
    );
    return;
  }

  await checkAndSendRenewalAlert(telegramId, ownerSub);

  const venueCount = await getVenueCount(telegramId);
  const statusLine = ownerStatusLine(ownerSub);
  const plan       = PLANS[ownerSub.plan] || PLANS.trial;

  await ctx.replyWithMarkdown(
    `🗂 *Панель Great Guest*\n\n${plan.emoji} Тариф: *${plan.label}*\n${statusLine}\nСобытий: *${venueCount}* из ${ownerSub.max_venues}`,
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
    `_По вопросам: shpak.organika@gmail.com_`
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
    await ctx.editMessageText('Произошла ошибка при удалении. Обратитесь на shpak.organika@gmail.com');
  }
});

// ─── /myid — гость узнаёт свой Telegram ID для передачи организатору ─────────
bot.command('myid', async (ctx) => {
  const telegramId = String(ctx.from.id);
  await ctx.replyWithMarkdown(
    `🪪 *Ваш Telegram ID*\n\n\`${telegramId}\`\n\n` +
    `_Передайте этот ID организатору — он сможет перенести историю ваших визитов на новый аккаунт._`
  );
});

// ─── /superadmin — владелец открывает панель управления ──────────────────────
bot.command('superadmin', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const ownerIds = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ownerIds.includes(telegramId)) return ctx.reply('Нет доступа.');
  await ctx.replyWithMarkdown(
    `🔐 *Super Admin Panel*\n\nВаш ID: \`${telegramId}\``,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '⚙️ Открыть панель', web_app: { url: `${APP_URL}/superadmin.html` } }
        ]]
      }
    }
  );
});

// ─── /recover — восстановление аккаунта по номеру телефона ───────────────────
bot.command('recover', async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (!(await hasConsent(telegramId))) return sendConsentRequest(ctx);

  await ctx.replyWithMarkdown(
    `🔄 *Восстановление аккаунта*\n\n` +
    `Если у вас был другой аккаунт Telegram, поделитесь номером телефона — ` +
    `мы найдём ваш старый профиль и перенесём историю визитов.`,
    Markup.keyboard([[Markup.button.contactRequest('📱 Поделиться номером')], ['⏭ Пропустить']])
      .resize().oneTime()
  );
});

// ─── Contact handler — обработка номера телефона ──────────────────────────────
bot.on('contact', async (ctx) => {
  // Telegram only allows sharing own contact via keyboard button
  if (ctx.message.contact.user_id !== ctx.from.id) return;

  const telegramId = String(ctx.from.id);
  const rawPhone = ctx.message.contact.phone_number || '';
  const phone = rawPhone.replace(/\D/g, ''); // normalize: digits only
  if (!phone) return ctx.reply('Не удалось получить номер телефона.');

  // Remove reply keyboard
  await ctx.reply('📱 Проверяю номер…', Markup.removeKeyboard());

  // Check if this phone belongs to a DIFFERENT account
  const { data: existing } = await supabase
    .from('guests')
    .select('telegram_id, first_name, last_name, visit_count')
    .eq('phone', phone)
    .neq('telegram_id', telegramId)
    .maybeSingle();

  if (existing) {
    const name = [existing.first_name, existing.last_name].filter(Boolean).join(' ') || 'Гость';
    await ctx.replyWithMarkdown(
      `🔍 *Найден аккаунт с этим номером*\n\n` +
      `👤 ${esc(name)} — ${existing.visit_count || 0} визит${decl(existing.visit_count || 0)}\n\n` +
      `Перенести историю визитов на ваш текущий аккаунт?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, перенести историю', `confirm_merge_${existing.telegram_id}_to_${telegramId}`)],
        [Markup.button.callback('❌ Нет, оставить так', 'skip_merge')],
      ])
    );
  } else {
    // Save phone to current account
    await supabase.from('guests').update({ phone }).eq('telegram_id', telegramId);
    await ctx.replyWithMarkdown(
      `✅ *Номер сохранён!*\n\n` +
      `Если когда-нибудь смените Telegram — используйте /recover, ` +
      `поделитесь номером, и история визитов восстановится автоматически.\n\n` +
      `_Чтобы удалить все данные: /forget_`
    );
  }
});

// Пропустить номер телефона
bot.hears('⏭ Пропустить', async (ctx) => {
  await ctx.reply('Хорошо. Вы всегда сможете сделать это позже командой /recover.', Markup.removeKeyboard());
});

// ─── Confirm merge via phone ──────────────────────────────────────────────────
bot.action(/^confirm_merge_(.+)_to_(.+)$/, async (ctx) => {
  const oldId = ctx.match[1];
  const newId = ctx.match[2];

  // Security: newId must be the person pressing the button
  if (String(ctx.from.id) !== newId) return ctx.answerCbQuery('Ошибка доступа');
  await ctx.answerCbQuery();

  const { data: result } = await supabase.rpc('merge_guest_accounts', {
    p_old_telegram_id: oldId,
    p_new_telegram_id: newId,
  });

  if (!result || result.error) {
    const msgs = { old_not_found: 'Старый аккаунт не найден.', new_not_found: 'Новый аккаунт не найден.', same_account: 'Это один и тот же аккаунт.' };
    return ctx.editMessageText(`❌ ${msgs[result?.error] || 'Ошибка переноса. Обратитесь в поддержку.'}`, { parse_mode: 'Markdown' });
  }

  await ctx.editMessageText(
    `✅ *Аккаунт восстановлен!*\n\nВизитов всего: *${result.merged_visits}*\n\n_История переехала на ваш текущий аккаунт._`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('skip_merge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Ок. Номер сохранён — история старого аккаунта не тронута.');
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

// ─── Catch-all: handle any unrecognized text ─────────────────────────────────
bot.on('text', async (ctx) => {
  const ownerSub = await getOwnerSub(String(ctx.from.id));
  if (ownerSub) {
    await ctx.reply('Используйте меню ниже 👇', ownerKb);
  } else {
    await ctx.reply('Используйте кнопки ниже 👇', guestKb);
  }
});

// ─── Vercel handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[bot] WEBHOOK_SECRET is not configured — refusing all updates');
    return res.status(500).json({ error: 'Server misconfiguration: WEBHOOK_SECRET required' });
  }
  const incoming = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (incoming !== webhookSecret) return res.status(401).end('Unauthorized');

  try {
    await bot.handleUpdate(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('Bot webhook error:', err);
    res.status(200).end();
  }
};
