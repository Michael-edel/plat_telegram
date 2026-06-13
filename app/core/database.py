from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.base import Base


def create_engine(settings: Settings | None = None) -> AsyncEngine:
    current_settings = settings or get_settings()
    return create_async_engine(current_settings.database_url, echo=False, future=True)


engine = create_engine()
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)


async def create_tables(db_engine: AsyncEngine | None = None) -> None:
    """Create database tables for MVP startup without migrations."""
    current_engine = db_engine or engine
    async with current_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        yield session
