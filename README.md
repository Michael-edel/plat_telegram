# Telegram-бот на Cloudflare Workers

Проект переведён на запуск через Cloudflare Workers, D1 и Wrangler. Docker и локальный Python-сервер больше не нужны для production-сценария: деплой выполняется из GitHub Actions.

## Архитектура

- Cloudflare Worker принимает Telegram webhook на `/telegram/webhook`.
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

## Что нужно создать в Cloudflare

1. Добавьте домен в Cloudflare и дождитесь активного статуса зоны.
2. Создайте D1 database:

```bash
npx wrangler d1 create plat_telegram
```

3. Скопируйте `database_id` из вывода команды в `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "plat_telegram"
database_id = "..."
```

4. В `wrangler.toml` замените route на ваш домен:

```toml
routes = [
  { pattern = "bot.edel.kz", custom_domain = true }
]
```

Итоговый Telegram webhook URL будет:

```text
https://bot.edel.kz/telegram/webhook
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
- `WEBHOOK_URL` - полный URL webhook: `https://bot.edel.kz/telegram/webhook`.

Workflow сам загрузит `BOT_TOKEN`, `WEBHOOK_SECRET` и `ALLOWED_USERS` в Worker secrets через Wrangler.

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
https://bot.edel.kz/health
```

Webhook endpoint:

```text
https://bot.edel.kz/telegram/webhook
```

## Legacy Python

Папка `app/` оставлена как предыдущая Python-реализация. Production-путь теперь находится в `src/worker.js` и деплоится через Wrangler.
