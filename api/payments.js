/**
 * api/payments.js
 * POST /api/payments
 *   - body.initData present  → create ЮKassa payment (organizer frontend)
 *   - body.type === 'notification' → ЮKassa webhook (payment confirmed)
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');

const db  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

const APP_URL = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');

const PLANS = {
  basic:   { label: 'Базовый',  price: 299000,  max_venues: 1   }, // 2 990 ₽ × 100
  network: { label: 'Сеть',     price: 799000,  max_venues: 5   }, // 7 990 ₽ × 100
  empire:  { label: 'Империя',  price: 1999000, max_venues: 999 }, // 19 990 ₽ × 100
};

// Duration discounts
const DISCOUNTS = { 1: 0, 3: 0.10, 6: 0.15, 12: 0.20 };

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return null;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user.id ? user : null;
  } catch { return null; }
}

async function createYooKassaPayment({ amount, description, metadata }) {
  const shopId    = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  const idempKey  = crypto.randomUUID();

  const resp = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'Idempotence-Key': idempKey,
      'Authorization':   'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64'),
    },
    body: JSON.stringify({
      amount:       { value: (amount / 100).toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: `${APP_URL}/payment.html?status=success` },
      capture:      true,
      description,
      metadata,
    }),
  });

  return resp.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};

  // ── ЮKassa webhook ───────────────────────────────────────────────────────────
  if (body.type === 'notification') {
    const payment = body.object;
    if (!payment || payment.status !== 'succeeded') return res.status(200).end();

    const { telegram_id, plan, months } = payment.metadata || {};
    if (!telegram_id || !plan || !PLANS[plan]) return res.status(200).end();

    const m = parseInt(months) || 1;

    // Mark payment succeeded (idempotent)
    await db.from('payments')
      .update({ status: 'succeeded', confirmed_at: new Date().toISOString() })
      .eq('payment_id', payment.id)
      .eq('status', 'pending');

    // Extend subscription from current expiry (or now, whichever is later)
    const { data: sub } = await db.from('owner_subscriptions')
      .select('subscription_expires_at')
      .eq('telegram_id', telegram_id)
      .maybeSingle();

    const base    = sub?.subscription_expires_at
      ? Math.max(new Date(sub.subscription_expires_at).getTime(), Date.now())
      : Date.now();
    const newExp  = new Date(base + m * 30 * 86_400_000).toISOString();
    const expDate = new Date(newExp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    await db.from('owner_subscriptions').upsert({
      telegram_id,
      plan,
      max_venues:            PLANS[plan].max_venues,
      subscription_status:   'active',
      subscription_expires_at: newExp,
    }, { onConflict: 'telegram_id' });

    // Notify organizer in bot
    try {
      await bot.telegram.sendMessage(
        telegram_id,
        `✅ *Оплата прошла!*\n\nТариф: ${PLANS[plan].label}\nДействует до: *${expDate}*\n\nСпасибо, что выбрали Great Guest! 🎉`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { console.error('Payment notify error:', e.message); }

    return res.status(200).end();
  }

  // ── Create payment (from organizer's browser/miniapp) ────────────────────────
  const tgUser = validateInitData(body.initData, process.env.BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram signature' });

  const telegramId = String(tgUser.id);
  const plan       = body.plan;
  const months     = Math.min(Math.max(parseInt(body.months) || 1, 1), 12);

  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const discount   = DISCOUNTS[months] || 0;
  const basePrice  = PLANS[plan].price * months;
  const amount     = Math.round(basePrice * (1 - discount));

  const ykPayment  = await createYooKassaPayment({
    amount,
    description: `Great Guest — ${PLANS[plan].label} × ${months} мес.`,
    metadata:    { telegram_id: telegramId, plan, months: String(months) },
  });

  if (ykPayment.type === 'error' || !ykPayment.id) {
    console.error('ЮKassa error:', JSON.stringify(ykPayment));
    return res.status(500).json({ error: 'Ошибка создания платежа', detail: ykPayment.description });
  }

  // Record pending payment
  await db.from('payments').insert({
    payment_id:  ykPayment.id,
    telegram_id: telegramId,
    plan,
    amount,
    months,
    status: 'pending',
  });

  return res.status(200).json({
    payment_id:       ykPayment.id,
    confirmation_url: ykPayment.confirmation?.confirmation_url,
    amount_rub:       amount / 100,
  });
};
