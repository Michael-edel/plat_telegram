from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload
from app.services.project_service import ProjectService

router = Router()


@router.message(Command("project_set"))
async def project_set(message: Message) -> None:
    name = command_payload(message)
    if not name:
        await message.answer("Укажите название проекта: /project_set название")
        return

    async with SessionFactory() as session:
        service = ProjectService(session)
        project = await service.set_active_project(message.chat.id, name)

    await message.answer(f"Активный проект: {project.name}")


@router.message(Command("projects"))
async def projects(message: Message) -> None:
    async with SessionFactory() as session:
        service = ProjectService(session)
        items = await service.list_projects()

    if not items:
        await message.answer("Проектов пока нет.")
        return

    lines = ["Проекты:"]
    lines.extend(f"- {project.name}" for project in items)
    await message.answer("\n".join(lines))
