from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.services.project_service import ProjectService
from app.services.search_service import SearchService

router = Router()


@router.message(Command("find"))
async def find(message: Message) -> None:
    query = command_payload(message)
    if not query:
        await message.answer("Укажите запрос: /find текст")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        results = await SearchService(session).search(project.id, query)

    if not results:
        await message.answer("Ничего не найдено.")
        return

    lines = ["Найдено:"]
    lines.extend(f"{item.kind} #{item.object_id}: {item.text}" for item in results[:20])
    await message.answer("\n".join(lines))
