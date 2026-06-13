from sqlalchemy import select

from app.models.decision import Decision
from app.repositories.base import BaseRepository


class DecisionRepository(BaseRepository[Decision]):
    model = Decision

    async def list_by_project(self, project_id: int, limit: int = 50) -> list[Decision]:
        result = await self.session.scalars(
            select(Decision)
            .where(Decision.project_id == project_id)
            .order_by(Decision.created_at.desc())
            .limit(limit)
        )
        return list(result.all())

    async def search(self, project_id: int, query: str, limit: int = 20) -> list[Decision]:
        result = await self.session.scalars(
            select(Decision)
            .where(Decision.project_id == project_id, Decision.text.ilike(f"%{query}%"))
            .order_by(Decision.created_at.desc())
            .limit(limit)
        )
        return list(result.all())
