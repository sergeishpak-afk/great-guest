/**
 * api/bot.js — Telegram bot webhook (Vercel Serverless)
 * Webhook URL: https://great-guest.vercel.app/api/bot
 */

const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

// Must use SERVICE_ROLE to bypass RLS for bot writes
const bot      = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const APP_URL  = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');
const MINI_APP = `${APP_URL}/app.html`;

// ─── Levels ──────────────────────────────────────────────────────────────────
const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', min: 0  },
  { name: 'Silver',   emoji: '🥈', min: 5  },
  { name: 'Gold',     emoji: '🥇', min: 15 },
  { name: 'Platinum', emoji: '💎', min: 30 },
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
  let s = `${lvl.emoji} *${lvl.name}* — ${count} визит${decl(count)}`;
  if (next) s += `\n\nДо *${next.name}*: ещё ${next.min - count} визит${decl(next.min - count)}`;
  else      s += '\n\n🏆 Максимальный статус достигнут!';
  return s;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainKb = Markup.keyboard([
  ['🎫 Получить QR для визита'],
  ['⭐ Мой статус', '📋 История визитов'],
]).resize();

const openBtn = Markup.inlineKeyboard([[
  Markup.button.webApp('🚀 Открыть Great Guest', MINI_APP),
]]);

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const u = ctx.from;
  await supabase.from('guests').upsert(
    { telegram_id: String(u.id), first_name: u.first_name || '', last_name: u.last_name || '', username: u.username || '' },
    { onConflict: 'telegram_id' }
  );
  await ctx.replyWithMarkdown(
    `👋 Привет, *${u.first_name}*!\n\nДобро пожаловать в *Great Guest* — программу лояльности для ресторанов.\n\nКаждый визит в ресторан-партнёр повышает статус: Bronze → Silver → Gold → Platinum.`,
    mainKb
  );
  await ctx.reply('👇 Открой приложение:', openBtn);
});

// ─── /app — открыть приложение ───────────────────────────────────────────────
bot.command('app', async (ctx) => {
  await ctx.reply('👇 Открой приложение:', openBtn);
});

// ─── 🎫 QR для визита ─────────────────────────────────────────────────────────
bot.hears('🎫 Получить QR для визита', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const token = uuidv4();

  const { error } = await supabase.from('pending_visits').insert({ token, telegram_id: telegramId });
  if (error) return ctx.reply('Не удалось создать QR, попробуй ещё раз.');

  // QR encodes the restaurant scan URL (not just the token)
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
    res.status(200).end(); // always 200 — 5xx causes Telegram to retry indefinitely
  }
};
