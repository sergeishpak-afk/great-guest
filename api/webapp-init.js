const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return false;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
    params.delete('hash');
    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(receivedHash, 'hex'));
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid Telegram signature' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user') || '{}');
  if (!tgUser.id) return res.status(400).json({ error: 'No user in initData' });

  const { data: existing } = await supabaseAdmin
    .from('guests')
    .select('telegram_id, consent_at')
    .eq('telegram_id', String(tgUser.id))
    .maybeSingle();

  if (!existing) {
    // Never started the bot / no consent — do not silently create a record
    return res.status(403).json({ error: 'consent_required' });
  }

  const { data: guest, error } = await supabaseAdmin
    .from('guests')
    .update({ first_name: tgUser.first_name || '', last_name: tgUser.last_name || '', username: tgUser.username || '' })
    .eq('telegram_id', String(tgUser.id))
    .select().single();

  if (error) return res.status(500).json({ error: 'DB error' });
  return res.status(200).json({ guest });
};
