// FINAL FIX for Great Guest Make.com scenarios
const https = require('https');

const TOKEN = '8ada274e-4ee3-4899-a1dc-a3f1a133a791';
const BASE = 'eu1.make.com';
const SUPABASE_URL = 'https://wjlhaizrygeyeishbycp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqbGhhaXpyeWdleWVpc2hieWNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODg3NTIsImV4cCI6MjA5NDg2NDc1Mn0.BtSP2YukFJD-0KoghZqyE-w66k6h_eo8wOjKokLfcps';
const BOT_TOKEN = '8604236222:AAHT3yi1TyMRVLlrH_ucW8e_J96IeeqVQIw';
const MY_TG_ID = '148446386';
const TG_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: BASE, path: '/api/v2' + path, method,
      headers: { 'Authorization': `Token ${TOKEN}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function waitExec(id, execId) {
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await api('GET', `/scenarios/${id}/executions/${execId}`);
    if (s.status !== 'RUNNING') return s;
  }
  return { status: 'TIMEOUT' };
}

function supabaseGet(id, path, x) {
  return {
    id, module: 'http:ActionSendData', version: 3,
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
    metadata: {
      designer: { x, y: 0 },
      expect: [],
      interface: [],
      restore: { method: { label: 'GET' } },
    },
  };
}

// KEY LESSON: Make.com HTTP module ignores the `qs` array when useQuerystring: false.
// Telegram params must be baked directly into the URL string (same as Supabase params).
// POST with JSON body also doesn't work — Make.com doesn't send the body correctly via API blueprints.
function tgGet(id, text, x) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${MY_TG_ID}&parse_mode=Markdown&text=${encodeURIComponent(text)}`;
  return {
    id, module: 'http:ActionSendData', version: 3,
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
    metadata: {
      designer: { x, y: 0 },
      expect: [],
      interface: [],
      restore: { method: { label: 'GET' } },
    },
  };
}

const SCENARIOS = [
  {
    id: 6685531,
    name: 'Great Guest — Новый клиент',
    flow: [
      supabaseGet(1, 'owner_subscriptions?order=created_at.desc&limit=1&select=telegram_id,plan,created_at', 0),
      tgGet(2, '🆕 Новый клиент Great Guest!\n\nПроверь список:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
  },
  {
    id: 6685532,
    name: 'Great Guest — Триал истекает через 3 дня',
    flow: [
      supabaseGet(1, 'owner_subscriptions?subscription_status=eq.trial&select=telegram_id,plan,subscription_expires_at', 0),
      tgGet(2, '⏰ Проверь пробные подписки Great Guest\n\nЕсть клиенты на триале:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
  },
  {
    id: 6685533,
    name: 'Great Guest — Еженедельный отчёт',
    flow: [
      supabaseGet(1, 'owner_subscriptions?select=plan,subscription_status', 0),
      tgGet(2, '📊 Great Guest — Отчёт за неделю\n\nПроверь статистику:\nhttps://great-guest.ru/superadmin.html', 300),
    ],
  },
];

async function applyAndTest(s) {
  process.stdout.write(`\n📌 ${s.name} (${s.id}):\n`);

  // Check current state first
  const state = await api('GET', `/scenarios/${s.id}`);
  const isActive = state.scenario?.islinked && state.scenario?.isActive;
  process.stdout.write(`   Состояние: islinked=${state.scenario?.islinked} isActive=${state.scenario?.isActive}\n`);

  // PATCH blueprint
  const patch = await api('PATCH', `/scenarios/${s.id}`, {
    blueprint: JSON.stringify({ name: s.name, flow: s.flow, metadata: { instant: false, version: 1 } }),
  });
  if (!patch.scenario) { process.stdout.write(`   PATCH FAIL: ${JSON.stringify(patch).slice(0, 100)}\n`); return; }
  process.stdout.write(`   Blueprint обновлён ✓\n`);

  // Try to activate (ok if already running)
  const act = await api('POST', `/scenarios/${s.id}/start`, {});
  const actMsg = act?.message || '';
  const actOk = !actMsg || actMsg.includes('already');
  process.stdout.write(`   Активация: ${actOk ? '✓ ' : '❌ '}${actMsg}\n`);
  if (!actOk) return;

  await new Promise(r => setTimeout(r, 1000));

  // Run test
  const run = await api('POST', `/scenarios/${s.id}/run`, {});
  if (!run.executionId) { process.stdout.write(`   Запуск: ❌ ${run.message}\n`); return; }
  process.stdout.write(`   Запуск: ожидаем...\n`);

  const exec = await waitExec(s.id, run.executionId);
  if (exec.status === 'SUCCESS') {
    process.stdout.write(`   Результат: ✅ SUCCESS — Telegram отправлен!\n`);
  } else if (exec.status === 'WARNING') {
    const msg = exec.error?.message || '';
    if (msg.includes('reachable')) {
      process.stdout.write(`   Результат: ⚠️  Supabase недоступен (paused), Telegram отправлен\n`);
    } else {
      process.stdout.write(`   Результат: ⚠️  WARNING: ${msg}\n`);
    }
  } else if (exec.status === 'TIMEOUT') {
    process.stdout.write(`   Результат: ⏳ Ещё выполняется\n`);
  } else {
    process.stdout.write(`   Результат: ❌ ${exec.error?.message || exec.status}\n`);
  }
}

(async () => {
  console.log('=== ФИНАЛЬНАЯ НАСТРОЙКА GREAT GUEST ===');
  for (const s of SCENARIOS) {
    await applyAndTest(s);
  }
  console.log('\n=== СЛЕДУЮЩИЕ ШАГИ ===');
  console.log('1. Проверь Telegram — пришли ли 2 тестовых сообщения');
  console.log('2. Supabase PAUSED → зайди на supabase.com/dashboard → Restore Project');
  console.log('3. Free план Make.com → только 2 активных сценария');
  console.log('   Сценарий 6685533 (еженедельный) → нужен upgrade или ручной запуск');
})();
