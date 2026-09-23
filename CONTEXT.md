# dsh-web-fetch-playwright

A DeepSeek Harness plugin that retrieves pages through a real browser, records what they load, and
drives them through a short sequence of actions. This glossary names the concepts specific to that
work; general programming words are deliberately absent.

## Language

### Retrieving

**Fetch(抓取)**:
One page retrieval on behalf of the model: a single URL, rendered in a browser, returned as text.
_Avoid_: crawl, scrape, 爬取 (those describe volume work — see **Crawler**)

**Denoise(降噪)**:
The transformation that turns a rendered document into the text the model reads, keeping the page's
content and dropping everything that is not it.

**Challenge(挑战页)**:
An interstitial a bot-protection layer serves instead of the requested page, and that can clear by
itself in the same tab, so the fetch waits for it rather than giving up.

**Consent banner(同意横幅)**:
A consent-management banner shown over the page content. Dismissing it is a click the fetch makes on
the user's behalf, in the profile the fetch runs in.
_Avoid_: cookie popup

**Backend(后端)**:
Which browser a fetch uses: one launched for it and thrown away, one persistent browser DSH keeps,
or an already-running browser reached over a debugging protocol.
_Avoid_: provider (that is a different thing — the object that serves the fetch capability)

**Capture(抓包)**:
The record of one fetch's network traffic — requests, responses, bodies — kept on disk.
_Avoid_: 录制 on its own (it collides with **Action recording**)

### Driving a page

**Action(动作)**:
One browser operation a fetch performs on the page, such as a click, a keystroke, or a wait.

**Intent(意图)**:
The purpose behind an action, stated independently of how it is achieved. An intent is satisfied by
exactly one of its candidates.

**Candidate(候选)**:
One way to satisfy an intent — a CSS selector, a visible text, or a role. Candidates are ordered and
the first visible one wins, which is what lets a target survive a redesign.
_Avoid_: selector (a candidate may not be one)

**Target(目标)**:
A named recipe for one page: how to recognise its URL, which intents to satisfy in order, and what
to read out. It is the unit that gets frozen and replayed.
_Avoid_: profile, recipe

**Discovery(发现)**:
Finding the path to the data — once — either by a planner or by a person clicking through it.
_Avoid_: C 方案

**Freeze(固化)**:
Turning a discovery into a target that replays without a planner.
_Avoid_: compile, 编译

**Replay(重放)**:
Running a frozen target deterministically, with no planner in the loop.
_Avoid_: B 方案

**Observe(观察)**:
Reading a page's state back so a planner can choose the next action. Replay does not need it.
_Avoid_: inspect

**Action recording(动作录制)**:
Capturing a person's operations on a page so they can become a target. Distinct from **Capture**,
which records traffic rather than intent.

### Offline output

**Business API(业务接口)**:
An endpoint in a capture that carries the data a page displays, as opposed to transport, telemetry,
or static assets.

**Inventory(接口清单)**:
The ranked list of business APIs derived from one capture.

**Crawler(爬虫)**:
The standalone script generated from an inventory, replaying it with no browser and no model.
_Avoid_: spider, 采集器
