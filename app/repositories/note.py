from sqlalchemy import select

from app.models.note import Note
from app.repositories.base import BaseRepository


class NoteRepository(BaseRepository[Note]):
    model = Note

    async def list_by_project(self, project_id: int, limit: int = 50) -> list[Note]:
        result = await self.session.scalars(
            select(Note).where(Note.project_id == project_id).order_by(Note.created_at.desc()).limit(limit)
        )
        return list(result.all())

    async def search(self, project_id: int, query: str, limit: int = 20) -> list[Note]:
        result = await self.session.scalars(
            select(Note)
            .where(Note.project_id == project_id, Note.text.ilike(f"%{query}%"))
            .order_by(Note.created_at.desc())
            .limit(limit)
        )
        return list(result.all())
