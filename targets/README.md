# Targets

Recipes that a fetch can be pointed at with the `targetsFile` setting. Both files
here are **verification assets**, not production recipes: they exist so that a
release's behaviour can be replayed against real pages instead of asserted in
prose.

| File | What it proves | Which plugin version it needs |
| --- | --- | --- |
| `verify.json` | URL selection, the action summary, a step that does not hold failing loudly, a non-document body being refused, and the per-fetch re-read of the file (edit it between two fetches and the second one sees the change) | 0.2.18 |
| `verify-state.json` | the `state` condition: the gate's opening state (`all unchecked` over its five boxes), then `check` and `all checked`; and a w3schools recipe whose optional condition is *not* met, so a run of it shows the condition failing without failing the fetch | 0.2.21 |
| `verify-check.json` | the `check` verb: reaching the gate's 1×1 consent checkboxes through the 897×20 `<label>` beside them, reading the state back, leaving a control that is already ticked alone, and naming every candidate when none can be checked | 0.2.20 |
| `verify-click.json` | the `click` verb: an ordered candidate list (role / text / selector), reachability checked before the act, a Chinese and an English candidate each resolving on a real page, the wait after a click confirming it, `clicked (unverified)` when nothing follows, and every candidate being named when none can be clicked | 0.2.19 |

Every `*.json` in this directory is parsed by the test suite (`tests/targets.spec.ts`), because a file the parser refuses makes **every** fetch fail, not just the URLs inside it — so a recipe that cannot be loaded cannot be committed.

Point `targetsFile` at one file at a time. Both are deliberately chosen to be
harmless: `example.com`, `baidu.com`'s own search button, and the IANA page that
`example.com` links to. `verify-click-unreachable` is *meant* to fail — fetching
`https://www.iana.org/help/example-domains` with that file loaded reports every
candidate and why it was passed over.

`verify-state-booking-gate` needs a profile that has **not** consented to booking.com yet (a fresh browser context is enough) — the same fresh-profile caveat as the gate recipe in `verify-check.json`. `verify-state-w3schools` is the awkward one on purpose: the page's checkboxes are normally unticked, so its optional condition reports *not met* and is recorded as skipped, which is how you see the failure wording without failing a fetch.

`verify-check-w3schools` is the plain one: two `check` steps on a page with three ordinary checkboxes, so it proves the pass *and* the second step's `already checked` without touching a real gate.

`verify-check-booking-gate` is also the **working recipe** for booking.com's consent gate: ticking all five through the select-all's label and then clicking 同意 clears the interstitial and lands on the homepage (measured: `final document https://www.booking.com/index.zh-cn.html?... (HTTP 200)`, `stillGate false`). It records the user's consent for booking.com in whatever profile runs it, which is the same thing the `dismissConsent` setting does — that setting only clicks an accept button, so on *this* site it fails loudly (`WEB_FETCH_CONSENT`) where this recipe succeeds. Note also that `verify-check-unreachable` matches the gate's own URL, which is longer, so requesting the gate URL directly selects *that* recipe and fails on purpose.

One interaction to know before pointing `targetsFile` at this file: the `dismissConsent` setting runs **before** a target's actions, and on a full-page gate it fails the fetch (`WEB_FETCH_CONSENT`) when its own accept-only click does not clear it. So a gate recipe and `dismissConsent` are alternatives, not partners: turn the setting off to let a recipe own the page.

Notes worth keeping next to the recipes:

- `https://www.baidu.com/` is the Chinese page because it is reachable and its
  search button is a plain in-page control. Most Chinese portals' nav links
  (`163.com`, `baidu.com`'s own 新闻, `gov.cn`'s 要闻) are `target="_blank"`: the
  click lands, the tab it opens is closed by the popup guard, and the page the
  fetch is reading does not move — which is why a target ending on such a click
  reads `clicked (unverified)` rather than pretending the page changed.
- Nothing here carries credentials. `verify-check.json` is the one file that
  *does* write something to a site: ticking the gate's consents and clicking 同意
  records consent for booking.com, exactly as `dismissConsent` does. The other
  two files submit no form and record no consent.
