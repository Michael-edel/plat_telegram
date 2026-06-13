import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web

from app.core.config import Settings, get_settings
from app.core.database import create_tables
from app.handlers import decisions, ideas, links, notes, projects, search, start, tasks
from app.middlewares.access import AccessMiddleware


def create_dispatcher(settings: Settings) -> Dispatcher:
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
    return dispatcher


async def healthcheck(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def run_polling(settings: Settings) -> None:
    bot = Bot(token=settings.bot_token)
    dispatcher = create_dispatcher(settings)

    await bot.delete_webhook(drop_pending_updates=settings.drop_pending_updates)
    await dispatcher.start_polling(bot)


async def run_webhook(settings: Settings) -> None:
    bot = Bot(token=settings.bot_token)
    dispatcher = create_dispatcher(settings)

    await bot.set_webhook(
        url=settings.webhook_url,
        secret_token=settings.webhook_secret,
        drop_pending_updates=settings.drop_pending_updates,
    )

    app = web.Application()
    app.router.add_get("/health", healthcheck)
    SimpleRequestHandler(
        dispatcher=dispatcher,
        bot=bot,
        secret_token=settings.webhook_secret,
    ).register(app, path=settings.webhook_path)
    setup_application(app, dispatcher, bot=bot)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=settings.web_server_host, port=settings.web_server_port)
    await site.start()

    logging.info("Webhook server started on %s:%s", settings.web_server_host, settings.web_server_port)
    logging.info("Telegram webhook URL: %s", settings.webhook_url)

    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()

    await create_tables()

    if settings.app_mode == "webhook":
        await run_webhook(settings)
    else:
        await run_polling(settings)


if __name__ == "__main__":
    asyncio.run(main())
