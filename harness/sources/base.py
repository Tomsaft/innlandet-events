from abc import ABC, abstractmethod
import json
from pathlib import Path
from harness.models import RawItem

FIXTURE_DIR = Path("fixtures")


class EventSource(ABC):
    """One adapter per calendar. Add Innlandet towns by adding subclasses."""
    id: str = "unnamed"

    @abstractmethod
    def fetch_live(self) -> list[RawItem]:
        """Fetch from the real source. Must respect robots.txt and terms."""

    def fetch(self, offline: bool = False) -> list[RawItem]:
        path = FIXTURE_DIR / f"{self.id}.json"
        if offline:
            data = json.loads(path.read_text(encoding="utf-8"))
            return [RawItem(**d) for d in data]
        items = self.fetch_live()
        FIXTURE_DIR.mkdir(exist_ok=True)
        path.write_text(
            json.dumps([i.__dict__ for i in items], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return items


class Enricher(ABC):
    """Later: Yr weather and Entur transport attach extra info to events."""
    id: str = "unnamed"

    @abstractmethod
    def enrich(self, events: list) -> list:
        ...