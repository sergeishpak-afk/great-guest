const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const QR_RL = new Map();
function checkQRLimit(telegramId) {
  const now = Date.now();
  const e = QR_RL.get(telegramId) || { count: 0, start: now };
  if (now - e.start > 60_000) { e.count = 0; e.start = now; }
  e.count++;
  QR_RL.set(telegramId, e);
  return e.count <= 5;
}

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return null;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user.id ? user : null;
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://great-guest.vercel.app');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};
  const tgUser = validateInitData(body.initData, process.env.BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Invalid Telegram signature' });

  const telegramId = String(tgUser.id);

  // ── action: init — guest app initialisation (replaces webapp-init.js) ────────
  if (body.action === 'init') {
    const { data: existing } = await supabase
      .from('guests')
      .select('telegram_id, first_name, last_name, username, visit_count, consent_at')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (!existing) return res.status(403).json({ error: 'consent_required' });

    const [{ data: guest, error }, { data: overrides }] = await Promise.all([
      supabase
        .from('guests')
        .update({ first_name: tgUser.first_name || '', last_name: tgUser.last_name || '', username: tgUser.username || '' })
        .eq('telegram_id', telegramId)
        .select()
        .single(),
      supabase
        .from('organizer_contacts')
        .select('status_override')
        .eq('guest_id', telegramId)
        .not('status_override', 'is', null),
    ]);

    if (error) return res.status(500).json({ error: 'DB error' });

    const RANK = { VIP: 5, Platinum: 4, Gold: 3, Silver: 2, Bronze: 1 };
    const bestOverride = (overrides || [])
      .map(r => r.status_override).filter(Boolean)
      .sort((a, b) => (RANK[b] || 0) - (RANK[a] || 0))[0] || null;

    return res.status(200).json({ guest: { ...guest, status_override: bestOverride } });
  }

  // ── Default: create QR token ──────────────────────────────────────────────────
  if (!checkQRLimit(telegramId))
    return res.status(429).json({ error: 'too_many_requests', message: 'Подождите минуту перед созданием нового QR' });

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('pending_visits')
    .insert({ token, telegram_id: telegramId, expires_at: expiresAt });

  if (error) return res.status(500).json({ error: 'DB error' });

  const appUrl = process.env.APP_URL || 'https://great-guest.vercel.app';
  return res.status(200).json({ token, visitUrl: `${appUrl}/restaurant.html?token=${token}` });
};
