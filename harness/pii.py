import re

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# Norwegian phone numbers: 8 digits, optional +47, grouped 2-2-2-2 or 3-2-3.
# The lookahead keeps ISO dates (2026-12-04) from matching.
PHONE = re.compile(
    r"(?<!\d)(?!\d{4}-\d{2}-\d{2})(?:\+47|0047)?[\s-]?(?:\d{2}[\s-]?){4}(?!\d)"
    r"|(?<!\d)(?:\+47|0047)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{3}(?!\d)"
)


def redact(text: str) -> str:
    text = EMAIL.sub("[epost fjernet]", text)
    text = PHONE.sub("[telefon fjernet]", text)
    return text