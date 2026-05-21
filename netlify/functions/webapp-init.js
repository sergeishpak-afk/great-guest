/**
 * webapp-init.js
 * Validates Telegram Mini App initData via HMAC-SHA256,
 * then upserts the guest and returns their profile.
 *
 * Called by index.html instead of hitting Supabase directly.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Read-only: anon key (respects RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// Write: service_role (bypasses RLS — server-side only, after HMAC validation)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Validate Telegram WebApp initData signature.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return false;

    params.delete('hash');

    // Sort keys alphabetically and build check string
    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256(data, HMAC-SHA256("WebAppData", botToken))
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(receivedHash, 'hex')
    );
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let initData;
  try {
    ({ initData } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!initData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'initData required' }) };
  }

  // ✅ HMAC check
  if (!validateInitData(initData, process.env.BOT_TOKEN)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid Telegram signature' }) };
  }

  // Parse user from validated initData
  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user') || '{}');
  if (!tgUser.id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No user in initData' }) };
  }

  const { data: guest, error } = await supabaseAdmin
    .from('guests')
    .upsert(
      {
        telegram_id: String(tgUser.id),
        first_name: tgUser.first_name || '',
        last_name: tgUser.last_name || '',
        username: tgUser.username || '',
      },
      { onConflict: 'telegram_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('DB error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB error' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ guest }) };
};
