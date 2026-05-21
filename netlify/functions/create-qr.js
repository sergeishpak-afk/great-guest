/**
 * create-qr.js
 * Validates Telegram Mini App initData, then creates a pending_visit token.
 * Replaces the direct Supabase INSERT from the browser.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

// service_role — INSERT after HMAC validation, no anon writes
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;

    params.delete('hash');

    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (!crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(receivedHash, 'hex')
    )) return null;

    // Return parsed user from validated data
    const user = JSON.parse(params.get('user') || '{}');
    return user.id ? user : null;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let initData;
  try {
    ({ initData } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ✅ HMAC check — returns verified tgUser or null
  const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
  if (!tgUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid Telegram signature' }) };
  }

  const token = uuidv4();
  const { error } = await supabase
    .from('pending_visits')
    .insert({ token, telegram_id: String(tgUser.id) });

  if (error) {
    console.error('DB error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB error' }) };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://fabulous-elf-aa225e.netlify.app';
  const visitUrl = `${appUrl}/restaurant.html?token=${token}`;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ token, visitUrl }),
  };
};
