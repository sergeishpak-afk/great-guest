require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');
const supabase = require('./admin-db'); // service_role — bypasses RLS for bot writes
const { formatStatus } = require('./status');

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

const MINI_APP_URL = 'https://great-guest.vercel.app/app.html';

const mainKeyboard = Markup.keyboard([
  ['🎫 Получить QR для визита'],
  ['⭐ Мой статус', '📋 История визитов'],
  ['💬 Поддержка'],
]).resize();

const pendingSupport = new Set();

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
          web_app: { url: `https://great-guest.vercel.app/app.html?venue=${venueId}` }
        }]]
      }
    });
  }

  if (payload.startsWith('qr_')) {
    const venueId = payload.slice(3);
    return ctx.reply('Получаем ваш QR...', {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Открыть кабинет',
          web_app: { url: `https://great-guest.vercel.app/app.html` }
        }]]
      }
    });
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

    await supabase.from('guests').upsert({
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
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
    await ctx.reply(`Нажми «🎫 Получить QR для визита» когда придёшь в заведение.`, mainKeyboard);
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
    `Привет, *${tgUser.first_name}*!\n\nДобро пожаловать в *Great Guest* — программу лояльности.\n\nКаждый визит в ресторан-партнёр повышает твой статус.`,
    mainKeyboard
  );
});

bot.command('app', async (ctx) => {
  await ctx.reply('👇 Нажми чтобы открыть:', appInlineBtn);
});

bot.hears('🎫 Получить QR для визита', async (ctx) => {
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
      caption: `🎫 *Твой QR-код для визита*\n\nПокажи этот код администратору ресторана.\nКод действителен для одного визита.`,
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

// Получить профиль гостя по QR-токену (без подтверждения)
app.get('/api/guest-preview/:token', async (req, res) => {
  const { data: pending } = await supabase
    .from('pending_visits')
    .select('telegram_id, used')
    .eq('token', req.params.token)
    .single();

  if (!pending) return res.status(404).json({ error: 'QR не найден' });
  if (pending.used) return res.status(400).json({ error: 'QR уже использован' });

  const { data: guest } = await supabase
    .from('guests')
    .select('first_name, last_name, username, visit_count')
    .eq('telegram_id', pending.telegram_id)
    .single();

  res.json({ guest });
});

// Подтвердить визит
app.post('/api/confirm-visit', async (req, res) => {
  const { token, restaurantId } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const { data: pending } = await supabase
    .from('pending_visits')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (!pending) return res.status(404).json({ error: 'QR не найден или уже использован' });

  const { data: guest } = await supabase
    .from('guests')
    .select('*')
    .eq('telegram_id', pending.telegram_id)
    .single();

  if (!guest) return res.status(404).json({ error: 'Гость не найден' });

  const newCount = guest.visit_count + 1;

  // Получаем название ресторана
  let restaurantName = 'ресторан-партнёр';
  if (restaurantId) {
    const { data: rest } = await supabase
      .from('restaurants')
      .select('name')
      .eq('id', restaurantId)
      .single();
    if (rest) restaurantName = rest.name;
  }

  // Записываем визит
  await supabase.from('visits').insert({
    telegram_id: pending.telegram_id,
    restaurant_id: restaurantId || null,
    visit_token: token,
  });

  // Обновляем счётчик
  await supabase
    .from('guests')
    .update({ visit_count: newCount })
    .eq('telegram_id', pending.telegram_id);

  // Помечаем токен использованным
  await supabase
    .from('pending_visits')
    .update({ used: true })
    .eq('token', token);

  // 🔔 Уведомляем гостя в Telegram
  try {
    const status = formatStatus(newCount);
    await bot.telegram.sendMessage(
      pending.telegram_id,
      `✅ *Визит подтверждён!*\n\n📍 ${restaurantName}\n\n${status}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Failed to notify guest:', e.message);
  }

  res.json({
    success: true,
    guest: {
      name: `${guest.first_name} ${guest.last_name}`.trim(),
      username: guest.username,
      visits: newCount,
    },
  });
});

// МЛ-1: Команда /myid
bot.command('myid', async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

bot.hears('💬 Поддержка', async (ctx) => {
  pendingSupport.add(String(ctx.from.id));
  await ctx.reply(
    'Опишите вашу проблему — мы ответим в течение 24 часов.\nНапишите сообщение прямо сейчас 👇',
    Markup.keyboard([['❌ Отмена']]).resize().oneTime()
  );
});

bot.hears('❌ Отмена', async (ctx) => {
  pendingSupport.delete(String(ctx.from.id));
  await ctx.reply('Хорошо, возвращаемся в меню.', mainKeyboard);
});

// Catch-all — последний перед launch
bot.on('message', async (ctx) => {
  const userId = String(ctx.from.id);

  // Перехватываем сообщение поддержки
  if (pendingSupport.has(userId) && ctx.message?.text) {
    pendingSupport.delete(userId);
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
      } catch (e) { console.error('Support forward error:', e.message); }
    }
    await ctx.reply('✅ Сообщение отправлено! Ответим здесь в течение 24 часов.', mainKeyboard);
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

// Устанавливаем menu button до запуска polling
bot.telegram.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Open Great Guest', web_app: { url: MINI_APP_URL } }
}).then(() => console.log('✅ Menu button установлен'))
  .catch(e => console.warn('⚠️  Menu button:', e.message));

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ @great_guest_bot запущен'))
  .catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
