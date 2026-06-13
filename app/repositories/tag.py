from sqlalchemy import select

from app.models.tag import Tag
from app.repositories.base import BaseRepository
from app.utils.tags import normalize_tag


class TagRepository(BaseRepository[Tag]):
    model = Tag

    async def get_by_name(self, name: str) -> Tag | None:
        result = await self.session.scalars(select(Tag).where(Tag.name == normalize_tag(name)))
        return result.first()

    async def get_or_create(self, name: str) -> Tag:
        normalized = normalize_tag(name)
        tag = await self.get_by_name(normalized)
        if tag is not None:
            return tag
        tag = Tag(name=normalized)
        self.session.add(tag)
        await self.session.flush()
        await self.session.refresh(tag)
        return tag
