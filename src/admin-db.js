require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Service role client — bypasses RLS, used only in server-side bot code
const adminDb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = adminDb;
