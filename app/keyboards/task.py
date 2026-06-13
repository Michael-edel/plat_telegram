from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup


def task_done_keyboard(task_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Готово", callback_data=f"task_done:{task_id}")],
        ]
    )
