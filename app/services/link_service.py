from sqlalchemy.ext.asyncio import AsyncSession

from app.models.link import Link
from app.repositories.link import LinkRepository
from app.services.tag_service import TagService
from app.utils.validators import is_valid_url


class LinkService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = LinkRepository(session)
        self.tags = TagService(session)

    async def create_link(self, project_id: int, url: str, description: str | None = None) -> Link:
        clean_url = url.strip()
        clean_description = description.strip() if description else None
        if not is_valid_url(clean_url):
            raise ValueError("Некорректная ссылка. Нужен URL с http или https")
        text_for_tags = f"{clean_url} {clean_description or ''}"
        link = Link(project_id=project_id, url=clean_url, description=clean_description)
        link.tags = await self.tags.get_or_create_many_from_text(text_for_tags)
        await self.repository.add(link)
        await self.session.commit()
        return link

    async def list_links(self, project_id: int, limit: int = 50) -> list[Link]:
        return await self.repository.list_by_project(project_id, limit)
