from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.services.link_service import LinkService
from app.services.project_service import ProjectService

router = Router()


@router.message(Command("link"))
async def create_link(message: Message) -> None:
    payload = command_payload(message)
    if not payload:
        await message.answer("Добавьте ссылку: /link https://example.com описание")
        return
    parts = payload.split(maxsplit=1)
    url = parts[0]
    description = parts[1] if len(parts) > 1 else None

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        try:
            link = await LinkService(session).create_link(project.id, url, description)
        except ValueError as error:
            await message.answer(str(error))
            return

    await message.answer(f"Ссылка сохранена: #{link.id}")
