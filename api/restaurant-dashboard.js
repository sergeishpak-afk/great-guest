/**
 * api/restaurant-dashboard.js
 * POST — returns dashboard data for restaurant owner (multi-venue):
 *   - owner subscription info
 *   - all venues with individual stats
 *   - global guest list (ALL guests in network)
 *   - sent offers history across all venues
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');
const { formatStatus } = require('../src/status');

const db  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

// Rate limit for bonus visits: 10 per owner per minute
const BONUS_RL = new Map();
function checkBonusLimit(ownerId) {
  const now = Date.now();
  const e = BONUS_RL.get(ownerId) || { count: 0, start: now };
  if (now - e.start > 60_000) { e.count = 0; e.start = now; }
  e.count++;
  BONUS_RL.set(ownerId, e);
  return e.count <= 10;
}

const PLANS = {
  trial:   { label: 'Старт',    max_venues: 1,   price: 0,     price_label: 'Бесплатно 14 дней' },
  event:   { label: 'Разовый',  max_venues: 1,   price: 490,   price_label: '490 ₽ разово'      },
  basic:   { label: 'Базовый',  max_venues: 1,   price: 2990,  price_label: '2 990 ₽/мес'       },
  network: { label: 'Сеть',     max_venues: 5,   price: 7990,  price_label: '7 990 ₽/мес'       },
  empire:  { label: 'Империя',  max_venues: 999, price: 19990, price_label: '19 990 ₽/мес'      },
};

function validateInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    // Reject requests older than 1 hour (replay-attack protection)
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
  res.setHeader('Access-Control-Allow-Origin', 'https://great-guest.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'initData required' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // ── action: check_subscription — lightweight check for payment polling ───────
  if ((req.body || {}).action === 'check_subscription') {
    const { data: sub } = await db
      .from('owner_subscriptions')
      .select('subscription_status, subscription_expires_at')
      .eq('telegram_id', ownerId)
      .maybeSingle();
    const isActive = sub && sub.subscription_status === 'active'
      && sub.subscription_expires_at && new Date(sub.subscription_expires_at) > new Date();
    return res.status(200).json({ subscription_status: sub?.subscription_status || null, is_active: !!isActive });
  }

  // ── action: get_rsvp_list — RSVP guests for a guestlist venue ───────────────
  if ((req.body || {}).action === 'get_rsvp_list') {
    const { venueId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    const { data: rsvps } = await db
      .from('rsvp')
      .select('telegram_id, first_name, last_name, username, created_at, status')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false });
    return res.status(200).json({ rsvps: rsvps || [] });
  }

  // ── action: remove_rsvp — remove a guest from guestlist ─────────────────────
  if ((req.body || {}).action === 'remove_rsvp') {
    const { venueId, telegramId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!telegramId || !/^\d+$/.test(telegramId)) return res.status(400).json({ error: 'invalid telegramId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    await db.from('rsvp').delete().eq('venue_id', venueId).eq('telegram_id', telegramId);
    return res.status(200).json({ success: true });
  }

  // ── action: add_rsvp — manually add a guest to guestlist ────────────────────
  if ((req.body || {}).action === 'add_rsvp') {
    const { venueId, telegramId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!telegramId || !/^\d+$/.test(telegramId)) return res.status(400).json({ error: 'invalid telegramId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    // В-3: Require active subscription (same as approve_rsvp)
    const { data: addSub } = await db.from('owner_subscriptions').select('subscription_status, subscription_expires_at').eq('telegram_id', ownerId).single();
    const addSubExp = addSub?.subscription_expires_at ? new Date(addSub.subscription_expires_at) : null;
    const addSubActive = addSub && (addSub.subscription_status === 'active' || addSub.subscription_status === 'trial') && addSubExp && addSubExp > new Date();
    if (!addSubActive)
      return res.status(403).json({ error: 'Управление гостевым списком доступно только на платном тарифе' });
    const { error } = await db.from('rsvp').upsert(
      { venue_id: venueId, telegram_id: telegramId, status: 'approved' },
      { onConflict: 'venue_id,telegram_id' }
    );
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // ── action: approve_rsvp — approve a pending RSVP request ────────────────────
  if ((req.body || {}).action === 'approve_rsvp') {
    const { venueId, telegramId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!telegramId || !/^\d+$/.test(telegramId)) return res.status(400).json({ error: 'invalid telegramId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id, name').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    const { data: sub } = await db.from('owner_subscriptions').select('subscription_status, subscription_expires_at').eq('telegram_id', ownerId).single();
    const subExpires = sub?.subscription_expires_at ? new Date(sub.subscription_expires_at) : null;
    const subActive = sub && (sub.subscription_status === 'active' || sub.subscription_status === 'trial') && subExpires && subExpires > new Date();
    if (!subActive)
      return res.status(403).json({ error: 'Управление заявками доступно только на платном тарифе' });
    await db.from('rsvp').update({ status: 'approved' }).eq('venue_id', venueId).eq('telegram_id', telegramId);
    try {
      await bot.telegram.sendMessage(telegramId,
        `✅ *Заявка одобрена!*\n\n📍 *${ven.name}*\n\nВы в списке гостей. Нажмите кнопку ниже чтобы открыть кабинет и получить QR-код для входа.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{
              text: '🎫 Открыть кабинет и получить QR',
              web_app: { url: 'https://great-guest.vercel.app/app.html' },
            }]],
          },
        });
    } catch (e) { console.error('Approve notify error:', e.message); }
    return res.status(200).json({ success: true });
  }

  // ── action: reject_rsvp — reject a pending RSVP request ─────────────────────
  if ((req.body || {}).action === 'reject_rsvp') {
    const { venueId, telegramId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!telegramId || !/^\d+$/.test(telegramId)) return res.status(400).json({ error: 'invalid telegramId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id, name').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    const { data: sub } = await db.from('owner_subscriptions').select('subscription_status, subscription_expires_at').eq('telegram_id', ownerId).single();
    const subExpires = sub?.subscription_expires_at ? new Date(sub.subscription_expires_at) : null;
    const rejectSubActive = sub && (sub.subscription_status === 'active' || sub.subscription_status === 'trial') && subExpires && subExpires > new Date();
    if (!rejectSubActive)
      return res.status(403).json({ error: 'Управление заявками доступно только на платном тарифе' });
    await db.from('rsvp').update({ status: 'rejected' }).eq('venue_id', venueId).eq('telegram_id', telegramId);
    try {
      await bot.telegram.sendMessage(telegramId,
        `❌ *Заявка отклонена*\n\n📍 *${ven.name}*\n\nК сожалению, организатор не смог подтвердить вашу заявку.`,
        { parse_mode: 'Markdown' });
    } catch (e) { console.error('Reject notify error:', e.message); }
    return res.status(200).json({ success: true });
  }

  // ── action: bonus_visit — award a bonus visit to a guest ──────────────────
  if ((req.body || {}).action === 'bonus_visit') {
    const { guestTelegramId, restaurantId: rid, reason } = req.body;
    if (!guestTelegramId) return res.status(400).json({ error: 'guestTelegramId required' });
    if (rid && !UUID_RE.test(rid)) return res.status(400).json({ error: 'invalid restaurantId' });
    if (!checkBonusLimit(ownerId)) return res.status(429).json({ error: 'too_many_requests' });

    const { data: ownerSub } = await db.from('owner_subscriptions').select('subscription_status,subscription_expires_at').eq('telegram_id', ownerId).single();
    const expires = ownerSub?.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
    const isActive = ownerSub && (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && expires && expires > new Date();
    if (!isActive) return res.status(403).json({ error: 'subscription_expired' });

    let venueQ = db.from('restaurants').select('*').eq('owner_telegram_id', ownerId);
    if (rid) venueQ = venueQ.eq('id', rid);
    const { data: restaurant } = await venueQ.single();
    if (!restaurant) return res.status(403).json({ error: 'venue_not_found' });

    const { data: guest } = await db.from('guests').select('*').eq('telegram_id', guestTelegramId).single();
    if (!guest) return res.status(404).json({ error: 'guest_not_found' });

    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data: recentBonus } = await db.from('visits').select('id')
      .eq('telegram_id', guestTelegramId).eq('restaurant_id', restaurant.id)
      .eq('visit_type', 'bonus').gte('created_at', oneHourAgo).limit(1);
    if (recentBonus && recentBonus.length > 0)
      return res.status(429).json({ error: 'Бонус этому гостю уже начислен в последний час' });

    // Atomic visit_count increment (prevents race condition on simultaneous bonuses)
    const { data: newCount, error: rpcError } = await db
      .rpc('increment_guest_visits', { p_telegram_id: guestTelegramId });

    if (rpcError || newCount === null) {
      console.error('increment_guest_visits error:', rpcError?.message);
      return res.status(500).json({ error: 'Ошибка обновления счётчика' });
    }

    await db.from('visits').insert({ telegram_id: guestTelegramId, restaurant_id: restaurant.id, visit_type: 'bonus', visit_token: null });

    const bonusNote = reason ? `\n💬 _${reason}_` : '';
    try {
      await bot.telegram.sendMessage(guestTelegramId,
        `🎁 *Бонус-визит начислен!*\n\n📍 ${restaurant.name}${bonusNote}\n\n${formatStatus(newCount)}`,
        { parse_mode: 'Markdown' });
    } catch (e) { console.error('Bonus notify error:', e.message); }

    return res.status(200).json({ success: true, newVisitCount: newCount,
      guest: { name: `${guest.first_name} ${guest.last_name || ''}`.trim(), visits: newCount } });
  }

  // ── action: update_cover ────────────────────────────────────────────────────
  if ((req.body || {}).action === 'update_cover') {
    const { venueId, base64, mimeType } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    if (!base64 || typeof base64 !== 'string') return res.status(400).json({ error: 'base64 required' });

    const { data: ven, error: venErr } = await db
      .from('restaurants').select('id, owner_telegram_id').eq('id', venueId).single();
    if (venErr || !ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });

    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 4 MB)' });

    const BUCKET = 'event-covers';
    await db.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    // Unique filename per upload — CDN never caches stale version
    const storagePath = `${ownerId}/${venueId}_${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage
      .from(BUCKET).upload(storagePath, buf, { contentType: mimeType || 'image/jpeg', upsert: false });
    if (upErr) return res.status(500).json({ error: 'Upload failed' });

    const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(storagePath);
    const { error: dbErr } = await db.from('restaurants').update({ cover_image_url: publicUrl }).eq('id', venueId);
    if (dbErr) return res.status(500).json({ error: 'DB update failed' });
    return res.status(200).json({ success: true, url: publicUrl });
  }

  // ── action: set_status_override — manually pin a guest's status ─────────────
  if ((req.body || {}).action === 'set_status_override') {
    const { guestId, override } = req.body || {};
    if (!guestId) return res.status(400).json({ error: 'guestId required' });
    const VALID = ['Bronze', 'Silver', 'Gold', 'Platinum', 'VIP', null];
    if (!VALID.includes(override === undefined ? null : override))
      return res.status(400).json({ error: 'invalid override value' });
    const { error: dbErr } = await db
      .from('organizer_contacts')
      .update({ status_override: override || null })
      .eq('organizer_id', ownerId)
      .eq('guest_id', String(guestId));
    if (dbErr) return res.status(500).json({ error: 'DB error' });
    return res.status(200).json({ success: true });
  }

  // ── action: export_visits_csv — flat visits + guest info CSV via bot ────────
  if ((req.body || {}).action === 'export_visits_csv') {
    const { data: venues } = await db
      .from('restaurants')
      .select('id')
      .eq('owner_telegram_id', ownerId);

    const venueIds = (venues || []).map(v => v.id);
    if (!venueIds.length) {
      return res.status(200).json({ success: true, count: 0, capped: false });
    }

    const { data: visits } = await db
      .from('visits')
      .select('visited_at, visit_type, telegram_id, restaurant_id, restaurants(name), guests(first_name, last_name, username, visit_count)')
      .in('restaurant_id', venueIds)
      .order('visited_at', { ascending: false })
      .limit(2000);

    const getLevel = (n) => {
      if (n >= 30) return 'Platinum';
      if (n >= 15) return 'Gold';
      if (n >= 5)  return 'Silver';
      return 'Bronze';
    };

    const rows = [['Дата визита', 'Время', 'Заведение', 'Тип', 'Имя', 'Фамилия', 'Username', 'Telegram ID', 'Статус', 'Визитов всего']];
    for (const v of (visits || [])) {
      const dt = v.visited_at ? new Date(v.visited_at) : null;
      const g = v.guests || {};
      rows.push([
        dt ? dt.toLocaleDateString('ru-RU') : '',
        dt ? dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '',
        v.restaurants?.name || '',
        v.visit_type === 'bonus' ? 'Бонус' : 'QR',
        g.first_name || '',
        g.last_name  || '',
        g.username   ? '@' + g.username : '',
        v.telegram_id || '',
        getLevel(g.visit_count || 0),
        g.visit_count || 0,
      ]);
    }

    const escape = v => `"${String(v).replace(/"/g, '""')}"`;
    const csv = '﻿' + rows.map(r => r.map(escape).join(',')).join('\r\n');
    const csvBuffer = Buffer.from(csv, 'utf-8');

    const dateStr = new Date().toLocaleDateString('ru-RU');
    const filename = `great-guest-visits_${dateStr.replace(/\./g, '-')}.csv`;
    const totalRows = (visits || []).length;
    const form = new FormData();
    form.set('chat_id', ownerId);
    form.set('caption', `📅 Визиты + гости · ${dateStr}\nЗаписей: ${totalRows}${totalRows === 2000 ? ' (последние 2 000)' : ''}`);
    form.set('document', new Blob([csvBuffer], { type: 'text/csv' }), filename);

    const tgRes = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`,
      { method: 'POST', body: form }
    );
    if (!tgRes.ok) return res.status(500).json({ error: 'Telegram send failed' });
    return res.status(200).json({ success: true, count: totalRows, capped: totalRows === 2000 });
  }

  // ── action: export_csv — generate guest list CSV and send via bot ──────────
  if ((req.body || {}).action === 'export_csv') {
    const [{ data: contacts }, { count: totalContacts }] = await Promise.all([
      db.from('organizer_contacts')
        .select('guest_id, first_name, last_name, username, total_visits, rsvp_count, last_seen_at')
        .eq('organizer_id', ownerId)
        .order('last_seen_at', { ascending: false })
        .limit(500),
      db.from('organizer_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('organizer_id', ownerId),
    ]);

    const rows = [['Имя', 'Фамилия', 'Username', 'Telegram ID', 'Визитов', 'RSVP', 'Последний визит']];
    for (const g of (contacts || [])) {
      rows.push([
        g.first_name || '',
        g.last_name  || '',
        g.username   ? '@' + g.username : '',
        g.guest_id,
        g.total_visits || 0,
        g.rsvp_count   || 0,
        g.last_seen_at ? new Date(g.last_seen_at).toLocaleDateString('ru-RU') : '',
      ]);
    }

    const escape = v => `"${String(v).replace(/"/g, '""')}"`;
    const csv = '﻿' + rows.map(r => r.map(escape).join(',')).join('\r\n');
    const csvBuffer = Buffer.from(csv, 'utf-8');

    const dateStr = new Date().toLocaleDateString('ru-RU');
    const filename = `great-guest_${dateStr.replace(/\./g, '-')}.csv`;

    const form = new FormData();
    form.set('chat_id', ownerId);
    form.set('caption', `📊 Аналитика гостей · ${dateStr}\nВсего: ${(contacts || []).length} контактов`);
    form.set('document', new Blob([csvBuffer], { type: 'text/csv' }), filename);

    const tgRes = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`,
      { method: 'POST', body: form }
    );
    if (!tgRes.ok) {
      const err = await tgRes.json().catch(() => ({}));
      return res.status(500).json({ error: 'Telegram send failed' });
    }
    const contactsArr = contacts || [];
    return res.status(200).json({ success: true, count: contactsArr.length, total: totalContacts || contactsArr.length, capped: contactsArr.length === 500 });
  }

  // ── action: sync_avatar — fetch TG profile photo + store in Supabase ─────────
  if ((req.body || {}).action === 'sync_avatar') {
    const AVATAR_BUCKET = 'profiles';
    await db.storage.createBucket(AVATAR_BUCKET, { public: true }).catch(() => {});

    const photosRes = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUserProfilePhotos?user_id=${ownerId}&limit=1`
    );
    const photosData = await photosRes.json();

    if (!photosData.ok || !photosData.result?.total_count) {
      return res.status(200).json({ url: null });
    }

    const fileId  = photosData.result.photos[0][0].file_id;
    const fileRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) return res.status(200).json({ url: null });

    const imgRes = await fetch(
      `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileData.result.file_path}`
    );
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());

    const avatarPath = `${ownerId}/avatar_${Date.now()}.jpg`;
    await db.storage.from(AVATAR_BUCKET).upload(avatarPath, imgBuf, { contentType: 'image/jpeg', upsert: false });
    const { data: { publicUrl: avatarUrl } } = db.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);

    await db.from('owner_subscriptions').update({ profile_photo_url: avatarUrl }).eq('telegram_id', ownerId);
    return res.status(200).json({ success: true, url: avatarUrl });
  }

  // ── action: update_avatar — custom photo upload ───────────────────────────
  if ((req.body || {}).action === 'update_avatar') {
    const { base64, mimeType: avatarMime } = req.body;
    if (!base64 || typeof base64 !== 'string') return res.status(400).json({ error: 'base64 required' });
    const avatarBuf = Buffer.from(base64, 'base64');
    if (avatarBuf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 4 MB)' });

    const AVATAR_BUCKET = 'profiles';
    await db.storage.createBucket(AVATAR_BUCKET, { public: true }).catch(() => {});

    const avatarExt  = avatarMime === 'image/png' ? 'png' : 'jpg';
    const avatarPath = `${ownerId}/avatar_${Date.now()}.${avatarExt}`;
    const { error: avErr } = await db.storage
      .from(AVATAR_BUCKET).upload(avatarPath, avatarBuf, { contentType: avatarMime || 'image/jpeg', upsert: false });
    if (avErr) return res.status(500).json({ error: 'Upload failed' });

    const { data: { publicUrl: avatarUrl } } = db.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
    await db.from('owner_subscriptions').update({ profile_photo_url: avatarUrl }).eq('telegram_id', ownerId);
    return res.status(200).json({ success: true, url: avatarUrl });
  }

  // 1. Get owner subscription
  let { data: ownerSub, error: subError } = await db
    .from('owner_subscriptions')
    .select('*')
    .eq('telegram_id', ownerId)
    .single();

  // 2. Get all venues for this owner
  const { data: venues, error: venuesError } = await db
    .from('restaurants')
    .select('*')
    .eq('owner_telegram_id', ownerId)
    .order('created_at', { ascending: true })
    .limit(20);

  if (venuesError) {
    console.error('restaurants select error:', venuesError);
    return res.status(500).json({ error: 'DB error' });
  }

  const venuesList = venues || [];

  // 3. Handle not registered case
  if (!ownerSub && venuesList.length === 0) {
    return res.status(404).json({ error: 'not_registered' });
  }

  // 4. Legacy case: venues exist but no subscription — auto-create expired trial
  if (!ownerSub && venuesList.length > 0) {
    const now = new Date();
    const { data: newSub, error: insertError } = await db
      .from('owner_subscriptions')
      .insert({
        telegram_id: ownerId,
        plan: 'trial',
        max_venues: 1,
        subscription_status: 'trial',
        trial_started_at: now.toISOString(),
        subscription_expires_at: now.toISOString(), // Expired immediately
      })
      .select()
      .single();

    if (insertError) {
      console.error('owner_subscriptions insert error:', insertError);
      return res.status(500).json({ error: 'DB error' });
    }
    ownerSub = newSub;
  }

  // 5. Build owner info
  const now = new Date();
  const expires = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
  const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && expires && expires > now;

  const { count: referralCount } = await db
    .from('owner_subscriptions')
    .select('*', { count: 'exact', head: true })
    .eq('referred_by', ownerId);

  const ownerInfo = {
    plan: ownerSub.plan,
    max_venues: ownerSub.max_venues,
    subscription_status: ownerSub.subscription_status,
    days_left: daysLeft,
    is_active: isActive,
    subscription_expires_at: ownerSub.subscription_expires_at,
    profile_photo_url: ownerSub.profile_photo_url || null,
    referral_count: referralCount || 0,
    referral_rewarded_count: ownerSub.referral_rewarded_count || 0,
  };

  // 6. Get stats for each venue (parallel queries)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const venueIds = venuesList.map(v => v.id);

  const venuesWithStats = await Promise.all(
    venuesList.map(async (venue) => {
      const [visits30dResult, totalVisitsResult, offersCountResult, rsvpCountResult] = await Promise.all([
        // Visits in last 30 days
        db
          .from('visits')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id)
          .gte('visited_at', thirtyDaysAgo),
        // Total visits
        db
          .from('visits')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id),
        // Offers count
        db
          .from('offers')
          .select('*', { count: 'exact', head: true })
          .eq('restaurant_id', venue.id),
        // RSVP confirmations (approved only)
        db
          .from('rsvp')
          .select('*', { count: 'exact', head: true })
          .eq('venue_id', venue.id)
          .eq('status', 'approved'),
      ]);

      return {
        ...venue,
        stats: {
          visits30d: visits30dResult.count || 0,
          totalVisits: totalVisitsResult.count || 0,
          offersCount: offersCountResult.count || 0,
          rsvpCount: rsvpCountResult.count || 0,
        },
      };
    })
  );

  // 7. Get organizer's persistent contact base + offers
  let globalGuests = [];
  let offers = [];

  if (isActive) {
    const [contactsResult, offersResult] = await Promise.all([
      db
        .from('organizer_contacts')
        .select('guest_id, first_name, last_name, username, total_visits, rsvp_count, last_seen_at, status_override')
        .eq('organizer_id', ownerId)
        .order('last_seen_at', { ascending: false })
        .limit(500),  // Note: if 500 records returned, list may be truncated
      venueIds.length > 0
        ? db
            .from('offers')
            .select('id, restaurant_id, guest_telegram_id, offer_text, status, created_at')
            .in('restaurant_id', venueIds)
            .order('created_at', { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [] }),
    ]);

    let contactRows = contactsResult.data || [];
    offers = offersResult.data || [];

    // ── Fallback: organizer_contacts is empty — build from visits + rsvp directly ──
    if (contactRows.length === 0 && venueIds.length > 0) {
      const [visitsRaw, rsvpRaw] = await Promise.all([
        db.from('visits')
          .select('telegram_id, restaurant_id, visited_at')
          .in('restaurant_id', venueIds)
          .order('visited_at', { ascending: false })
          .limit(2000),
        db.from('rsvp')
          .select('telegram_id, venue_id, created_at, first_name, last_name, username')
          .in('venue_id', venueIds)
          .limit(2000),
      ]);

      // Aggregate by telegram_id
      const map = {};
      for (const v of (visitsRaw.data || [])) {
        if (!map[v.telegram_id]) map[v.telegram_id] = { guest_id: v.telegram_id, total_visits: 0, rsvp_count: 0, last_seen_at: v.visited_at, first_name: '', last_name: '', username: '' };
        map[v.telegram_id].total_visits++;
        if (v.visited_at > map[v.telegram_id].last_seen_at) map[v.telegram_id].last_seen_at = v.visited_at;
      }
      for (const r of (rsvpRaw.data || [])) {
        if (!map[r.telegram_id]) map[r.telegram_id] = { guest_id: r.telegram_id, total_visits: 0, rsvp_count: 0, last_seen_at: r.created_at, first_name: r.first_name||'', last_name: r.last_name||'', username: r.username||'' };
        map[r.telegram_id].rsvp_count++;
        if (!map[r.telegram_id].first_name) { map[r.telegram_id].first_name = r.first_name||''; map[r.telegram_id].last_name = r.last_name||''; map[r.telegram_id].username = r.username||''; }
      }
      contactRows = Object.values(map);

      // Backfill organizer_contacts — cap at 200 per load to protect DB connection pool
      const backfillRows = contactRows.slice(0, 200);
      for (const c of backfillRows) {
        db.rpc('upsert_organizer_contact', {
          p_org: ownerId, p_guest: c.guest_id,
          p_first: c.first_name, p_last: c.last_name, p_user: c.username, p_rsvp: false,
        }).then().catch(() => {});
      }
    }

    // Enrich with global visit_count + names from guests table
    const contactIds = contactRows.map(c => c.guest_id);
    let statsMap = {}, nameMap = {};
    if (contactIds.length > 0) {
      const { data: guestStats } = await db
        .from('guests')
        .select('telegram_id, visit_count, last_visit_at, first_name, last_name, username')
        .in('telegram_id', contactIds);
      (guestStats || []).forEach(g => {
        statsMap[g.telegram_id] = g;
        nameMap[g.telegram_id]  = g;
      });
    }

    globalGuests = contactRows.map(c => ({
      telegram_id:     c.guest_id,
      first_name:      nameMap[c.guest_id]?.first_name  || c.first_name  || '',
      last_name:       nameMap[c.guest_id]?.last_name   || c.last_name   || '',
      username:        nameMap[c.guest_id]?.username    || c.username    || '',
      visit_count:     statsMap[c.guest_id]?.visit_count  || 0,
      last_visit_at:   statsMap[c.guest_id]?.last_visit_at || c.last_seen_at,
      org_visits:      c.total_visits,
      rsvp_count:      c.rsvp_count,
      status_override: c.status_override || null,
    })).sort((a, b) => (b.visit_count || 0) - (a.visit_count || 0));
  }

  // 8. Build targeted IDs set from all offers
  const targetedIds = new Set((offers || []).map(o => o.guest_telegram_id));

  // 9. Build per-venue guest map (for filtering in s-dash)
  let venueGuestIds = {};
  if (venueIds.length > 0) {
    const { data: venueVisits } = await db
      .from('visits')
      .select('telegram_id, restaurant_id')
      .in('restaurant_id', venueIds);
    if (venueVisits) {
      venueVisits.forEach(({ telegram_id, restaurant_id }) => {
        if (!venueGuestIds[restaurant_id]) venueGuestIds[restaurant_id] = [];
        if (!venueGuestIds[restaurant_id].includes(String(telegram_id))) {
          venueGuestIds[restaurant_id].push(String(telegram_id));
        }
      });
    }
  }

  // 10. Return response
  const guestsTruncated = globalGuests.length === 500;
  return res.status(200).json({
    owner: ownerInfo,
    venues: venuesWithStats,
    globalGuests: globalGuests.map(g => ({
      ...g,
      alreadyTargeted: targetedIds.has(g.telegram_id),
    })),
    guests_truncated: guestsTruncated,
    offers: offers || [],
    venueGuestIds,
  });
};
