/**
 * scripts/register-webhook.js
 * Registers the Telegram webhook URL with WEBHOOK_SECRET for signature validation.
 * Run once after deploy or when BOT_TOKEN / WEBHOOK_SECRET changes.
 *
 * Usage: node scripts/register-webhook.js
 */
require('dotenv').config();

const BOT_TOKEN      = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APP_URL        = process.env.APP_URL || 'https://great-guest.vercel.app';

if (!BOT_TOKEN)      { console.error('BOT_TOKEN not set'); process.exit(1); }
if (!WEBHOOK_SECRET) { console.error('WEBHOOK_SECRET not set'); process.exit(1); }

const webhookUrl = `${APP_URL}/api/bot`;

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: WEBHOOK_SECRET }),
  });
  const data = await res.json();
  if (data.ok) {
    console.log(`✅ Webhook registered: ${webhookUrl}`);
  } else {
    console.error('❌ Failed:', data.description);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
