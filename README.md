# dsh-web-fetch-playwright

[中文](./README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the built-in `web_fetch` tool a **Playwright/CDP backend**: pages are rendered in a real browser, denoised with **Readability + DOMPurify + Turndown + GFM**, and returned as Markdown.

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## Features

- **Real browser rendering** — loads the page the way a user sees it, so client-side rendered (SPA) content is captured, not just the raw HTML.
- **Denoise pipeline** — Mozilla Readability extracts the article, DOMPurify removes layout/noise tags (nav, sidebar, footer, ads, forms), and Turndown with the GFM plugin converts to Markdown with the same style options as the shipped `tool-web` renderer. Inline `data:` images (build tools like Docusaurus embed screenshots as base64) are elided to size placeholders such as `![alt](data:image/png;base64,...8.9KB)` so they cannot flood the body.
- **Three backends** — a throwaway local Playwright browser per fetch, a **DSH-managed persistent browser** (one browser over a `user-data-dir`, reused as tabs, headless by configuration), or an already-running browser driven over CDP.
- **Outbound proxy** — configure address, bypass list, username, and password once; the proxy is injected into every browser this plugin launches (**local** and **DSH-managed**), and the bundled launcher turns the same settings into the `--proxy-server` command the **CDP** browser must be started with.
- **Browser resolution** — a configured path, a `playwright` CLI on `$PATH`, or the bundled `playwright-core`; CDP needs no local browser at all.
- **Isolated or profile sessions** — every fetch is scoped to exactly one tab. Local launches close their browser per fetch; the DSH-managed backend and the CDP backend keep **one shared browser** and each fetch opens a tab inside it, closed when done. For CDP the default is a tab in the remote browser's **real profile** (its cookies, localStorage, and persistent logins apply — like `playwright-cli open`); unchecking *Share the browser context* switches to a throwaway isolated context per fetch.
- **Local launcher for the visible-browser topology** — `dsh-web-fetch-launch` copies your real profile, starts your own Chrome with `--remote-debugging-port` (plus the configured proxy), and prints the `autossh` reverse-tunnel line that carries that port to the machine the plugin runs on (see [Two topologies](#two-topologies-visible-browser--headless-server)).
- **Network capture** — one CDP session per fetch records that tab's XHR/Fetch/WebSocket traffic (URL, method, headers, payload, response body, WS frames) to JSONL while the fetch runs, plus a HAR 1.2 export when it ends; opt-in, and the dumps hold plaintext credentials by design (see [Network capture](#network-capture-xhr--fetch--websocket)).
- **Live configuration** — a settings card (设置 → 插件 → 插件配置) edits the backend, context mode, denoise toggle, and concurrency; changes apply to the next fetch without a restart.
- **Budget-aware** — per-fetch deadline (45s); concurrency is backend-priced (`maxConcurrency`, default 4 local browsers / **50 tabs** for the CDP and DSH-managed backends; queued fetches fail fast with a retry hint after 20s instead of hanging); image/font/media subrequests aborted; body capped at 100k chars.
- **Bounded Cloudflare-challenge wait** — when a navigation lands on a challenge interstitial ("Just a moment…" and its localized siblings, recognized via the documented `cf-mitigated: challenge` response header plus structural page markers), the fetch keeps the **same tab and context** and waits for the browser's own verification to clear it — tracking the *last* main-frame response (the real page reloads in) and watching the live DOM so SPA-style clears are caught too. Bounded and configurable (`challengeWaitMs`, default 15s; 0 restores the legacy first-response behavior), with a bounded same-tab retry (`challengeRetries`, default 1). When the budget runs out, the fetch fails with the distinct `WEB_FETCH_CHALLENGE` error code instead of returning the interstitial as content. It never clicks, never injects CAPTCHA answers, never fakes browser state, and never exports or copies cookies.

## How it works

| Half | Location | Responsibility |
| --- | --- | --- |
| Host (server) | `src/` | Registers the fetch provider (id `playwright`) into `ctx.web`; `cordis.patch.yml` pins the web seam's `fetchProvider` to it and enables the `web_fetch` tool with a 60s budget. |
| Browser (client) | `src/client/` | Registers the *Playwright 网页爬取* configuration card, which hot-writes the settings section into `$DSH_HOME/settings.yaml`. |
| Local launcher | `bin/launch-browser.mjs` | `dsh-web-fetch-launch`: copies your profile, starts your browser with the DevTools port and the configured proxy, prints the tunnel command. |

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = playwright
        ├─ local:   resolve (path → $PATH → bundled playwright-core) → chromium.launch      (one browser per fetch)
        ├─ managed: resolve → chromium.launchPersistentContext(userDataDir, {headless, proxy, args})
        │            └─ ONE browser for the provider's lifetime; each fetch is a tab in it
        ├─ cdp:     connectOverCDP(endpoint) → one shared connection; each fetch is a tab
        ├─ page.goto → settle (networkidle, best-effort) → page.content()
        ├─ denoise: jsdom → elide data-URI images → Readability → DOMPurify → Turndown(GFM)
        └─ Markdown (or raw HTML when denoise is off)
```

## Requirements

- DSH web profile (`dsh web`), Node.js ≥ 20.
- For the **local** backend: a Playwright installation with Chromium, a Chromium-family browser binary, or `playwright-core` with a browser in the default cache.
- For the **DSH-managed** backend: the same browser resolution; the plugin runs the browser (headless by default) on a `user-data-dir`.
- For the **CDP** backend: any browser already running with `--remote-debugging-port` (e.g. `chromium --headless --remote-debugging-port=9222`, or the bundled launcher below).

## Installation

From the npm registry (prebuilt — no build permission needed):

```sh
dsh plugin --profile web add dsh-web-fetch-playwright
```

From a GitHub repository (source — pnpm runs the `prepare` build; allowlist the package in `profiles/web/pnpm-workspace.yaml` if pnpm blocks the build script):

```sh
dsh plugin --profile web add github:chendefine/dsh-web-fetch-playwright
```

Or through the DSH plugin marketplace (设置 → DSH插件市场) — the repo carries the `dsh-plugin` topic and is indexed automatically.

After a bundle plugin is added to the profile layer stack, **restart `dsh web`** for it to load; uninstall with `dsh plugin --profile web remove dsh-web-fetch-playwright` and restart again.

## Configuration

The settings card (设置 → 插件 → 插件配置 → *Playwright 网页爬取*) edits the `web-fetch-playwright` settings section live:

![Playwright 网页爬取 plugin configuration card](./playwright-plugin-config.png)

| Field | Default | Description |
| --- | --- | --- |
| `backend` | `local` | Radio: *Local Playwright* (throwaway browser per fetch), *DSH-managed persistent browser* (one browser kept alive on a `user-data-dir`), or *Remote CDP endpoint* (a browser you started), each with its own nested inputs. |
| `playwrightPath` | (blank) | Local and managed backends: path to a `playwright` executable or a Chromium-family browser binary. Blank = discover on `$PATH`, then fall back to the bundled `playwright-core`. |
| `headless` | `true` | Applies to every browser this plugin launches (local and DSH-managed) and to the launcher's `--headless=new`. Uncheck it on a desktop session to log in by hand. On the CDP backend it only changes the launcher command (the card's preview reflects that); override it there with `--headful`. |
| `userDataDir` | (blank) | Managed backend: the persistent profile directory — logins, cookies, extensions. Blank = `$DSH_HOME/web-fetch-playwright/profile`. **This directory is credential-bearing and is never cleaned by the plugin.** |
| `launchArgs` | (blank) | Extra Chromium arguments appended to every browser this plugin launches and to the launcher command, e.g. `--lang=zh-CN --disable-gpu`. Split on spaces, with quoting for values that contain them. On the CDP backend only the launcher command carries them; override there with `--launch-args`. |
| `cdpEndpoint` | `127.0.0.1:9222` | CDP backend: `host:port`, `http(s)://…` or `ws(s)://…`. |
| `shareBrowserContext` | `true` | CDP backend only. **Checked (profile mode)**: each fetch is a tab in the remote browser's default context — its real profile — so cookies/localStorage are shared and its persistent logins apply; only the tab closes when the fetch ends. **Unchecked (isolated mode)**: a fresh incognito-like context per fetch, nothing shared. The managed backend always uses its own persistent profile; the local backend ignores this field. |
| `proxyServer` | (blank) | Outbound proxy: `host:port` or an `http(s)/socks4/socks5` URL. Blank = direct. **Local/managed**: injected into the launched browser. **CDP**: not applied by the plugin (see [Proxy](#outbound-proxy)) — it drives the launcher's `--proxy-server` flag. |
| `proxyBypass` | (blank) | Comma-separated hosts that skip the proxy. Loopback (`127.0.0.1`, `localhost`, `::1`) is always merged in; the launcher re-joins the list with `;` for Chromium's `--proxy-bypass-list`. |
| `proxyUsername` / `proxyPassword` | (blank) | Proxy credentials for the browsers THIS plugin launches (local and DSH-managed), sent as `Proxy-Authorization`. Stored with the other settings; the password is never echoed back in an error message (the card renders it masked). **Not used in the CDP/launcher topology** — a Chromium command line cannot carry them, so the launcher warns instead (see [Two topologies](#two-topologies-visible-browser--headless-server)). |
| `denoise` | `true` | Run the denoise pipeline; off returns the full rendered HTML for the tool layer to convert. |
| `maxConcurrency` | *(auto)* | How many fetches may render at once (1–200). Blank = backend default: **4** for local (each slot launches a browser) / **50 tabs** for the CDP and DSH-managed backends (one browser is already alive, so a slot is a tab in it). Beyond the limit, fetches wait briefly; if no slot frees within 20s they fail with `WEB_FETCH_TIMEOUT` and a hint to retry or raise this setting, rather than hanging until the tool budget aborts. |
| `challengeWaitMs` | `15000` | Bounded wait (ms, 0–60000) for a Cloudflare challenge to clear naturally in the same tab. `0` disables the whole challenge path — the first response is returned as-is (the pre-0.2.5 behavior). |
| `challengeRetries` | `1` | Same-tab re-navigation attempts after a wait window runs out (0–3); any clearance cookies the browser earned stay in the context for the retry. Everything stays inside the 45s per-fetch deadline. |
| `recordNetwork` | `false` | Record each fetch's XHR/Fetch/WebSocket traffic to JSONL + HAR 1.2. Off by default: the dumps contain plaintext credentials. |
| `recordDir` | (blank) | Base directory for the dumps; each capture gets its own `<sessionId>` subdirectory. Blank = `<working directory>/net-dumps` (gitignored; directory `0700`, files `0600`). |
| `captureBodies` | `true` | Read response bodies through `Network.getResponseBody`. Off = URLs, statuses, headers, and request payloads only. |
| `maxBodyBytes` | `262144` | Byte cap per stored response body / WebSocket frame (0–16 MiB). A cut body is flagged `bodyTruncated` and keeps its original `bodyBytes`. |
| `recordAllResources` | `false` | Keep image/font/media/stylesheet records too (dropped by default: noise for API extraction). |

Local backend resolution order:

1. The configured path (auto-detected as Playwright CLI or browser binary).
2. A `playwright` executable on `$PATH` (its package knows that installation's browser registry).
3. The bundled `playwright-core` — requires `PLAYWRIGHT_BROWSERS_PATH` or browsers in the default cache; otherwise the error suggests `playwright install chromium`.

> **Windows note** — `$PATH` is scanned with the platform delimiter (`;`), but npm/pnpm global installs expose `playwright` as `.cmd`/`.ps1` shims whose location does not walk up to the package root, so discovery may still land on step 3 (the bundled core). To drive a specific installation's browser registry, point `playwrightPath` at the `playwright` package directory or a browser executable.

CDP mode needs no local browser: the provider holds **one shared connection** for its lifetime (reconnecting automatically if it drops, and reconnecting to the new endpoint when the setting changes), and every fetch leases a tab in the remote browser that closes when the fetch completes. Concurrency therefore counts tabs, which is why the CDP default is high (50). Unloading the plugin drops the shared connection (the remote browser itself is never closed).

### The DSH-managed persistent browser

`backend: managed` moves the browser into DSH's own hands: the plugin calls `launchPersistentContext(userDataDir, { headless, proxy, args })` once and keeps that browser for its whole lifetime, so every fetch is a tab in **one** browser over **one** profile directory. Logins, cookies, localStorage, and extensions survive across fetches, across `dsh web` restarts, and across plugin reloads — log in by hand once (uncheck *Run headless*), then flip it back to headless for production.

- **Concurrency means tabs.** One browser is already alive, so `maxConcurrency` (default 50) is how many tabs may be open at once, exactly like the CDP backend.
- **A setting change replaces the browser.** The shared browser is keyed on its launch descriptor (profile directory, headless, extra args, proxy, Playwright path): editing any of them closes the old browser and starts a new one on the next fetch. Changing `challengeWaitMs`, `denoise`, or `maxConcurrency` does not.
- **Teardown closes it.** Unloading the plugin (or `dsh web` exiting) closes the browser and leaves the profile directory on disk. A browser the user killed is detected (`isClosed()`) and relaunched on the next fetch.
- **The profile is yours to protect.** Everything the browser cached from a logged-in session lives there. Point `userDataDir` at a path you are willing to treat as credentials; nothing in this plugin ever cleans, exports, or copies it. Deleting it logs the browser out.

### The CDP context modes (share the browser's profile or not)

With *Share the browser context* **checked** (default, profile mode), each fetch is a tab in the remote browser's default context — the real profile. Cookies and localStorage come from and are written back to that profile, so sites the browser is logged into are fetched logged-in, exactly like a tab you open by hand. The shared context is never closed; resource filtering and popup guards attach to the fetch's tab only, so your other tabs are untouched. With it **unchecked** (isolated mode), every fetch gets a fresh incognito-like context — anonymous reads, nothing persists.

**Profile-mode risk notes** — it upgrades `web_fetch` from "anonymous read" to "acts as the browser's logged-in user":

- A fetched page that talks the agent into a GET-style state-changing URL (logout, settings change, API call) will send it with your session cookies.
- Concurrent fetches to the same site share one cookie jar; one fetch's logout or `Set-Cookie` affects the others.
- Output starts depending on the browser's history (A/B buckets, language preferences). The remote profile also keeps accumulating site data; the plugin never cleans it.

Persistent logins require a persistent user-data-dir. Headful (recommended — log in by hand once):

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-dsh-profile"
```

Headless server (pre-seed logins in a headful environment first): `chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/data/chrome-dsh-profile`. Do **not** add `--incognito` or a throwaway user-data-dir — either defeats profile mode. Design notes and verified playwright-core facts live in [`docs/context-mode-profile.md`](./docs/context-mode-profile.md).

### Outbound proxy

The card's proxy fields are one setting with two jobs, because a proxy belongs to the browser PROCESS:

| Backend | What the proxy settings do |
| --- | --- |
| `local` | Injected through Playwright's `launch({ proxy })`: every throwaway browser uses it, with the loopback bypass merged in. |
| `managed` | Injected through `launchPersistentContext({ proxy })` the same way, on the persistent browser. |
| `cdp` | **Not injected — and not verified.** The browser was started by someone else, so its proxy is that browser's own launch-time property: start it with `--proxy-server=…` (the launcher below does this from these same settings). This plugin does not block such fetches; if the browser was started without the flag, its traffic simply goes direct. |

Details that apply everywhere:

- `proxyServer` accepts `host:port` (normalized to `http://host:port`) or an explicit `http://`, `https://`, `socks4://`, `socks5://` URL. A blank field means a direct connection; an unusable value fails the fetch with the provider-specific `WEB_FETCH_PROXY` code.
- The loopback hosts `127.0.0.1`, `localhost`, and `::1` are always bypassed (`PROXY_LOOPBACK_BYPASS`), merged into whatever `proxyBypass` holds.
- Credentials ride in Playwright's `proxy.username` / `proxy.password` and are stored with the rest of the settings. A `WEB_FETCH_PROXY` message names the proxy address (userinfo stripped) and where it was resolved from, and **never** prints the password.
- The launcher prints Chromium's spelling: `--proxy-server=<normalized>` plus `--proxy-bypass-list=<a;b;c>` (semicolons, loopback included).
- An unreachable proxy surfaces as `WEB_FETCH_PROXY` on the local/managed backends — the launch itself fails, and the message says which proxy and which settings field it came from.

### Two topologies (visible browser ↔ headless server)

**(a) Server-only, headless** — `backend: managed`. One setting: `headless` checked, `userDataDir` pointed at a durable path (e.g. `/data/chrome-dsh-profile`). DSH starts the browser itself; nothing else to run. Log in by hand once by unchecking `headless` on a desktop, then re-check it.

**(b) Visible browser on your machine, plugin on a server** — the browser runs where you can SEE it, the plugin attaches over CDP through a reverse tunnel:

```sh
# 1. on your workstation: copy the real profile, start Chrome headful on 9222
dsh-web-fetch-launch --dry-run              # print the command (+ proxy flags) without running it
dsh-web-fetch-launch                        # or run it: copies the profile, starts the browser
dsh-web-fetch-launch --headful --profile "$HOME/.config/google-chrome"

# 2. carry that loopback port to the server the plugin runs on
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>

# 3. on the plugin host: settings card → backend = Remote CDP endpoint, cdpEndpoint = 127.0.0.1:9222
```

The launcher is `bin/launch-browser.mjs`, exposed as `dsh-web-fetch-launch`; it reads the same `web-fetch-playwright` section the card writes (`$DSH_HOME/settings.yaml`), so the proxy, `headless`, `userDataDir`, and `launchArgs` you configured in the UI are what it uses. Flags win over settings (`--proxy`, `--profile`, `--user-data-dir`, `--headless`/`--headful`, `--launch-args`, `--port`, `--settings`), `--no-copy` skips the profile copy, `--force` overwrites an existing copy target (without it a re-run into a directory that already exists is refused), and `--dry-run` only prints.

Two things worth knowing before you trust the launched browser:

- **`proxyUsername`/`proxyPassword` are NOT delivered here.** A Chromium command line has no place for proxy credentials, so the launcher never puts them into `--proxy-server` — it prints an explicit warning when the settings card has them. If your proxy demands authentication, put an auth-free hop in front of it (`ssh -D 1080 user@host`, then `--proxy socks5://127.0.0.1:1080`, or an IP allowlist on the proxy), or launch once headful and answer the authentication by hand. The same limitation applies to the CDP backend in general: the plugin cannot inject (or verify) a proxy on a browser it did not start.
- **The DevTools port stays on loopback.** `--address` accepts only `127.0.0.1`, the rest of `127.0.0.0/8`, `::1`, or `localhost`; anything else is refused with the reason (the port is full control of the browser *and* the logins in its profile). A bracketed IPv6 literal (`[::1]`) is accepted and normalized to the bare `::1` Chromium needs — the bracketed form is never passed through. Remote access is the reverse tunnel's job.

Errors and usage text echo your arguments back, never your credentials: before anything reaches stdout/stderr the launcher strips the `user:pass@` userinfo out of every token (unknown flags, `--port`, `--address`, and plan failures alike), so a typo like `--proxyy=http://user:secret@proxy:1080` prints only `--proxyy=http://proxy:1080`.

The profile copy is deliberately partial: `SingletonLock`/`SingletonCookie`/`SingletonSocket` (a live browser's locks), the big caches (`Cache`, `Code Cache`, `GPUCache`, `Service Worker`, `Media Cache`, the shader caches), and crash/telemetry droppings are excluded; cookies, `Login Data`, `Local Storage`, `Preferences`, and extensions are kept. It refuses to copy onto a profile a browser is currently running on (`SingletonLock` present), and it refuses to touch an EXISTING destination unless you pass `--force` — a copy target is a snapshot of real profile data, and silently merging into it is never what was meant. From a source checkout, build first (`pnpm build`) so `bin/` can import the built plugin; the published package ships `lib/` already.

`autossh -R 9222:127.0.0.1:9222` binds the remote port to the client's loopback — keep it that way (the launcher already binds DevTools to `127.0.0.1`), and treat the tunnel as access to your logged-in browser. The plugin's security stance is unchanged: no SSRF protection, so an agent that can call `web_fetch` can reach whatever that browser can reach.

### Network capture (XHR / Fetch / WebSocket)

With `recordNetwork` on, every fetch opens **one CDP session on the tab it just created** and silently records that tab's traffic: request URL, method, headers, request payload, response status/headers/body, and WebSocket lifecycle + frames. Nothing else is observed — no `Target.setAutoAttach`, no other tab of a shared browser, not even in profile mode: what the fetch opened is what gets recorded.

Two files per capture, under `<recordDir>/<sessionId>/` (default `<working directory>/net-dumps/<sessionId>`):

| File | What it is |
| --- | --- |
| `network.jsonl` | One JSON object per line, appended **while the fetch runs** — a `session` header, then `request` / `response` / `responseBody` / `finished` (or `failed`) per exchange, `requestExtra` / `responseExtra` rows carrying the authoritative header+cookie sets paired per HOP (a redirect hop closes as its own `response`/`finished` pair, so 301→200 yields two records, each keeping its own cookies/headers even when the extra-info event arrives before its hop's base event), plus `websocketCreated` / `websocketFrame` / `websocketClosed`. Live-readable, crash-tolerant, and what the offline pipeline consumes. One malformed URL or record degrades to that record alone: the export never loses the rest of the document. |
| `har.json` | A HAR 1.2 export written when the fetch ends — on success, on a thrown error, and on abort (plugin teardown flushes too). WebSocket traffic rides Chrome's `_webSocketMessages` extension. |

> **The dumps contain PLAINTEXT credentials.** `Cookie`, `Set-Cookie`, `Authorization`, tokens, and request/response bodies are stored verbatim — deliberately, because replaying a logged-in session is the point — so treat a dump directory as you would a password file. The defaults help: mode `0700` on the directory, `0600` on every file, and `net-dumps/` is in this repository's `.gitignore`. They do not help if you copy the directory somewhere else or commit it: never share, publish, or attach a dump.

Config knobs: `recordNetwork` (off by default — an opt-in switch, because recording writes credentials to disk), `recordDir` (base directory; each capture claims its own `<sessionId>` subdirectory with a non-recursive `mkdir`, so two captures can never share a dump), `captureBodies` (read response bodies through `getResponseBody`), `maxBodyBytes` (per-body/frame cap, 0–16 MiB, **0 = no cap**; a cut body is flagged `bodyTruncated` with its original `bodyBytes`), `recordAllResources` (keep image/font/media/stylesheet records — dropped by default: they are noise for API extraction and dominate the volume; note that the fetch's own resource filter *aborts* image/font/media subrequests before they load, so enabling this surfaces their URL and cancellation only, while stylesheet requests are recorded in full). The settings card shows the plaintext-credentials warning next to the switch.

Recording is **best-effort**: a CDP hiccup, a body that was already evicted, an unwritable directory, or a malformed event is swallowed (and listed in the recorder report) — it can never fail a `web_fetch`, and it never hides the fetched page.

### From a capture to a crawler (offline, no AI)

`tools/netdump/` (Python 3.11 standard library only) turns a dump into a business-API list and a runnable `httpx` crawler — with the captured headers and cookies embedded, static resources filtered, WebSocket channels listed:

```sh
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<session>/network.jsonl -o netdump-out
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<session>/har.json        -o netdump-out   # HAR works too
PYTHONPATH=tools/netdump python3 -m netdump summary net-dumps/<session>/network.jsonl                   # what is in here?
```

### Cloudflare challenge handling (bounded natural wait)

Some strict sites serve a Cloudflare interstitial before the real page. A real browser often passes the check on its own within a few seconds — but a fetch that only looks at the first response hands you the interstitial as if it were the page (the pre-0.2.5 behavior; reproduce it any time with `challengeWaitMs: 0`, or — from a repo checkout, after `pnpm build` — run `node scripts/challenge-demo.mjs` for a local simulated before/after, and `node scripts/challenge-online.mjs <url>` against a real site).

With the wait on (default):

1. **Detection** — a response carrying `cf-mitigated: challenge` (the documented signal for every challenge page type), or a 403/503 HTML document from a `server: cloudflare` edge, or the localized interstitial itself (title family like "Just a moment…", `请稍候…`, "Минутку…", plus structural markers: `/cdn-cgi/challenge-platform/` scripts, `#challenge-*` elements, `cf-chl-widget-` frames, `window._cf_chl_opt`). The content-level markers are the *fallback tier* and only run on challenge-compatible responses — 403/429/503 or a Cloudflare edge (`server: cloudflare` / `cf-ray`) — because interstitials never ship as a plain 200, so an ordinary article that merely quotes challenge text can never be mistaken for one. Cloudflare Bot Management's passive JavaScript-Detections telemetry (`/cdn-cgi/challenge-platform/scripts/jsd/`, injected into every *normal* page of a protected zone — e.g. openrouter.ai) is neutralized before the prefix scan, so protected 200 pages with real content never misclassify. A hard block ("Sorry, you have been blocked") is classified separately and fails immediately.
2. **Bounded wait, same tab and context** — the fetch polls the live DOM (500ms interval) for the challenge to disappear while the browser runs its own verification; the *last* main-frame navigation response is tracked so the reloaded real document's status and headers are the ones reported. SPA-style clears (content swapped without any navigation) are caught by the same DOM probe.
3. **Bounded retry** — when a window runs out, the same tab re-navigates once (default; `challengeRetries`) with whatever clearance cookies the context already holds.
4. **Clear failure** — `WEB_FETCH_CHALLENGE` (a provider-specific code the web seam's open-string `code` allows) naming the site, the budget spent, and the last challenge status.

Security boundary (deliberate): no clicking through Turnstile, no CAPTCHA solving or token injection, no fingerprint/UA spoofing, and no proxy **rotation** (the configured proxy is a single static egress hop — it is never swapped per request to dodge a challenge) — and no cookie export: in isolated mode the clearance a fetch's browser earns dies with that fetch's context; in profile mode it stays in the browser's own profile, which this plugin never copies or cleans. The wait is always bounded by `challengeWaitMs` and the 45s per-fetch deadline; nothing blocks forever.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (browser smoke self-skips without a browser)
pnpm build       # tsc declarations + tsdown (host ESM + client module-registration bundle)
```

Repository layout:

```
src/
├── index.ts               # host entry: registers provider + settings section
├── config.ts              # schemastery schema, CDP/proxy normalizers, managed launch plan
├── provider.ts            # WebFetchProvider: navigation, deadline, semaphore, caps
├── browser-pool.ts        # shared-browser pool (lease/liveness/replacement) both backends ride
├── cdp-pool.ts            # the CDP instantiation of that pool
├── recorder.ts            # P2 capture: per-fetch CDP session → JSONL + HAR (best-effort)
├── har.ts                 # HAR 1.2 assembly for a capture (pure)
├── launcher.ts            # local launcher logic: settings section, command, profile copy
├── launch-args.ts         # dependency-free flag shaping (host + card preview + launcher)
├── markdown.ts            # denoise pipeline (Readability + DOMPurify + Turndown/GFM)
├── playwright-resolve.ts  # local backend discovery (path / $PATH / bundled core)
├── types.ts               # structural Playwright types (runtime module discovered dynamically)
└── client/                # browser half: settings card, form model, locales, preview
bin/
└── launch-browser.mjs     # dsh-web-fetch-launch (see the topology manual)
tests/                     # unit + provider + browser integration (self-skipping)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and release workflow, and [SECURITY.md](./SECURITY.md) for the security model and reporting policy.

## Security

Same stance as the built-in HTTP provider: **no SSRF / private-network protection is implemented** — anything the browser can reach, this provider can fetch. The CDP endpoint and the local launcher are configured from the settings page with no loopback restriction, so only expose the settings page to trusted environments. Fetched pages are rendered locally; no data is sent anywhere beyond the target page itself — with two caveats:

- **A configured proxy is a second destination.** When `proxyServer` is set, the browser's requests (including the target URL and its headers) egress through that hop, so its operator sees them. `PROXY_LOOPBACK_BYPASS` keeps loopback traffic off the proxy; nothing else is filtered.
- **Profile-bearing backends act with your sessions.** The DSH-managed backend fetches with the logins in its `userDataDir`, and CDP profile mode (the default) with the remote browser's real profile. A page that tricks the agent into a state-changing GET sends it with those cookies, and one fetch's logout/`Set-Cookie` affects the others sharing the jar. See [SECURITY.md](./SECURITY.md) for the per-backend threat model.

## License

[MIT](./LICENSE) © 2026 chendefine
