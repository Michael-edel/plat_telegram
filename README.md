# Telegram-бот на Cloudflare Workers

Проект переведён на запуск через Cloudflare Workers, D1 и Wrangler. Docker и локальный Python-сервер больше не нужны для production-сценария: деплой выполняется из GitHub Actions.

## Архитектура

- Cloudflare Worker принимает Telegram webhook на `/telegram/webhook`.
- Веб-панель доступна на `/app` и работает с той же D1 базой.
- JSON API веб-панели доступен на `/api/*`.
- Cloudflare D1 хранит проекты, активный проект чата, идеи, задачи, ссылки, заметки, решения и теги.
- Wrangler деплоит Worker и применяет D1 migrations.
- GitHub Actions запускает тесты, применяет миграции, деплоит Worker и настраивает Telegram webhook.

## Команды бота

- `/start` или `/help` - помощь
- `/project_set [name]` - выбрать активный проект для чата
- `/projects` - список проектов
- `/idea [text]` - сохранить идею
- `/task [text]` - создать задачу
- `/tasks` - показать задачи по статусам
- `/task_done [id]` - завершить задачу
- `/note [text]` - сохранить заметку
- `/decision [text]` - зафиксировать решение
- `/link [url] [description]` - сохранить ссылку
- `/find [query]` - поиск по текущему проекту

Команды `/idea`, `/task`, `/note`, `/decision` и `/link` поддерживают reply-режим.

## Веб-панель

Панель предназначена для внутренней работы двух партнёров и закрыта Basic Auth.

Адрес:

```text
https://bot.michael.kz/app
```

Возможности MVP:

- список проектов;
- создание проекта;
- статистика по задачам, идеям, заметкам, решениям и ссылкам;
- страница проекта;
- задачи по статусам `todo`, `doing`, `review`, `done`;
- смена статуса задачи через select;
- создание задач, идей, заметок, решений и ссылок;
- просмотр ссылок с открытием в новой вкладке;
- поиск по текущему проекту;
- JSON API для проектов, данных проекта и поиска.

Маршруты:

```text
GET  /app
GET  /app/projects
GET  /app/projects/:id
POST /app/projects
POST /app/tasks
POST /app/tasks/:id/status
POST /app/ideas
POST /app/notes
POST /app/decisions
POST /app/links

GET  /api/projects
GET  /api/projects/:id
GET  /api/search?project_id=1&q=...
```

Basic Auth задаётся через Worker secrets:

```text
PANEL_USERNAME
PANEL_PASSWORD
```

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
- `PANEL_USERNAME` - логин для веб-панели.
- `PANEL_PASSWORD` - пароль для веб-панели.

Workflow сам загрузит `BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_USERS`, `PANEL_USERNAME` и `PANEL_PASSWORD` в Worker secrets через Wrangler.

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
