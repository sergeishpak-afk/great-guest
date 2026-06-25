/**
 * scripts/register-webhook.js
 * Registers Telegram webhook with WEBHOOK_SECRET.
 * Runs automatically as Vercel buildCommand on every deploy.
 * Can also be run locally: node scripts/register-webhook.js
 */
if (!process.env.BOT_TOKEN) require('dotenv').config();

const BOT_TOKEN      = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APP_URL        = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');

if (!BOT_TOKEN)      { console.log('[webhook] BOT_TOKEN not set — skipping'); process.exit(0); }
if (!WEBHOOK_SECRET) { console.log('[webhook] WEBHOOK_SECRET not set — skipping'); process.exit(0); }

const webhookUrl = `${APP_URL}/api/bot`;

fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: webhookUrl, secret_token: WEBHOOK_SECRET }),
})
  .then(r => r.json())
  .then(d => {
    if (d.ok) { console.log(`[webhook] ✅ Registered: ${webhookUrl}`); }
    else      { console.error(`[webhook] ❌ Failed: ${d.description}`); process.exit(1); }
  })
  .catch(e => { console.error('[webhook] Error:', e.message); process.exit(1); });
