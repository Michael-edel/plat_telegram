from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.repositories.project import ChatProjectRepository, ProjectRepository


class ProjectService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.projects = ProjectRepository(session)
        self.chat_projects = ChatProjectRepository(session)

    async def get_or_create_project(self, name: str) -> Project:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Название проекта не может быть пустым")
        project = await self.projects.get_by_name(clean_name)
        if project is None:
            project = await self.projects.add(Project(name=clean_name))
            await self.session.commit()
        return project

    async def list_projects(self) -> list[Project]:
        return await self.projects.list_all()

    async def set_active_project(self, chat_id: int, name: str) -> Project:
        project = await self.get_or_create_project(name)
        await self.chat_projects.set_for_chat(chat_id, project.id)
        await self.session.commit()
        return project

    async def get_active_project(self, chat_id: int) -> Project | None:
        chat_project = await self.chat_projects.get_for_chat(chat_id)
        return chat_project.project if chat_project else None
