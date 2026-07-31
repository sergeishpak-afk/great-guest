/**
 * api/send-offer.js
 * POST — generate AI offer/invite options + send chosen one to guest via bot
 * Body: { initData, guestTelegramId, offerText? }
 *   - if offerText not provided → return 3 generated options
 *   - if offerText provided → send that one directly
 */
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const ORIGIN  = process.env.APP_ORIGIN || 'https://great-guest.ru';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// In-memory rate limit: max 20 send-offer requests per owner per minute
const RL_MAP = new Map();
function checkRateLimit(ownerId) {
  const now = Date.now();
  const window = 60_000;
  const limit = 20;
  const entry = RL_MAP.get(ownerId) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  RL_MAP.set(ownerId, entry);
  return entry.count <= limit;
}

const db  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);

const LEVELS = [
  { name: 'Bronze',   emoji: '🥉', min: 0  },
  { name: 'Silver',   emoji: '🥈', min: 5  },
  { name: 'Gold',     emoji: '🥇', min: 15 },
  { name: 'Platinum', emoji: '💎', min: 30 },
];
function getLevel(n) { return [...LEVELS].reverse().find(l => n >= l.min) || LEVELS[0]; }

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

// ── Restaurant offer templates ─────────────────────────────────────────────
function generateRestaurantOffers(guest, restaurant) {
  const lvl   = getLevel(guest.visit_count);
  const name  = guest.first_name;
  const rname = restaurant.name;
  const city  = restaurant.city || 'нашем городе';

  const byLevel = {
    Bronze: [
      `${name}, добро пожаловать в мир Great Guest! 🥉\n\n${rname} рад приветствовать новых участников программы — специально для вас: бесплатный комплимент от шефа при первом визите к нам.\n\nПросто покажите этот экран администратору. 🎁`,
      `Привет, ${name}! 👋\n\nМы видим, что вы начинаете путь в программе Great Guest, и хотим познакомиться! ${rname} предлагает вам скидку 10% при первом визите — наш подарок новому гостю.\n\n📍 ${restaurant.address || city}`,
      `${name}, вас заметили! ✨\n\n${rname} следит за гостями программы Great Guest и рад пригласить вас лично. Первый визит к нам — за нашим счётом: бесплатный напиток на выбор.\n\nОжидаем вас! 🥂`,
    ],
    Silver: [
      `${name}, ваш Silver-статус говорит сам за себя! 🥈\n\n${rname} предлагает Silver-гостям особые условия: скидка 5% на всё меню + приоритетное бронирование лучшего столика без ожидания.\n\nЗабронировать можно в ответ на это сообщение.`,
      `Серебряные гости — серебряный сервис! ${name}, вы в топ-20% программы Great Guest. 🥈\n\n${rname} хочет познакомиться с вами лично: скидка 5% + бесплатный десерт в подарок при визите на этой неделе.`,
      `${name}, 5+ визитов в сети — это уже история! 🥈\n\n${rname} ценит преданность гостей и предлагает вам: скидка 5%, приоритетная посадка и персональная рекомендация от шеф-повара. Когда вас ждать?`,
    ],
    Gold: [
      `${name}, Gold — это стиль жизни. 🥇\n\n${rname} приглашает вас на особый вечер: VIP-зона, скидка 10% на всё меню и авторский комплимент от шеф-повара. Место зарезервировано — просто скажите, когда придёте.`,
      `Уважаемый ${name}, Gold-статус открывает закрытые двери. 🥇\n\n${rname} организует для вас и вашей компании закрытый ужин: 10% скидка, лучший столик в зале, расширенное меню. Свяжитесь с нами для деталей.`,
      `${name}, вы среди лучших гостей Great Guest! 🥇\n\n${rname} проводит Gold-вечер в эту пятницу — специальное меню, живая музыка, скидка 10%. Приглашаем вас как почётного гостя. Места лимитированы.`,
    ],
    Platinum: [
      `${name}, Platinum — это семья. 💎\n\n${rname} готовит для вас эксклюзивный опыт: персональный Chef's Table, 15% скидка на весь визит, персональный ассистент на вечер. Это не просто ужин — это событие.\n\nКогда вам удобно? Мы подстраиваемся под вас.`,
      `Уважаемый ${name}, как Platinum-гость вы заслуживаете лучшего. 💎\n\n${rname} приглашает вас и вашего гостя на закрытую дегустацию нового сезонного меню — 5 курсов от шефа, 15% скидка, VIP-зал только для вас. Это наша честь.`,
      `${name}, вы — легенда программы Great Guest. 💎\n\n${rname} хочет познакомиться лично. Для вас: приватный ужин, эксклюзивное меню не из карты, 15% скидка и маленький сюрприз от команды. Напишите — организуем всё.`,
    ],
  };

  return byLevel[lvl.name] || byLevel.Bronze;
}

// ── Event invitation templates ─────────────────────────────────────────────
function generateEventInvites(guest, restaurant) {
  const lvl   = getLevel(guest.visit_count);
  const name  = guest.first_name;
  const ename = restaurant.name;
  const date  = restaurant.event_date
    ? new Date(restaurant.event_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    : 'в ближайшее время';
  const etype = restaurant.event_type || 'мероприятие';

  return [
    `${name}, вас ждут на ${ename}! 🎉\n\n${date} — особенный вечер для особенных гостей. Для вас зарезервировано место как для ${lvl.emoji} ${lvl.name}-гостя программы Great Guest.`,
    `${name}, персональное приглашение для вас 💌\n\n${ename} — ${date}. Мы выбрали вас из базы Great Guest как ${lvl.emoji} ${lvl.name}-гостя. Ваш статус открывает приоритетный вход.`,
    `${name}, вас заметили! ✨\n\nПриглашаем на ${ename} — ${date}. Специально для гостей уровня ${lvl.emoji} ${lvl.name} предусмотрены особые условия и привилегии.`,
  ];
}

function generateOffers(guest, restaurant) {
  if (restaurant.venue_type === 'event') {
    return generateEventInvites(guest, restaurant);
  }
  return generateRestaurantOffers(guest, restaurant);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { initData, guestTelegramId, offerText, restaurantId } = req.body || {};
  if (!initData || !guestTelegramId)
    return res.status(400).json({ error: 'initData and guestTelegramId required' });
  if (restaurantId && !UUID_RE.test(restaurantId))
    return res.status(400).json({ error: 'invalid restaurantId' });
  if (!validateInitData(initData, process.env.BOT_TOKEN))
    return res.status(401).json({ error: 'Invalid signature' });

  const params  = new URLSearchParams(initData);
  const tgUser  = JSON.parse(params.get('user') || '{}');
  const ownerId = String(tgUser.id);

  // Rate limiting
  if (!checkRateLimit(ownerId))
    return res.status(429).json({ error: 'too_many_requests', message: 'Подождите минуту перед следующей отправкой' });

  // Verify owner subscription
  const { data: ownerSub } = await db
    .from('owner_subscriptions')
    .select('*')
    .eq('telegram_id', ownerId)
    .single();

  const now     = new Date();
  const expires = ownerSub?.subscription_expires_at ? new Date(ownerSub.subscription_expires_at) : null;
  const isActive = ownerSub && (ownerSub.subscription_status === 'trial' || ownerSub.subscription_status === 'active') && expires && expires > now;
  if (!isActive) return res.status(403).json({ error: 'subscription_expired' });

  // Get the specific restaurant (verify ownership)
  // NOTE: must reassign to let so the .eq() chain is not discarded
  let venueQuery = db.from('restaurants').select('*').eq('owner_telegram_id', ownerId);
  if (restaurantId) venueQuery = venueQuery.eq('id', restaurantId);
  const { data: restaurant } = await venueQuery.single();

  if (!restaurant) return res.status(403).json({ error: 'not_registered' });

  // Get guest
  const { data: guest } = await db
    .from('guests')
    .select('*')
    .eq('telegram_id', guestTelegramId)
    .single();

  if (!guest) return res.status(404).json({ error: 'guest_not_found' });

  // Verify guest belongs to this owner's venue network (defense in depth)
  const { data: ownerVenueRows } = await db
    .from('restaurants')
    .select('id')
    .eq('owner_telegram_id', ownerId);

  const ownerVenueIds = (ownerVenueRows || []).map(v => v.id);

  if (ownerVenueIds.length > 0) {
    const { count: visitCount } = await db
      .from('visits')
      .select('*', { count: 'exact', head: true })
      .eq('telegram_id', guestTelegramId)
      .in('restaurant_id', ownerVenueIds);

    // Also allow guests who RSVPed but haven't visited yet
    const { count: contactCount } = await db
      .from('organizer_contacts')
      .select('*', { count: 'exact', head: true })
      .eq('organizer_id', ownerId)
      .eq('guest_id', guestTelegramId);

    if ((!visitCount || visitCount === 0) && (!contactCount || contactCount === 0)) {
      return res.status(403).json({ error: 'guest_not_in_your_network' });
    }
  }

  // No offerText → return 3 options
  if (!offerText) {
    const options = generateOffers(guest, restaurant);
    return res.status(200).json({ options });
  }

  // Send the chosen offer/invite via bot
  const lvl        = getLevel(guest.visit_count);
  const isEvent    = restaurant.venue_type === 'event';
  const typeLabel  = isEvent ? 'Приглашение' : 'Персональное предложение';
  const senderName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Организатор';
  const footer     = `_${senderName} · ${restaurant.name} ${lvl.emoji}_`;

  const msg = [
    `🎁 *${typeLabel} от «${restaurant.name}»*`,
    '',
    offerText,
    '',
    restaurant.address ? `📍 ${restaurant.address}` : null,
    `\n${footer}`,
  ].filter(Boolean).join('\n');

  // Insert offer with pending status first
  const { data: insertedOffer, error: insertError } = await db.from('offers').insert({
    restaurant_id:     restaurant.id,
    guest_telegram_id: guestTelegramId,
    offer_text:        offerText,
    status:            'pending',
  }).select('id').single();

  if (insertError) {
    console.error('Offer insert error:', insertError);
    return res.status(500).json({ error: 'db_insert_failed' });
  }

  // Try to send via Telegram
  try {
    await bot.telegram.sendMessage(guestTelegramId, msg, { parse_mode: 'Markdown' });
    // Update status to sent
    await db.from('offers').update({ status: 'sent' }).eq('id', insertedOffer.id);
  } catch (e) {
    // Update status to failed, but don't return 500 — offer is saved and can be retried
    console.error('Telegram send error:', e.message);
    await db.from('offers').update({ status: 'failed' }).eq('id', insertedOffer.id);
    return res.status(200).json({ success: false, error: 'telegram_send_failed', offer_saved: true });
  }

  return res.status(200).json({ success: true });
};
