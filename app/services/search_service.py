from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.decision import DecisionRepository
from app.repositories.idea import IdeaRepository
from app.repositories.link import LinkRepository
from app.repositories.note import NoteRepository
from app.repositories.task import TaskRepository


@dataclass(frozen=True)
class SearchItem:
    kind: str
    object_id: int
    text: str


class SearchService:
    def __init__(self, session: AsyncSession) -> None:
        self.ideas = IdeaRepository(session)
        self.tasks = TaskRepository(session)
        self.links = LinkRepository(session)
        self.notes = NoteRepository(session)
        self.decisions = DecisionRepository(session)

    async def search(self, project_id: int, query: str, limit_per_type: int = 10) -> list[SearchItem]:
        clean_query = query.strip()
        if not clean_query:
            raise ValueError("Поисковый запрос не может быть пустым")

        results: list[SearchItem] = []
        for idea in await self.ideas.search(project_id, clean_query, limit_per_type):
            results.append(SearchItem("Идея", idea.id, idea.text))
        for task in await self.tasks.search(project_id, clean_query, limit_per_type):
            results.append(SearchItem("Задача", task.id, task.text))
        for link in await self.links.search(project_id, clean_query, limit_per_type):
            text = f"{link.url} {link.description or ''}".strip()
            results.append(SearchItem("Ссылка", link.id, text))
        for note in await self.notes.search(project_id, clean_query, limit_per_type):
            results.append(SearchItem("Заметка", note.id, note.text))
        for decision in await self.decisions.search(project_id, clean_query, limit_per_type):
            results.append(SearchItem("Решение", decision.id, decision.text))
        return results
