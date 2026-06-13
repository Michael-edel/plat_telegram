from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.project import ChatProject, Project
from app.repositories.base import BaseRepository


class ProjectRepository(BaseRepository[Project]):
    model = Project

    async def get_by_name(self, name: str) -> Project | None:
        result = await self.session.scalars(select(Project).where(Project.name == name))
        return result.first()

    async def list_all(self) -> list[Project]:
        result = await self.session.scalars(select(Project).order_by(Project.name))
        return list(result.all())


class ChatProjectRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_for_chat(self, chat_id: int) -> ChatProject | None:
        result = await self.session.scalars(
            select(ChatProject)
            .options(selectinload(ChatProject.project))
            .where(ChatProject.chat_id == chat_id)
        )
        return result.first()

    async def set_for_chat(self, chat_id: int, project_id: int) -> ChatProject:
        chat_project = await self.get_for_chat(chat_id)
        if chat_project is None:
            chat_project = ChatProject(chat_id=chat_id, project_id=project_id)
            self.session.add(chat_project)
        else:
            chat_project.project_id = project_id
        await self.session.flush()
        await self.session.refresh(chat_project)
        return chat_project
