import asyncio
import logging

from aiogram import Bot, Dispatcher

from app.core.config import get_settings
from app.core.database import create_tables
from app.handlers import decisions, ideas, links, notes, projects, search, start, tasks
from app.middlewares.access import AccessMiddleware


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()

    await create_tables()

    bot = Bot(token=settings.bot_token)
    dispatcher = Dispatcher()
    dispatcher.message.middleware(AccessMiddleware(settings.allowed_users))

    dispatcher.include_router(start.router)
    dispatcher.include_router(projects.router)
    dispatcher.include_router(ideas.router)
    dispatcher.include_router(tasks.router)
    dispatcher.include_router(links.router)
    dispatcher.include_router(notes.router)
    dispatcher.include_router(decisions.router)
    dispatcher.include_router(search.router)

    await dispatcher.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
