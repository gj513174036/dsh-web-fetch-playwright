# Targets

Recipes that a fetch can be pointed at with the `targetsFile` setting. Both files
here are **verification assets**, not production recipes: they exist so that a
release's behaviour can be replayed against real pages instead of asserted in
prose.

| File | What it proves | Which plugin version it needs |
| --- | --- | --- |
| `verify.json` | URL selection, the action summary, a step that does not hold failing loudly, a non-document body being refused, and the per-fetch re-read of the file (edit it between two fetches and the second one sees the change) | 0.2.18 |
| `verify-click.json` | the `click` verb: an ordered candidate list (role / text / selector), reachability checked before the act, a Chinese and an English candidate each resolving on a real page, the wait after a click confirming it, `clicked (unverified)` when nothing follows, and every candidate being named when none can be clicked | 0.2.19 |

Point `targetsFile` at one file at a time. Both are deliberately chosen to be
harmless: `example.com`, `baidu.com`'s own search button, and the IANA page that
`example.com` links to. `verify-click-unreachable` is *meant* to fail — fetching
`https://www.iana.org/help/example-domains` with that file loaded reports every
candidate and why it was passed over.

Notes worth keeping next to the recipes:

- `https://www.baidu.com/` is the Chinese page because it is reachable and its
  search button is a plain in-page control. Most Chinese portals' nav links
  (`163.com`, `baidu.com`'s own 新闻, `gov.cn`'s 要闻) are `target="_blank"`: the
  click lands, the tab it opens is closed by the popup guard, and the page the
  fetch is reading does not move — which is why a target ending on such a click
  reads `clicked (unverified)` rather than pretending the page changed.
- Nothing here carries credentials, and nothing here writes to a site: no form is
  submitted with data, and no consent is recorded.
