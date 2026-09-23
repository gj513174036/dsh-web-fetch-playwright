# tools/probe

`probe-site.mjs` — classify how hard one page is to take data from.

```
cd <repo root>
node tools/probe/probe-site.mjs '<url>' ['<url>' ...]
```

It connects to the browser on `127.0.0.1:9222` (the same one the plugin drives over CDP), opens one tab
per URL, records that tab's traffic over CDP, reads a few interaction signals from the DOM, closes the
tab, and prints one JSON line per URL.

**Why it sits next to `netdump`.** `web_fetch` + `netdump` are the canonical path for a site we are
going to run: they write a real capture to disk and rank its endpoints. But they also hand back the
whole page body. Sweeping a batch of sites to find out *which kind of site* needs the action model
needs only the verdict, not the bodies — which is what this does, cheaply.

**Verdicts**

| verdict | meaning |
| --- | --- |
| `ok-no-actions` | the served document already holds the content |
| `api-replayable` | little served text, but JSON endpoints exist that a crawler could replay |
| `api-opaque` | little served text, and the endpoints look signed or otherwise unreplayable |
| `needs-action` | little text, no JSON endpoint, but load-more / tabs are present |
| `login-gated` | a login wall stands where the content should be |
| `unclear` | none of the above held |

The first question is deliberately "did the fetch already get the content?", because that decides
whether anything else is needed at all; endpoints are the secondary question, about how a *crawler*
would replay it. A page can be both — `examine.com` serves 27k characters of content *and* has account
APIs that carry none of it.

Results so far are recorded in `docs/action-model-design.zh-CN.md` appendix B.

Read-only: it never types, clicks, submits, or navigates beyond the URL it was given.
