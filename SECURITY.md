# Security Policy

## Security stance

This plugin takes the same position as the shipped HTTP fetch provider: it implements **no SSRF / private-network protection**. Anything the browser can reach, the provider can fetch — a rendered page, an internal service, or a link-local address. The CDP endpoint and the local browser path are configured from the settings page with no loopback restriction. Deploy it in a trusted environment and do not expose the settings page to untrusted networks.

Fetched pages are rendered locally; beyond the target page itself, no data leaves the machine — **except through a configured proxy**, which is a second destination by design (see the threat model below).

## Credentials and profile data this plugin handles

| Data | Where it lives | Why |
| --- | --- | --- |
| Proxy address, username, password | the `web-fetch-playwright` settings section (`$DSH_HOME/settings.yaml`) | injected into the browser this plugin launches; on the CDP backend it only shapes the launcher command. Error messages name the proxy address with any `user:pass@` userinfo stripped and never print the password. |
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
| Loopback DevTools port | The debug port is exposed to a network | The launcher binds it to `127.0.0.1` (`--remote-debugging-address=127.0.0.1`) and expects a reverse tunnel (`autossh -R`) for remote access; keeping that tunnel loopback-bound is the operator's responsibility, and the port grants full control of the browser |
| Workspace data | Rendered page content stored in sessions | Same as any `web_fetch` output — treat fetched content as untrusted data |

## Supported versions

The latest published npm release is the only supported version. Users on older releases should upgrade to the newest `dsh-web-fetch-playwright` on npm.
