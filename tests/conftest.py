import asyncio
from collections.abc import Awaitable, Callable

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base


@pytest.fixture
def run_in_session() -> Callable[[Callable[[AsyncSession], Awaitable[None]]], None]:
    async def runner(test_func: Callable[[AsyncSession], Awaitable[None]]) -> None:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            await test_func(session)

        await engine.dispose()

    def run(test_func: Callable[[AsyncSession], Awaitable[None]]) -> None:
        asyncio.run(runner(test_func))

    return run
