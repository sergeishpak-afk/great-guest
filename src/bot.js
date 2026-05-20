require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const supabase = require('./db');
const { formatStatus } = require('./status');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const tgUser = ctx.from;

  // Upsert guest
  const { data: guest, error } = await supabase
    .from('guests')
    .upsert({
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name || '',
      last_name: tgUser.last_name || '',
      username: tgUser.username || '',
    }, { onConflict: 'telegram_id' })
    .select()
    .single();

  if (error) {
    console.error('DB error on start:', error);
    return ctx.reply('Упс, что-то пошло не так. Попробуй ещё раз.');
  }

  await ctx.replyWithMarkdown(
    `👋 Привет, *${tgUser.first_name}*!\n\nДобро пожаловать в *Great Guest* — программу лояльности для ресторанов.\n\nКаждый визит в ресторан-партнёр повышает твой статус и открывает привилегии.`,
    Markup.keyboard([
      ['🎫 Получить QR для визита'],
      ['⭐ Мой статус', '📋 История визитов'],
    ]).resize()
  );
});

// ─── QR для визита ────────────────────────────────────────────────────────────
bot.hears('🎫 Получить QR для визита', async (ctx) => {
  const telegramId = String(ctx.from.id);

  // Создаём одноразовый токен визита
  const visitToken = uuidv4();

  const { error } = await supabase
    .from('pending_visits')
    .insert({ token: visitToken, telegram_id: telegramId });

  if (error) {
    console.error('DB error creating visit token:', error);
    return ctx.reply('Не удалось создать QR. Попробуй ещё раз.');
  }

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

// ─── Мой статус ───────────────────────────────────────────────────────────────
bot.hears('⭐ Мой статус', async (ctx) => {
  const telegramId = String(ctx.from.id);

  const { data: guest, error } = await supabase
    .from('guests')
    .select('visit_count, first_name')
    .eq('telegram_id', telegramId)
    .single();

  if (error || !guest) {
    return ctx.reply('Ты ещё не зарегистрирован. Нажми /start');
  }

  await ctx.replyWithMarkdown(
    `📊 *Твой статус, ${guest.first_name}*\n\n${formatStatus(guest.visit_count)}`
  );
});

// ─── История визитов ──────────────────────────────────────────────────────────
bot.hears('📋 История визитов', async (ctx) => {
  const telegramId = String(ctx.from.id);

  const { data: visits, error } = await supabase
    .from('visits')
    .select('visited_at, restaurants(name)')
    .eq('telegram_id', telegramId)
    .order('visited_at', { ascending: false })
    .limit(10);

  if (error) {
    return ctx.reply('Не удалось загрузить историю.');
  }

  if (!visits || visits.length === 0) {
    return ctx.replyWithMarkdown('📋 *История пустая*\n\nПолучи QR-код и посети ресторан-партнёр!');
  }

  const lines = visits.map((v, i) => {
    const date = new Date(v.visited_at).toLocaleDateString('ru-RU');
    const restaurant = v.restaurants?.name || 'Ресторан';
    return `${i + 1}. ${restaurant} — ${date}`;
  });

  await ctx.replyWithMarkdown(
    `📋 *Последние визиты*\n\n${lines.join('\n')}`
  );
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('✅ @great_guest_bot запущен');
}).catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
