from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.services.idea_service import IdeaService
from app.services.project_service import ProjectService

router = Router()


@router.message(Command("idea"))
async def create_idea(message: Message) -> None:
    text = command_payload(message)
    if not text:
        await message.answer("Добавьте текст идеи: /idea текст")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        idea = await IdeaService(session).create_idea(project.id, text)

    await message.answer(f"Идея сохранена: #{idea.id}")
