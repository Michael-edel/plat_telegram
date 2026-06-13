from aiogram.types import Message

from app.models.project import Project
from app.services.project_service import ProjectService


def command_payload(message: Message) -> str:
    text = message.text or message.caption or ""
    parts = text.split(maxsplit=1)
    if len(parts) > 1 and parts[1].strip():
        return parts[1].strip()
    if message.reply_to_message:
        return (message.reply_to_message.text or message.reply_to_message.caption or "").strip()
    return ""


async def require_active_project(message: Message, service: ProjectService) -> Project | None:
    project = await service.get_active_project(message.chat.id)
    if project is None:
        await message.answer("Активный проект не выбран. Используйте /project_set название")
    return project
