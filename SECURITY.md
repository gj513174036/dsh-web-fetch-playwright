# Security Policy

## Security stance

This plugin takes the same position as the shipped HTTP fetch provider: it implements **no SSRF / private-network protection**. Anything the browser can reach, the provider can fetch — a rendered page, an internal service, or a link-local address. The CDP endpoint and the local browser path are configured from the settings page with no loopback restriction. Deploy it in a trusted environment and do not expose the settings page to untrusted networks.

Fetched pages are rendered locally; beyond the target page itself, no data leaves the machine — **except through a configured proxy**, which is a second destination by design (see the threat model below).

## Credentials and profile data this plugin handles

| Data | Where it lives | Why |
| --- | --- | --- |
| Proxy address | the `web-fetch-playwright` settings section (`$DSH_HOME/settings.yaml`) | injected into the browsers this plugin launches (local and DSH-managed); on the CDP backend it only shapes the launcher's `--proxy-server`. Error messages name the address with any `user:pass@` userinfo stripped. |
| Proxy username, password | the `web-fetch-playwright` settings section (`$DSH_HOME/settings.yaml`) | used by the browsers this plugin launches itself (Playwright's `proxy.username`/`password`). **Not delivered in the CDP/launcher topology**: a Chromium command line has no place for proxy credentials, the launcher never puts them in `--proxy-server`, and it prints a warning when they are set. Credentials never appear in an error message (the password is treated as secret everywhere). |
| DSH-managed browser profile (`userDataDir`) | the configured directory, default `$DSH_HOME/web-fetch-playwright/profile` | cookies, localStorage, and logins for the persistent browser. **Treat this directory as credential-bearing**: it is written by the browser and never cleaned, exported, or copied by this plugin. |
| CDP browser profile | the remote browser's own user-data-dir, chosen by you | profile mode (the default) fetches with those sessions. |
| Local launcher profile copy | the `--user-data-dir` you pass (default `$DSH_HOME/chrome-dsh-profile`) | a partial copy of your real Chrome profile for the visible-browser topology; the launcher excludes the browser locks, the big caches, and crash droppings, and never copies anything back. |

## Reporting a vulnerability

If you believe you have found a security issue in this plugin, please open a private advisory on GitHub:

https://github.com/chendefine/dsh-web-fetch-playwright/security/advisories/new

Please include:

- the affected version;
- a minimal reproduction (URL, configuration, expected vs actual behavior);
- whether you consider it a security boundary violation or a misconfiguration footgun.

Repair policy: confirmed issues get a fix, a version bump, a `CHANGELOG.md` entry, and a GitHub Security Advisory; fixes are published to npm and tagged.

## Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Internal network | Page fetch reaches private/link-local hosts | None by design (provider stance); restrict who may call `web_fetch`, run in a network-scoped environment |
| Settings page | CDP endpoint reconfiguration to an attacker-controlled browser | Trusted-environment deployment only; loopback checks deliberately not enforced |
| Outbound traffic | A configured proxy operator observes the target URLs, headers, and bodies | Expected: setting `proxyServer` names that hop deliberately. Loopback destinations always bypass it (`PROXY_LOOPBACK_BYPASS`); the plugin never rotates or auto-selects proxies |
| Fetched page (local backend) | Malicious JS runs in the browser | The browser is this plugin's own, launched per fetch, headless, closed with the fetch; the context is fresh per fetch; image/font/media subrequests are aborted; output passes Readability + DOMPurify before conversion |
| Fetched page (DSH-managed backend) | Malicious JS runs in a **persistent** browser whose profile holds logins | Headless per configuration; one browser for the plugin's lifetime, but each fetch still gets its own tab that is closed when the fetch ends; run it on a profile you accept as credential-bearing, and prefer a dedicated `userDataDir` over a personal one |
| Fetched page (CDP backend) | Malicious JS runs in the browser you started | The plugin never changes that browser's settings; isolated mode (uncheck *Share the browser context*) gives each fetch a throwaway context; profile mode runs with that browser's sessions, so a page tricking the agent into a state-changing request sends it with your cookies — the plugin cannot tell the two apart |
| Persistent profile directory | Cookies/logins linger after a session | Not a bug: it is the feature. Delete the `userDataDir` (managed) or the remote profile (CDP) to log out; nothing in this plugin exports or copies profile data — except the local launcher, which copies YOUR profile into YOUR chosen directory on YOUR command |
| Loopback DevTools port | The debug port is exposed to a network | The launcher defaults to loopback and **only accepts a loopback `--address`** (`127.0.0.1`, `127.0.0.0/8`, `::1`, `localhost`; a bracketed `[::1]` is normalized to `::1` and the bracketed form is never passed through): the port grants full control of the browser AND access to the logins in its profile, so it is never bound to a network interface. Remote access goes through a reverse tunnel (`autossh -R`), and keeping that tunnel loopback-bound is the operator's responsibility |
| Launcher diagnostics | A mistyped flag carrying `user:pass@host` (or a credentialed `--port`/`--address`) echoing the password into a terminal, a log, or a shell history | Every echoed argument and error message goes through `scrubCredentials`, which removes each token's userinfo up to its LAST `@` — covering passwords containing `/` or `@` — before anything is printed. The command the launcher actually runs still carries whatever the operator put in `--proxy-server`; that is why credentials do not belong there at all |
| A CDP browser's proxy | A proxied CDP browser silently going direct, or credentials leaking into a shell history | The launcher takes the proxy from the settings and warns when `proxyUsername`/`proxyPassword` are set (it cannot deliver them). Documented workaround: an auth-free local hop (e.g. `ssh -D 1080`) or answering the authentication once in a headful browser; never put credentials in `--proxy-server` |
| Profile copy for the launcher | Copying over (or into) a live/dirty profile directory | The copy skips `Singleton*` locks, caches, and crash droppings; it refuses a destination a browser is running on, and refuses to touch an EXISTING destination unless `--force` is passed |
| Workspace data | Rendered page content stored in sessions | Same as any `web_fetch` output — treat fetched content as untrusted data |

## Supported versions

The latest published npm release is the only supported version. Users on older releases should upgrade to the newest `dsh-web-fetch-playwright` on npm.
