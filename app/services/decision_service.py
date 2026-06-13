from sqlalchemy.ext.asyncio import AsyncSession

from app.models.decision import Decision
from app.repositories.decision import DecisionRepository
from app.services.tag_service import TagService


class DecisionService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = DecisionRepository(session)
        self.tags = TagService(session)

    async def create_decision(self, project_id: int, text: str) -> Decision:
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("Текст решения не может быть пустым")
        decision = Decision(project_id=project_id, text=clean_text)
        decision.tags = await self.tags.get_or_create_many_from_text(clean_text)
        await self.repository.add(decision)
        await self.session.commit()
        return decision

    async def list_decisions(self, project_id: int, limit: int = 50) -> list[Decision]:
        return await self.repository.list_by_project(project_id, limit)
