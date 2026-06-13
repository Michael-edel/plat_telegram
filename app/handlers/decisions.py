from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.services.decision_service import DecisionService
from app.services.project_service import ProjectService

router = Router()


@router.message(Command("decision"))
async def create_decision(message: Message) -> None:
    text = command_payload(message)
    if not text:
        await message.answer("Добавьте текст решения: /decision текст")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        decision = await DecisionService(session).create_decision(project.id, text)

    await message.answer(f"Решение сохранено: #{decision.id}")
