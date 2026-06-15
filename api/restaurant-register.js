/**
 * api/restaurant-register.js
 * POST — register a restaurant/event + start 14-day free trial
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, name, address, city, cuisine, venue_type, event_date, event_type } = req.body || {};
  if (!initData || !name) return res.status(400).json({ error: 'initData and name required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  // Check if already registered
  const { data: existing } = await db
    .from('restaurants')
    .select('*')
    .eq('owner_telegram_id', ownerId)
    .single();

  if (existing) return res.status(200).json({ restaurant: existing, alreadyExists: true });

  const now      = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const { data: restaurant, error } = await db
    .from('restaurants')
    .insert({
      name:                    name.trim(),
      address:                 (address || '').trim(),
      city:                    (city || 'Москва').trim(),
      cuisine:                 (cuisine || '').trim(),
      venue_type:              venue_type || 'restaurant',
      event_date:              event_date || null,
      event_type:              (event_type || '').trim(),
      owner_telegram_id:       ownerId,
      subscription_status:     'trial',
      trial_started_at:        now.toISOString(),
      subscription_expires_at: trialEnd.toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB error', detail: error.message });

  return res.status(201).json({ restaurant, alreadyExists: false });
};
