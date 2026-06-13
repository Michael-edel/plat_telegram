# Telegram-бот для совместной работы

Production-ready MVP Telegram-бота для двух партнёров: проекты, идеи, задачи, ссылки, заметки, решения и поиск.

## Стек

- Python 3.12+
- aiogram 3.x
- SQLAlchemy 2.x Async ORM
- SQLite через aiosqlite
- pydantic-settings
- Docker
- pytest

## Структура

```text
app/
  core/          # конфиг и БД
  handlers/      # Telegram-команды
  keyboards/     # inline-клавиатуры
  middlewares/   # контроль доступа
  models/        # ORM-модели
  repositories/  # работа с БД
  services/      # бизнес-логика
  utils/         # утилиты
tests/           # базовые тесты
```

## Локальный запуск

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.main
```

На Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python -m app.main
```

## Docker

```bash
cp .env.example .env
docker compose up --build
```

SQLite хранится в persistent volume `bot_data`.

## Запуск через Cloudflare HTTPS

Бот поддерживает два режима:

- `APP_MODE=polling` - локальная разработка без публичного HTTPS.
- `APP_MODE=webhook` - запуск через публичный HTTPS URL, например через Cloudflare Tunnel.

Для работы через Cloudflare Dashboard настройте Tunnel так, чтобы публичный hostname вёл на локальный сервис:

```text
http://bot:8080
```

Если бот запущен не внутри `docker-compose`, а напрямую на сервере, укажите origin service:

```text
http://localhost:8080
```

Пример `.env` для Cloudflare:

```env
APP_MODE=webhook
WEBHOOK_BASE_URL=https://bot.example.com
WEBHOOK_PATH=/telegram/webhook
WEBHOOK_SECRET=change-this-secret-token
WEB_SERVER_HOST=0.0.0.0
WEB_SERVER_PORT=8080
```

`WEBHOOK_BASE_URL` должен быть вашим публичным HTTPS-адресом из Cloudflare. Итоговый webhook Telegram будет:

```text
https://bot.example.com/telegram/webhook
```

### Docker Compose с Cloudflare Tunnel

1. В Cloudflare Dashboard создайте Tunnel.
2. В Public Hostname укажите домен или поддомен.
3. В Service укажите `http://bot:8080`.
4. Скопируйте token tunnel в `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=your_cloudflare_tunnel_token
```

5. Запустите:

```bash
docker compose --profile cloudflare up --build
```

Для обычного запуска без Cloudflare:

```bash
docker compose up --build
```

## Настройка ALLOWED_USERS

В `.env` укажите Telegram user_id пользователей через запятую:

```env
ALLOWED_USERS=111111111,222222222
```

Если список пустой, бот не ограничивает доступ. Для закрытого рабочего бота список лучше всегда заполнять.

## Команды

- `/start` - старт
- `/help` - помощь
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

Команды `/idea`, `/task`, `/note`, `/decision` и `/link` поддерживают reply-режим: если команда отправлена ответом на сообщение без текста после команды, бот возьмёт текст или caption из исходного сообщения.

## Тесты

```bash
pytest
```
