from dataclasses import dataclass, field

CATEGORIES = ["concert", "theatre", "talk", "exhibition", "sports", "kids",
              "senior", "course", "market", "food_drink", "religious",
              "meeting", "workshop", "other"]

# student_fit is derived from category in code, not asked from the LLM.
# 0 = not relevant for students ... 3 = very relevant.
STUDENT_FIT_BY_CATEGORY = {
    "concert": 3, "theatre": 2, "talk": 2, "exhibition": 2, "sports": 2,
    "kids": 0, "senior": 0, "course": 2, "market": 1, "food_drink": 2,
    "religious": 1, "meeting": 1, "workshop": 3, "other": 1,
}
assert set(STUDENT_FIT_BY_CATEGORY) == set(CATEGORIES), "every category needs a student_fit"

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
    student_fit: int = 0          # from STUDENT_FIT_BY_CATEGORY[category], set in code
    tags: list[str] = field(default_factory=list)