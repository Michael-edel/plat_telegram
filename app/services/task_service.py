from collections import defaultdict

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus
from app.repositories.task import TaskRepository
from app.services.tag_service import TagService


class TaskService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = TaskRepository(session)
        self.tags = TagService(session)

    async def create_task(self, project_id: int, text: str) -> Task:
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("Текст задачи не может быть пустым")
        task = Task(project_id=project_id, text=clean_text)
        task.tags = await self.tags.get_or_create_many_from_text(clean_text)
        await self.repository.add(task)
        await self.session.commit()
        return task

    async def list_tasks(self, project_id: int) -> list[Task]:
        return await self.repository.list_by_project(project_id)

    async def group_by_status(self, project_id: int) -> dict[TaskStatus, list[Task]]:
        grouped: dict[TaskStatus, list[Task]] = defaultdict(list)
        for task in await self.list_tasks(project_id):
            grouped[task.status].append(task)
        return {status: grouped[status] for status in TaskStatus}

    async def set_status(self, project_id: int, task_id: int, status: TaskStatus) -> Task:
        task = await self.repository.get_in_project(task_id, project_id)
        if task is None:
            raise LookupError("Задача не найдена в текущем проекте")
        await self.repository.set_status(task, status)
        await self.session.commit()
        return task

    async def complete_task(self, project_id: int, task_id: int) -> Task:
        return await self.set_status(project_id, task_id, TaskStatus.DONE)
