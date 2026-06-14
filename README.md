# Telegram-бот на Cloudflare Workers

Проект переведён на запуск через Cloudflare Workers, D1 и Wrangler. Docker и локальный Python-сервер больше не нужны для production-сценария: деплой выполняется из GitHub Actions.

## Архитектура

- Cloudflare Worker принимает Telegram webhook на `/telegram/webhook`.
- Веб-панель доступна на `/app`, работает с той же D1 базой и защищена cookie-session авторизацией.
- JSON API веб-панели доступен на `/api/*`.
- Cloudflare D1 хранит проекты, активный проект чата, идеи, задачи, ссылки, заметки, решения и теги.
- Wrangler деплоит Worker и применяет D1 migrations.
- GitHub Actions запускает тесты, применяет миграции, деплоит Worker и настраивает Telegram webhook.
- Scheduled Trigger каждые 30 минут проверяет дедлайны задач, отправляет Telegram-уведомления и очищает старый аудит.

## Команды бота

- `/start` или `/help` - помощь
- `/project_set [name]` - выбрать активный проект для чата
- `/projects` - список проектов
- `/idea [text]` - сохранить идею
- `/task [text]` - создать задачу
- `/tasks` - показать задачи по статусам
- `/task_doing [id]` - перевести задачу в `doing`
- `/task_review [id]` - перевести задачу в `review`
- `/task_done [id]` - завершить задачу
- `/ideas` - показать идеи текущего проекта
- `/notes` - показать заметки текущего проекта
- `/decisions` - показать решения текущего проекта
- `/links` - показать ссылки текущего проекта
- `/note [text]` - сохранить заметку
- `/decision [text]` - зафиксировать решение
- `/link [url] [description]` - сохранить ссылку
- `/find [query]` - поиск по текущему проекту

Команды `/idea`, `/task`, `/note`, `/decision` и `/link` поддерживают reply-режим.
После создания задачи бот показывает inline-кнопки для перевода задачи в `doing`, `review` и `done`; команды `/task_doing`, `/task_review` и `/task_done` оставлены для совместимости.

## Веб-панель и роли

Панель предназначена для внутренней работы двух партнёров и закрыта логином/паролем.

Адрес:

```text
https://bot.michael.kz/app
```

Страница входа:

```text
https://bot.michael.kz/login
```

Роли:

- `admin` - полный доступ, пользователи, аудит, создание проектов и все рабочие действия.
- `manager` - управление проектами, задачами, сроками, приоритетами, ответственными и рабочими записями без доступа к управлению пользователями.
- `editor` - просмотр, создание и редактирование рабочих записей, смена статуса задач.
- `viewer` - только просмотр и поиск.

Возможности:

- список проектов;
- создание проекта;
- статистика по задачам, идеям, заметкам, решениям и ссылкам;
- страница проекта;
- задачи по статусам `todo`, `doing`, `review`, `done`;
- приоритеты задач `low`, `normal`, `high`, `urgent`;
- дедлайны задач;
- ответственные за задачи;
- история изменений по проекту;
- фильтры проекта по статусу, автору, ответственному, приоритету, дедлайну и тегу;
- фильтр истории изменений по типу сущности и пользователю;
- обзор рисков: просроченные задачи и задачи с ближайшим дедлайном;
- расчёт дедлайнов с учётом локального часового пояса приложения;
- поиск по проекту с учётом выбранного тега;
- отображение тегов на карточках задач, идей, заметок, решений и ссылок;
- смена статуса задачи через select;
- создание задач, идей, заметок, решений и ссылок;
- просмотр ссылок с открытием в новой вкладке;
- поиск по текущему проекту;
- управление пользователями для `admin` с фильтрами по роли и активности;
- отображение `telegram_id` и `last_login_at` в пользователях;
- аудит действий для `admin` с фильтрами по пользователю, действию и типу сущности;
- просмотр и восстановление мягко удалённых записей для `admin`;
- экспорт проекта в Markdown, CSV и JSON;
- Telegram-уведомления о назначении ответственного, смене статуса, ближайшем дедлайне и просрочке;
- Telegram inline-кнопки для быстрой смены статуса задач;
- фоновая отправка уведомлений через `ctx.waitUntil()`, чтобы веб-запросы и webhook отвечали быстрее;
- JSON API для проектов, данных проекта и поиска.

Маршруты:

```text
GET  /app
GET  /app/projects
GET  /app/projects/:id
GET  /app/projects/:id/export.md
GET  /app/projects/:id/export.csv
GET  /app/projects/:id/export.json
GET  /app/users
GET  /app/deleted
GET  /app/audit
POST /app/projects
POST /app/tasks
POST /app/tasks/:id/status
POST /app/tasks/:id/meta
POST /app/tasks/:id/edit
POST /app/tasks/:id/delete
POST /app/ideas
POST /app/ideas/:id/edit
POST /app/ideas/:id/delete
POST /app/notes
POST /app/notes/:id/edit
POST /app/notes/:id/delete
POST /app/decisions
POST /app/decisions/:id/edit
POST /app/decisions/:id/delete
POST /app/links
POST /app/links/:id/edit
POST /app/links/:id/delete
POST /app/deleted/:entity_type/:id/restore

GET  /api/projects
GET  /api/projects/:id
GET  /api/search?project_id=1&q=...
GET  /api/admin/users
GET  /api/admin/audit
POST /api/admin/users
POST /api/admin/users/:id/role
POST /api/admin/users/:id/status
POST /api/admin/users/:id/password
```

Безопасность:

- пароли хранятся только как PBKDF2-SHA256 hash;
- web session хранится в signed HttpOnly cookie;
- POST-формы защищены CSRF token;
- `/login` ограничивает частые неудачные попытки входа по IP;
- write routes проверяют роли на backend;
- viewer не видит кнопки создания, редактирования, удаления и смены статуса;
- действия записываются в `audit_log`.
- старые записи `audit_log` и `change_log` очищаются по `AUDIT_RETENTION_DAYS`.

Первый admin создаётся автоматически при первом обращении к панели, если таблица `users` пустая и заданы secrets:

```text
INITIAL_ADMIN_USERNAME
INITIAL_ADMIN_PASSWORD
SESSION_SECRET
```

`SESSION_SECRET` должен быть длинной случайной строкой.

## Cloudflare

Домен `michael.kz` добавлен в Cloudflare и активирован через nameservers:

```text
hadlee.ns.cloudflare.com
kolton.ns.cloudflare.com
```

D1 database для проекта уже создана:

```toml
[[d1_databases]]
binding = "DB"
database_name = "plat_telegram"
database_id = "e9450fe2-08cc-4f04-b9d9-14e9ce6d0c8b"
```

Worker будет доступен на поддомене:

```toml
routes = [
  { pattern = "bot.michael.kz", custom_domain = true }
]
```

Итоговый Telegram webhook URL будет:

```text
https://bot.michael.kz/telegram/webhook
```

## GitHub Secrets

В репозитории GitHub откройте:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Добавьте:

- `CLOUDFLARE_API_TOKEN` - token Cloudflare с правами на Workers Scripts, Workers Routes и D1.
- `CLOUDFLARE_ACCOUNT_ID` - Account ID из Cloudflare.
- `BOT_TOKEN` - token Telegram-бота.
- `ALLOWED_USERS` - Telegram user_id через запятую, например `111111111,222222222`.
- `WEBHOOK_SECRET` - произвольная секретная строка для проверки Telegram webhook.
- `WEBHOOK_URL` - полный URL webhook: `https://bot.michael.kz/telegram/webhook`.
- `SESSION_SECRET` - длинный секрет для подписи web sessions и CSRF.
- `INITIAL_ADMIN_USERNAME` - логин первого admin, если `users` ещё пустая.
- `INITIAL_ADMIN_PASSWORD` - пароль первого admin, если `users` ещё пустая.
- `TASK_DUE_SOON_HOURS` - окно ближайшего дедлайна в часах, по умолчанию `24`.
- `APP_TIMEZONE_OFFSET_HOURS` - смещение локального времени для расчёта дедлайнов, по умолчанию `5`.
- `AUDIT_RETENTION_DAYS` - сколько дней хранить аудит и историю изменений, по умолчанию `90`.
- `TELEGRAM_NOTIFY_OVERVIEW_CHAT_ID` - необязательный общий чат/канал для уведомлений о статусах и дедлайнах.

Workflow сам загрузит `BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_USERS`, `SESSION_SECRET`, `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `TASK_DUE_SOON_HOURS`, `APP_TIMEZONE_OFFSET_HOURS`, `AUDIT_RETENTION_DAYS` и, если задан, `TELEGRAM_NOTIFY_OVERVIEW_CHAT_ID` в Worker secrets через Wrangler.

## Деплой через GitHub

После настройки `wrangler.toml` и GitHub Secrets просто отправьте изменения в `main`.

Workflow `.github/workflows/deploy-worker.yml` выполнит:

1. `npm ci`
2. `npm test`
3. `wrangler d1 migrations apply plat_telegram --remote`
4. `wrangler deploy`
5. `wrangler secret put ...`
6. `node scripts/set-webhook.mjs`

## Локальная разработка

```bash
npm install
npm test
npm run dev
```

Для локального D1:

```bash
npm run db:migrate:local
```

## Проверка

Healthcheck:

```text
https://bot.michael.kz/health
```

Webhook endpoint:

```text
https://bot.michael.kz/telegram/webhook
```

Веб-панель:

```text
https://bot.michael.kz/app
```

## Legacy Python

Папка `app/` оставлена как предыдущая Python-реализация. Production-путь теперь находится в `src/worker.js` и деплоится через Wrangler.
