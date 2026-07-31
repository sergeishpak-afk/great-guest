// Recreate Great Guest Make.com scenarios from scratch
// Run: node recreate.js
//
// KEY FIXES (discovered after systematic debugging):
// 1. expect: [] in module metadata → fixes BundleValidationError (was "Validation failed for 5 parameter(s)")
// 2. handleErrors: true on Supabase GET → Telegram fires even if Supabase is paused
// 3. method: lowercase ('get', 'post') → one fewer validation error
// 4. useNewZLibDeCompress: true → must be in parameters, not mapper
// 5. timeout: number (not string or 0) → use 15 for Supabase (short timeout for paused check), 40 for Telegram
// Free plan: only 2 of 3 scenarios can be active simultaneously

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
      headers: { 'Authorization': `Token ${TOKEN}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
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

// Supabase GET — handleErrors:true so Telegram fires even when Supabase is paused
function supabaseGet(id, path, x) {
  return {
    id,
    module: 'http:ActionSendData',
    version: 3,
    parameters: { handleErrors: true, useNewZLibDeCompress: true },
    mapper: {
      url: `${SUPABASE_URL}/rest/v1/${path}`,
      method: 'get',
      headers: [
        { name: 'apikey', value: SUPABASE_KEY },
        { name: 'Authorization', value: `Bearer ${SUPABASE_KEY}` },
      ],
      qs: [],
      serializeUrl: false,
      useQuerystring: false,
      gzip: false,
      useMtls: false,
      followRedirect: true,
      followAllRedirects: false,
      parseResponse: false,
      timeout: 15,
      shareCookies: false,
      rejectUnauthorized: true,
    },
    metadata: { designer: { x, y: 0 }, expect: [], interface: [] },
  };
}

// Telegram GET with params in URL — Make.com ignores qs[] when useQuerystring:false,
// and POST body is not sent correctly via API blueprints. GET with URL params works.
function tgGet(id, text, x) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${MY_TG_ID}&parse_mode=Markdown&text=${encodeURIComponent(text)}`;
  return {
    id,
    module: 'http:ActionSendData',
    version: 3,
    parameters: { handleErrors: false, useNewZLibDeCompress: true },
    mapper: {
      url,
      method: 'get',
      headers: [],
      qs: [],
      serializeUrl: false,
      useQuerystring: false,
      gzip: false,
      useMtls: false,
      followRedirect: true,
      followAllRedirects: false,
      parseResponse: false,
      timeout: 30,
      shareCookies: false,
      rejectUnauthorized: true,
    },
    metadata: { designer: { x, y: 0 }, expect: [], interface: [] },
  };
}

async function makeScenario(name, flow, scheduling) {
  return api('POST', '/scenarios?confirmed=true', {
    teamId: TEAM_ID,
    blueprint: JSON.stringify({ name, flow, metadata: { instant: false, version: 1 } }),
    scheduling: JSON.stringify(scheduling),
  });
}

const SUPABASE_HEADERS_BASE = 'owner_subscriptions';

(async () => {
  const OLD_IDS = [6685531, 6685532, 6685533];
  console.log('Удаляю старые сценарии...');
  for (const id of OLD_IDS) {
    const r = await api('DELETE', `/scenarios/${id}`);
    console.log(`  ${id}: ${r === '' || r?.message === undefined ? 'OK' : JSON.stringify(r)}`);
  }
  console.log('');

  console.log('🚀 Создаю сценарии...\n');

  // 1. New client — daily 08:00
  const s1 = await makeScenario(
    'Great Guest — Новый клиент',
    [
      supabaseGet(1, `${SUPABASE_HEADERS_BASE}?order=created_at.desc&limit=1&select=telegram_id,plan,created_at`, 0),
      tgGet(2, '🆕 *Новый клиент Great Guest!*\n\nПроверь список:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
    { type: 'daily', time: '08:00' }
  );
  if (s1.scenario) {
    console.log(`✅ Новый клиент → ID ${s1.scenario.id}`);
    await api('POST', `/scenarios/${s1.scenario.id}/start`, {});
  } else {
    console.log('❌ Новый клиент:', JSON.stringify(s1).slice(0, 200));
  }

  // 2. Trial expiring — daily 09:00
  const s2 = await makeScenario(
    'Great Guest — Триал истекает через 3 дня',
    [
      supabaseGet(1, `${SUPABASE_HEADERS_BASE}?subscription_status=eq.trial&select=telegram_id,plan,subscription_expires_at`, 0),
      tgGet(2, '⏰ *Проверь пробные подписки Great Guest*\n\nЕсть клиенты на триале:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
    { type: 'daily', time: '09:00' }
  );
  if (s2.scenario) {
    console.log(`✅ Триал → ID ${s2.scenario.id}`);
    await api('POST', `/scenarios/${s2.scenario.id}/start`, {});
  } else {
    console.log('❌ Триал:', JSON.stringify(s2).slice(0, 200));
  }

  // 3. Weekly report — weekly 09:00
  const s3 = await makeScenario(
    'Great Guest — Еженедельный отчёт',
    [
      supabaseGet(1, `${SUPABASE_HEADERS_BASE}?select=plan,subscription_status`, 0),
      tgGet(2, '📊 *Great Guest — Отчёт за неделю*\n\nПроверь статистику:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
    { type: 'weekly', time: '09:00' }
  );
  if (s3.scenario) {
    console.log(`✅ Отчёт → ID ${s3.scenario.id} (inactive — free plan limit)`);
    // Note: can't activate this one on free plan (max 2 active)
  } else {
    console.log('❌ Отчёт:', JSON.stringify(s3).slice(0, 200));
  }

  console.log('\n✅ Готово!');
  console.log('⚠️  Если Supabase paused → зайди на supabase.com/dashboard и восстанови проект');
  console.log('⚠️  Free план: только 2 из 3 сценариев активны. Для 3-го нужен Core план ($9/мес)');
})();
