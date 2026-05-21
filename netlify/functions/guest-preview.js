const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

exports.handler = async (event) => {
  const token = event.path.split('/').pop();

  const { data: pending } = await supabase
    .from('pending_visits').select('telegram_id, used').eq('token', token).single();

  if (!pending) return { statusCode: 404, body: JSON.stringify({ error: 'QR не найден' }) };
  if (pending.used) return { statusCode: 400, body: JSON.stringify({ error: 'QR уже использован' }) };

  const { data: guest } = await supabase
    .from('guests').select('first_name, last_name, username, visit_count')
    .eq('telegram_id', pending.telegram_id).single();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest }),
  };
};
