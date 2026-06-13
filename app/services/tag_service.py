from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import Tag
from app.repositories.tag import TagRepository
from app.utils.tags import extract_hashtags


class TagService:
    def __init__(self, session: AsyncSession) -> None:
        self.repository = TagRepository(session)

    async def get_or_create_many_from_text(self, text: str) -> list[Tag]:
        tags: list[Tag] = []
        for tag_name in extract_hashtags(text):
            tags.append(await self.repository.get_or_create(tag_name))
        return tags
