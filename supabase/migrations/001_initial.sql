-- Гости (регистрируются через Telegram)
CREATE TABLE guests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  TEXT UNIQUE NOT NULL,
  first_name   TEXT NOT NULL DEFAULT '',
  last_name    TEXT NOT NULL DEFAULT '',
  username     TEXT NOT NULL DEFAULT '',
  visit_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Рестораны-партнёры
CREATE TABLE restaurants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  city       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ожидающие визиты (QR токены от гостей)
CREATE TABLE pending_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       UUID UNIQUE NOT NULL,
  telegram_id TEXT NOT NULL REFERENCES guests(telegram_id),
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Подтверждённые визиты
CREATE TABLE visits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id   TEXT NOT NULL REFERENCES guests(telegram_id),
  restaurant_id UUID REFERENCES restaurants(id),
  visit_token   UUID NOT NULL,
  visited_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE guests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits         ENABLE ROW LEVEL SECURITY;

-- Политики (на этапе MVP — открытые, сервер-сайд через service_role или anon)
CREATE POLICY "allow all" ON guests         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON restaurants    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON pending_visits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON visits         FOR ALL USING (true) WITH CHECK (true);
