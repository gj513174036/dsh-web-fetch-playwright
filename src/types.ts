/**
 * Structural types over the Playwright surface this plugin uses. Declared
 * locally (not imported from `playwright`) because the runtime module is
 * discovered dynamically — a user's global install, a pinned browser
 * executable, or the bundled `playwright-core` — and only these members are
 * load-bearing.
 *
 * @module dsh-web-fetch-playwright/types
 */

/**
 * Lifecycle events a shared browser handle can report. Declared once so the
 * two handle shapes (a connected `Browser`, a persistent context) are
 * structurally interchangeable for the pool; each backend only listens for
 * the event its handle actually emits — over CDP a connection reports
 * `disconnected`, a launched persistent context reports `close`.
 */
export type PlaywrightBrowserLifecycleEvent = 'disconnected' | 'close'

/** A navigation response, as `page.goto` returns it. */
export interface PlaywrightResponse {
  status(): number
  headers(): Record<string, string>
  text(): Promise<string>
  /** This response's URL; absent on minimal fakes. */
  url?(): string
  /**
   * The request this response answers — used to recognize main-frame
   * navigation responses while the challenge wait runs. Absent on fakes.
   */
  request?(): PlaywrightRequest
}

/** The request side of a response, for main-frame filtering. */
export interface PlaywrightRequest {
  /** True for navigations (document loads and their redirect hops). */
  isNavigationRequest?(): boolean
  /** `'document'` for frame navigations; absent on minimal fakes. */
  resourceType?(): string
  /** The frame that issued the request; compare with `page.mainFrame()`. */
  frame?(): unknown
}

/** A page inside a context. */
export interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<PlaywrightResponse | null>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  url(): string
  content(): Promise<string>
  close(): Promise<void>
  /**
   * Resource-filter interception at page level — installed on the page (not
   * its context) so profile mode never intercepts tabs it does not own.
   */
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  /** Popup notification; the fetch closes whatever its page spawns. */
  on?(event: 'popup', listener: (page: PlaywrightPage) => void): unknown
  /**
   * Response notification — the challenge wait uses it to track the LAST
   * main-frame navigation response (challenge pages reload into the real
   * document). Absent on minimal fakes (content polling covers them).
   */
  on?(event: 'response', listener: (response: PlaywrightResponse) => void): unknown
  /**
   * Evaluate an expression in the page — the challenge probe's live-DOM
   * path. Absent on minimal fakes (content polling covers them).
   */
  evaluate?(script: string, arg?: unknown): Promise<unknown>
  /** The main frame handle; compare with `request.frame()` for filtering. */
  mainFrame?(): unknown
}

/**
 * A browser context: fetch-owned and isolated (local backend, or CDP
 * `isolated` mode), or a persistent profile (CDP `profile` mode, or the
 * DSH-managed backend — never closed by a fetch).
 */
export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  close(): Promise<void>
  /**
   * Open a CDP session on ONE page of this context — the seam the network
   * recorder attaches to. Chromium-family contexts expose it; absent on
   * minimal fakes and non-CDP-capable backends, in which case recording is
   * skipped (never a fetch failure).
   */
  newCDPSession?(page: PlaywrightPage): Promise<CdpSession>
}

/**
 * One Chrome DevTools Protocol session attached to exactly one page, as
 * `context.newCDPSession(page)` returns it. Only the two members the network
 * recorder uses are declared, and both are structural so the test suite can
 * substitute a fake that replays an event stream.
 *
 * A session is per-page on purpose: the recorder must see ONLY the tab this
 * plugin's fetch opened, never the other tabs of a shared browser (profile
 * mode) — no `Target.setAutoAttach`, no browser-wide capture.
 */
export interface CdpSession {
  /** Send one protocol command (e.g. `Network.enable`). */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * Subscribe to one protocol event. The payload is the raw CDP params
   * object; the recorder narrows the fields it needs itself.
   */
  on(event: string, listener: (params: Record<string, unknown>) => void): unknown
  /** Detach the session; best-effort (absent on minimal fakes). */
  detach?(): Promise<void>
}

/** A route interception decision. */
export interface PlaywrightRoute {
  request(): { resourceType(): string }
  abort(): Promise<void>
  continue(): Promise<void>
}

/** A browser instance (launched locally or connected over CDP). */
export interface PlaywrightBrowser {
  /**
   * Open a fresh isolated context. Absent on the DSH-managed backend's shared
   * handle: `launchPersistentContext` resolves to a CONTEXT (the persistent
   * profile itself) which owns pages directly — see
   * {@link PlaywrightPersistentContext}.
   */
  newContext?(): Promise<PlaywrightContext>
  close(): Promise<void>
  /**
   * Contexts visible to this connection. Over CDP the default context — the
   * remote browser's real profile — is always dispatched first, so `[0]` is
   * it; absent on minimal fakes (isolated mode never calls this).
   */
  contexts?(): PlaywrightContext[]
  /** Liveness probe; absent on minimal fakes (assumed live). */
  isConnected?(): boolean
  /** Optional disconnect notification used to drop a stale shared connection. */
  on?(event: PlaywrightBrowserLifecycleEvent, listener: () => void): unknown
}

/**
 * What `launchPersistentContext` resolves to: the persistent PROFILE itself.
 * Playwright models a persistent launch as a context rather than a browser —
 * it owns pages directly (there is no separate isolated-context layer), and
 * closing it closes the browser process, which is why the pool treats it as
 * the shared handle and never releases it per fetch. Structurally it is also a
 * {@link PlaywrightContext}, so a lease can open its tabs in it unchanged.
 */
export interface PlaywrightPersistentContext {
  newPage(): Promise<PlaywrightPage>
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  close(): Promise<void>
  /** Tabs this profile currently has open; absent on minimal fakes. */
  pages?(): PlaywrightPage[]
  /** Closed probe — the persistent handle's liveness signal. */
  isClosed?(): boolean
  /** Close notification: the browser process went away. */
  on?(event: PlaywrightBrowserLifecycleEvent, listener: () => void): unknown
}

/**
 * The `proxy` launch option: the launched browser process dials every request
 * through `server` (`http(s)://`, `socks4://`, or `socks5://` — a bare
 * `host:port` is normalized to `http://` before it gets here), optionally
 * skipping `bypass` (comma-separated hosts) and authenticating with
 * `username`/`password`. It is a launch-time property of the browser process:
 * an already-running browser this plugin merely connects to cannot take one.
 */
export interface PlaywrightProxyOption {
  server: string
  bypass?: string
  username?: string
  password?: string
}

/** The `chromium` namespace of whichever Playwright module serves a fetch. */
export interface PlaywrightChromium {
  launch(options?: {
    headless?: boolean
    executablePath?: string
    timeout?: number
    /** Outbound proxy for the launched browser; omitted entirely = direct. */
    proxy?: PlaywrightProxyOption
    /** Extra Chromium command-line arguments (already split into argv). */
    args?: string[]
  }): Promise<PlaywrightBrowser>
  /**
   * Launch a browser on a PERSISTENT profile directory (the DSH-managed
   * backend): logins, cookies, and localStorage live in `userDataDir` and
   * survive across fetches, plugin restarts, and `dsh web` restarts.
   *
   * @param userDataDir - the profile directory (never a throwaway temp dir
   *   when persistence is the point).
   * @param options - headless switch, browser binary, proxy, extra args, budget.
   * @returns the persistent context (also the pool's shared handle).
   */
  launchPersistentContext(userDataDir: string, options?: {
    headless?: boolean
    executablePath?: string
    timeout?: number
    /** Outbound proxy for the launched browser; omitted entirely = direct. */
    proxy?: PlaywrightProxyOption
    /** Extra Chromium command-line arguments (already split into argv). */
    args?: string[]
  }): Promise<PlaywrightPersistentContext>
  connectOverCDP(endpointURL: string, options?: { timeout?: number }): Promise<PlaywrightBrowser>
}
