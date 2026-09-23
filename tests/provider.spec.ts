/**
 * The provider over fake browser sessions: URL hygiene, content-type
 * branching, the denoise toggle, body caps, error taxonomy, the concurrency
 * queue (gated sessions), the CDP context modes (profile closing only its
 * tab, isolated closing page + context, abort leaving the shared default
 * context intact, the popup guard), plus one real-socket case for the CDP
 * connect failure path — the bounded Cloudflare-challenge wait (A/B
 * baseline vs feature on, SPA clears, same-page retries, hard blocks,
 * aborts) — and the outbound proxy: launch-option injection, the
 * WEB_FETCH_PROXY mapping, password redaction, and the CDP refusal.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import type { ResolvedConfig } from '../src/config.ts'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { ResolvedPlaywright } from '../src/playwright-resolve.ts'
import { CAPTURE_ERROR_KINDS_MAX, captureErrorKey, CaptureErrorReporter, PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE, WEB_FETCH_PROXY_CODE } from '../src/provider.ts'
import type { BrowserSession } from '../src/provider.ts'
import type { CdpSession, PlaywrightBrowser, PlaywrightChromium, PlaywrightContext, PlaywrightPage, PlaywrightPersistentContext, PlaywrightResponse } from '../src/types.ts'

/**
 * Controllable seam over the LOCAL backend resolution. With no hook installed
 * the real resolution runs (the CDP real-socket case below needs its
 * sibling), while a test installs a hook to observe the `launch` options
 * without a browser, or to make the launch fail.
 */
const localBackendHook = vi.hoisted(() => ({
  current: undefined as undefined | ((path: string) => Promise<ResolvedPlaywright>),
}))

vi.mock('../src/playwright-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playwright-resolve.ts')>()
  return {
    ...actual,
    resolvePlaywrightBackend: async (path: string): Promise<ResolvedPlaywright> => {
      const hook = localBackendHook.current
      return hook === undefined ? await actual.resolvePlaywrightBackend(path) : await hook(path)
    },
  }
})

/** Observable state of a fake persistent context (the managed backend). */
interface FakePersistentState {
  /** close() was called on the context (the whole browser going away). */
  closed: boolean
  /** Tabs handed out by newPage(). */
  pagesOpened: number
  /** Tabs whose close() was called. */
  pagesClosed: number
  /** Close listeners registered through on('close'). */
  closeListeners: Array<() => void>
}

/** A fake persistent context: owns pages directly, tracks its own close. */
function fakePersistentContext(spec: FakePageSpec = {}): { handle: PlaywrightPersistentContext; state: FakePersistentState } {
  const state: FakePersistentState = { closed: false, pagesOpened: 0, pagesClosed: 0, closeListeners: [] }
  const handle: PlaywrightPersistentContext = {
    newPage: async () => {
      state.pagesOpened++
      const pageState: FakePageState = { pageClosed: false, gotos: 0, waits: 0 }
      const page = makeFakePage(spec, pageState)
      const close = page.close.bind(page)
      return {
        ...page,
        close: async () => {
          if (!pageState.pageClosed) state.pagesClosed++
          await close()
        },
      }
    },
    route: async () => {},
    close: async () => { state.closed = true },
    pages: () => [],
    isClosed: () => state.closed,
    on: (event: 'disconnected' | 'close', listener: () => void) => {
      if (event === 'close') state.closeListeners.push(listener)
    },
  }
  return { handle, state }
}

/** One event a fake CDP session replays once the Network domain is enabled. */
interface FakeCdpEvent {
  event: string
  params: Record<string, unknown>
}

/** What a fake CDP session does, per test. */
interface FakeCaptureScript {
  /** Events replayed right after `Network.enable` (the tab's own traffic). */
  events?: FakeCdpEvent[]
  /** `Network.getResponseBody` answers, keyed by requestId. */
  bodies?: Record<string, { body: string; base64Encoded?: boolean }>
  /** Make `Network.enable` reject (a backend without the domain). */
  failEnable?: boolean
  /** Make `newCDPSession` reject (no session on this page/context). */
  sessionError?: Error
}

/** A fake CDP session: records commands, replays a scripted event stream. */
class FakeCdpSession implements CdpSession {
  readonly sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()

  constructor(private readonly script: FakeCaptureScript = {}) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params })
    if (method === 'Network.enable') {
      if (this.script.failEnable === true) throw new Error('Network domain is not available')
      for (const step of this.script.events ?? []) this.emit(step.event, step.params)
      return {}
    }
    if (method === 'Network.getResponseBody') {
      const requestId = String(params?.['requestId'] ?? '')
      const body = this.script.bodies?.[requestId]
      if (body === undefined) throw new Error(`No resource with given identifier found (${requestId})`)
      return { body: body.body, base64Encoded: body.base64Encoded === true }
    }
    return {}
  }

  on(event: string, listener: (params: Record<string, unknown>) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return undefined
  }

  private emit(event: string, params: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(params)
  }

  /** The protocol commands this session received, by method name. */
  methods(): string[] {
    return this.sent.map(entry => entry.method)
  }
}

/** What a fake backend recorded, for assertions. */
interface FakeBackend {
  /** `launch` option objects, in call order (the per-fetch local backend). */
  launches: Array<Parameters<PlaywrightChromium['launch']>[0]>
  /** `launchPersistentContext` calls: profile directory plus options. */
  persistentLaunches: Array<{ userDataDir: string; options: Parameters<PlaywrightChromium['launchPersistentContext']>[1] }>
  /** The persistent contexts those calls produced (one per launch). */
  persistentContexts: Array<{ handle: PlaywrightPersistentContext; state: FakePersistentState }>
  /** CDP sessions the backends handed out (the P2 capture seam). */
  cdpSessions: FakeCdpSession[]
}

/**
 * Install a fake local backend: every `launch`/`launchPersistentContext` call
 * is recorded (options included, so the proxy/args/headless passthrough is
 * observable) and the failure switches make it reject the way a real
 * browser/proxy failure would.
 */
function installFakeLocalBackend(behavior: { failLaunch?: Error; failPersistentLaunch?: Error; capture?: FakeCaptureScript; page?: FakePageSpec } = {}): FakeBackend {
  const record: FakeBackend = { launches: [], persistentLaunches: [], persistentContexts: [], cdpSessions: [] }
  const cdpSession = async (): Promise<CdpSession> => {
    if (behavior.capture?.sessionError !== undefined) throw behavior.capture.sessionError
    const session = new FakeCdpSession(behavior.capture ?? {})
    record.cdpSessions.push(session)
    return session
  }
  const chromium: PlaywrightChromium = {
    launch: async (options) => {
      record.launches.push(options)
      if (behavior.failLaunch !== undefined) throw behavior.failLaunch
      const pageState: FakePageState = { pageClosed: false, gotos: 0, waits: 0 }
      const page = makeFakePage(behavior.page ?? {}, pageState)
      const context: PlaywrightContext = {
        newPage: async () => page,
        route: async () => {},
        close: async () => {},
        newCDPSession: cdpSession,
      }
      return { newContext: async () => context, close: async () => {} }
    },
    launchPersistentContext: async (userDataDir, options) => {
      record.persistentLaunches.push({ userDataDir, options })
      if (behavior.failPersistentLaunch !== undefined) throw behavior.failPersistentLaunch
      const context = fakePersistentContext()
      record.persistentContexts.push(context)
      return context.handle
    },
    connectOverCDP: async () => { throw new Error('the local backend never connects over CDP') },
  }
  localBackendHook.current = async () => ({ chromium, source: 'fake test chromium' })
  return record
}

/** A complete resolved section: optional fields blank unless overridden. */
function resolvedConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    backend: 'local',
    playwrightPath: '',
    cdpEndpoint: '',
    shareBrowserContext: true,
    denoise: true,
    dismissConsent: false,
    observe: false,
    targetsFile: '',
    maxConcurrency: 4,
    challengeWaitMs: 0,
    challengeRetries: 0,
    proxyServer: '',
    proxyBypass: '',
    proxyUsername: '',
    proxyPassword: '',
    headless: true,
    userDataDir: '',
    launchArgs: '',
    ...over,
  }
}

/** Everything a fake navigation can be told to produce. */
interface FakePageSpec {
  finalUrl?: string
  status?: number
  contentType?: string
  html?: string
  textBody?: string
  gotoError?: Error
  networkIdleError?: boolean
  /** Never settle `goto` on its own — it rejects when the page closes. */
  hangGoto?: boolean
  /**
   * Single-shot challenge goto: 403 + `cf-mitigated: challenge` + the
   * interstitial HTML, cleared only by the scripted probe behavior below.
   */
  challenge?: boolean
  /**
   * Ordered goto results — the first `goto` uses [0], later ones repeat the
   * last entry; a `challenge: true` entry serves the interstitial.
   */
  gotoScript?: Array<{ status?: number; contentType?: string; html?: string; textBody?: string; challenge?: boolean }>
  /** The fake clears its challenge on the Nth probe (evaluate/content read). */
  clearAfterProbes?: number
  /** The fake never clears — a challenge only a human (or nothing) passes. */
  neverClears?: boolean
  /** A main-frame response emitted through 'response' listeners at clear time. */
  emitOnClear?: { status?: number; contentType?: string }
  /** Omit `evaluate` so the provider's probe falls back to content polling. */
  noEvaluate?: boolean
  /** What the fake's `evaluate` answers (default: the challenge verdict). */
  evaluateResult?: unknown
  /** Make the fake's `evaluate` reject with this error. */
  evaluateError?: Error
  /** Answers shifted once per `evaluate` call, before `evaluateResult` is used. */
  evaluateQueue?: unknown[]
}

const ARTICLE_HTML = `<!doctype html><html><head><title>Fake page</title></head><body>
<nav>nav noise</nav>
<main><article><h1>Hello</h1><p>World</p><p>A second paragraph gives the article scorer enough text mass to find the main region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

/** The interstitial a challenged navigation serves (markers must classify). */
const CHALLENGE_HTML = `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><div class="main-content">
<div id="challenge-stage"><div id="challenge-running">Verifying you are human. This may take a few seconds.</div></div>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: FAKE0123456789</span></div></div>
</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/fake" async></script>
<script>window._cf_chl_opt = { cvId: 3 };</script>
</body></html>`

/** Identity token shared by the page's mainFrame and its responses' requests. */
const mainFrameToken = Symbol('fake-main-frame')

/** A fake page's shared, observable lifecycle state. */
interface FakePageState {
  pageClosed: boolean
  /** How many `goto` calls the page served. */
  gotos: number
  /** How many `waitForLoadState` calls the page served. */
  waits: number
}

function fakeResponse(spec: FakePageSpec, entry?: NonNullable<FakePageSpec['gotoScript']>[number]): PlaywrightResponse | null {
  if (spec.gotoError !== undefined) return null
  const challenge = entry?.challenge === true || (entry === undefined && spec.challenge === true)
  const headers: Record<string, string> = { 'content-type': entry?.contentType ?? spec.contentType ?? 'text/html; charset=utf-8' }
  if (challenge) headers['cf-mitigated'] = 'challenge'
  return {
    status: () => entry?.status ?? spec.status ?? (challenge ? 403 : 200),
    headers: () => headers,
    text: async () => entry?.textBody ?? spec.textBody ?? '',
    url: () => spec.finalUrl ?? 'https://final.example.com/docs',
    request: () => ({
      isNavigationRequest: () => true,
      resourceType: () => 'document',
      frame: () => mainFrameToken,
    }),
  }
}

/** Shared page behavior: the members the provider touches, close tracking. */
function makeFakePage(spec: FakePageSpec, state: FakePageState, popupListeners: Array<(page: PlaywrightPage) => void> = []): PlaywrightPage {
  const gotoRejecters: Array<(error: Error) => void> = []
  const responseListeners: Array<(response: PlaywrightResponse) => void> = []
  const scripted = spec.gotoScript ?? []
  let reads = 0
  let cleared = false

  const entryAt = (index: number): NonNullable<FakePageSpec['gotoScript']>[number] | undefined =>
    scripted.length === 0 ? undefined : scripted[Math.min(index, scripted.length - 1)]
  const currentEntry = (): NonNullable<FakePageSpec['gotoScript']>[number] | undefined =>
    entryAt(Math.max(0, state.gotos - 1))
  const onChallenge = (): boolean => {
    if (cleared) return false
    if (spec.neverClears === true) return true
    const entry = currentEntry()
    if (entry !== undefined) return entry.challenge === true
    return spec.challenge === true
  }
  /** One probe read of the challenged document; the fake clears at the Nth. */
  const noteRead = (): void => {
    if (cleared || !onChallenge() || spec.clearAfterProbes === undefined) return
    reads++
    if (reads >= spec.clearAfterProbes) {
      cleared = true
      if (spec.emitOnClear !== undefined) {
        const emit = spec.emitOnClear
        const headers = { 'content-type': emit.contentType ?? 'text/html; charset=utf-8' }
        const response: PlaywrightResponse = {
          status: () => emit.status ?? 200,
          headers: () => headers,
          text: async () => '',
          url: () => spec.finalUrl ?? 'https://final.example.com/docs',
          request: () => ({ isNavigationRequest: () => true, resourceType: () => 'document', frame: () => mainFrameToken }),
        }
        for (const listener of [...responseListeners]) listener(response)
      }
    }
  }

  const page: PlaywrightPage = {
    goto: (): Promise<PlaywrightResponse | null> => {
      // A closed page rejects navigation, like a real Playwright page.
      if (state.pageClosed) return Promise.reject(new Error('Target closed'))
      if (spec.gotoError !== undefined) return Promise.reject(spec.gotoError)
      if (spec.hangGoto === true) {
        return new Promise((_resolve, reject) => { gotoRejecters.push(reject) })
      }
      const entry = entryAt(state.gotos)
      state.gotos++
      return Promise.resolve(fakeResponse(spec, entry))
    },
    waitForLoadState: async () => {
      state.waits++
      if (spec.networkIdleError === true) throw new Error('networkidle timeout')
    },
    url: () => spec.finalUrl ?? 'https://final.example.com/docs',
    content: async () => {
      noteRead()
      if (onChallenge()) return CHALLENGE_HTML
      return currentEntry()?.html ?? spec.html ?? ARTICLE_HTML
    },
    close: async () => {
      state.pageClosed = true
      for (const reject of gotoRejecters.splice(0)) reject(new Error('Target closed'))
    },
    route: async () => {},
    on: (event: 'popup' | 'response', listener: ((page: PlaywrightPage) => void) | ((response: PlaywrightResponse) => void)) => {
      if (event === 'popup') popupListeners.push(listener as (page: PlaywrightPage) => void)
      else responseListeners.push(listener as (response: PlaywrightResponse) => void)
    },
    ...(spec.noEvaluate === true ? {} : {
      evaluate: async (): Promise<unknown> => {
        noteRead()
        if (spec.evaluateError !== undefined) throw spec.evaluateError
        if (spec.evaluateQueue !== undefined && spec.evaluateQueue.length > 0) return spec.evaluateQueue.shift()
        if (spec.evaluateResult !== undefined) return spec.evaluateResult
        return onChallenge()
      },
    }),
    mainFrame: () => mainFrameToken,
  }
  return page
}

function fakeSession(spec: FakePageSpec): BrowserSession {
  const pageState: FakePageState = { pageClosed: false, gotos: 0, waits: 0 }
  const closed = { context: false, browser: false }
  const page = makeFakePage(spec, pageState)
  const context: PlaywrightContext = {
    newPage: async () => page,
    route: async () => {},
    close: async () => { closed.context = true },
  }
  const browser: PlaywrightBrowser = {
    newContext: async () => context,
    close: async () => { closed.browser = true },
  }
  return {
    browser,
    context,
    page,
    closed: {
      get pageClosed() { return pageState.pageClosed },
      get gotos() { return pageState.gotos },
      get waits() { return pageState.waits },
      get context() { return closed.context },
      get browser() { return closed.browser },
    },
  } as unknown as BrowserSession & { closed: { pageClosed: boolean; context: boolean; browser: boolean; gotos: number } }
}

/** The provider under test: a fixed config and an injected fake session. */
class FakeProvider extends PlaywrightFetchProvider {
  /** The session the last fetch ran in (counters ride on it). */
  lastSession: BrowserSession | undefined

  constructor(config: Partial<ResolvedConfig> = {}, private readonly spec: FakePageSpec = {}) {
    super(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      maxConcurrency: 4,
      // Legacy default: the challenge path stays off unless a test opts in.
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...config,
    }))
  }

  protected async openSession(): Promise<BrowserSession> {
    this.lastSession = fakeSession(this.spec)
    return this.lastSession
  }
}

/**
 * The provider over a fake session whose `openSession` blocks on a test-held
 * gate: concurrency-queue behavior without real browser launches. `started`
 * records `openSession` entries in arrival order.
 */
class GatedProvider extends PlaywrightFetchProvider {
  readonly started: number[] = []
  private gate: Promise<void> = Promise.resolve()

  constructor(config: Partial<ResolvedConfig>) {
    super(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...config,
    }))
  }

  /** Make every subsequent `openSession` await the given promise. */
  blockOn(gate: Promise<void>): void {
    this.gate = gate
  }

  protected async openSession(): Promise<BrowserSession> {
    this.started.push(this.started.length)
    await this.gate
    return fakeSession({})
  }
}

/**
 * A fake shared CDP connection for provider-level tests: every fetch leases
 * a page (tab) over ONE browser — from its default context (profile mode)
 * or a throwaway context (isolated mode) — whose open/close counts are
 * tracked for assertions. The default context records (and tests assert it
 * never receives) a close.
 */
function fakeCdpConnection(spec: FakePageSpec = {}, capture: FakeCaptureScript = {}) {
  const state = {
    connects: 0,
    isolatedContextsOpened: 0,
    isolatedContextsClosed: 0,
    /** Tabs opened in the default context (profile mode). */
    defaultPagesOpened: 0,
    /** close() calls on the default context — profile mode must keep at 0. */
    defaultContextClosed: 0,
    /** Every page any mode opened / fully closed (closes are idempotent). */
    pagesOpened: 0,
    pagesClosed: 0,
    browserClosed: false,
    /** Popup listeners the guard registered on the leased pages. */
    popupListeners: [] as Array<(page: PlaywrightPage) => void>,
    /** CDP sessions the P2 capture opened on leased tabs. */
    cdpSessions: [] as FakeCdpSession[],
  }
  const makePage = (): PlaywrightPage => {
    state.pagesOpened++
    const pageState = { pageClosed: false, gotos: 0, waits: 0 }
    const page = makeFakePage(spec, pageState, state.popupListeners)
    const base = page.close.bind(page)
    return {
      ...page,
      close: async () => {
        if (pageState.pageClosed) return // a real page's second close is a no-op
        state.pagesClosed++
        await base()
      },
    }
  }
  const cdpSession = async (): Promise<CdpSession> => {
    if (capture.sessionError !== undefined) throw capture.sessionError
    const session = new FakeCdpSession(capture)
    state.cdpSessions.push(session)
    return session
  }
  const defaultContext: PlaywrightContext = {
    newPage: async () => {
      state.defaultPagesOpened++
      return makePage()
    },
    route: async () => {},
    close: async () => { state.defaultContextClosed++ },
    newCDPSession: cdpSession,
  }
  const browser: PlaywrightBrowser = {
    newContext: async () => {
      state.isolatedContextsOpened++
      const context: PlaywrightContext = {
        newPage: async () => makePage(),
        route: async () => {},
        close: async () => { state.isolatedContextsClosed++ },
        newCDPSession: cdpSession,
      }
      return context
    },
    contexts: () => [defaultContext],
    close: async () => { state.browserClosed = true },
  }
  return {
    state,
    /** A pool whose connect always lands on this one connection. */
    pool: new CdpConnectionPool(async () => { state.connects++; return browser }),
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const webError = error as WebError
    if (webError instanceof WebError) return webError.code
    throw error
  }
  throw new Error('expected the fetch to reject')
}

/** The message of the error a fetch rejects with — the words the caller sees. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the fetch to reject')
}

describe('PlaywrightFetchProvider', () => {
  it('is always available (cheap check, no side effects)', () => {
    expect(new FakeProvider().available()).toBe(true)
    expect(new FakeProvider().id).toBe('playwright')
  })

  it('rejects non-http schemes and credentialed URLs up front', async () => {
    await expect(codeOf(new FakeProvider().fetch({ url: 'ftp://example.com/x' }))).resolves.toBe('WEB_INVALID_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'http://user:pass@example.com/' }))).resolves.toBe('WEB_BLOCKED_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'not a url' }))).resolves.toBe('WEB_INVALID_URL')
  })

  it('returns denoised markdown for html pages', async () => {
    const result = await new FakeProvider().fetch({ url: 'https://example.com/docs' })
    expect(result.url).toBe('https://final.example.com/docs')
    expect(result.statusCode).toBe(200)
    expect(result.truncated).toBe(false)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    // Either the kept article heading or the prepended page title leads it.
    expect(content).toMatch(/^# (Hello|Fake page)\b/m)
    expect(content).toContain('World')
    expect(content).not.toContain('nav noise')
    expect(content).not.toContain('footer noise')
  })

  it('returns raw html when the denoise toggle is off', async () => {
    const result = await new FakeProvider({ denoise: false }).fetch({ url: 'https://example.com/docs' })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') {
      expect(result.body.content).toContain('<article>')
      expect(result.body.content).toContain('nav noise')
    }
  })

  it('dismissConsent off (the default): the page is never probed for a banner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await new FakeProvider({}, { evaluateResult: { clicked: null, problem: 'exploded' } })
        .fetch({ url: 'https://example.com/docs' })
      expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('consent banner dismissal')
    } finally {
      warn.mockRestore()
    }
  })

  it('dismissConsent on: probes the page and stays quiet when a control is clicked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await new FakeProvider({ dismissConsent: true }, { evaluateResult: { clicked: '#onetrust-accept-btn-handler', problem: null } })
        .fetch({ url: 'https://example.com/docs' })
      expect(result.statusCode).toBe(200)
      expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('consent banner dismissal')
    } finally {
      warn.mockRestore()
    }
  })

  it('dismissConsent on: a failing click is reported and never fails the fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await new FakeProvider({ dismissConsent: true }, { evaluateResult: { clicked: null, problem: 'selector exploded' } })
        .fetch({ url: 'https://example.com/docs' })
      expect(result.statusCode).toBe(200)
      expect((result.body as { content: string }).content).toContain('World')
      expect(warn.mock.calls.flat().map(String).join(' ')).toContain('consent banner dismissal problem')
    } finally {
      warn.mockRestore()
    }
  })

  it('dismissConsent on: a click that moves the document still reads it', async () => {
    // A full-page consent interstitial is accepted and the browser is sent back
    // to the page it interrupted: the fetch must read the settled document, not
    // the gate it clicked through.
    const result = await new FakeProvider({ dismissConsent: true }, { evaluateResult: { clicked: 'text:"同意"', problem: null } })
      .fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    expect(result.url).toBe('https://final.example.com/docs')
    expect((result.body as { content: string }).content).toContain('World')
  })

  it('dismissConsent on: a gate that does not clear fails the fetch loudly', async () => {
    // The click landed but the gate is still there, so the page the caller asked
    // for was never reached. Returning the gate as if it were the page is the
    // silent-wrong-answer this check exists to prevent.
    const code = await codeOf(
      new FakeProvider({ dismissConsent: true }, {
        evaluateQueue: [{ clicked: 'text:"同意"', problem: null, gate: true }, true],
      }).fetch({ url: 'https://example.com/docs' }),
    )
    expect(code).toBe('WEB_FETCH_CONSENT')
  })

  it('dismissConsent on: a gate that clears is not an error', async () => {
    const result = await new FakeProvider({ dismissConsent: true }, {
      evaluateQueue: [{ clicked: 'text:"同意"', problem: null, gate: true }, false],
    }).fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
  })

  it('dismissConsent on: a banner click is never verified as a gate', async () => {
    // Only a page-level click needs the gate re-check, so a banner dismissal
    // must not spend a second probe or fail on one.
    const result = await new FakeProvider({ dismissConsent: true }, {
      evaluateResult: { clicked: '#onetrust-accept-btn-handler', problem: null, gate: false },
    }).fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
  })

  it('dismissConsent on: a page handle without evaluate still fetches', async () => {
    const result = await new FakeProvider({ dismissConsent: true }, { noEvaluate: true })
      .fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
  })

  it('observe mode returns the page state instead of the article', async () => {
    const observation = {
      url: 'https://final.example.com/docs',
      title: '需您同意',
      textHead: '需您同意 请阅读《隐私声明》',
      counts: { controls: 6, reachable: 6, buttons: 1, links: 0, checkboxes: 5, uncheckedCheckboxes: 5, selects: 0, forms: 1, iframes: 0 },
      controlsTotal: 2,
      controls: [
        { kind: 'button', label: '同意', host: 'self', state: '' },
        { kind: 'checkbox', label: '全选', host: 'label', state: 'unchecked' },
      ],
    }
    const result = await new FakeProvider({ observe: true }, { evaluateResult: observation })
      .fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content).toContain('# Page state: 需您同意')
    expect(content).toMatch(/checkboxes 5 \(unchecked 5\)/)
    expect(content).toContain('[checkbox] "全选" - unchecked (visible as its label)')
  })

  it('observe mode fails loudly when the page cannot be read', async () => {
    // Observe mode *is* the fetch, so an unreadable page is a failure, not an
    // empty observation.
    const code = await codeOf(new FakeProvider({ observe: true }, { noEvaluate: true }).fetch({ url: 'https://example.com/docs' }))
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })

  /** Write a targets file into a fresh temp directory and return its path. */
  function writeTargets(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-targets-'))
    const file = join(dir, 'targets.json')
    writeFileSync(file, contents, 'utf8')
    return file
  }

  const targetFor = (url: string, actions: string, name = 'docs'): string =>
    writeTargets(`{ "targets": [ { "name": "${name}", "match": { "kind": "prefix", "url": "${url}" }, "actions": [${actions}] } ] }`)

  const waitText = (text: string): string => `{ "verb": "waitFor", "condition": { "kind": "text", "text": "${text}" } }`

  it('runs the target whose URL matches and says so at the top of the body', async () => {
    const targetsFile = targetFor('https://example.com/docs', waitText('World'))
    const result = await new FakeProvider({ targetsFile }, { evaluateResult: true }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content.startsWith('> actions: ')).toBe(true)
    expect(content).toContain('1. waitFor text "World" — met')
    expect(content).toContain('final document https://final.example.com/docs (HTTP 200)')
    // The article still follows the summary.
    expect(content).toContain('World')
  })

  it('selects on the URL that was asked for, not the one it redirected to', async () => {
    // The caller's URL is the key; where the site sends the browser afterwards is
    // not known until the fetch has already happened.
    const targetsFile = targetFor('https://final.example.com/docs', waitText('World'))
    const result = await new FakeProvider({ targetsFile }, { evaluateResult: true }).fetch({ url: 'https://example.com/docs' })
    expect((result.body as { content: string }).content.startsWith('> actions: ')).toBe(false)
  })

  it('leaves a page that matches no target exactly as it was', async () => {
    const targetsFile = targetFor('https://other.example.com/', waitText('World'))
    const result = await new FakeProvider({ targetsFile }, { evaluateResult: true }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content.startsWith('> actions: ')).toBe(false)
    expect(content).not.toContain('waitFor')
  })

  it('fails loudly when a step does not hold, instead of reading the page anyway', async () => {
    // This is the mapping the provider owes: a step that did not hold stops the
    // fetch. The timing half (a condition that is simply never true waits out the
    // step ceiling before this same failure) belongs to the runner's suite, so
    // this uses the path that fails at once: a page with no scripting seam.
    const targetsFile = targetFor('https://example.com/docs', waitText('never there'))
    const code = await codeOf(new FakeProvider({ targetsFile }, { noEvaluate: true }).fetch({ url: 'https://example.com/docs' }))
    expect(code).toBe('WEB_FETCH_ACTION')
  })

  it('rejects an unusable targets file', async () => {
    expect(await codeOf(new FakeProvider({ targetsFile: writeTargets('{ not json }') }, {}).fetch({ url: 'https://example.com/docs' }))).toBe('WEB_FETCH_TARGET')
    expect(await codeOf(new FakeProvider({ targetsFile: writeTargets('{ "targets": [] }')[0] + 'x' }, {}).fetch({ url: 'https://example.com/docs' }))).toBe('WEB_FETCH_TARGET')
  })

  it('rejects a missing targets file', async () => {
    const code = await codeOf(new FakeProvider({ targetsFile: join(tmpdir(), 'dsh-targets-missing', 'none.json') }, {}).fetch({ url: 'https://example.com/docs' }))
    expect(code).toBe('WEB_FETCH_TARGET')
  })

  it('rejects a file that names two equally specific targets', async () => {
    const contents = `{ "targets": [
      { "name": "a", "match": { "kind": "prefix", "url": "https://example.com/docs" }, "actions": [${waitText('World')}] },
      { "name": "b", "match": { "kind": "prefix", "url": "https://example.com/docs" }, "actions": [${waitText('World')}] } ] }`
    const code = await codeOf(new FakeProvider({ targetsFile: writeTargets(contents) }, {}).fetch({ url: 'https://example.com/docs' }))
    expect(code).toBe('WEB_FETCH_TARGET')
  })

  it('refuses to skip a target just because the body is not HTML', async () => {
    // The early return for non-HTML bodies used to swallow a matching target
    // silently: no actions, no summary, no error. A target needs a document, so
    // saying so is the only honest outcome.
    const targetsFile = targetFor('https://example.com/api', waitText('ok'))
    const code = await codeOf(
      new FakeProvider({ targetsFile }, { contentType: 'application/json', textBody: '{"ok":true}' }).fetch({ url: 'https://example.com/api' }),
    )
    expect(code).toBe('WEB_FETCH_TARGET')
  })

  const clickText = (text: string, optional = false): string =>
    `{ "verb": "click", "candidates": [ { "text": "${text}" } ]${optional ? ', "optional": true' : ''} }`

  const checkText = (text: string): string =>
    `{ "verb": "check", "candidates": [ { "text": "${text}" } ] }`

  it('checks a control and says which state it ended in', async () => {
    const targetsFile = targetFor('https://example.com/docs', `${checkText('全选')}, ${waitText('World')}`)
    const result = await new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: true, candidate: 'text "全选" -> label', was: 'unchecked', state: 'checked', acted: true }, true],
    }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content.startsWith('> actions: 1. check text "全选" -> label (was unchecked, now checked) — met')).toBe(true)
    expect(content).toContain('2. waitFor text "World" — met')
  })

  it('fails a check the page did not keep, naming the step and the candidate', async () => {
    const targetsFile = targetFor('https://example.com/docs', checkText('全选'))
    const message = await messageOf(new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: true, candidate: 'text "全选" -> label', was: 'unchecked', state: 'unchecked', acted: true }],
    }).fetch({ url: 'https://example.com/docs' }))
    expect(message).toContain('target "docs" step 1 (check) did not hold')
    expect(message).toContain('text "全选" -> label: it was unchecked, the click went out, and it reports unchecked')
    expect(message).toContain('at https://final.example.com/docs')
  })

  it('clicks a candidate, and counts the click as confirmed by the wait that follows', async () => {
    const targetsFile = targetFor('https://example.com/docs', `${clickText('查询')}, ${waitText('World')}`)
    const result = await new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: true, candidate: 'text "查询" -> button' }, true],
    }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content.startsWith('> actions: 1. click text "查询" -> button — clicked')).toBe(true)
    expect(content).toContain('2. waitFor text "World" — met → final document https://final.example.com/docs (HTTP 200)')
  })

  it('shows a click that nothing after it confirmed as unverified', async () => {
    // A recipe may end on a click. The summary then has to carry the doubt, so
    // "clicked" never reads as "the page changed".
    const targetsFile = targetFor('https://example.com/docs', clickText('查询'))
    const result = await new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: true, candidate: 'text "查询" -> button' }],
    }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content).toContain('1. click text "查询" -> button — clicked (unverified)')
  })

  it('fails the fetch when no click candidate can land, naming the step, the candidates and the URL', async () => {
    const targetsFile = targetFor('https://example.com/docs', `${clickText('查询')}, ${waitText('World')}`)
    const message = await messageOf(new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: false, tried: ['selector "#off": matched 1, none reachable (disabled)', 'text "查询": no match'] }],
    }).fetch({ url: 'https://example.com/docs' }))
    expect(message).toContain('target "docs" step 1 (click) did not hold')
    expect(message).toContain('no candidate could be clicked, out of text "查询"')
    expect(message).toContain('selector "#off": matched 1, none reachable (disabled)')
    expect(message).toContain('text "查询": no match')
    expect(message).toContain('at https://final.example.com/docs')
  })

  it('records an optional step that was skipped, and still reads the page', async () => {
    const targetsFile = targetFor('https://example.com/docs', `${clickText('关闭广告', true)}, ${waitText('World')}`)
    const result = await new FakeProvider({ targetsFile }, {
      evaluateQueue: [{ ok: false, tried: ['text "关闭广告": no match'] }, true],
    }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content).toContain('— skipped')
    expect(content).toContain('text "关闭广告": no match')
    expect(content).toContain('2. waitFor text "World" — met')
  })

  it('lets a click’s navigation land before it re-describes the result', async () => {
    // The click can navigate; the URL and status in the summary must describe the
    // document it landed on, so one more bounded settle runs. A recipe of waits
    // alone does not pay for it.
    const clicked = targetFor('https://example.com/docs', `${clickText('查询')}, ${waitText('World')}`)
    const clickedProvider = new FakeProvider({ targetsFile: clicked }, {
      evaluateQueue: [{ ok: true, candidate: 'text "查询" -> button' }, true],
    })
    await clickedProvider.fetch({ url: 'https://example.com/docs' })

    const waited = targetFor('https://example.com/docs', waitText('World'))
    const waitedProvider = new FakeProvider({ targetsFile: waited }, { evaluateResult: true })
    await waitedProvider.fetch({ url: 'https://example.com/docs' })

    const waitsOf = (provider: FakeProvider): number =>
      (provider.lastSession as unknown as { closed: { waits: number } }).closed.waits
    expect(waitsOf(clickedProvider)).toBeGreaterThan(waitsOf(waitedProvider))
  })

  it('wraps the summary as a blockquote element when the body is raw HTML', async () => {
    // A literal "> actions:" line in front of raw HTML renders as text inside the
    // page; the same line has to be a blockquote element there.
    const targetsFile = targetFor('https://example.com/docs', waitText('World'))
    const result = await new FakeProvider({ targetsFile, denoise: false }, { evaluateResult: true }).fetch({ url: 'https://example.com/docs' })
    const content = (result.body as { content: string }).content
    expect(content.startsWith('<blockquote>actions: ')).toBe(true)
    expect(content).not.toContain('> actions:')
    expect(content).toContain('</blockquote>')
  })

  it('decodes non-html text bodies verbatim', async () => {
    const result = await new FakeProvider({}, { contentType: 'application/json', textBody: '{"ok":true}' })
      .fetch({ url: 'https://example.com/api' })
    expect(result.body).toEqual({ kind: 'text', content: '{"ok":true}' })
  })

  it('refuses binary content types', async () => {
    const code = await codeOf(new FakeProvider({}, { contentType: 'image/png' }).fetch({ url: 'https://example.com/img' }))
    expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
  })

  it('keeps a non-2xx status as a result, not an error', async () => {
    const result = await new FakeProvider({}, { status: 404, html: '<html><body><h1>Not found</h1></body></html>' })
      .fetch({ url: 'https://example.com/missing' })
    expect(result.statusCode).toBe(404)
  })

  it('caps the body and flags the cut', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `<p>paragraph ${String(i)} with some words</p>`).join('')
    const html = `<!doctype html><html><body><article><h1>Big</h1>${big}</article></body></html>`
    const result = await new FakeProvider({}, { html }).fetch({ url: 'https://example.com/big' })
    expect(result.truncated).toBe(true)
    expect((result.body as { content: string }).content.length).toBe(100_000)
  })

  it('charges the pipeline budget for content, not for non-content bloat', async () => {
    // The iHerb product-page shape: megabytes of inline CSS/JS, then the copy.
    // Slicing the raw HTML at the cap discarded the whole article, leaving
    // Readability to score the cookie banner instead; stripping the
    // non-content subtrees first keeps the copy inside the budget.
    const bloat = 'a'.repeat(1_100_000)
    const html =
      `<!doctype html><html><head><style>${bloat}</style><script>${bloat}</script></head>` +
      '<body><article><h1>Vitamin D3</h1><p>125 mcg (5,000 IU) per softgel.</p></article></body></html>'
    expect(html.length).toBeGreaterThan(2_000_000)
    const result = await new FakeProvider({}, { html }).fetch({ url: 'https://example.com/pdp' })
    // Nothing of the article was clipped, so this is not a truncated body.
    expect(result.truncated).toBe(false)
    const content = (result.body as { content: string }).content
    expect(content).toContain('125 mcg')
    expect(content).not.toContain('aaaaaaaa')
  })

  it('maps navigation failures to WEB_PROVIDER_ERROR with the original message', async () => {
    const code = await codeOf(
      new FakeProvider({}, { gotoError: new Error('net::ERR_CONNECTION_REFUSED at https://example.com') })
        .fetch({ url: 'https://example.com/down' }),
    )
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })

  it('translates a pre-aborted signal to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const code = await codeOf(new FakeProvider().fetch({ url: 'https://example.com/x' }, controller.signal))
    expect(code).toBe('WEB_ABORTED')
  })

  it('survives a networkidle settle timeout (keeps domcontentloaded content)', async () => {
    const result = await new FakeProvider({}, { networkIdleError: true }).fetch({ url: 'https://example.com/spa' })
    expect(result.body.kind).toBe('text')
  })
})

describe('PlaywrightFetchProvider concurrency queue', () => {
  /** Flush pending microtasks/macrotasks without waiting on gated fetches. */
  async function flush(): Promise<void> {
    await new Promise(resolve => { setImmediate(resolve) })
  }

  /** Real-timer safety net: a timed-out test's `finally` never runs. */
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('renders up to maxConcurrency pages at once and queues the rest', async () => {
    const provider = new GatedProvider({})
    provider.blockOn(new Promise<void>(() => {}))
    const controllers = Array.from({ length: 5 }, () => new AbortController())
    const fetches = controllers.map((controller, i) =>
      provider.fetch({ url: `https://example.com/page-${String(i)}` }, controller.signal).catch(() => {}) as Promise<unknown>)
    await flush()
    // The four slot holders reached openSession; the fifth is still queued.
    expect(provider.started).toEqual([0, 1, 2, 3])
    controllers.forEach(controller => controller.abort())
    await flush()
    void fetches
  })

  it('fails a queued fetch fast with a retry hint instead of hanging until abort', async () => {
    // Only the timeout functions are faked: flush() relies on a real setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    expect(provider.started).toEqual([0])
    const queued = provider.fetch({ url: 'https://example.com/queued' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    const error = await queued
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_FETCH_TIMEOUT')
    expect((error as WebError).message).toContain('rendering slots stayed busy')
    expect((error as WebError).message).toContain('maxConcurrency')
  })

  it('keeps the slot message when the caller cancels a queued fetch', async () => {
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    const controller = new AbortController()
    const queued = provider.fetch({ url: 'https://example.com/queued' }, controller.signal).catch(error => error)
    await flush()
    controller.abort()
    const error = await queued
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect((error as WebError).message).toContain('waiting for a free rendering slot')
  })

  it('drains a queue longer than the limit instead of stranding its tail', async () => {
    // Regression: release() used to hand a slot to the next waiter WITHOUT
    // dropping the finished holder's count, so `active` drifted one above the
    // limit and only every other release freed a slot — a queue longer than
    // the limit stranded its tail until the 20s queue timeout.
    const provider = new GatedProvider({ maxConcurrency: 2 })
    let releaseGate: (() => void) | undefined
    provider.blockOn(new Promise<void>(resolve => { releaseGate = resolve }))
    const fetches = Array.from({ length: 6 }, (_, index) =>
      provider.fetch({ url: `https://example.com/queued-${String(index)}` }))
    await flush()
    expect(provider.started).toEqual([0, 1]) // two slots busy, four queued

    releaseGate?.()
    const results = await Promise.all(fetches)
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    expect(provider.started).toHaveLength(6) // every waiter eventually ran
  })

  it('does not release a phantom slot when a queued fetch fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    const queued = provider.fetch({ url: 'https://example.com/queued' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await queued).toBeInstanceOf(WebError)
    // The failed waiter held no slot: a later fetch still queues (and fails
    // on its own patience) rather than slipping into a phantom free slot.
    const later = provider.fetch({ url: 'https://example.com/later' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    const laterFailure = await later
    expect(laterFailure).toBeInstanceOf(WebError)
    expect((laterFailure as WebError).message).toContain('rendering slots stayed busy')
    expect(provider.started).toEqual([0])
  })
})

describe('PlaywrightFetchProvider CDP backend', () => {
  it('isolated mode (checkbox off): one shared connection, each fetch a throwaway context it closes', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: false,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const first = await provider.fetch({ url: 'https://example.com/a' })
    const second = await provider.fetch({ url: 'https://example.com/b' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // Two fetches, two isolated tabs (page + context each), ONE connection.
    expect(state.connects).toBe(1)
    expect(state.isolatedContextsOpened).toBe(2)
    expect(state.isolatedContextsClosed).toBe(2)
    expect(state.pagesClosed).toBe(2)
    expect(state.defaultPagesOpened).toBe(0)
    expect(state.browserClosed).toBe(false)

    // Teardown (plugin unload) is what drops the shared connection.
    await provider.dispose()
    expect(state.browserClosed).toBe(true)
  })

  it('runs many concurrent isolated CDP fetches as tabs without queueing', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: false,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      provider.fetch({ url: `https://example.com/tab-${String(i)}` })))
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    // All fifty rode the single connection as concurrent tabs — the CDP
    // default concurrency is high enough that none queued.
    expect(state.connects).toBe(1)
    expect(state.isolatedContextsOpened).toBe(50)
    expect(state.isolatedContextsClosed).toBe(50)
  })

  it('profile mode: each fetch is a tab of the shared default context, closed when done', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const first = await provider.fetch({ url: 'https://example.com/a' })
    const second = await provider.fetch({ url: 'https://example.com/b' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // Two tabs of the ONE default context; both closed; the context and
    // the connection itself never closed.
    expect(state.connects).toBe(1)
    expect(state.defaultPagesOpened).toBe(2)
    expect(state.pagesOpened).toBe(2)
    expect(state.pagesClosed).toBe(2)
    expect(state.isolatedContextsOpened).toBe(0)
    expect(state.defaultContextClosed).toBe(0)
    expect(state.browserClosed).toBe(false)

    // Even plugin teardown only disconnects (the remote browser survives).
    await provider.dispose()
    expect(state.defaultContextClosed).toBe(0)
  })

  it('profile mode serves a concurrent burst as tabs of the one default context', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      provider.fetch({ url: `https://example.com/tab-${String(i)}` })))
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    expect(state.connects).toBe(1)
    expect(state.pagesOpened).toBe(12)
    expect(state.pagesClosed).toBe(12)
    expect(state.defaultContextClosed).toBe(0)
  })

  it('an aborted profile fetch closes only its tab — the shared default context survives', async () => {
    const { state, pool } = fakeCdpConnection({ hangGoto: true })
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const controller = new AbortController()
    const pending = provider.fetch({ url: 'https://example.com/slow' }, controller.signal)
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error)
    await new Promise(resolve => { setImmediate(resolve) }) // reaches goto
    expect(state.pagesOpened).toBe(1)
    controller.abort()
    const error = await pending

    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect(state.pagesClosed).toBe(1)
    expect(state.defaultContextClosed).toBe(0) // other tabs of the profile unaffected
    expect(state.browserClosed).toBe(false)
  })

  it('closes popups a fetched page spawns so no tab outlives the fetch', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    await provider.fetch({ url: 'https://example.com/popup-spawner' })
    expect(state.popupListeners.length).toBeGreaterThan(0) // the guard attached

    const popupState = { pageClosed: false, gotos: 0, waits: 0 }
    const popup = makeFakePage({}, popupState)
    for (const listener of state.popupListeners) listener(popup) // page spawned a popup
    expect(popupState.pageClosed).toBe(true)
  })

  it('closes a local session explicitly: page, context, then browser', async () => {
    const provider = new FakeProvider()
    await provider.fetch({ url: 'https://example.com/docs' })
    const closed = (provider.lastSession as unknown as { closed: { pageClosed: boolean; context: boolean; browser: boolean } }).closed
    expect(closed.pageClosed).toBe(true)
    expect(closed.context).toBe(true)
    expect(closed.browser).toBe(true)
  })

  it('wraps a dead CDP endpoint as WEB_PROVIDER_ERROR naming the endpoint', { timeout: 30_000 }, async () => {
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '127.0.0.1:1',
      shareBrowserContext: true,
      denoise: true,
      dismissConsent: false,
      observe: false,
      targetsFile: '',
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    // Real bundled playwright-core; port 1 refuses connections immediately.
    const error = await provider.fetch({ url: 'https://example.com/x' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).toContain('127.0.0.1:1')
  })
})

/** The bounded Cloudflare-challenge wait, end to end over the fake page. */
describe('PlaywrightFetchProvider cloudflare challenge wait', () => {
  /** Read the page-under-test's lifecycle counters off the last session. */
  function counters(provider: FakeProvider): { pageClosed: boolean; gotos: number } {
    return (provider.lastSession as unknown as { closed: { pageClosed: boolean; gotos: number } }).closed
  }

  function bodyOf(result: { body: { kind: string; content: string } }): string {
    return result.body.content
  }

  it('A1 baseline (challengeWaitMs 0): the interstitial comes back as content — the 0.2.4 behavior', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 0 }, { challenge: true, neverClears: true })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(403)
    expect(bodyOf(result)).toMatch(/just a moment/i)
    expect(bodyOf(result)).not.toContain('World')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A2 feature on: waits past the clear, reads the reloaded document, and reports the tracked response status', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, {
      challenge: true,
      clearAfterProbes: 3,
      // The natural verification reloads the same URL — the tracker must
      // hand the provider THIS response, not the 403 it started from.
      emitOnClear: { status: 200 },
    })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(bodyOf(result)).toMatch(/^# (Fake page|Hello)\b/m)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(1) // same page the whole time
  })

  it('A3 never clears: fails as WEB_FETCH_CHALLENGE within the bounded window, no slot leak', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 60, challengeRetries: 0 }, { challenge: true, neverClears: true })
    const started = Date.now()
    const error = await provider.fetch({ url: 'https://example.com/hard' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('Cloudflare')
    // Bounded: one wait window, far short of the fetch deadline.
    expect(Date.now() - started).toBeLessThan(5_000)
    // The session still closed — the concurrency slot is not held hostage.
    expect(counters(provider).pageClosed).toBe(true)
  })

  it('A4 first window runs out, one same-page retry lands on the cleared document', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 80, challengeRetries: 1 }, {
      gotoScript: [{ challenge: true }, { status: 200 }],
    })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    // The retry re-navigated the SAME page (only one page ever existed).
    expect(counters(provider).gotos).toBe(2)
  })

  it('A5 a hard block fails immediately with WEB_FETCH_CHALLENGE instead of burning the wait', async () => {
    // Real hard blocks ship 403 from the Cloudflare edge (no cf-mitigated —
    // that header marks challenges, not blocks), which is what opens the
    // suspicion gate for the content-level blocked-page classification.
    const provider = new FakeProvider({ challengeWaitMs: 10_000 }, {
      status: 403,
      html: '<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1 class="cf-headline">Sorry, you have been blocked</h1></body></html>',
    })
    const started = Date.now()
    const error = await provider.fetch({ url: 'https://example.com/blocked' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('hard-blocked')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('A6 an outer abort during the wait maps to WEB_ABORTED and closes the page', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 10_000 }, { challenge: true, neverClears: true })
    const controller = new AbortController()
    const pending = provider.fetch({ url: 'https://example.com/guarded' }, controller.signal)
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error)
    await new Promise(resolve => { setImmediate(resolve) }) // reaches the wait loop
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect(counters(provider).pageClosed).toBe(true)
  })

  it('A7 SPA clear (no navigation, no new response): the DOM probe sees the swap and the result reads 200', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, { challenge: true, clearAfterProbes: 3 })
    const result = await provider.fetch({ url: 'https://example.com/spa-guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A8 no evaluate on the page: the probe falls back to content polling and still clears', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, { challenge: true, clearAfterProbes: 3, noEvaluate: true })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
  })

  it('A9 no false kill: a plain-200 article that merely looks challenge-ish is returned untouched', async () => {
    // The suspicion gate: content markers only run on challenge-compatible
    // responses (403/429/503 or a Cloudflare edge), so an ordinary 200
    // article — even one whose TITLE reads "Just a moment" — never enters
    // the challenge path, waits nothing, and fails nothing.
    const provider = new FakeProvider({ challengeWaitMs: 5_000 }, {
      status: 200,
      html: `<!doctype html><html><head><title>Just a moment</title></head><body>
<main><article><h1>Not a challenge</h1><p>An essay about waiting screens; enough words for the article scorer to lock onto the main region here.</p><p>A second paragraph.</p></article></main>
</body></html>`,
    })
    const result = await provider.fetch({ url: 'https://example.com/blog-about-waiting' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('Not a challenge')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A10 chained rounds: a clear that lands on another interstitial consumes a retry and still lands the article', async () => {
    // Round 1 "clears" into a second interstitial (JS test → Turnstile
    // interstitial chains); the settled-DOM recheck catches it, the
    // same-page retry (with its earned cookies) then gets the document.
    const provider = new FakeProvider({ challengeWaitMs: 3_000, challengeRetries: 1 }, {
      clearAfterProbes: 2,
      gotoScript: [
        { challenge: true, html: CHALLENGE_HTML }, // after the probe clears, the DOM still shows a challenge
        { status: 200 },
      ],
    })
    const result = await provider.fetch({ url: 'https://example.com/chained' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(2)
  })
})

/** The P0 outbound proxy: injection, diagnosis, and the CDP refusal. */
describe('PlaywrightFetchProvider outbound proxy', () => {
  /** Read the rejection as a WebError (fails loudly on a surprise success). */
  async function failureOf(promise: Promise<unknown>): Promise<WebError> {
    const error = await promise.then(() => { throw new Error('expected the fetch to reject') }, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WebError)
    return error as WebError
  }

  afterEach(() => {
    // Back to the real resolution for the next describe/test.
    localBackendHook.current = undefined
  })

  it('passes the configured proxy (loopback bypass merged) to the local launch', async () => {
    const { launches } = installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      proxyServer: '127.0.0.1:7890',
      proxyBypass: '*.corp',
    }))
    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    expect(launches).toHaveLength(1)
    expect(launches[0]?.headless).toBe(true)
    expect(launches[0]?.proxy).toEqual({
      server: 'http://127.0.0.1:7890',
      bypass: '*.corp,127.0.0.1,localhost,::1',
    })
  })

  it('omits the proxy key entirely when no proxy is configured', async () => {
    const { launches } = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig()).fetch({ url: 'https://example.com/docs' })
    expect(launches).toHaveLength(1)
    // A direct connection is expressed by the ABSENCE of the key, never by a
    // blank proxy object.
    expect(launches[0]).not.toHaveProperty('proxy')
  })

  it('carries the proxy credentials through to the launch', async () => {
    const { launches } = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig({
      proxyServer: 'http://proxy.corp:3128',
      proxyUsername: 'proxyuser',
      proxyPassword: 'p@ss word',
    })).fetch({ url: 'https://example.com/docs' })
    expect(launches[0]?.proxy).toEqual({
      server: 'http://proxy.corp:3128',
      bypass: '127.0.0.1,localhost,::1',
      username: 'proxyuser',
      password: 'p@ss word',
    })
  })

  it('maps a launch failure with a proxy configured to WEB_FETCH_PROXY, naming the proxy and where it came from', async () => {
    installFakeLocalBackend({ failLaunch: new Error('net::ERR_PROXY_CONNECTION_FAILED at http://127.0.0.1:7890') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ proxyServer: '127.0.0.1:7890' }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
    expect(error.message).toContain('127.0.0.1:7890') // the proxy address
    expect(error.message).toContain('proxyServer') // the settings field it was resolved from
    expect(error.message).toContain('fake test chromium') // the browser-backend provenance
    expect(error.message).toContain('ERR_PROXY_CONNECTION_FAILED') // the upstream cause is kept
  })

  it('never lets the proxy password reach that message, even when the launch error quotes it', async () => {
    installFakeLocalBackend({ failLaunch: new Error('proxy authentication failed for secret "p@ss word"') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      proxyServer: 'http://user:s3cret@proxy.corp:3128',
      proxyUsername: 'user',
      proxyPassword: 'p@ss word',
    }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
    // Neither the password the launch error quoted nor the one embedded in
    // the server field may survive into the diagnostic.
    expect(error.message).not.toContain('p@ss word')
    expect(error.message).not.toContain('s3cret')
    expect(error.message).toContain('***')
    expect(error.message).toContain('proxy.corp:3128')
  })

  it('keeps a plain launch failure as WEB_PROVIDER_ERROR when no proxy is configured', async () => {
    installFakeLocalBackend({ failLaunch: new Error('no executable found') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig())
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).toContain('no executable found')
  })

  it('maps an unusable proxy server value to WEB_FETCH_PROXY without echoing it', async () => {
    installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      proxyServer: 'ftp://user:sup3r-secret@proxy.corp:21',
    }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
    expect(error.message).toContain('proxyServer')
    expect(error.message).not.toContain('sup3r-secret')
  })

  it('does NOT enforce a configured proxy on the CDP backend: the fetch runs', async () => {
    // Asserted BEHAVIORALLY, not by reading the policy constant: a proxy
    // belongs to the browser process that was started elsewhere, so the
    // settings value drives the launcher command/card preview and the
    // explanation — and a proxied CDP fetch must complete like any other.
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'cdp',
      cdpEndpoint: '127.0.0.1:9222',
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '*.corp',
    }), pool)
    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200) // not refused, not WEB_FETCH_PROXY
    expect(state.connects).toBe(1)
    expect(state.pagesClosed).toBe(1)

    // A proxied CDP fetch never produces WEB_FETCH_PROXY, while an unusable
    // proxy VALUE still does (the two paths the code can actually observe).
    const unusable = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'cdp',
      cdpEndpoint: '127.0.0.1:9222',
      proxyServer: 'ftp://proxy.corp:21',
    }), fakeCdpConnection().pool)
    const error = await failureOf(unusable.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
  })

  it('names the --proxy-server remedy in a CDP connect failure', async () => {
    const pool = new CdpConnectionPool(async () => { throw new Error('connect ECONNREFUSED') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'cdp',
      cdpEndpoint: '127.0.0.1:9222',
      proxyServer: 'http://127.0.0.1:7890',
    }), pool)
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('--proxy-server')
    expect(error.message).toContain('already-running browser')
    expect(error.message).toContain('ECONNREFUSED')
  })

  it('leaves the CDP backend untouched when no proxy is configured', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'cdp', cdpEndpoint: '' }), pool)
    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    expect(state.connects).toBe(1)
  })
})

/** The P1 DSH-managed persistent backend: one browser, many tabs. */
describe('PlaywrightFetchProvider managed backend', () => {
  /** Read the rejection as a WebError (fails loudly on a surprise success). */
  async function failureOf(promise: Promise<unknown>): Promise<WebError> {
    const error = await promise.then(() => { throw new Error('expected the fetch to reject') }, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WebError)
    return error as WebError
  }

  afterEach(() => {
    localBackendHook.current = undefined
  })

  it('launches ONE persistent browser (profile, headless, proxy, args) and reuses it as tabs', async () => {
    const backend = installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'managed',
      userDataDir: '/data/chrome-profile',
      headless: true,
      launchArgs: '--lang=zh-CN --disable-gpu',
      proxyServer: '127.0.0.1:7890',
    }))

    const first = await provider.fetch({ url: 'https://example.com/a' })
    const second = await provider.fetch({ url: 'https://example.com/b' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // ONE launch for both fetches, with every managed launch input.
    expect(backend.launches).toHaveLength(0) // no per-fetch browser at all
    expect(backend.persistentLaunches).toHaveLength(1)
    expect(backend.persistentLaunches[0]?.userDataDir).toBe('/data/chrome-profile')
    expect(backend.persistentLaunches[0]?.options).toMatchObject({
      headless: true,
      proxy: { server: 'http://127.0.0.1:7890', bypass: '127.0.0.1,localhost,::1' },
      args: ['--lang=zh-CN', '--disable-gpu'],
    })

    // Two tabs opened and closed; the persistent context (the browser) never.
    const state = backend.persistentContexts[0]?.state
    expect(state?.pagesOpened).toBe(2)
    expect(state?.pagesClosed).toBe(2)
    expect(state?.closed).toBe(false)

    // Plugin teardown is what closes the browser (the profile stays on disk).
    await provider.dispose()
    expect(state?.closed).toBe(true)
  })

  it('omits headless/args/proxy keys the settings left unset (headless still defaults on)', async () => {
    const backend = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', userDataDir: '/data/p' }))
      .fetch({ url: 'https://example.com/docs' })
    const options = backend.persistentLaunches[0]?.options
    expect(options).toMatchObject({ headless: true })
    expect(options).not.toHaveProperty('proxy')
    expect(options).not.toHaveProperty('args')
    expect(options).not.toHaveProperty('executablePath')
  })

  it('honours headless=false and a resolvable default profile directory', async () => {
    const backend = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', headless: false }))
      .fetch({ url: 'https://example.com/docs' })
    expect(backend.persistentLaunches[0]?.options?.headless).toBe(false)
    // Blank userDataDir resolves to the DSH-managed default, never ''.
    expect(backend.persistentLaunches[0]?.userDataDir).toMatch(/web-fetch-playwright[\\/]profile$/)
  })

  it('replaces the browser when a launch setting changes, closing the old one', async () => {
    const backend = installFakeLocalBackend()
    let userDataDir = '/data/one'
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', userDataDir }))

    await provider.fetch({ url: 'https://example.com/a' })
    userDataDir = '/data/two'
    await provider.fetch({ url: 'https://example.com/b' })

    expect(backend.persistentLaunches.map(launch => launch.userDataDir)).toEqual(['/data/one', '/data/two'])
    expect(backend.persistentContexts[0]?.state.closed).toBe(true) // the old browser is gone
    expect(backend.persistentContexts[1]?.state.closed).toBe(false)
  })

  it('maps a managed launch failure with a proxy to WEB_FETCH_PROXY, naming the proxy and the profile', async () => {
    installFakeLocalBackend({ failPersistentLaunch: new Error('net::ERR_PROXY_CONNECTION_FAILED') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'managed',
      userDataDir: '/data/p',
      proxyServer: 'http://127.0.0.1:7890',
      proxyUsername: 'proxyuser',
      proxyPassword: 'p@ss word',
    }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
    expect(error.message).toContain('127.0.0.1:7890')
    expect(error.message).toContain('proxyServer')
    expect(error.message).toContain('/data/p')
    expect(error.message).not.toContain('p@ss word')
  })

  it('reports a managed launch failure without a proxy as WEB_PROVIDER_ERROR naming the profile', async () => {
    installFakeLocalBackend({ failPersistentLaunch: new Error('Executable doesn\'t exist') })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', userDataDir: '/data/p', headless: false }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('/data/p')
    expect(error.message).toContain('headful')
    expect(error.message).toContain("Executable doesn't exist")
  })

  it('maps an unusable proxy value to WEB_FETCH_PROXY before any launch', async () => {
    const backend = installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      backend: 'managed',
      proxyServer: 'ftp://proxy.corp:21',
    }))
    const error = await failureOf(provider.fetch({ url: 'https://example.com/docs' }))
    expect(error.code).toBe(WEB_FETCH_PROXY_CODE)
    expect(backend.persistentLaunches).toHaveLength(0)
  })

  it('relaunches after the persistent context went away (user closed the browser)', async () => {
    const backend = installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', userDataDir: '/data/p' }))
    await provider.fetch({ url: 'https://example.com/a' })
    const first = backend.persistentContexts[0]
    first?.state.closeListeners.forEach(listener => { listener() })
    first && (first.state.closed = true)

    await provider.fetch({ url: 'https://example.com/b' })
    expect(backend.persistentLaunches).toHaveLength(2)
  })

  it('honours maxConcurrency as a TAB budget on the managed backend', async () => {
    const backend = installFakeLocalBackend()
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ backend: 'managed', userDataDir: '/data/p' }))
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      provider.fetch({ url: `https://example.com/tab-${String(index)}` })))
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    // One browser for all twenty tabs — the managed default (50) never queued.
    expect(backend.persistentLaunches).toHaveLength(1)
    expect(backend.persistentContexts[0]?.state.pagesOpened).toBe(20)
  })

  it('passes headless/args to the LOCAL launch too, and omits them when unset', async () => {
    const configured = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig({ headless: false, launchArgs: '--lang=zh-CN' }))
      .fetch({ url: 'https://example.com/docs' })
    expect(configured.launches[0]?.headless).toBe(false)
    expect(configured.launches[0]?.args).toEqual(['--lang=zh-CN'])

    const bare = installFakeLocalBackend()
    await new PlaywrightFetchProvider(() => resolvedConfig()).fetch({ url: 'https://example.com/docs' })
    expect(bare.launches[0]?.headless).toBe(true)
    expect(bare.launches[0]).not.toHaveProperty('args')
  })
})

/** The P2 capture wiring: one CDP session per fetch, JSONL + HAR on disk. */
describe('PlaywrightFetchProvider network capture', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-capture-')) })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    localBackendHook.current = undefined
  })

  /** The scripted traffic a fake tab produces once Network is enabled. */
  function captureScript(body = '{"token":"tok-123"}'): FakeCaptureScript {
    return {
      events: [
        {
          event: 'Network.requestWillBeSent',
          params: {
            requestId: '1',
            type: 'XHR',
            request: {
              url: 'https://api.example.com/v1/login',
              method: 'POST',
              headers: { 'content-type': 'application/json', cookie: 'session=abc123', authorization: 'Bearer tok-123' },
              postData: '{"user":"u","pw":"p"}',
            },
          },
        },
        {
          event: 'Network.responseReceived',
          params: {
            requestId: '1',
            type: 'XHR',
            response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'set-cookie': 'sid=xyz; Path=/' } },
          },
        },
        { event: 'Network.loadingFinished', params: { requestId: '1', encodedDataLength: body.length } },
        { event: 'Network.webSocketCreated', params: { requestId: 'ws1', url: 'wss://stream.example.com/socket' } },
        { event: 'Network.webSocketFrameReceived', params: { requestId: 'ws1', response: { opcode: 1, payloadData: '{"price":42}' } } },
        { event: 'Network.webSocketClosed', params: { requestId: 'ws1' } },
      ],
      bodies: { '1': { body } },
    }
  }

  /** The capture directories a test produced, in name (≈ time) order. */
  function captureDirs(): string[] {
    return existsSync(root) ? readdirSync(root).sort() : []
  }

  /** Poll until the capture session directory exists (attach is async). */
  async function waitForCaptureDir(): Promise<string> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const dirs = captureDirs()
      if (dirs.length > 0) return join(root, dirs[0] ?? '')
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    throw new Error('the capture session directory never appeared')
  }

  function readJsonl(dir: string): Array<Record<string, unknown>> {
    return readFileSync(join(dir, 'network.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  }

  function readHar(dir: string): { log: { version: string; creator: { name: string }; entries: Array<Record<string, unknown>> } } {
    return JSON.parse(readFileSync(join(dir, 'har.json'), 'utf8')) as { log: { version: string; creator: { name: string }; entries: Array<Record<string, unknown>> } }
  }

  it('opens one CDP session on the fetch tab and writes JSONL + HAR under <recordDir>/<session>', async () => {
    const backend = installFakeLocalBackend({ capture: captureScript() })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({
      recordNetwork: true,
      recordDir: root,
      captureBodies: true,
      maxBodyBytes: 1024,
    }))

    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    expect(backend.cdpSessions).toHaveLength(1) // one session, on the fetch's own tab
    expect(backend.cdpSessions[0]?.methods()).toContain('Network.enable')
    expect(backend.cdpSessions[0]?.methods()).toContain('Network.getResponseBody')

    const dirs = captureDirs()
    expect(dirs).toHaveLength(1)
    const dir = join(root, dirs[0] ?? '')
    const lines = readJsonl(dir)
    expect(lines[0]).toMatchObject({ kind: 'session', fetchUrl: 'https://example.com/docs' })
    expect(lines[0]).not.toHaveProperty('url')
    // The body-carrying `responseBody` line is appended after its async
    // getResponseBody, so the order among kinds is not guaranteed — only the
    // header-first invariant and the set of events are.
    expect([...lines.map(line => line['kind'])].sort()).toEqual([
      'finished', 'request', 'response', 'responseBody', 'session', 'websocketClosed', 'websocketCreated', 'websocketFrame',
    ])
    // Credentials are stored verbatim, on purpose.
    expect((lines[1]?.['headers'] as Record<string, string>)['cookie']).toBe('session=abc123')

    const har = readHar(dir)
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('dsh-web-fetch-playwright')
    expect(har.log.entries).toHaveLength(2)
    const http = har.log.entries.find(entry => entry['_resourceType'] === 'XHR')
    expect(http).toMatchObject({ request: { method: 'POST', url: 'https://api.example.com/v1/login' }, response: { status: 200 } })
    const socket = har.log.entries.find(entry => entry['_resourceType'] === 'WebSocket')
    expect(socket?.['_webSocketMessages']).toEqual([{ type: 'receive', time: expect.any(Number), opcode: 1, data: '{"price":42}' }])
  })

  it('bounds the captured body with maxBodyBytes and flags the cut', async () => {
    const backend = installFakeLocalBackend({ capture: captureScript('x'.repeat(500)) })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root, maxBodyBytes: 32 }))
    await provider.fetch({ url: 'https://example.com/docs' })
    expect(backend.cdpSessions).toHaveLength(1)

    const dir = join(root, captureDirs()[0] ?? '')
    const bodyLine = readJsonl(dir).find(line => line['kind'] === 'responseBody')
    expect(bodyLine).toMatchObject({ base64Encoded: false, bodyTruncated: true, bodyBytes: 500 })
    expect(String(bodyLine?.['body']).length).toBe(32)
    const http = readHar(dir).log.entries.find(entry => entry['_resourceType'] === 'XHR') as
      | { response: { content: { text?: string; size: number } } }
      | undefined
    expect(http?.response.content.text).toBe('x'.repeat(32))
    expect(http?.response.content.size).toBe(500)
  })

  it('keeps recording metadata when captureBodies is off', async () => {
    const backend = installFakeLocalBackend({ capture: captureScript() })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root, captureBodies: false }))
    await provider.fetch({ url: 'https://example.com/docs' })
    expect(backend.cdpSessions[0]?.methods()).not.toContain('Network.getResponseBody')

    const dir = join(root, captureDirs()[0] ?? '')
    expect(readJsonl(dir).some(line => line['kind'] === 'responseBody')).toBe(false)
    expect(readHar(dir).log.entries.some(entry => entry['_resourceType'] === 'XHR')).toBe(true)
  })

  it('exports the HAR when the fetch itself throws', async () => {
    const backend = installFakeLocalBackend({
      capture: captureScript(),
      page: { gotoError: new Error('net::ERR_CONNECTION_REFUSED') },
    })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    const error = await provider.fetch({ url: 'https://example.com/down' }).then(
      () => { throw new Error('expected the fetch to reject') },
      (thrown: unknown) => thrown as WebError,
    )
    expect(error).toBeInstanceOf(WebError)
    expect(backend.cdpSessions).toHaveLength(1)

    const dir = join(root, captureDirs()[0] ?? '')
    expect(existsSync(join(dir, 'har.json'))).toBe(true)
    expect(readHar(dir).log.entries).toHaveLength(2) // the scripted XHR + WebSocket
    expect(readJsonl(dir).some(line => line['kind'] === 'finished')).toBe(true)
  })

  it('exports the HAR when the fetch is aborted mid-capture', async () => {
    const backend = installFakeLocalBackend({ capture: captureScript(), page: { hangGoto: true } })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    const controller = new AbortController()
    const pending = provider.fetch({ url: 'https://example.com/aborted' }, controller.signal)
      .then(() => { throw new Error('expected the fetch to reject') }, (thrown: unknown) => thrown as WebError)
    const dir = await waitForCaptureDir() // the recorder is attached; goto hangs
    expect(backend.cdpSessions).toHaveLength(1)
    controller.abort()

    const error = await pending
    expect(error.code).toBe('WEB_ABORTED')
    expect(existsSync(join(dir, 'har.json'))).toBe(true)
    expect(readJsonl(dir)[0]).toMatchObject({ kind: 'session', fetchUrl: 'https://example.com/aborted' })
  })

  it('does nothing at all when recordNetwork is off (the default)', async () => {
    const backend = installFakeLocalBackend({ capture: captureScript() })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig())
    await provider.fetch({ url: 'https://example.com/docs' })
    expect(backend.cdpSessions).toHaveLength(0)
    expect(captureDirs()).toHaveLength(0)
  })

  it('never fails a fetch when the capture cannot start', async () => {
    const backend = installFakeLocalBackend({ capture: { sessionError: new Error('no CDP on this page') } })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    expect(backend.cdpSessions).toHaveLength(0)
    expect(captureDirs()).toHaveLength(0)

    // A session whose Network domain refuses still records nothing fatal.
    const broken = installFakeLocalBackend({ capture: { failEnable: true, events: captureScript().events } })
    const brokenProvider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    expect((await brokenProvider.fetch({ url: 'https://example.com/docs' })).statusCode).toBe(200)
    expect(broken.cdpSessions).toHaveLength(1)
    expect(captureDirs()).toHaveLength(1)
  })

  it('records the CDP backend too (a session on the leased remote tab)', async () => {
    const { state, pool } = fakeCdpConnection({}, captureScript())
    const provider = new PlaywrightFetchProvider(
      () => resolvedConfig({ backend: 'cdp', cdpEndpoint: '127.0.0.1:9222', recordNetwork: true, recordDir: root }),
      pool,
    )
    const result = await provider.fetch({ url: 'https://example.com/docs' })
    expect(result.statusCode).toBe(200)
    // One session on the tab this fetch leased — the shared connection and the
    // remote default context are untouched by recording.
    expect(state.cdpSessions).toHaveLength(1)
    expect(state.defaultContextClosed).toBe(0)

    const dir = join(root, captureDirs()[0] ?? '')
    expect(readHar(dir).log.entries.some(entry => entry['_resourceType'] === 'XHR')).toBe(true)
    await provider.dispose()
    expect(state.browserClosed).toBe(true) // teardown still only disconnects
  })

  it('relaunches the capture directory per fetch (one session each)', async () => {
    installFakeLocalBackend({ capture: captureScript() })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    await provider.fetch({ url: 'https://example.com/a' })
    await provider.fetch({ url: 'https://example.com/b' })
    const dirs = captureDirs()
    expect(dirs).toHaveLength(2)
    // Session ids carry a random suffix, so two captures in the same
    // millisecond may order either way: compare the set.
    const urls = dirs.map(dir => readJsonl(join(root, dir))[0]?.['fetchUrl'])
    expect([...urls].sort()).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('flushes an in-flight capture on plugin teardown (dispose)', async () => {
    const backend = installFakeLocalBackend({ page: { hangGoto: true } })
    const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
    const controller = new AbortController()
    // The page never settles: the fetch is still running when the plugin unloads.
    const pending = provider.fetch({ url: 'https://example.com/slow' }, controller.signal)
      .then(() => undefined, (error: unknown) => error)
    const dir = await waitForCaptureDir()
    expect(backend.cdpSessions).toHaveLength(1)

    // Unload while the capture is still running: dispose flushes it.
    await provider.dispose()
    expect(existsSync(join(dir, 'har.json'))).toBe(true)
    expect(readJsonl(dir)[0]).toMatchObject({ kind: 'session', fetchUrl: 'https://example.com/slow' })

    controller.abort()
    expect(await pending).toBeInstanceOf(WebError)
  })
})

/** The capture failure outlet: visible, bounded, and never fatal. */
describe('PlaywrightFetchProvider capture failure outlet', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-capture-warn-')) })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    localBackendHook.current = undefined
  })

  /** A provider whose capture session id is pinned, so the test knows the path. */
  class FixedCaptureIdProvider extends PlaywrightFetchProvider {
    protected nextCaptureSessionId(): string { return 'fixed-session' }
  }

  it('reports a capture that cannot even start (filesystem), error text only, fetch still succeeds', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installFakeLocalBackend({
        capture: {
          events: [
            { event: 'Network.requestWillBeSent', params: { requestId: '1', type: 'XHR', request: { url: 'https://api.example.com/v1/login', method: 'POST', headers: { cookie: 'session=abc123', authorization: 'Bearer tok-123' }, postData: '{"user":"u","pw":"p"}' } } },
          ],
        },
      })
      // The pinned session directory already exists, so the (non-recursive)
      // claim cannot succeed and the capture never starts: a filesystem-level
      // recording failure the caller must be able to see.
      mkdirSync(join(root, 'fixed-session'))

      const provider = new FixedCaptureIdProvider(() => resolvedConfig({
        recordNetwork: true,
        recordDir: root,
        captureBodies: true,
      }))
      const result = await provider.fetch({ url: 'https://example.com/docs' })
      expect(result.statusCode).toBe(200) // recording never fails a fetch

      const messages = warning.mock.calls.map(call => String(call[0]))
      expect(messages).toHaveLength(1) // reported once, not per fetch
      expect(messages[0]).toContain('network capture problem')
      expect(messages[0]).toContain('could not start a capture session')
      expect(messages[0]).not.toContain('abc123')
      expect(messages[0]).not.toContain('tok-123')
      expect(messages[0]).not.toContain('{"user"')
      expect(existsSync(join(root, 'fixed-session', 'network.jsonl'))).toBe(false)
    } finally {
      warning.mockRestore()
    }
  })

  it('reports a capture that cannot attach its CDP session, without leaking dump content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installFakeLocalBackend({ capture: { sessionError: new Error('no CDP session on this page') } })
      const provider = new FixedCaptureIdProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
      const result = await provider.fetch({ url: 'https://example.com/docs' })
      expect(result.statusCode).toBe(200)
      const messages = warning.mock.calls.map(call => String(call[0]))
      expect(messages.join('\n')).toContain('could not attach a capture session')
      expect(messages.join('\n')).toContain('no CDP session on this page')
    } finally {
      warning.mockRestore()
    }
  })

  it('stays quiet when the capture is healthy', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installFakeLocalBackend({})
      const provider = new FixedCaptureIdProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
      await provider.fetch({ url: 'https://example.com/docs' })
      expect(warning).not.toHaveBeenCalled()
      expect(existsSync(join(root, 'fixed-session', 'har.json'))).toBe(true)
    } finally {
      warning.mockRestore()
    }
  })
})

/** t15/R3: the capture failure outlet de-duplicates by KIND and stays bounded. */
describe('capture failure outlet policy (t15/R3)', () => {
  it('warns once for the same failure KIND across different request ids', () => {
    const warned: string[] = []
    const reporter = new CaptureErrorReporter(message => { warned.push(message) })
    // The volatile part is the requestId in the parentheses.
    expect(reporter.report('getResponseBody(1000.1) failed: No resource with given identifier found (1000.1)')).toBe(true)
    expect(reporter.report('getResponseBody(2000.2) failed: No resource with given identifier found (2000.2)')).toBe(false)
    expect(reporter.report('getResponseBody(3000.3) failed: No resource with given identifier found (3000.3)')).toBe(false)
    expect(warned).toHaveLength(1)
    expect(reporter.size).toBe(1)

    // A genuinely different kind still gets through.
    expect(reporter.report('writing har.json failed: EISDIR')).toBe(true)
    expect(warned).toHaveLength(2)
  })

  it('normalizes the de-duplication key', () => {
    expect(captureErrorKey('getResponseBody(1000.1) failed: ENOENT')).toBe(captureErrorKey('getResponseBody(2000.2) failed: ENOENT'))
    expect(captureErrorKey('could not start a capture session under /tmp/net-dumps')).toContain('/tmp/net-dumps')
    expect(captureErrorKey('something happened at 12:30:45')).toBe(captureErrorKey('something happened at 01:02:03'))
  })

  it('keeps the remembered kinds bounded under a flood of distinct failures', () => {
    const warned: string[] = []
    const reporter = new CaptureErrorReporter(message => { warned.push(message) }, { maxKinds: 8 })
    // Alphabetic kinds on purpose: a numeric one would be normalized into the
    // same key as its siblings (which is the point of the normalizer).
    const word = (index: number): string => {
      let value = index + 1
      let text = ''
      while (value > 0) {
        text = String.fromCharCode(97 + ((value - 1) % 26)) + text
        value = Math.floor((value - 1) / 26)
      }
      return text
    }
    for (let index = 0; index < 200; index++) {
      reporter.report(`kind-${word(index)} failed somewhere`)
    }
    expect(reporter.size).toBeLessThanOrEqual(8)
    // Every distinct kind warned as it arrived (bounded by eviction, not by
    // silencing new kinds).
    expect(warned).toHaveLength(200)
  })

  it('forgets a kind after the TTL so a recurrence is reported again', () => {
    let now = 1_000_000
    const warned: string[] = []
    const reporter = new CaptureErrorReporter(message => { warned.push(message) }, { ttlMs: 1_000, now: () => now })
    expect(reporter.report('Network.enable failed: boom')).toBe(true)
    expect(reporter.report('Network.enable failed: boom')).toBe(false)
    now += 1_500 // past the TTL
    expect(reporter.report('Network.enable failed: boom')).toBe(true)
    expect(warned).toHaveLength(2)
  })

  it('reports a flood of per-request capture failures through the provider ONCE', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Three requests whose bodies cannot be read: each failure carries its
      // own requestId in the text, which is exactly what used to spam.
      const events: Array<{ event: string; params: Record<string, unknown> }> = []
      for (const requestId of ['1000.1', '1000.2', '1000.3']) {
        events.push(
          { event: 'Network.requestWillBeSent', params: { requestId, type: 'XHR', request: { url: `https://api.example.com/v1/${requestId}`, method: 'GET', headers: {} } } },
          { event: 'Network.responseReceived', params: { requestId, response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} } } },
          { event: 'Network.loadingFinished', params: { requestId } },
        )
      }
      // No bodies scripted → every getResponseBody read fails.
      installFakeLocalBackend({ capture: { events } })
      const root = mkdtempSync(join(tmpdir(), 'dsh-capture-dedupe-'))
      try {
        const provider = new PlaywrightFetchProvider(() => resolvedConfig({ recordNetwork: true, recordDir: root }))
        const result = await provider.fetch({ url: 'https://example.com/docs' })
        expect(result.statusCode).toBe(200)
        const captureWarnings = warning.mock.calls.map(call => String(call[0])).filter(message => message.includes('network capture problem'))
        expect(captureWarnings).toHaveLength(1)
        expect(captureWarnings[0]).toContain('getResponseBody')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    } finally {
      warning.mockRestore()
    }
  })
})
