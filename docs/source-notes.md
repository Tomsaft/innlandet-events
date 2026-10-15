# Source notes

## hamar_kommune (https://www.hamar.kommune.no/kulturkalender/)
- Checked: <date>
- robots.txt: `User-agent: *` allows /, Crawl-delay: 5, Disallow: /sok/.
  /kulturkalender/ is not disallowed. ClaudeBot and SemrushBot are blocked.
- Our crawler: own User-Agent, honest identification, >=5 s between requests,
  results cached in fixtures/.
- Calendar is JS-filtered (filters in URL fragment).
- Feed options found: <ics / rss / none>
- Data endpoint observed in browser: <url or none>
- Terms of use: <link and summary>
- Decision: <use feed / use endpoint after terms check / choose another source>
- Open question for lecturer: site blocks AI crawlers (ClaudeBot); is
  low-volume, cached, identified access acceptable for a course project?