from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note import Note
from app.repositories.note import NoteRepository
from app.services.tag_service import TagService


class NoteService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = NoteRepository(session)
        self.tags = TagService(session)

    async def create_note(self, project_id: int, text: str) -> Note:
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("Текст заметки не может быть пустым")
        note = Note(project_id=project_id, text=clean_text)
        note.tags = await self.tags.get_or_create_many_from_text(clean_text)
        await self.repository.add(note)
        await self.session.commit()
        return note

    async def list_notes(self, project_id: int, limit: int = 50) -> list[Note]:
        return await self.repository.list_by_project(project_id, limit)
