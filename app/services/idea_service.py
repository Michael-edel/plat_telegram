from sqlalchemy.ext.asyncio import AsyncSession

from app.models.idea import Idea
from app.repositories.idea import IdeaRepository
from app.services.tag_service import TagService


class IdeaService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = IdeaRepository(session)
        self.tags = TagService(session)

    async def create_idea(self, project_id: int, text: str) -> Idea:
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("Текст идеи не может быть пустым")
        idea = Idea(project_id=project_id, text=clean_text)
        idea.tags = await self.tags.get_or_create_many_from_text(clean_text)
        await self.repository.add(idea)
        await self.session.commit()
        return idea

    async def list_ideas(self, project_id: int, limit: int = 50) -> list[Idea]:
        return await self.repository.list_by_project(project_id, limit)
