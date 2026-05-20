require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const supabase = require('../db');

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

// ─── Подтвердить визит по токену из QR ───────────────────────────────────────
app.post('/api/confirm-visit', async (req, res) => {
  const { token, restaurantId } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  // Найти pending_visit
  const { data: pending, error: findErr } = await supabase
    .from('pending_visits')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (findErr || !pending) {
    return res.status(404).json({ error: 'QR не найден или уже использован' });
  }

  // Найти гостя
  const { data: guest, error: guestErr } = await supabase
    .from('guests')
    .select('*')
    .eq('telegram_id', pending.telegram_id)
    .single();

  if (guestErr || !guest) {
    return res.status(404).json({ error: 'Гость не найден' });
  }

  // Записать визит
  await supabase.from('visits').insert({
    telegram_id: pending.telegram_id,
    restaurant_id: restaurantId || null,
    visit_token: token,
  });

  // Увеличить счётчик визитов
  await supabase
    .from('guests')
    .update({ visit_count: guest.visit_count + 1 })
    .eq('telegram_id', pending.telegram_id);

  // Пометить токен использованным
  await supabase
    .from('pending_visits')
    .update({ used: true })
    .eq('token', token);

  return res.json({
    success: true,
    guest: {
      name: `${guest.first_name} ${guest.last_name}`.trim(),
      username: guest.username,
      visits: guest.visit_count + 1,
    },
  });
});

// ─── Получить профиль гостя по токену (до подтверждения) ─────────────────────
app.get('/api/guest-preview/:token', async (req, res) => {
  const { token } = req.params;

  const { data: pending } = await supabase
    .from('pending_visits')
    .select('telegram_id, used')
    .eq('token', token)
    .single();

  if (!pending) return res.status(404).json({ error: 'QR не найден' });
  if (pending.used) return res.status(400).json({ error: 'QR уже использован' });

  const { data: guest } = await supabase
    .from('guests')
    .select('first_name, last_name, username, visit_count')
    .eq('telegram_id', pending.telegram_id)
    .single();

  return res.json({ guest });
});

const PORT = process.env.WEB_PORT || 3000;
app.listen(PORT, () => console.log(`✅ Веб-интерфейс запущен: http://localhost:${PORT}`));
