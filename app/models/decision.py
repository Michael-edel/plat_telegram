from __future__ import annotations

from sqlalchemy import ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.association_tables import decision_tags
from app.models.base import Base, TimestampMixin
from app.models.tag import Tag


class Decision(TimestampMixin, Base):
    __tablename__ = "decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="decisions")
    tags: Mapped[list[Tag]] = relationship(secondary=decision_tags, lazy="selectin")
