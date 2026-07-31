/**
 * api/invite.js
 * GET  ?v=UUID         — public: returns event info for the invite landing page
 * POST { initData, venueId, invite_message } — protected: update invite message
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_URL = (process.env.APP_URL || 'https://great-guest.ru').replace(/\/$/, '');
const ORIGIN  = process.env.APP_ORIGIN || 'https://great-guest.ru';

// Broadcast rate limit: 1 per owner per venue per 5 minutes
const BROADCAST_RL = new Map();
function checkBroadcastRL(key) {
  const now = Date.now();
  const last = BROADCAST_RL.get(key) || 0;
  if (now - last < 5 * 60 * 1000) return false;
  BROADCAST_RL.set(key, now);
  return true;
}

// Merge rate limit: max 5 merges per organizer per hour
const MERGE_RL = new Map();
function checkMergeRL(ownerId) {
  const now = Date.now();
  const e = MERGE_RL.get(ownerId) || { count: 0, reset: now + 3600000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 3600000; }
  e.count++;
  MERGE_RL.set(ownerId, e);
  return e.count > 5;
}

const EV_ICONS = { 'Вечеринка':'🎉','Корпоратив':'💼','Конференция':'🎓','Спорт':'🏅','Гала-ужин':'🍷','Концерт':'🎵','Другое':'✨' };

function he(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmtDateLong(d) {
  if (!d) return null;
  return new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric', weekday:'long' });
}

function renderInviteHtml(venue) {
  const icon     = EV_ICONS[venue.event_type] || '🎉';
  const typeLabel = venue.event_type || 'Мероприятие';
  const dateStr  = fmtDateLong(venue.event_date);
  const ogDesc   = [typeLabel, dateStr, venue.city].filter(Boolean).join(' · ');
  const pageUrl  = `${APP_URL}/api/invite?v=${venue.id}`;
  const cover    = venue.cover_image_url || null;

  const metaRows = [];
  if (dateStr) metaRows.push({ icon:'📅', label:'Дата', text: dateStr });
  if (venue.address) metaRows.push({ icon:'📍', label:'Место', text: venue.address + (venue.city ? ', ' + venue.city : '') });
  else if (venue.city) metaRows.push({ icon:'📍', label:'Город', text: venue.city });

  const metaHtml = metaRows.map(m => `
    <div style="display:flex;align-items:flex-start;gap:10px;background:#1E1D2A;border-radius:12px;padding:10px 14px;margin-bottom:10px">
      <span style="font-size:16px;flex-shrink:0;margin-top:1px">${m.icon}</span>
      <div style="font-size:13px;line-height:1.4">
        <span style="font-size:11px;color:rgba(240,235,224,0.5);display:block;margin-bottom:2px">${m.label}</span>
        ${he(m.text)}
      </div>
    </div>`).join('');

  const msgHtml = venue.invite_message ? `
    <div style="background:rgba(201,169,110,0.06);border:1px solid rgba(201,169,110,0.15);border-radius:16px;padding:16px 18px;margin-bottom:24px;font-size:14px;color:#F0EBE0;line-height:1.65;white-space:pre-wrap;font-style:italic">
      <div style="font-size:11px;color:rgba(240,235,224,0.5);margin-bottom:8px;font-style:normal;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Сообщение от организатора</div>
      ${he(venue.invite_message)}
    </div>` : '';

  const coverStyle = cover
    ? `height:180px;background-image:url('${he(cover)}');background-size:cover;background-position:center;margin:-28px -24px 20px;border-radius:20px 20px 0 0`
    : `display:none`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
  <title>${he(venue.name)} — Great Guest</title>
  <meta property="og:title" content="${he(venue.name)}"/>
  <meta property="og:description" content="${he(ogDesc || 'Приглашение на мероприятие')}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${he(pageUrl)}"/>
  <meta property="og:site_name" content="Great Guest"/>
  ${cover ? `<meta property="og:image" content="${he(cover)}"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>` : ''}
  <meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}"/>
  <meta name="twitter:title" content="${he(venue.name)}"/>
  <meta name="twitter:description" content="${he(ogDesc || 'Приглашение на мероприятие')}"/>
  ${cover ? `<meta name="twitter:image" content="${he(cover)}"/>` : ''}
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--gold:#C9A96E;--gold2:#E8C97E;--bg:#0D0C12;--card:#161520;--text:#F0EBE0}
    html,body{min-height:100%;background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,sans-serif}
    body{display:flex;flex-direction:column;align-items:center;padding:0;min-height:100vh}
    .glow{position:fixed;top:-120px;left:50%;transform:translateX(-50%);width:400px;height:300px;
      background:radial-gradient(ellipse,rgba(201,169,110,0.12) 0%,transparent 70%);pointer-events:none;z-index:0}
    .wrap{width:100%;max-width:480px;margin:0 auto;padding:24px 20px 48px;position:relative;z-index:1}
    .brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:28px;padding-top:8px}
    .cta-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:18px;
      border-radius:16px;font-size:17px;font-weight:700;border:none;cursor:pointer;text-decoration:none;
      background:linear-gradient(135deg,var(--gold),var(--gold2));color:#0D0C12;
      box-shadow:0 4px 20px rgba(201,169,110,0.35);letter-spacing:-0.2px}
    .cta-btn:active{transform:scale(.97)}
    .cta-ghost{background:rgba(255,255,255,0.05);color:var(--text);border:1px solid rgba(255,255,255,0.08);box-shadow:none;margin-bottom:0}
  </style>
</head>
<body>
<div class="glow"></div>
<div class="wrap">
  <div class="brand">
    <div style="font-size:15px;font-weight:800;letter-spacing:-0.3px">Great<span style="color:var(--gold)">Guest</span></div>
    <div style="width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,0.08)"></div>
    <div style="font-size:12px;color:rgba(240,235,224,0.5);font-weight:500">Приглашение</div>
  </div>

  <div style="position:relative;background:var(--card);border:1px solid rgba(201,169,110,0.2);border-radius:24px;padding:28px 24px;margin-bottom:20px;box-shadow:0 8px 40px rgba(0,0,0,0.4)">
    <div style="${coverStyle}"></div>
    ${cover ? '' : `<div style="font-size:48px;text-align:center;margin-bottom:16px">${icon}</div>`}
    <div style="text-align:center">
      <div style="display:inline-flex;align-items:center;background:rgba(201,169,110,0.12);border:1px solid rgba(201,169,110,0.25);border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600;color:var(--gold);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px">${he(typeLabel)}</div>
    </div>
    <div style="font-size:26px;font-weight:800;text-align:center;letter-spacing:-0.5px;line-height:1.2;margin-bottom:20px">${he(venue.name)}</div>
    <div>${metaHtml}</div>
    ${msgHtml}
  </div>

  <a class="cta-btn" href="https://t.me/great_guest_bot?start=rsvp_${venue.id}" style="margin-bottom:14px">
    <span style="font-size:20px">✅</span>
    <span>Подтвердить участие</span>
  </a>

  <div style="display:flex;align-items:center;gap:10px;margin:14px 0;color:rgba(240,235,224,0.5);font-size:12px">
    <div style="flex:1;height:1px;background:rgba(255,255,255,0.08)"></div>
    или
    <div style="flex:1;height:1px;background:rgba(255,255,255,0.08)"></div>
  </div>

  <a class="cta-btn cta-ghost" href="https://t.me/great_guest_bot?start=qr_${venue.id}">
    <span style="font-size:20px">📱</span>
    <span>Получить QR-код для входа</span>
  </a>

  <div style="text-align:center;font-size:11px;color:rgba(240,235,224,0.5);line-height:1.6;margin-top:16px;padding:0 8px">
    <strong style="color:var(--text)">Подтвердить участие</strong> — зарегистрируйтесь на событие в боте (RSVP).<br><br>
    <strong style="color:var(--text)">QR-код для входа</strong> — бот пришлёт код, который организатор отсканирует на входе.
  </div>

  <div style="text-align:center;margin-top:28px;font-size:12px;color:rgba(240,235,224,0.25)">Powered by <strong style="color:var(--gold)">Great Guest</strong></div>
</div>
</body>
</html>`;
}
const TG_API  = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

const LEVELS = [
  { name: 'Bronze',   min: 1  },
  { name: 'Silver',   min: 5  },
  { name: 'Gold',     min: 15 },
  { name: 'Platinum', min: 30 },
];
function getLevel(n) {
  if (n < 1) return 'Bronze';
  return ([...LEVELS].reverse().find(l => n >= l.min) || LEVELS[0]).name;
}

async function tgSend(chatId, text, replyMarkup) {
  try {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
    return r.ok;
  } catch { return false; }
}

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
    params.delete('hash');
    const str = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
    const computed = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── GET: public event info ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const venueId = req.query.v;
    if (!venueId || !UUID_RE.test(venueId))
      return res.status(400).json({ error: 'invalid venue id' });

    const { data: venue, error } = await db
      .from('restaurants')
      .select('id, name, venue_type, event_type, event_date, address, city, invite_message, cover_image_url')
      .eq('id', venueId)
      .single();

    if (error || !venue) return res.status(404).json({ error: 'not found' });

    // Browser / Telegram link-preview scraper → serve full HTML with OG tags
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderInviteHtml(venue));
    }

    // API clients (fetch without Accept: text/html) → return JSON
    return res.status(200).json({
      id:             venue.id,
      name:           venue.name,
      venue_type:     venue.venue_type,
      event_type:     venue.event_type,
      event_date:     venue.event_date,
      address:        venue.address,
      city:           venue.city,
      invite_message:   venue.invite_message || '',
      cover_image_url:  venue.cover_image_url || null,
    });
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { initData, venueId, invite_message, action, filter, customMessage } = req.body || {};
    if (!initData) return res.status(400).json({ error: 'initData required' });
    if (!validateInitData(initData, process.env.BOT_TOKEN))
      return res.status(401).json({ error: 'Invalid signature' });

    const params   = new URLSearchParams(initData);
    const tgUser   = JSON.parse(params.get('user') || '{}');
    const ownerId  = String(tgUser.id || '');
    const senderName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Организатор';
    if (!ownerId) return res.status(401).json({ error: 'No user' });

    // ── action: merge_guest — перенос истории на новый аккаунт ───────────────
    if (action === 'merge_guest') {
      if (checkMergeRL(ownerId))
        return res.status(429).json({ error: 'too_many_requests', message: 'Максимум 5 слияний в час' });

      const oldId = String(req.body.old_telegram_id || '').trim();
      const newId = String(req.body.new_telegram_id || '').trim();
      if (!/^\d+$/.test(oldId) || !/^\d+$/.test(newId))
        return res.status(400).json({ error: 'Некорректные Telegram ID' });
      if (oldId === newId)
        return res.status(400).json({ error: 'same_account', message: 'Это один и тот же аккаунт' });

      // Security: old guest must be in organizer's own contact base
      const { data: contact } = await db
        .from('organizer_contacts')
        .select('guest_id')
        .eq('organizer_id', ownerId)
        .eq('guest_id', oldId)
        .maybeSingle();
      if (!contact)
        return res.status(403).json({ error: 'guest_not_in_your_base', message: 'Гость не найден в вашей базе' });

      // Security: new account must be a registered guest (prevents history theft via unknown IDs)
      const { data: newGuest } = await db
        .from('guests')
        .select('telegram_id')
        .eq('telegram_id', newId)
        .maybeSingle();
      if (!newGuest)
        return res.status(404).json({ error: 'new_account_not_registered', message: 'Новый аккаунт не зарегистрирован в Great Guest' });

      const { data: result, error: rpcErr } = await db.rpc('merge_guest_accounts', {
        p_old_telegram_id: oldId,
        p_new_telegram_id: newId,
      });
      if (rpcErr || !result || result.error)
        return res.status(400).json({ error: result?.error || rpcErr?.message || 'merge_failed' });

      return res.status(200).json({ success: true, merged_visits: result.merged_visits });
    }

    if (!venueId) return res.status(400).json({ error: 'venueId required' });
    if (!UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });

    const { data: venue, error: fetchErr } = await db
      .from('restaurants')
      .select('id, name, owner_telegram_id, venue_type, event_type, event_date, address, city, invite_message, classification_mode')
      .eq('id', venueId)
      .single();

    if (fetchErr || !venue) return res.status(404).json({ error: 'Venue not found' });
    if (venue.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });

    // ── action: update_event ──────────────────────────────────────────────────
    if (action === 'update_event') {
      const updates = {};
      if (req.body.name !== undefined) {
        const n = String(req.body.name).trim().slice(0, 80);
        if (!n) return res.status(400).json({ error: 'Название не может быть пустым' });
        updates.name = n;
      }
      if (req.body.event_type !== undefined) updates.event_type = String(req.body.event_type || '').slice(0, 60);
      if (req.body.event_date !== undefined) {
        const _dateVal = req.body.event_date;
        if (_dateVal && isNaN(Date.parse(_dateVal)))
          return res.status(400).json({ error: 'Неверный формат даты события' });
        updates.event_date = _dateVal || null;
      }
      if (req.body.address !== undefined) updates.address = String(req.body.address || '').trim().slice(0, 120);
      if (req.body.city !== undefined) updates.city = String(req.body.city || '').trim().slice(0, 60);
      if (req.body.invite_message !== undefined) updates.invite_message = String(req.body.invite_message || '').trim().slice(0, 1000);
      if (req.body.classification_mode !== undefined) {
        const m = req.body.classification_mode;
        if (m === 'guestlist' || m === 'loyalty') updates.classification_mode = m;
      }

      const { error: upErr } = await db.from('restaurants').update(updates).eq('id', venueId);
      if (upErr) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ success: true, venue: { ...venue, ...updates } });
    }

    // ── action: broadcast ──────────────────────────────────────────────────────
    if (action === 'broadcast') {
      // Verify organizer has active subscription before allowing broadcast
      const { data: ownerSub } = await db
        .from('owner_subscriptions')
        .select('subscription_status, subscription_expires_at')
        .eq('telegram_id', ownerId)
        .single();
      const subActive = ownerSub
        && (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active')
        && ownerSub.subscription_expires_at
        && new Date(ownerSub.subscription_expires_at) > new Date();
      if (!subActive) return res.status(403).json({ error: 'subscription_required', message: 'Рассылки доступны только на активном тарифе.' });

      if (!checkBroadcastRL(`${ownerId}:${venueId}`))
        return res.status(429).json({ error: 'too_many_requests', message: 'Подождите 5 минут между рассылками' });

      const levelFilter = String(filter || 'all');
      const msgText     = String(customMessage || '').trim().slice(0, 1000);

      // Load organizer contacts (capped at 200 per broadcast)
      const { data: allContacts } = await db
        .from('organizer_contacts')
        .select('guest_id, first_name')
        .eq('organizer_id', ownerId);

      const totalContacts = (allContacts || []).length;
      const contacts = (allContacts || []).slice(0, 200);
      const capped = totalContacts > 200;

      if (!contacts || contacts.length === 0)
        return res.status(200).json({ sent: 0, failed: 0, total: 0, capped: false });

      // Enrich with global visit_count for level filtering
      const guestIds = contacts.map(c => c.guest_id);
      const { data: guestStats } = await db
        .from('guests')
        .select('telegram_id, visit_count')
        .in('telegram_id', guestIds);

      const statsMap = {};
      (guestStats || []).forEach(g => { statsMap[g.telegram_id] = g.visit_count || 0; });

      // Apply level filter
      const targets = contacts.filter(c => {
        if (levelFilter === 'all') return true;
        return getLevel(statsMap[c.guest_id] || 0) === levelFilter;
      });

      if (targets.length === 0)
        return res.status(200).json({ sent: 0, failed: 0, total: 0 });

      // Build message
      const inviteLink = `${APP_URL}/api/invite?v=${venueId}`;
      const dateStr = venue.event_date
        ? `\n📅 ${new Date(venue.event_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
        : '';
      const locStr = venue.address
        ? `\n📍 ${venue.address}${venue.city ? ', ' + venue.city : ''}`
        : venue.city ? `\n📍 ${venue.city}` : '';

      const tgText = `🎉 *${venue.name}*${dateStr}${locStr}${msgText ? '\n\n' + msgText : ''}\n\n_Приглашает: ${senderName}_`;
      const markup = { inline_keyboard: [[
        { text: '✅ Подтвердить участие', url: inviteLink },
      ]]};

      // Send in parallel batches of 30
      let sent = 0, failed = 0;
      for (let i = 0; i < targets.length; i += 30) {
        const batch = targets.slice(i, i + 30);
        const results = await Promise.allSettled(
          batch.map(c => tgSend(c.guest_id, tgText, markup))
        );
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) sent++;
          else failed++;
        });
      }

      return res.status(200).json({ success: true, sent, failed, total: targets.length, totalContacts, capped });
    }

    // ── action: update invite_message (default) ────────────────────────────────
    const msg = String(invite_message || '').trim().slice(0, 1000);
    const { error: updErr } = await db
      .from('restaurants')
      .update({ invite_message: msg })
      .eq('id', venueId);

    if (updErr) return res.status(500).json({ error: 'Update failed' });
    return res.status(200).json({ success: true, invite_message: msg });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
