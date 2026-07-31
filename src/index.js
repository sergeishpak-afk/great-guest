require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');
const fs = require('fs');
const supabase = require('./admin-db'); // service_role — bypasses RLS for bot writes
const { formatStatus } = require('./status');

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

const APP_URL      = (process.env.APP_URL || 'https://great-guest.ru').replace(/\/$/, '');
const MINI_APP_URL = `${APP_URL}/app.html`;

const mainKeyboard = Markup.keyboard([
  ['🎫 Мой QR-код'],
  ['⭐ Мой статус', '📋 История визитов'],
  ['📌 Команды', '💬 Поддержка'],
]).resize();

// Pending states persist across restarts via local file with 10-min TTL
const PENDING_FILE = path.join(__dirname, '../.pending.json');
const PENDING_TTL  = 10 * 60 * 1000;

function _loadPending() {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    const now = Date.now();
    return {
      support: new Map(Object.entries(raw.support || {}).filter(([, e]) => e > now)),
      email:   new Map(Object.entries(raw.email   || {}).filter(([, e]) => e > now)),
    };
  } catch { return { support: new Map(), email: new Map() }; }
}
function _savePending() {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify({
      support: Object.fromEntries(pendingSupport),
      email:   Object.fromEntries(pendingEmail),
    }), 'utf8');
  } catch (e) { console.warn('[pending] save error:', e.message); }
}
const { support: pendingSupport, email: pendingEmail } = _loadPending();
function pAdd(map, id)    { map.set(id, Date.now() + PENDING_TTL); _savePending(); }
function pHas(map, id)    {
  const e = map.get(id);
  if (!e) return false;
  if (Date.now() > e) { map.delete(id); _savePending(); return false; }
  return true;
}
function pDel(map, id)    { map.delete(id); _savePending(); }

const appInlineBtn = Markup.inlineKeyboard([
  [Markup.button.webApp('🚀 Открыть Great Guest', MINI_APP_URL)]
]);

bot.start(async (ctx) => {
  const tgUser = ctx.from;
  const payload = ctx.startPayload || '';

  // КР-5: Обработка диплинков ?start=v_/qr_/ref_
  if (payload.startsWith('v_')) {
    const venueId = payload.slice(2);
    return ctx.reply('Открываем заведение...', {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Открыть',
          web_app: { url: `${APP_URL}/app.html?venue=${venueId}` }
        }]]
      }
    });
  }

  if (payload.startsWith('qr_')) {
    return ctx.reply('Ваш QR-код 👇', {
      reply_markup: {
        inline_keyboard: [[{
          text: '🎫 Показать QR-код',
          web_app: { url: `${APP_URL}/app.html?qr=1` },
        }]],
      },
    });
  }

  if (payload === 'support') {
    // Fix #12: Guard — if SUPPORT_TELEGRAM_ID not set, messages would be silently lost
    if (!process.env.SUPPORT_TELEGRAM_ID) {
      return ctx.reply('Поддержка временно недоступна. Попробуйте позже.', mainKeyboard);
    }
    pAdd(pendingSupport, String(ctx.from.id));
    return ctx.reply(
      'Опишите вашу проблему — мы ответим в течение 24 часов.\nНапишите сообщение прямо сейчас 👇',
      Markup.keyboard([['❌ Отмена']]).resize().oneTime(),
    );
  }

  if (payload.startsWith('plan_')) {
    const planKey = payload.slice(5); // event | basic | network | empire
    const planInfo = {
      event:   { label: 'Разовый',  price: '490₽',    period: 'разово · 30 дней',     emoji: '⚡' },
      basic:   { label: 'Базовый',  price: '2 990₽',  period: 'в месяц',              emoji: '🔑' },
      network: { label: 'Сеть',     price: '7 990₽',  period: 'в месяц · до 5 площадок', emoji: '🏢' },
      empire:  { label: 'Империя',  price: '19 990₽', period: 'в месяц · без ограничений', emoji: '👑' },
    }[planKey];
    if (!planInfo) return ctx.reply('Неизвестный тариф. Откройте панель управления.', appInlineBtn);
    await ctx.replyWithMarkdown(
      `${planInfo.emoji} *Тариф ${planInfo.label}* — ${planInfo.price} ${planInfo.period}\n\nОткройте панель управления и перейдите в раздел *Тарифы* для оформления.`,
      appInlineBtn
    );
    return;
  }

  if (payload === 'guest') {
    const upsertData = {
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
    };
    const { data: existingG } = await supabase
      .from('guests').select('consent_at').eq('telegram_id', String(tgUser.id)).single();
    if (!existingG?.consent_at) upsertData.consent_at = new Date().toISOString();
    await supabase.from('guests').upsert(upsertData, { onConflict: 'telegram_id' });
    await ctx.replyWithMarkdown(
      `Привет, *${tgUser.first_name}*! Собирай визиты в ресторанах-партнёрах и повышай свой статус.`,
      mainKeyboard
    );
    return ctx.reply('👇 Открыть личный кабинет:', appInlineBtn);
  }

  if (payload.startsWith('rsvp_')) {
    const venueId = payload.slice(5);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(venueId)) return ctx.reply('Недействительная ссылка приглашения.');

    const { data: venue } = await supabase
      .from('restaurants')
      .select('name, owner_telegram_id, classification_mode')
      .eq('id', venueId)
      .single();

    if (!venue || venue.classification_mode !== 'guestlist') {
      return ctx.reply('Мероприятие не найдено или уже не принимает заявки.');
    }

    // Check if consent already exists before upserting
    const { data: existingRsvpGuest } = await supabase
      .from('guests').select('consent_at').eq('telegram_id', String(tgUser.id)).maybeSingle();

    await supabase.from('guests').upsert({
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
      // 152-ФЗ: record consent timestamp on first interaction
      ...(!existingRsvpGuest?.consent_at && { consent_at: new Date().toISOString() }),
    }, { onConflict: 'telegram_id' });

    const { data: existing } = await supabase
      .from('rsvp')
      .select('status')
      .eq('venue_id', venueId)
      .eq('telegram_id', String(tgUser.id))
      .maybeSingle();

    if (existing?.status === 'approved') {
      return ctx.replyWithMarkdown(`✅ Ваша заявка на *${venue.name}* уже одобрена! Вы в списке гостей.`);
    }
    if (existing?.status === 'pending') {
      return ctx.replyWithMarkdown(`⏳ Ваша заявка на *${venue.name}* уже отправлена и ожидает одобрения организатора.`);
    }

    const { error: rsvpError } = await supabase.from('rsvp').upsert({
      venue_id: venueId,
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
      status: 'pending',
    }, { onConflict: 'venue_id,telegram_id' });

    if (rsvpError) return ctx.reply('Ошибка при отправке заявки. Попробуй ещё раз.');

    await ctx.replyWithMarkdown(
      `📋 *Заявка отправлена!*\n\n📍 *${venue.name}*\n\nОрганизатор рассмотрит вашу заявку и сообщит о решении.`
    );

    const guestName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Гость';
    const guestLabel = guestName + (tgUser.username ? ` (@${tgUser.username})` : '');
    try {
      await bot.telegram.sendMessage(
        venue.owner_telegram_id,
        `🔔 *Новая заявка на участие*\n\n📍 ${venue.name}\n👤 ${guestLabel}\n🆔 \`${tgUser.id}\`\n\nОткройте кабинет → Гостевой список для одобрения.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { console.error('Organizer notify error:', e.message); }

    // Показываем главное меню — на случай если пользователь новый и пришёл только через инвайт
    await ctx.reply(`Нажми «🎫 Мой QR-код» когда придёшь в заведение.`, mainKeyboard);
    return;
  }

  // ref_ — реферальный код, продолжаем стандартный /start

  // КР-4: Проверяем есть ли уже consent_at у гостя
  const { data: existingGuest } = await supabase
    .from('guests')
    .select('consent_at')
    .eq('telegram_id', String(tgUser.id))
    .single();

  const upsertData = {
    telegram_id: String(tgUser.id),
    first_name: tgUser.first_name || '',
    last_name: tgUser.last_name || '',
    username: tgUser.username || '',
  };

  // Устанавливаем consent_at только если не было раньше
  if (!existingGuest?.consent_at) {
    upsertData.consent_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('guests')
    .upsert(upsertData, { onConflict: 'telegram_id' });

  if (error) return ctx.reply('Ошибка регистрации, попробуй ещё раз.');

  await ctx.replyWithMarkdown(
    `Привет, *${tgUser.first_name}*!\n\nДобро пожаловать в *Great Guest* — программу лояльности.\n\nКаждый визит в заведение-партнёр или мероприятие системы Great Guest повышает твой статус.`,
    mainKeyboard
  );
  await ctx.reply('👇 Открыть личный кабинет:', appInlineBtn);
});

bot.command('app', async (ctx) => {
  await ctx.reply('👇 Нажми чтобы открыть:', appInlineBtn);
});

bot.command('restaurant', async (ctx) => {
  await ctx.reply('Панель сканирования QR для персонала 👇', {
    reply_markup: {
      inline_keyboard: [[{
        text: '📷 Открыть панель сканирования',
        web_app: { url: `${APP_URL}/restaurant.html` },
      }]],
    },
  });
});

const HELP_TEXT = `❓ *Что умеет Great Guest:*

🎫 *Мой QR-код*
Генерирует одноразовый код — покажи сотруднику заведения, он отметит визит.

⭐ *Мой статус*
Текущий уровень лояльности и сколько визитов до следующего.

📋 *История визитов*
Последние 10 посещений с датами и названиями заведений.

💬 *Поддержка*
Напишем ответ прямо в этот чат в течение 24 часов.

🚀 *Личный кабинет*
Полная карта лояльности, офферы и настройки — через кнопку ниже.

📧 *Восстановление аккаунта*
Добавь email командой /setemail — поможет вернуть историю при смене Telegram.`;

bot.hears('📌 Команды', async (ctx) => {
  await ctx.replyWithMarkdown(HELP_TEXT, appInlineBtn);
});

bot.command('help', async (ctx) => {
  await ctx.replyWithMarkdown(HELP_TEXT, appInlineBtn);
});

bot.hears('🎫 Мой QR-код', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const visitToken = uuidv4();

  // ВА-4: Добавляем expires_at (1 час)
  const { error } = await supabase
    .from('pending_visits')
    .insert({
      token: visitToken,
      telegram_id: telegramId,
      expires_at: new Date(Date.now() + 3600_000).toISOString()
    });

  if (error) return ctx.reply('Не удалось создать QR, попробуй ещё раз.');

  const qrBuffer = await QRCode.toBuffer(visitToken, {
    errorCorrectionLevel: 'H',
    width: 400,
    margin: 2,
  });

  await ctx.replyWithPhoto(
    { source: qrBuffer },
    {
      caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код администратору ресторана.\nКод действителен 1 час, для одного визита.`,
      parse_mode: 'Markdown',
    }
  );
});

bot.hears('⭐ Мой статус', async (ctx) => {
  const { data: guest } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', String(ctx.from.id))
    .single();

  if (!guest) return ctx.reply('Нажми /start для регистрации.');
  await ctx.replyWithMarkdown(`📊 *Твой статус, ${guest.first_name}*\n\n${formatStatus(guest.visit_count)}`);
});

bot.hears('📋 История визитов', async (ctx) => {
  const { data: visits } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', String(ctx.from.id))
    .order('visited_at', { ascending: false })
    .limit(10);

  if (!visits?.length) return ctx.replyWithMarkdown('📋 *История пустая*\n\nПолучи QR и посети ресторан-партнёр!');

  const lines = visits.map((v, i) => {
    const date = new Date(v.visited_at).toLocaleDateString('ru-RU');
    return `${i + 1}. ${v.restaurants?.name || 'Ресторан'} — ${date}`;
  });
  await ctx.replyWithMarkdown(`📋 *Последние визиты*\n\n${lines.join('\n')}`);
});

// ─── Web server ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web/public')));

// МЛ-1: Команда /myid
bot.command('myid', async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

bot.command('setemail', async (ctx) => {
  pAdd(pendingEmail, String(ctx.from.id));
  await ctx.reply(
    '📧 Введите ваш email для восстановления аккаунта:\n\n_Поможет вернуть историю визитов при смене Telegram._',
    { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Отмена']]).resize().oneTime() }
  );
});

bot.hears('💬 Поддержка', async (ctx) => {
  if (!process.env.SUPPORT_TELEGRAM_ID) {
    return ctx.reply('Поддержка временно недоступна. Попробуйте позже.', mainKeyboard);
  }
  pAdd(pendingSupport, String(ctx.from.id));
  await ctx.reply(
    'Опишите вашу проблему — мы ответим в течение 24 часов.\nНапишите сообщение прямо сейчас 👇',
    Markup.keyboard([['❌ Отмена']]).resize().oneTime()
  );
});

bot.hears('❌ Отмена', async (ctx) => {
  const uid = String(ctx.from.id);
  pDel(pendingSupport, uid);
  pDel(pendingEmail, uid);
  await ctx.reply('Хорошо, возвращаемся в меню.', mainKeyboard);
});

// Catch-all — последний перед launch
bot.on('message', async (ctx) => {
  const userId = String(ctx.from.id);

  // Перехватываем ввод email
  if (pHas(pendingEmail, userId) && ctx.message?.text) {
    pDel(pendingEmail, userId);
    const email = ctx.message.text.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      pAdd(pendingEmail, userId);
      await ctx.reply('❌ Некорректный email. Попробуйте ещё раз:', Markup.keyboard([['❌ Отмена']]).resize().oneTime());
      return;
    }
    const { error: emailErr } = await supabase.from('guests').update({ email }).eq('telegram_id', userId);
    if (emailErr) {
      if (emailErr.code === '23505') {
        await ctx.reply('❌ Этот email уже привязан к другому аккаунту.', mainKeyboard);
      } else {
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.', mainKeyboard);
      }
    } else {
      await ctx.reply(`✅ Email *${email}* сохранён.\nИспользуй его для восстановления аккаунта.`, { parse_mode: 'Markdown', ...mainKeyboard });
    }
    return;
  }

  // Перехватываем сообщение поддержки
  if (pHas(pendingSupport, userId) && ctx.message?.text) {
    pDel(pendingSupport, userId);
    const guestName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Гость';
    const guestLabel = guestName + (ctx.from.username ? ` (@${ctx.from.username})` : '') + ` [${userId}]`;
    const supportId = process.env.SUPPORT_TELEGRAM_ID;
    if (supportId) {
      try {
        await bot.telegram.sendMessage(
          supportId,
          `🆘 *Обращение в поддержку*\n\n👤 ${guestLabel}\n\n💬 ${ctx.message.text}`,
          { parse_mode: 'Markdown' }
        );
        await ctx.reply('✅ Сообщение отправлено! Ответим здесь в течение 24 часов.', mainKeyboard);
      } catch (e) {
        console.error('Support forward error:', e.message);
        await ctx.reply('❌ Не удалось отправить сообщение. Попробуйте позже.', mainKeyboard);
      }
    } else {
      console.error('[support] SUPPORT_TELEGRAM_ID not set — message lost:', guestLabel, ctx.message.text);
      await ctx.reply('❌ Поддержка временно недоступна. Попробуйте позже.', mainKeyboard);
    }
    return;
  }

  try {
    await ctx.reply('Используйте меню ниже 👇', mainKeyboard);
  } catch (e) { console.error('[bot catch-all]', e); }
});

// ─── Start both ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.WEB_PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Веб-панель ресторана: http://localhost:${PORT}`);
});

// Регистрируем команды в меню Telegram
bot.telegram.setMyCommands([
  { command: 'start',      description: 'Начать / перезапустить бота' },
  { command: 'help',       description: 'Что умеет бот' },
  { command: 'app',        description: 'Открыть мини-приложение' },
  { command: 'restaurant', description: 'Панель сканирования QR (для персонала)' },
  { command: 'setemail',   description: 'Добавить email для восстановления аккаунта' },
  { command: 'myid',       description: 'Мой Telegram ID' },
]).then(() => console.log('✅ Команды бота зарегистрированы'))
  .catch(e => console.warn('⚠️  setMyCommands:', e.message));

// Устанавливаем menu button до запуска polling
bot.telegram.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Открыть Great Guest', web_app: { url: MINI_APP_URL } }
}).then(() => console.log('✅ Menu button установлен'))
  .catch(e => console.warn('⚠️  Menu button:', e.message));

if (!process.env.SUPPORT_TELEGRAM_ID) {
  console.warn('⚠️  SUPPORT_TELEGRAM_ID не задан — сообщения поддержки будут потеряны');
}

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ @great_guest_bot запущен'))
  .catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
