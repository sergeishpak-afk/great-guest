const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGIN  = process.env.APP_ORIGIN || 'https://great-guest.ru';

const RL_MAP = new Map();
function checkRL(ip) {
  const now = Date.now();
  const e = RL_MAP.get(ip) || { count: 0, reset: now + 60000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 60000; }
  e.count++;
  RL_MAP.set(ip, e);
  if (RL_MAP.size > 5000) { for (const [k, v] of RL_MAP) if (v.reset < now) RL_MAP.delete(k); }
  return e.count > 30;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (checkRL(ip)) return res.status(429).json({ error: 'Too many requests' });
  const token = req.query.token || req.url.split('/').pop();

  if (!token || !UUID_RE.test(token))
    return res.status(400).json({ error: 'Invalid token' });

  const { data: pending } = await supabase
    .from('pending_visits')
    .select('telegram_id, used, expires_at')
    .eq('token', token)
    .single();

  if (!pending) return res.status(404).json({ error: 'QR не найден' });
  if (pending.used) return res.status(400).json({ error: 'QR уже использован' });
  // В-2: Check expiry before showing guest preview
  if (pending.expires_at && new Date(pending.expires_at) < new Date())
    return res.status(410).json({ error: 'QR-код устарел — гость должен получить новый в Telegram' });

  // Return minimal PII needed for confirmation screen — include status_override for VIP badge
  const { data: guest } = await supabase
    .from('guests')
    .select('first_name, last_name, visit_count, status_override')
    .eq('telegram_id', pending.telegram_id)
    .single();

  return res.status(200).json({ guest });
};
