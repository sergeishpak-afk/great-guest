/**
 * api/setup-webhook.js — one-shot webhook registration
 * GET /api/setup-webhook?key=WEBHOOK_SECRET
 * Protected: only callable if you know the WEBHOOK_SECRET value.
 * Safe to leave deployed — without the key it returns 403.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://great-guest.vercel.app');
  if (req.method !== 'GET') return res.status(405).end();

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'WEBHOOK_SECRET not configured' });

  const key = req.query.key || '';
  if (key !== secret) return res.status(403).json({ error: 'Forbidden' });

  const appUrl = (process.env.APP_URL || 'https://great-guest.vercel.app').replace(/\/$/, '');
  const webhookUrl = `${appUrl}/api/bot`;

  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
  });
  const data = await r.json();

  if (data.ok) {
    return res.status(200).json({ success: true, webhook: webhookUrl });
  }
  return res.status(500).json({ error: data.description });
};
