from sqlalchemy import or_, select

from app.models.link import Link
from app.repositories.base import BaseRepository


class LinkRepository(BaseRepository[Link]):
    model = Link

    async def list_by_project(self, project_id: int, limit: int = 50) -> list[Link]:
        result = await self.session.scalars(
            select(Link).where(Link.project_id == project_id).order_by(Link.created_at.desc()).limit(limit)
        )
        return list(result.all())

    async def search(self, project_id: int, query: str, limit: int = 20) -> list[Link]:
        result = await self.session.scalars(
            select(Link)
            .where(
                Link.project_id == project_id,
                or_(Link.url.ilike(f"%{query}%"), Link.description.ilike(f"%{query}%")),
            )
            .order_by(Link.created_at.desc())
            .limit(limit)
        )
        return list(result.all())
