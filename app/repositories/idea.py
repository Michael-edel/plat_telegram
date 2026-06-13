from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.idea import Idea
from app.repositories.base import BaseRepository


class IdeaRepository(BaseRepository[Idea]):
    model = Idea

    async def list_by_project(self, project_id: int, limit: int = 50) -> list[Idea]:
        result = await self.session.scalars(
            select(Idea)
            .options(selectinload(Idea.tags))
            .where(Idea.project_id == project_id)
            .order_by(Idea.created_at.desc())
            .limit(limit)
        )
        return list(result.all())

    async def search(self, project_id: int, query: str, limit: int = 20) -> list[Idea]:
        result = await self.session.scalars(
            select(Idea)
            .where(Idea.project_id == project_id, Idea.text.ilike(f"%{query}%"))
            .order_by(Idea.created_at.desc())
            .limit(limit)
        )
        return list(result.all())
