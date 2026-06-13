from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import TaskStatus
from app.services.idea_service import IdeaService
from app.services.project_service import ProjectService
from app.services.search_service import SearchService
from app.services.task_service import TaskService


def test_create_project(run_in_session: Callable[[Callable[[AsyncSession], Awaitable[None]]], None]) -> None:
    async def scenario(session: AsyncSession) -> None:
        project = await ProjectService(session).get_or_create_project("Работа")
        assert project.id is not None
        assert project.name == "Работа"

    run_in_session(scenario)


def test_create_idea_with_tags(
    run_in_session: Callable[[Callable[[AsyncSession], Awaitable[None]]], None],
) -> None:
    async def scenario(session: AsyncSession) -> None:
        project = await ProjectService(session).get_or_create_project("Работа")
        idea = await IdeaService(session).create_idea(project.id, "Сделать MVP #Bot #MVP")
        assert idea.id is not None
        assert {tag.name for tag in idea.tags} == {"bot", "mvp"}

    run_in_session(scenario)


def test_complete_task(run_in_session: Callable[[Callable[[AsyncSession], Awaitable[None]]], None]) -> None:
    async def scenario(session: AsyncSession) -> None:
        project = await ProjectService(session).get_or_create_project("Работа")
        task = await TaskService(session).create_task(project.id, "Подготовить деплой")
        completed = await TaskService(session).complete_task(project.id, task.id)
        assert completed.status == TaskStatus.DONE

    run_in_session(scenario)


def test_search(run_in_session: Callable[[Callable[[AsyncSession], Awaitable[None]]], None]) -> None:
    async def scenario(session: AsyncSession) -> None:
        project = await ProjectService(session).get_or_create_project("Работа")
        await IdeaService(session).create_idea(project.id, "Интеграция с 1С")
        results = await SearchService(session).search(project.id, "1С")
        assert len(results) == 1
        assert results[0].kind == "Идея"

    run_in_session(scenario)
