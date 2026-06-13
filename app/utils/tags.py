import re

TAG_PATTERN = re.compile(r"(?<!\w)#([A-Za-zА-Яа-яЁё0-9_]{2,80})")


def normalize_tag(tag: str) -> str:
    return tag.strip().lstrip("#").lower()


def extract_hashtags(text: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw_tag in TAG_PATTERN.findall(text or ""):
        tag = normalize_tag(raw_tag)
        if tag and tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result
