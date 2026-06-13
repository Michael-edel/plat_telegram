from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message

from app.core.database import SessionFactory
from app.handlers.common import command_payload, require_active_project
from app.models.task import TaskStatus
from app.services.project_service import ProjectService
from app.services.task_service import TaskService

router = Router()


@router.message(Command("task"))
async def create_task(message: Message) -> None:
    text = command_payload(message)
    if not text:
        await message.answer("Добавьте текст задачи: /task текст")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        task = await TaskService(session).create_task(project.id, text)

    await message.answer(f"Задача создана: #{task.id}")


@router.message(Command("tasks"))
async def list_tasks(message: Message) -> None:
    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        grouped = await TaskService(session).group_by_status(project.id)

    lines = [f"Задачи проекта {project.name}:"]
    for status in TaskStatus:
        lines.append(f"\n{status.value}:")
        tasks = grouped.get(status, [])
        if tasks:
            lines.extend(f"#{task.id} {task.text}" for task in tasks)
        else:
            lines.append("-")
    await message.answer("\n".join(lines))


@router.message(Command("task_done"))
async def task_done(message: Message) -> None:
    payload = command_payload(message)
    if not payload.isdigit():
        await message.answer("Укажите id задачи: /task_done 1")
        return

    async with SessionFactory() as session:
        project = await require_active_project(message, ProjectService(session))
        if project is None:
            return
        try:
            task = await TaskService(session).complete_task(project.id, int(payload))
        except LookupError:
            await message.answer("Задача не найдена в текущем проекте.")
            return

    await message.answer(f"Задача #{task.id} завершена.")


@router.callback_query(F.data.startswith("task_done:"))
async def task_done_callback(callback: CallbackQuery) -> None:
    if callback.message is None or callback.data is None:
        await callback.answer()
        return
    task_id = int(callback.data.split(":", maxsplit=1)[1])
    async with SessionFactory() as session:
        project = await ProjectService(session).get_active_project(callback.message.chat.id)
        if project is None:
            await callback.message.answer("Активный проект не выбран.")
            await callback.answer()
            return
        try:
            task = await TaskService(session).complete_task(project.id, task_id)
        except LookupError:
            await callback.message.answer("Задача не найдена.")
            await callback.answer()
            return
    await callback.message.answer(f"Задача #{task.id} завершена.")
    await callback.answer()
