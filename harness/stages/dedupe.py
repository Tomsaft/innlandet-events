from datetime import datetime, timezone


def _norm(s: str | None) -> str:
    return " ".join((s or "").casefold().split())


def event_key(e: dict) -> tuple:
    """Same event = same normalised title, start instant (UTC) and venue."""
    start = datetime.fromisoformat(e["start"]).astimezone(timezone.utc)
    return (_norm(e["title"]), start, _norm(e["venue"]))


def dedupe(events: list[dict]) -> tuple[list[dict], dict]:
    """Drop later events whose key was already seen; keep order otherwise.

    Done in code, not by the LLM: no model call, so no Budget needed.
    """
    kept, seen, merged = [], {}, []
    for e in events:
        k = event_key(e)
        if k in seen:
            merged.append({"kept": seen[k], "dropped": e["source_url"]})
            continue
        seen[k] = e["source_url"]
        kept.append(e)
    report = {"input": len(events), "output": len(kept),
              "removed": len(events) - len(kept), "merged": merged}
    return kept, report
