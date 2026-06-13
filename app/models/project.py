from __future__ import annotations

from sqlalchemy import BigInteger, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)

    ideas: Mapped[list["Idea"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    tasks: Mapped[list["Task"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    links: Mapped[list["Link"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    notes: Mapped[list["Note"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    decisions: Mapped[list["Decision"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ChatProject(Base):
    __tablename__ = "chat_projects"
    __table_args__ = (UniqueConstraint("chat_id", name="uq_chat_projects_chat_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)

    project: Mapped[Project] = relationship()
