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

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PLANS = {
  trial:   { label: 'Старт',   max_venues: 1,   price: 0,     price_label: 'Бесплатно 14 дней' },
  basic:   { label: 'Базовый', max_venues: 1,   price: 2990,  price_label: '2 990 ₽/мес' },
  network: { label: 'Сеть',    max_venues: 5,   price: 7990,  price_label: '7 990 ₽/мес' },
  empire:  { label: 'Империя', max_venues: 999, price: 19990, price_label: '19 990 ₽/мес' },
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
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  // ── action: get_rsvp_list — RSVP guests for a guestlist venue ───────────────
  if ((req.body || {}).action === 'get_rsvp_list') {
    const { venueId } = req.body;
    if (!venueId || !UUID_RE.test(venueId)) return res.status(400).json({ error: 'invalid venueId' });
    const { data: ven } = await db.from('restaurants').select('id, owner_telegram_id').eq('id', venueId).single();
    if (!ven) return res.status(404).json({ error: 'Venue not found' });
    if (ven.owner_telegram_id !== ownerId) return res.status(403).json({ error: 'Not your venue' });
    const { data: rsvps } = await db
      .from('rsvp')
      .select('telegram_id, first_name, last_name, username, created_at')
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
    const { error } = await db.from('rsvp').upsert(
      { venue_id: venueId, telegram_id: telegramId },
      { onConflict: 'venue_id,telegram_id' }
    );
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ success: true });
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
    if (upErr) return res.status(500).json({ error: 'Upload failed', detail: upErr.message });

    const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(storagePath);
    const { error: dbErr } = await db.from('restaurants').update({ cover_image_url: publicUrl }).eq('id', venueId);
    if (dbErr) return res.status(500).json({ error: 'DB update failed', detail: dbErr.message });
    return res.status(200).json({ success: true, url: publicUrl });
  }

  // ── action: export_csv — generate guest list CSV and send via bot ──────────
  if ((req.body || {}).action === 'export_csv') {
    const { data: contacts } = await db
      .from('organizer_contacts')
      .select('guest_id, first_name, last_name, username, total_visits, rsvp_count, last_seen_at')
      .eq('organizer_id', ownerId)
      .order('last_seen_at', { ascending: false })
      .limit(500);

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
      return res.status(500).json({ error: 'Telegram send failed', detail: err.description });
    }
    return res.status(200).json({ success: true, count: (contacts || []).length });
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
    if (avErr) return res.status(500).json({ error: 'Upload failed', detail: avErr.message });

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
    return res.status(500).json({ error: 'DB error', detail: venuesError.message });
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
      return res.status(500).json({ error: 'DB error', detail: insertError.message });
    }
    ownerSub = newSub;
  }

  // 5. Build owner info
  const now = new Date();
  const expires = ownerSub.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : 0;
  const isActive = (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && daysLeft > 0;

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
        // RSVP confirmations
        db
          .from('rsvp')
          .select('*', { count: 'exact', head: true })
          .eq('venue_id', venue.id),
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
        .select('guest_id, first_name, last_name, username, total_visits, rsvp_count, last_seen_at')
        .eq('organizer_id', ownerId)
        .order('last_seen_at', { ascending: false })
        .limit(500),
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

      // Backfill organizer_contacts so next load is fast (fire-and-forget)
      for (const c of contactRows) {
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
      telegram_id:   c.guest_id,
      first_name:    nameMap[c.guest_id]?.first_name  || c.first_name  || '',
      last_name:     nameMap[c.guest_id]?.last_name   || c.last_name   || '',
      username:      nameMap[c.guest_id]?.username    || c.username    || '',
      visit_count:   statsMap[c.guest_id]?.visit_count  || 0,
      last_visit_at: statsMap[c.guest_id]?.last_visit_at || c.last_seen_at,
      org_visits:    c.total_visits,
      rsvp_count:    c.rsvp_count,
    })).sort((a, b) => (b.visit_count || 0) - (a.visit_count || 0));
  }

  // 8. Build targeted IDs set from all offers
  const targetedIds = new Set((offers || []).map(o => o.guest_telegram_id));

  // 9. Return response
  return res.status(200).json({
    owner: ownerInfo,
    venues: venuesWithStats,
    globalGuests: globalGuests.map(g => ({
      ...g,
      alreadyTargeted: targetedIds.has(g.telegram_id),
    })),
    offers: offers || [],
  });
};
