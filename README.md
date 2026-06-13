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
