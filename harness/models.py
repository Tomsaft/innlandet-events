from dataclasses import dataclass, field


@dataclass
class RawItem:
    """Unprocessed text from a source, before the LLM touches it."""
    source_id: str
    url: str
    text: str
    fetched_at: str


@dataclass
class Event:
    """Normalised event. Deliberately has NO personal-data fields."""
    title: str
    start: str                  # ISO 8601, e.g. 2026-10-18T19:00
    venue: str
    source_id: str
    source_url: str
    language: str               # language of the original text: "no" | "en"
    end: str | None = None
    category: str | None = None
    description: str = ""
    municipality: str = "Hamar"
    tags: list[str] = field(default_factory=list)