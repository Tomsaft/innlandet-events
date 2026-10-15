import xml.etree.ElementTree as ET

NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def parse_sitemap(xml_bytes: bytes) -> list[str]:
    root = ET.fromstring(xml_bytes)
    return [el.text.strip() for el in root.findall("sm:url/sm:loc", NS) if el.text]


def fetch_sitemap_urls(sitemap_url: str, session) -> list[str]:
    resp = session.get(sitemap_url, timeout=60)
    resp.raise_for_status()
    return parse_sitemap(resp.content)


def event_urls(urls: list[str], prefix: str) -> list[str]:
    """Keep /<prefix>/<slug> only. Category pages end in '/', so they are dropped."""
    seen, out = set(), []
    for u in urls:
        if not u.startswith(prefix):
            continue
        slug = u[len(prefix):]
        if not slug or "/" in slug or "?" in slug or "#" in slug:
            continue
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out