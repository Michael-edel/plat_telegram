from app.utils.tags import extract_hashtags
from app.utils.validators import is_valid_url


def test_extract_hashtags_unique_lowercase() -> None:
    assert extract_hashtags("Идея #AI #бот #ai #Бот") == ["ai", "бот"]


def test_validate_url() -> None:
    assert is_valid_url("https://example.com/path")
    assert is_valid_url("http://localhost:8000")
    assert not is_valid_url("ftp://example.com")
    assert not is_valid_url("example.com")
