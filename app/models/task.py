from __future__ import annotations

from enum import StrEnum

from sqlalchemy import Enum, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.association_tables import task_tags
from app.models.base import Base, TimestampMixin
from app.models.tag import Tag


class TaskStatus(StrEnum):
    TODO = "todo"
    DOING = "doing"
    REVIEW = "review"
    DONE = "done"


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus, values_callable=lambda item: [status.value for status in item]),
        default=TaskStatus.TODO,
        nullable=False,
        index=True,
    )

    project: Mapped["Project"] = relationship(back_populates="tasks")
    tags: Mapped[list[Tag]] = relationship(secondary=task_tags, lazy="selectin")
