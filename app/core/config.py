from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    bot_token: str = Field(alias="BOT_TOKEN")
    database_url: str = Field(default="sqlite+aiosqlite:///./data/bot.db", alias="DATABASE_URL")
    allowed_users: set[int] = Field(default_factory=set, alias="ALLOWED_USERS")

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @field_validator("allowed_users", mode="before")
    @classmethod
    def parse_allowed_users(cls, value: object) -> set[int]:
        if value is None or value == "":
            return set()
        if isinstance(value, set):
            return {int(item) for item in value}
        if isinstance(value, list | tuple):
            return {int(item) for item in value}
        if isinstance(value, str):
            return {int(item.strip()) for item in value.split(",") if item.strip()}
        raise TypeError("ALLOWED_USERS must be a comma-separated string or a collection of integers")


@lru_cache
def get_settings() -> Settings:
    return Settings()
