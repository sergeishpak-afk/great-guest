const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = req.query.token || req.url.split('/').pop();

  if (!token || !UUID_RE.test(token))
    return res.status(400).json({ error: 'Invalid token' });

  const { data: pending } = await supabase
    .from('pending_visits')
    .select('telegram_id, used')
    .eq('token', token)
    .single();

  if (!pending) return res.status(404).json({ error: 'QR не найден' });
  if (pending.used) return res.status(400).json({ error: 'QR уже использован' });

  // Return only first_name + visit_count — minimal PII needed for confirmation screen
  const { data: guest } = await supabase
    .from('guests')
    .select('first_name, visit_count')
    .eq('telegram_id', pending.telegram_id)
    .single();

  return res.status(200).json({ guest });
};
