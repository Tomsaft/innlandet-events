import argparse

from harness.sources.hamar_kommune import HamarKommuneSource


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["probe"])
    p.add_argument("--max-pages", type=int, default=30)
    p.add_argument("--offline", action="store_true", help="read fixtures instead of fetching")
    args = p.parse_args()

    items = HamarKommuneSource(max_pages=args.max_pages).fetch(offline=args.offline)
    print(f"{len(items)} items")
    for it in items[:5]:
        print(f"- {it.start} | {it.title} | {it.venue}")


if __name__ == "__main__":
    main()