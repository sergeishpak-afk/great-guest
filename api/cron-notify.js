/**
 * api/cron-notify.js
 * Daily cron: renewal alerts at 7 days and 3 days before expiry,
 * plus "expired today" notification.
 *
 * Schedule: 08:00 Moscow = 05:00 UTC (set in vercel.json)
 * Security: Vercel Cron passes Authorization: Bearer <CRON_SECRET>
 */
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');

const db  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

const APP_URL = (process.env.APP_URL || 'https://great-guest.ru').replace(/\/$/, '');

const PLANS = {
  trial:   { label: 'Старт (пробный)', emoji: '🆓' },
  event:   { label: 'Разовый',         emoji: '🎟' },
  basic:   { label: 'Базовый',         emoji: '🔑' },
  network: { label: 'Сеть',            emoji: '🏢' },
  empire:  { label: 'Империя',         emoji: '👑' },
};

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Subscriptions expiring in targetDays ± 12h
async function getExpiringIn(targetDays) {
  const now  = Date.now();
  const from = new Date(now + (targetDays - 0.5) * 86_400_000).toISOString();
  const to   = new Date(now + (targetDays + 0.5) * 86_400_000).toISOString();
  const { data } = await db
    .from('owner_subscriptions')
    .select('telegram_id, plan, subscription_status, subscription_expires_at')
    .in('subscription_status', ['trial', 'active'])
    .gte('subscription_expires_at', from)
    .lte('subscription_expires_at', to);
  return data || [];
}

// Subscriptions that expired within the last 24 hours
async function getExpiredToday() {
  const now  = Date.now();
  const from = new Date(now - 86_400_000).toISOString();
  const to   = new Date(now).toISOString();
  const { data } = await db
    .from('owner_subscriptions')
    .select('telegram_id, plan, subscription_status, subscription_expires_at')
    .eq('subscription_status', 'active')
    .gte('subscription_expires_at', from)
    .lte('subscription_expires_at', to);
  return data || [];
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron-notify] CRON_SECRET is not configured — refusing request');
    return res.status(500).json({ error: 'Server misconfiguration: CRON_SECRET required' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let sent = 0;
  let errors = 0;

  // ── Renewal alerts: 7 days and 3 days before expiry ──────────────────────
  for (const days of [7, 3]) {
    const subs = await getExpiringIn(days);
    for (const sub of subs) {
      const plan    = PLANS[sub.plan] || PLANS.trial;
      const isTrial = sub.subscription_status === 'trial';
      const text    = isTrial
        ? `⏳ *Пробный период заканчивается через ${days} дн.*\n\n` +
          `Дата окончания: ${fmtDate(sub.subscription_expires_at)}\n\n` +
          `Выберите тариф, чтобы продолжить работу и не потерять базу гостей.`
        : `⚠️ *Подписка заканчивается через ${days} дн.*\n\n` +
          `${plan.emoji} Тариф: ${plan.label}\n` +
          `Истекает: ${fmtDate(sub.subscription_expires_at)}\n\n` +
          `Продлите подписку, чтобы не потерять доступ к панели и базе гостей.`;
      try {
        await bot.telegram.sendMessage(sub.telegram_id, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: isTrial ? '💳 Выбрать тариф' : '💳 Продлить подписку',
              web_app: { url: `${APP_URL}/payment.html` } },
          ]]},
        });
        sent++;
      } catch (e) {
        console.error(`[cron-notify] ${days}d alert error for ${sub.telegram_id}:`, e.message);
        errors++;
      }
    }
  }

  // ── Expired today: subscription just ran out ──────────────────────────────
  const expired = await getExpiredToday();
  for (const sub of expired) {
    const plan = PLANS[sub.plan] || PLANS.trial;
    try {
      await bot.telegram.sendMessage(
        sub.telegram_id,
        `⛔ *Подписка истекла*\n\n` +
        `${plan.emoji} Тариф: ${plan.label} — срок действия закончился ${fmtDate(sub.subscription_expires_at)}.\n\n` +
        `Доступ к панели управления и базе гостей приостановлен. Оформите подписку для продолжения работы.`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '💳 Оформить подписку', web_app: { url: `${APP_URL}/payment.html` } },
          ]]},
        }
      );
      sent++;
    } catch (e) {
      console.error(`[cron-notify] expired alert error for ${sub.telegram_id}:`, e.message);
      errors++;
    }
  }

  console.log(`[cron-notify] done: ${sent} sent, ${errors} errors`);
  return res.status(200).json({ ok: true, sent, errors });
};
