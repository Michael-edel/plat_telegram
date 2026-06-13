from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

router = Router()


HELP_TEXT = (
    "Команды:\n"
    "/project_set название - выбрать проект\n"
    "/projects - список проектов\n"
    "/idea текст - сохранить идею\n"
    "/task текст - создать задачу\n"
    "/tasks - список задач\n"
    "/task_done id - завершить задачу\n"
    "/note текст - сохранить заметку\n"
    "/decision текст - зафиксировать решение\n"
    "/link url описание - сохранить ссылку\n"
    "/find запрос - поиск"
)


@router.message(Command("start"))
async def start(message: Message) -> None:
    await message.answer("Бот для совместной работы готов. Используйте /help.")


@router.message(Command("help"))
async def help_command(message: Message) -> None:
    await message.answer(HELP_TEXT)
