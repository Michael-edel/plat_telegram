from __future__ import annotations

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.association_tables import link_tags
from app.models.base import Base, TimestampMixin
from app.models.tag import Tag


class Link(TimestampMixin, Base):
    __tablename__ = "links"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="links")
    tags: Mapped[list[Tag]] = relationship(secondary=link_tags, lazy="selectin")
