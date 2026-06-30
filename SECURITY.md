# SECURITY AUDIT — Great Guest API

**Date:** 2026-06-25
**Auditor:** gsd-security-auditor (Claude claude-sonnet-4-6)
**Scope:** `api/` (13 files) + `miniapp/admin.html` (client data-flow review)
**ASVS Level:** 2 (implied — authenticated web/Telegram Mini App with payments)

---

## Summary

| Category | Status |
|----------|--------|
| Authentication (validateInitData) | PASS — present in all protected endpoints |
| auth_date expiry (3600s) | PASS — enforced in all validateInitData copies |
| Authorization / IDOR | MOSTLY PASS — 1 gap in send-offer.js |
| Rate limiting | MOSTLY PASS — missing on guest-preview, og-pitch |
| Input validation | MOSTLY PASS — 2 gaps |
| Injection (SQL/XSS) | PASS — parameterised queries, he() escaping in HTML |
| Secrets in responses | ISSUE — DB error detail leaked in production |
| Payment webhook auth | BLOCKER — no signature verification on YooKassa webhook |

---

## Findings

### 1. КРИТИЧНО — Отсутствует верификация подписи webhook от ЮKassa
**Файл:** `api/payments.js:74`

**Проблема:** Входящие webhook-уведомления от ЮKassa принимаются без проверки подлинности. Единственная проверка — `body.type === 'notification'`, что может установить любой HTTP-клиент.

**Риск:** Злоумышленник может отправить POST с `{ "type": "notification", "object": { "status": "succeeded", "metadata": { "telegram_id": "...", "plan": "empire", "months": "12" } } }` и получить подписку empire бесплатно. Проверка `payment.id` в таблице `payments` существует, но если платёж ещё не создан или ID угадан — защиты нет. YooKassa подписывает webhook через `X-Content-Signature` — эта подпись не читается и не проверяется.

**Исправление:** Проверять заголовок `X-Content-Signature` по секретному ключу магазина перед обработкой уведомления.

---

### 2. ВАЖНО — UUID не валидируется для `restaurantId` в `send-offer.js`
**Файл:** `api/send-offer.js:114,143`

**Проблема:** Параметр `restaurantId` из тела запроса не проходит проверку по `UUID_RE` перед использованием в запросе к БД. В отличие от других endpoint-ов (restaurant-dashboard, import-guests), здесь отсутствует явный `UUID_RE.test(restaurantId)`.

**Риск:** Передача произвольной строки как `restaurantId` может приводить к неожиданному поведению PostgREST (хотя UUID-колонка отклонит невалидное значение на уровне БД). Основной риск — логические ошибки: при `restaurantId = undefined` запрос возвращает все рестораны владельца через `.single()`, и если у него несколько — функция упадёт с ошибкой или вернёт произвольный.

**Исправление:** Добавить `if (restaurantId && !UUID_RE.test(restaurantId)) return res.status(400)...` перед запросом к БД.

---

### 3. ВАЖНО — DB/internal error detail утекает в HTTP-ответы
**Файлы:** `api/restaurant-register.js:78,124,129,153,197`, `api/restaurant-dashboard.js:178,182,226,277,301,329`, `api/send-offer.js:211`, `api/invite.js:285,372`

**Проблема:** При ошибках возвращается `{ error: '...', detail: someError.message }` — внутренние сообщения об ошибках Supabase, Telegraf, PostgREST включены в ответ клиенту.

**Риск:** Утечка информации о схеме БД, именах таблиц, ограничениях, внутренних путях. Используется для fingerprinting инфраструктуры и планирования атак.

**Исправление:** Логировать `detail` в `console.error`, в HTTP-ответе возвращать только общий код ошибки без `detail`.

---

### 4. ВАЖНО — CORS `Access-Control-Allow-Origin: *` на всех endpoint-ах включая payments и superadmin
**Файлы:** Все файлы в `api/`

**Проблема:** Открытый CORS (`*`) на endpoint-ах с мутациями, включая `api/payments.js` (создание платежей) и `api/superadmin.js` (управление подписками).

**Риск:** Для Telegram Mini App этот CORS не нужен — мини-апп запускается внутри Telegram WebView с инициализационными данными. Открытый CORS разрешает cross-origin запросы с любого сайта; в сочетании с уязвимостью в initData — расширяет поверхность атаки.

**Исправление:** Ограничить CORS до `process.env.APP_URL` или доменов Telegram. Для `bot.js` (webhook) CORS не нужен вообще.

---

### 5. ВАЖНО — `guest-preview.js` не требует аутентификации и раскрывает PII гостя
**Файл:** `api/guest-preview.js:1-30`

**Проблема:** Endpoint публичный (без `validateInitData`). По UUID токена (который считывается с QR-кода) возвращает `{ first_name, visit_count }` гостя без какой-либо аутентификации.

**Риск:** Любой, кто получил QR-код гостя (сфотографировал экран, перехватил URL), может запросить данные профиля. Сам по себе риск ограничен минимальным набором PII, но endpoint не имеет rate limiting — возможен brute-force перебор UUID токенов (хотя UUID v4 пространство велико).

**Исправление:** Добавить rate limiting по IP (аналогично `confirm-visit.js`). Оценить необходимость возврата `first_name` — достаточно ли булевого флага "гость найден".

---

### 6. ВАЖНО — Отсутствует проверка реального содержимого загружаемых изображений (magic bytes)
**Файлы:** `api/restaurant-dashboard.js:167` (update_cover), `api/restaurant-dashboard.js:267` (update_avatar)

**Проблема:** При загрузке изображений (base64) проверяется только размер файла (4 MB) и `mimeType` из запроса клиента. Magic bytes (сигнатура файла) не проверяются. Клиент может передать `mimeType: 'image/jpeg'` с произвольным содержимым.

**Риск:** Загрузка файлов с вредоносным содержимым в Supabase Storage под видом изображений. Прямой RCE маловероятен (файлы отдаются как статика), но возможны XSS через SVG/HTML, скрытые данные в метаданных.

**Исправление:** Проверять первые байты буфера (`buf.slice(0,4)`) на соответствие сигнатурам JPEG (`FF D8 FF`), PNG (`89 50 4E 47`). Запрещать SVG и HTML.

---

### 7. ВАЖНО — In-memory rate limiting не работает в serverless (Vercel)
**Файлы:** Все файлы с `RL_MAP`, `BONUS_RL`, `QR_RL`, `IMPORT_RL`

**Проблема:** Rate limiting реализован через in-memory Map. В serverless-среде (Vercel) каждый запрос может выполняться в новом изоляте — счётчики не сохраняются между invocations. Даже при warm instance — параллельные invocations имеют независимые Map.

**Риск:** Rate limiting фактически не работает в production. Злоумышленник может неограниченно флудить на:
- `confirm-visit.js` — перебор QR токенов (60/min задуман, реально — неограниченно)
- `restaurant-register.js` — спам регистрации заведений
- `send-offer.js` — рассылка спама гостям через бота

**Исправление:** Перенести rate limiting в Redis (Upstash) или Supabase (таблица rate_limits с TTL).

---

### 8. РЕКОМЕНДАЦИЯ — `venueId` из callback_data бота не валидируется по UUID_RE
**Файл:** `api/bot.js:352-365` (обработка `startPayload`)

**Проблема:** В `bot.start()` payload `v_<venueId>`, `rsvp_<venueId>`, `qr_<venueId>` передаётся в хелперы без UUID-валидации. `handleQrRequest` (строка 612) добавляет проверку `UUID_RE_BOT`, но `handleVenueEntry` и `handleRsvp` — нет. Они передают venueId напрямую в `.eq('id', venueId)`.

**Риск:** Произвольная строка в startPayload (Telegram ограничивает 64 символами, но не ограничивает содержимое) попадёт в SQL-запрос. Supabase отклонит не-UUID на уровне БД, но это ненадёжная защита.

**Исправление:** Добавить `UUID_RE_BOT.test(venueId)` проверку в начале `handleVenueEntry` и `handleRsvp`.

---

### 9. РЕКОМЕНДАЦИЯ — `merge_guest` в `invite.js` позволяет перенести историю на произвольный `new_telegram_id`
**Файл:** `api/invite.js:230-255`

**Проблема:** При merge проверяется что `old_telegram_id` принадлежит базе организатора, но `new_telegram_id` не проверяется никак — может быть любым Telegram ID.

**Риск:** Организатор может объединить историю гостя с любым произвольным аккаунтом, добавив ему визиты. Злоупотребление для накрутки статуса.

**Исправление:** Ограничить `new_telegram_id` — либо требовать что новый ID тоже в базе организатора, либо что это сам звонящий (ownerId).

---

### 10. РЕКОМЕНДАЦИЯ — `broadcast` в `invite.js` не имеет rate limiting
**Файл:** `api/invite.js:290`

**Проблема:** Action `broadcast` рассылает сообщения до 200 гостям без rate limiting на уровне endpoint-а. Проверка подписки есть, но на количество рассылок в час/день — нет.

**Риск:** Организатор с активной подпиской может инициировать сотни broadcast-запросов подряд, перегружая Telegram Bot API и нарушая работу других пользователей.

**Исправление:** Добавить rate limit — не более N broadcasts в час на organizer_id.

---

### 11. РЕКОМЕНДАЦИЯ — `og-pitch.js` не требует аутентификации и не имеет rate limiting (DoS)
**Файл:** `api/og-pitch.js`

**Проблема:** Endpoint генерирует изображение 1200×630 PNG через `@vercel/og` без какой-либо защиты. Каждый запрос запускает Edge Function.

**Риск:** Низкая стоимость для атакующего, высокая стоимость исполнения. DoS через flood. Нет кеширования на уровне кода.

**Исправление:** Добавить `Cache-Control: public, max-age=86400` заголовок. Vercel Edge будет кешировать ответ.

---

## Закрытые / подтверждённые защиты

| Проверка | Результат | Доказательство |
|----------|-----------|---------------|
| `validateInitData` во всех protected endpoints | PASS | Все 8 protected файлов: restaurant-register, restaurant-dashboard, create-qr, send-offer, import-guests, guest-offers, payments, invite, superadmin |
| `auth_date` expiry 3600s | PASS | Все копии validateInitData: `Date.now() / 1000 - authDate > 3600` |
| HMAC timing-safe compare | PASS | `crypto.timingSafeEqual` во всех копиях |
| IDOR: ownership check перед DELETE venue | PASS | restaurant-register.js:72 `venue.owner_telegram_id !== ownerId` |
| IDOR: ownership check перед rsvp/remove/add | PASS | restaurant-dashboard.js:75,91,103 |
| IDOR: ownership check перед bonus_visit | PASS | restaurant-dashboard.js:124-127 |
| UUID validation для venueId | PASS | UUID_RE используется в dashboard, register, import, invite |
| Max length на text fields | PASS | `.slice(0, 1000)` для invite_message, `.slice(0, 100)` для names |
| SQL Injection | PASS | Parameterised queries через Supabase JS SDK везде |
| XSS в HTML endpoint | PASS | invite.js использует `he()` функцию для всех user-supplied данных |
| BOT_TOKEN не в client | PASS | Отсутствует в admin.html и других клиентских файлах |
| SUPABASE_SERVICE_ROLE_KEY только на сервере | PASS | Используется только в серверных файлах через `process.env` |
| QR replay protection (atomic claim) | PASS | confirm-visit.js:42-43 `.eq('used', false)` atomic update |
| QR TTL | PASS | confirm-visit.js:52-57 проверка expires_at |

---

## Открытые угрозы (требуют исправления до деплоя)

| ID | Уровень | Файл | Описание |
|----|---------|------|----------|
| SEC-001 | КРИТИЧНО | payments.js:74 | Нет верификации webhook ЮKassa — возможна бесплатная подписка |
| SEC-002 | ВАЖНО | send-offer.js:143 | restaurantId не валидируется по UUID_RE |
| SEC-003 | ВАЖНО | Все api/*.js | DB error detail в HTTP-ответах |
| SEC-004 | ВАЖНО | Все api/*.js | CORS `*` на мутирующих endpoints |
| SEC-005 | ВАЖНО | guest-preview.js | Нет rate limiting, PII без auth |
| SEC-006 | ВАЖНО | restaurant-dashboard.js | Нет magic bytes валидации при загрузке файлов |
| SEC-007 | ВАЖНО | Все файлы с RL_MAP | In-memory rate limiting неэффективен в serverless |
