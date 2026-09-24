# Targets

> **怎么写一份配方？** 完整语法（四个动词、五种等待条件、候选、`optional`、`opensPage`）、
> 三步走（发现 → 固化 → 重放）、怎么读动作摘要与失败句：见
> [`docs/usage-scenarios.zh-CN.md` §5](../docs/usage-scenarios.zh-CN.md#5-场景-d页面要先操作才出数据)。
> 本文只说明**这个目录里各份文件是什么、证明什么**。

Recipes that a fetch can be pointed at with the `targetsFile` setting, in two kinds:

- **`verify-*.json` — verification assets.** They exist so a release's behaviour can be
  replayed against real pages instead of asserted in prose. Meant to be replaced, not kept.
- **A plain name — a production recipe**, for a site that needs actions before its data
  means anything. It is meant for real use, and its number (a count, a name) is part of
  the recipe because the fetch seam carries a URL and nothing else.

Each production recipe may carry its discovery beside it as `<name>.observation.md`: the
observe-mode report it was written from, what the recipe is and why each step looks the way
it does. A recipe whose reasoning is not written down cannot be reviewed.

| File | What it proves | Which plugin version it needs |
| --- | --- | --- |
| `verify.json` | URL selection, the action summary, a step that does not hold failing loudly, a non-document body being refused, and the per-fetch re-read of the file (edit it between two fetches and the second one sees the change) | 0.2.18 |
| `nmpa-datasearch.json` | the NMPA 数据查询 register (tickets #10 and #1): a dataset tile, a keyword, a submit that answers **in a new tab** — the recipe marks it `"opensPage": true`, so the run adopts the tab and the fetch reads the result table from it — and a `waitFor` on the **response** the submit is answered by (`…/data/nmpadata/countNums`), which is what turns "a click went out" into "the server answered". Observation: `nmpa-datasearch.observation.md` | 0.2.26 |
| `tga-artg.json` | the first recipe produced by *freezing a discovery* (ticket #9): the keyword `vitamin d` typed into the TGA's ARTG search and submitted, with `tga-artg.observation.md` committed next to it | 0.2.23 |
| `verify-type.json` | the `type` verb: writing into bing's own search box and letting its own submit carry the value (the results URL proves the page held it), plus a recipe whose candidates are all untypable, so the failure names each one | 0.2.23 |
| `verify-state.json` | the `state` condition: the gate's opening state (`all unchecked` over its five boxes), then `check` and `all checked`; and a w3schools recipe whose optional condition is *not* met, so a run of it shows the condition failing without failing the fetch | 0.2.21 |
| `verify-check.json` | the `check` verb: reaching the gate's 1×1 consent checkboxes through the 897×20 `<label>` beside them, reading the state back, leaving a control that is already ticked alone, and naming every candidate when none can be checked | 0.2.20 |
| `verify-click.json` | the `click` verb: an ordered candidate list (role / text / selector), reachability checked before the act, a Chinese and an English candidate each resolving on a real page, the wait after a click confirming it, `clicked (unverified)` when nothing follows, and every candidate being named when none can be clicked | 0.2.19 |

Every `*.json` in this directory is parsed by the test suite (`tests/targets.spec.ts`), because a file the parser refuses makes **every** fetch fail, not just the URLs inside it — so a recipe that cannot be loaded cannot be committed.

Point `targetsFile` at one file at a time. The verification files are deliberately
chosen to be harmless: `example.com`, `baidu.com`'s own search button, `cn.bing.com`'s
own search box, w3schools' plain checkboxes, and the IANA page `example.com` links to.
Some of them are *meant* to fail — `verify-click-unreachable` and `verify-type-unreachable`
report every candidate and why it was passed over, and `verify-state-w3schools` records a
condition that does not hold. `tga-artg.json` is a real query against the TGA's public
register: it types a keyword and submits the register's own form, which is what it is for.

Measured for `verify-state-booking-gate` (0.2.21, a throwaway browser context against the real interstitial):

```
before   state checked  → { held: false, why: '5 of 5 controls in selector "input[type=checkbox]" are not checked (e.g. "全选")' }
         state unchecked → { held: true }
replay   1. waitFor text "需您同意" — met
         2. waitFor all unchecked over selector "input[type=checkbox]" — met
         3. check text "全选" -> label (was unchecked, now checked) — met
         4. waitFor all checked over selector "input[type=checkbox]" — met
         5. click text "同意" -> button — clicked
         6. waitFor to have left https://www.booking.com/pipl_consent.zh-cn.html — met
         → final document https://www.booking.com/? (HTTP 200)
```

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
- Nothing here carries credentials. Two files write to a site: `verify-check.json`
  ticks booking.com's consents and clicks 同意 (which records consent, exactly as
  `dismissConsent` does), and `tga-artg.json` submits a keyword to the TGA's public
  register — the same query a person typing in that box would run. The rest only read,
  click links the sites themselves offer, or fill a search box and submit it.
