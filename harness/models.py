from dataclasses import dataclass, field

CATEGORIES = ["concert", "theatre", "talk", "exhibition", "sports", "kids",
              "senior", "course", "market", "food_drink", "religious",
              "meeting", "other"]

@dataclass
class RawItem:
    """Fields extracted from a source page, before the LLM touches it."""
    source_id: str
    url: str
    fetched_at: str
    title: str
    start: str                  # ISO 8601 with offset, from JSON-LD
    end: str | None = None
    venue: str = ""
    address: str = ""
    description: str = ""       # emails/phones redacted
    schedule: list[str] = field(default_factory=list)
    language: str = "no"


@dataclass
class Event:
    """Normalised event. Deliberately has NO personal-data fields."""
    title: str
    start: str
    venue: str
    source_id: str
    source_url: str
    language: str
    end: str | None = None
    category: str = "other"
    description: str = ""
    municipality: str = "Hamar"
    cancelled: bool = False
    summary_en: str = ""
    summary_no: str = ""
    student_fit: int = 0          # 0 = not relevant ... 3 = very relevant
    tags: list[str] = field(default_factory=list)