const https = require('https');

const TOKEN = '8ada274e-4ee3-4899-a1dc-a3f1a133a791';
const TEAM_ID = 2202459;
const BASE = 'eu1.make.com';
const SUPABASE_URL = 'https://wjlhaizrygeyeishbycp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqbGhhaXpyeWdleWVpc2hieWNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODg3NTIsImV4cCI6MjA5NDg2NDc1Mn0.BtSP2YukFJD-0KoghZqyE-w66k6h_eo8wOjKokLfcps';
const BOT_TOKEN = '8604236222:AAHT3yi1TyMRVLlrH_ucW8e_J96IeeqVQIw';
const MY_TG_ID = '148446386';

const TG_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: BASE, path: '/api/v2' + path, method,
      headers: {
        'Authorization': `Token ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeScenario(blueprint, scheduling) {
  return api('POST', '/scenarios?confirmed=true', {
    teamId: TEAM_ID,
    blueprint: JSON.stringify(blueprint),
    scheduling: JSON.stringify(scheduling),
  });
}

async function activate(id) {
  return api('PATCH', `/scenarios/${id}`, { islinked: true });
}

// Helper: HTTP module calling Telegram Bot API
function tgModule(id, chatId, text, x) {
  return {
    id, module: 'http:ActionSendData', version: 3,
    parameters: { handleErrors: false, useNewZLibDeCompress: true },
    mapper: {
      url: TG_URL,
      method: 'POST',
      headers: [],
      bodyType: 'raw',
      contentType: 'application/json',
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      serialize: false,
    },
    metadata: { designer: { x, y: 0 } },
  };
}

// Helper: HTTP module calling Supabase REST
function supabaseModule(id, path, x) {
  return {
    id, module: 'http:ActionSendData', version: 3,
    parameters: { handleErrors: false, useNewZLibDeCompress: true },
    mapper: {
      url: `${SUPABASE_URL}/rest/v1/${path}`,
      method: 'GET',
      headers: [
        { name: 'apikey', value: SUPABASE_KEY },
        { name: 'Authorization', value: `Bearer ${SUPABASE_KEY}` },
      ],
      bodyType: 'raw', contentType: 'application/json', serialize: false,
    },
    metadata: { designer: { x, y: 0 } },
  };
}

(async () => {
  console.log('🚀 Создаю сценарии в Make.com...\n');

  // ── Сценарий 1: Новый клиент (проверяем каждый день в 8:00) ─────────────
  console.log('📌 Сценарий 1 — Новый клиент:');
  const s1 = await makeScenario({
    name: 'Great Guest — Новый клиент',
    flow: [
      supabaseModule(
        1,
        'owner_subscriptions?order=created_at.desc&limit=1&select=telegram_id,plan,created_at',
        0
      ),
      tgModule(
        2, MY_TG_ID,
        '🆕 *Новый клиент Great Guest!*\n\nПроверь список организаторов:\nhttps://great-guest.ru/superadmin.html',
        300
      ),
    ],
    metadata: { instant: false, version: 1 },
  }, { type: 'daily', time: '08:00' });

  if (s1.scenario) {
    console.log(`✅ Создан (ID: ${s1.scenario.id})`);
    await activate(s1.scenario.id);
  } else {
    console.log('❌', JSON.stringify(s1).slice(0, 300));
  }

  // ── Сценарий 2: Триал истекает (ежедневно в 9:00) ──────────────────────
  // Вместо итерации по каждому — отправляем Сергею сводку с кол-вом
  console.log('\n📌 Сценарий 2 — Триал истекает через 3 дня:');
  const s2 = await makeScenario({
    name: 'Great Guest — Триал истекает через 3 дня',
    flow: [
      supabaseModule(
        1,
        'owner_subscriptions?subscription_status=eq.trial&select=telegram_id,plan,subscription_expires_at',
        0
      ),
      tgModule(
        2, MY_TG_ID,
        '⏰ *Проверь пробные подписки Great Guest*\n\nЕсть клиенты на триале — проверь кому скоро истекает:\nhttps://great-guest.ru/superadmin.html',
        300
      ),
    ],
    metadata: { instant: false, version: 1 },
  }, { type: 'daily', time: '09:00' });

  if (s2.scenario) {
    console.log(`✅ Создан (ID: ${s2.scenario.id})`);
    await activate(s2.scenario.id);
  } else {
    console.log('❌', JSON.stringify(s2).slice(0, 300));
  }

  // ── Сценарий 3: Еженедельный отчёт (каждый понедельник в 9:00) ─────────
  console.log('\n📌 Сценарий 3 — Еженедельный отчёт:');
  const s3 = await makeScenario({
    name: 'Great Guest — Еженедельный отчёт',
    flow: [
      supabaseModule(
        1,
        'owner_subscriptions?select=plan,subscription_status',
        0
      ),
      tgModule(
        2, MY_TG_ID,
        '📊 *Great Guest — Отчёт за неделю*\n\nПроверь статистику организаторов:\nhttps://great-guest.ru/superadmin.html',
        300
      ),
    ],
    metadata: { instant: false, version: 1 },
  }, { type: 'weekly', time: '09:00' });

  if (s3.scenario) {
    console.log(`✅ Создан (ID: ${s3.scenario.id})`);
    await activate(s3.scenario.id);
  } else {
    console.log('❌', JSON.stringify(s3).slice(0, 300));
  }

  console.log('\n✅ Готово!');
})();
