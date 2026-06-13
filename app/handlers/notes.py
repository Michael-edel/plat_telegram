from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.services.note_service import NoteService
from app.services.project_service import ProjectService

router = Router()


@router.message(Command("note"))
async def create_note(message: Message) -> None:
    text = command_payload(message)
    if not text:
        await message.answer("Добавьте текст заметки: /note текст")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        note = await NoteService(session).create_note(project.id, text)

    await message.answer(f"Заметка сохранена: #{note.id}")
