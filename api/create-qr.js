const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');
    const checkString = Array.from(params.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256',secretKey).update(checkString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computedHash,'hex'),Buffer.from(receivedHash,'hex'))) return null;
    const user = JSON.parse(params.get('user')||'{}');
    return user.id ? user : null;
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData } = req.body || {};
  const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram signature' });

  const token = uuidv4();
  const { error } = await supabase.from('pending_visits').insert({ token, telegram_id: String(tgUser.id) });
  if (error) return res.status(500).json({ error: 'DB error' });

  const appUrl = process.env.APP_URL || 'https://great-guest.vercel.app';
  return res.status(200).json({ token, visitUrl: `${appUrl}/restaurant.html?token=${token}` });
};
