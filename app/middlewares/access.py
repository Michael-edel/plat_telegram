from collections.abc import Awaitable, Callable
from typing import Any

from aiogram import BaseMiddleware
from aiogram.types import Message, TelegramObject


class AccessMiddleware(BaseMiddleware):
    def __init__(self, allowed_users: set[int]) -> None:
        self.allowed_users = allowed_users

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        if not isinstance(event, Message):
            return await handler(event, data)

        user = event.from_user
        if user is None:
            return None

        if self.allowed_users and user.id not in self.allowed_users:
            if event.chat.type == "private":
                await event.answer("Доступ закрыт.")
            return None

        return await handler(event, data)
