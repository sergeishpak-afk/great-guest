/**
 * api/bot-setup.js
 * Manually registers webhook + bot commands.
 * Call once after deploy: GET /api/bot-setup?secret=<CRON_SECRET>
 */
const APP_URL = (process.env.APP_URL || 'https://great-guest.ru').replace(/\/$/, '');

const COMMANDS = [
  { command: 'start',   description: '👋 Главное меню' },
  { command: 'qr',      description: '🎫 Мой QR-код для входа на событие' },
  { command: 'status',  description: '⭐ Мой статус гостя' },
  { command: 'history', description: '📋 История посещений' },
  { command: 'mydata',  description: '📊 Мои данные (152-ФЗ)' },
  { command: 'forget',  description: '🗑 Удалить мои данные' },
];

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = req.query.secret || req.headers['x-secret'];
  if (secret && provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

  const webhookUrl = `${APP_URL}/api/bot`;
  const results = {};

  try {
    const r1 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: process.env.WEBHOOK_SECRET }),
    });
    results.webhook = await r1.json();
  } catch (e) {
    results.webhook = { ok: false, error: e.message };
  }

  try {
    const r2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: COMMANDS }),
    });
    results.commands = await r2.json();
  } catch (e) {
    results.commands = { ok: false, error: e.message };
  }

  try {
    const r3 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    results.webhookInfo = await r3.json();
  } catch (e) {
    results.webhookInfo = { error: e.message };
  }

  const allOk = results.webhook?.ok && results.commands?.ok;
  return res.status(allOk ? 200 : 500).json(results);
};
