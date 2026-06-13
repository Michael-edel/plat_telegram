from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.task import Task, TaskStatus
from app.repositories.base import BaseRepository


class TaskRepository(BaseRepository[Task]):
    model = Task

    async def list_by_project(self, project_id: int) -> list[Task]:
        result = await self.session.scalars(
            select(Task)
            .options(selectinload(Task.tags))
            .where(Task.project_id == project_id)
            .order_by(Task.status, Task.created_at.desc())
        )
        return list(result.all())

    async def get_in_project(self, task_id: int, project_id: int) -> Task | None:
        result = await self.session.scalars(
            select(Task).where(Task.id == task_id, Task.project_id == project_id)
        )
        return result.first()

    async def set_status(self, task: Task, status: TaskStatus) -> Task:
        task.status = status
        await self.session.flush()
        await self.session.refresh(task)
        return task

    async def search(self, project_id: int, query: str, limit: int = 20) -> list[Task]:
        result = await self.session.scalars(
            select(Task)
            .where(Task.project_id == project_id, Task.text.ilike(f"%{query}%"))
            .order_by(Task.created_at.desc())
            .limit(limit)
        )
        return list(result.all())
