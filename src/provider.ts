/**
 * The Playwright `WebFetchProvider`: renders one URL in a real browser and
 * returns it as markdown (denoised) or HTML. Mirrors `dsh-web-fetch-http`'s
 * error taxonomy (URL hygiene, abort/timeout translation, content-type
 * classification) so the tool layer sees the same codes from either backend.
 *
 * Lifecycle — one row per backend:
 *
 * - `local`: launches a browser per fetch and closes it; nothing outlives the
 *   call. Fresh context, fresh everything.
 * - `managed` (DSH-hosted persistent browser): launches ONE browser for the
 *   provider's lifetime over `userDataDir` (`launchPersistentContext`), so
 *   logins persist across fetches and restarts; each fetch opens a tab in that
 *   persistent context and closes only the tab. The browser and its profile
 *   context are never closed per fetch — only on plugin teardown (or when a
 *   setting that shapes the launch changes, which replaces it).
 * - `cdp`: keeps ONE shared connection to a browser someone else started; each
 *   fetch opens a page (tab) inside it and closes that on completion — in a
 *   throwaway isolated context, or (the default, `shareBrowserContext`) in the
 *   remote browser's default context so its profile, cookies, and persistent
 *   logins apply; that default context is never closed.
 *
 * Concurrency counts TABS for `cdp` and `managed` (one browser is already
 * alive; a slot is a tab) and BROWSERS for `local` — hence the backend-priced
 * defaults ({@link DEFAULT_MAX_CONCURRENCY_LOCAL} /
 * {@link DEFAULT_MAX_CONCURRENCY_CDP} / {@link DEFAULT_MAX_CONCURRENCY_MANAGED}).
 * Either way, an aborted signal closes the fetch's page, further fetches wait
 * briefly in a queue, and a queued fetch fails fast (rather than hanging until
 * abort) when no slot frees.
 *
 * Private-network and SSRF protection is not implemented (same stance as the
 * shipped HTTP provider); a page this provider can reach is whatever the
 * browser can reach. Profile-bearing backends (`managed`, CDP `profile` mode)
 * additionally act WITH the browser's logged-in sessions (see the README's
 * risk notes).
 *
 * Outbound proxy (P0): the proxy configured in the settings is injected into
 * every browser THIS PLUGIN launches — `local` and `managed` — through
 * Playwright's `launch({ proxy })` / `launchPersistentContext({ proxy })`;
 * with no proxy configured the key is not passed at all. A proxy is a
 * launch-time property of a browser PROCESS, so on the `cdp` backend it
 * belongs to the browser that was started elsewhere: this plugin can neither
 * inject it there nor verify it (see {@link CDP_PROXY_NOTE} and
 * {@link CDP_PROXY_POLICY}), and the local launcher turns the same settings
 * into that browser's `--proxy-server`. Every proxy failure THIS plugin can
 * observe (an unusable value, a launch that failed with a proxy configured)
 * surfaces as {@link WEB_FETCH_PROXY_CODE}, naming the proxy address and where
 * it came from — and never the password.
 *
 * Network capture (P2): with `recordNetwork` on, every fetch opens ONE CDP
 * session on the tab it just created and records that tab's XHR/Fetch/
 * WebSocket traffic — nothing else; other tabs of a shared browser are never
 * observed (no `Target.setAutoAttach`). The recorder appends JSONL events as
 * they arrive and writes a HAR 1.2 export when the fetch ends, on every path
 * (success, thrown error, abort, and plugin teardown through
 * {@link PlaywrightFetchProvider.dispose}). All of it is best-effort: a CDP or
 * filesystem failure is swallowed and can never fail a fetch.
 *
 * Cloudflare challenges (issue #2): when a navigation lands on a challenge
 * interstitial, the fetch waits — on the SAME page and in the SAME browser
 * context, so the browser's natural verification and any clearance cookies
 * it earns apply — for a bounded, configurable window
 * (`challengeWaitMs`, default 15s; 0 restores the legacy first-response
 * behavior). The wait tracks the LAST main-frame navigation response (the
 * real page reloads in after the challenge clears) and watches the live DOM
 * so SPA-style clears are caught too. It never clicks, never injects
 * answers, never touches cookies itself; when the budget runs out the fetch
 * fails with {@link WEB_FETCH_CHALLENGE_CODE} instead of returning the
 * interstitial as content.
 *
 * @module dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { CHALLENGE_DOM_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
import type { ChallengeVerdict } from './challenge.ts'
import { DEFAULT_MAX_CONCURRENCY_CDP, DEFAULT_MAX_CONCURRENCY_LOCAL, DEFAULT_MAX_CONCURRENCY_MANAGED, captureOptionsFor, effectiveChallengeRetries, effectiveChallengeWaitMs, effectiveContextMode, effectiveHeadless, effectiveMaxConcurrency, managedLaunchFor, managedLaunchKey, normalizeCdpEndpoint, proxyOptionFor, redactProxyServer } from './config.ts'
import type { ManagedLaunch, ProxySettings, ResolvedConfig } from './config.ts'
import { NetworkRecorder, nextCaptureSessionId as recorderSessionId } from './recorder.ts'
import { BrowserPool } from './browser-pool.ts'
import type { BrowserPoolOptions } from './browser-pool.ts'
import { CdpConnectionPool } from './cdp-pool.ts'
import { htmlToMarkdown, stripNonContentHtml } from './markdown.ts'
import { CONSENT_TIMEOUT_MS, dismissConsentBanner, isConsentGate } from './consent.ts'
import { OBSERVE_TIMEOUT_MS, observePage, renderObservation } from './observe.ts'
import { runTargetActions, renderActionSummary } from './actions.ts'
import { selectTarget, type Target } from './targets.ts'
import { loadTargets } from './target-store.ts'
import { parseLaunchArgs } from './launch-args.ts'
import { resolveCdpBackend, resolvePlaywrightBackend } from './playwright-resolve.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage, PlaywrightPersistentContext, PlaywrightProxyOption, PlaywrightResponse, PlaywrightRoute } from './types.ts'

/** Stable id this provider registers under (the bundle patch pins it). */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/**
 * Error code for a Cloudflare challenge the bounded natural wait could not
 * clear. Provider-specific by design — the web seam's `code` is an open
 * string and consumers must tolerate provider-specific codes — so callers
 * can tell "the site challenged us and the browser did not pass" apart from
 * a transport timeout or a provider bug.
 */
export const WEB_FETCH_CHALLENGE_CODE = 'WEB_FETCH_CHALLENGE'

/**
 * Error code for a proxy this provider could not apply: an unusable
 * `proxyServer` value, or a launch through the configured proxy that failed
 * (`local` / `managed`, the two backends this plugin launches itself).
 * Provider-specific by the same open-`code` contract as
 * {@link WEB_FETCH_CHALLENGE_CODE}; the message always names the proxy address
 * and where it was resolved from, and never the password.
 */
export const WEB_FETCH_PROXY_CODE = 'WEB_FETCH_PROXY'

/**
 * Error code for a consent gate that survived its own dismissal: a full-page
 * consent interstitial was recognised and its accept control was clicked, and
 * the document is *still* the gate — so the requested page was never reached.
 *
 * It exists because the alternative is worse: without it the fetch reads the
 * gate and returns it as if it were the page. Opt-in by construction — the
 * check only runs when `dismissConsent` is on and a gate click happened.
 */
export const WEB_FETCH_CONSENT_CODE = 'WEB_FETCH_CONSENT'

/**
 * Error code for an unusable targets file: missing, unreadable, not JSON, or
 * naming a target ambiguously. The message carries the JSON path of the problem,
 * because the file is hand-edited.
 */
export const WEB_FETCH_TARGET_CODE = 'WEB_FETCH_TARGET'

/**
 * Error code for a target step that did not hold: the fetch stops rather than
 * reading a document the target never reached, and the message names the step,
 * the verb, what it was waiting for, and where the browser was.
 */
export const WEB_FETCH_ACTION_CODE = 'WEB_FETCH_ACTION'

/**
 * The one fact a user needs when a proxy meets the CDP backend: the proxy is
 * a launch-time property of the browser PROCESS, so it belongs on the command
 * that starts that browser (`--proxy-server=...`) — attaching over CDP cannot
 * retro-fit one, and this plugin cannot verify one either (a hand-started
 * browser that forgot the flag simply goes direct). Spelled once here and
 * mirrored by the card's copy (`client/locales.ts`) and the README so the
 * explanation cannot drift between them.
 */
const CDP_PROXY_NOTE = 'a proxy is a launch-time property of that browser: it must have been started with --proxy-server=..., and this plugin cannot inject a proxy into (or verify one on) an already-running browser'

/**
 * The single switch point for what a configured `proxyServer` means while the
 * CDP backend is selected — the only place that decision lives.
 *
 * `'hint-only'` (shipped): the fetch RUNS. Refusing every proxied CDP fetch
 * would break exactly the topology the local launcher exists for (the user
 * configures the proxy in the card, the launcher turns it into
 * `--proxy-server`, and the plugin then attaches over CDP), so the settings
 * field instead drives the launcher command and the card preview, and the
 * relationship is EXPLAINED — {@link CDP_PROXY_NOTE} in the card's copy and in
 * the CDP error messages — rather than enforced. A browser started without the
 * flag simply egresses directly; that footgun is documented, not policed.
 *
 * `'refuse'` is the pre-P1 alternative: every fetch over CDP fails with
 * {@link WEB_FETCH_PROXY_CODE} until the field is cleared. It is implemented —
 * {@link cdpProxyRefusal} enforces whatever this constant says — so flipping it
 * is genuinely a one-line change, and the tests assert the BEHAVIOR (a proxied
 * CDP fetch runs) rather than the constant's literal value.
 */
export const CDP_PROXY_POLICY: 'hint-only' | 'refuse' = 'hint-only'

/**
 * Enforce {@link CDP_PROXY_POLICY} for one fetch: `undefined` when the fetch
 * may proceed, or the refusal to throw. With the shipped `'hint-only'` policy
 * this is always `undefined`, and the CDP path explains the relationship
 * ({@link CDP_PROXY_NOTE}) instead of blocking it.
 *
 * @param proxy - the resolved proxy option, if the settings configure one.
 * @returns the error to throw, or undefined when the fetch may run.
 */
function cdpProxyRefusal(proxy: PlaywrightProxyOption | undefined): WebError | undefined {
  if (proxy === undefined || CDP_PROXY_POLICY !== 'refuse') return undefined
  return new WebError(
    `the proxy ${redactProxyServer(proxy.server)} from the web-fetch-playwright settings cannot be applied to the CDP backend: ${CDP_PROXY_NOTE}. Start that browser with --proxy-server=${redactProxyServer(proxy.server)} yourself, or clear the proxyServer setting to fetch through CDP without one.`,
    WEB_FETCH_PROXY_CODE,
  )
}

/** Maximum accepted request URL length (http-provider parity). */
const MAX_URL_LENGTH = 2048

/** Cap on the decoded markdown/HTML body this provider returns. */
const MAX_BODY_CHARS = 100_000

/**
 * Cap on rendered HTML fed into the synchronous denoise pipeline.
 *
 * Measured *after* {@link boundPipelineInput} deletes non-content subtrees,
 * so the budget pays for markup that can actually become markdown.
 */
const MAX_PIPELINE_INPUT_CHARS = 2_000_000

/**
 * Put the action summary at the top of the body.
 *
 * The result shape is closed (ADR-0003), so the body is the only place a caller
 * can learn that a recipe ran and which document it ended on. When no target ran
 * there is nothing to say and the body is untouched.
 *
 * @param content - the body the fetch produced.
 * @param summary - the summary line, or null when no target ran.
 * @returns the body, with the summary first when there is one.
 */
function withActionSummary(content: string, summary: string | null, kind: 'html' | 'text'): string {
  if (summary === null) return content
  // The same line, wrapped for the body it is going into: a blockquote element in
  // HTML, a blockquote line in markdown. Plain text in front of raw HTML would
  // render as literal "> actions:" inside the page.
  if (kind === 'html') {
    const escaped = summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<blockquote>${escaped}</blockquote>\n${content}`
  }
  return `> ${summary}\n\n${content}`
}

/**
 * Shrink rendered HTML to the denoise pipeline's input budget.
 *
 * Non-content subtrees go first: they can never reach the returned markdown,
 * yet on component-heavy sites they are most of the document, and a plain
 * character-count cut beheads pages whose copy sits late. On a measured
 * iHerb product page the document was 2.89 MB with the product copy starting
 * at offset 2,111,410 — past the cap — so the article was discarded and
 * Readability scored a cookie banner instead; stripping script/style/svg
 * first left 1.86 MB with the copy intact. Only what survives that reduction
 * is charged against {@link MAX_PIPELINE_INPUT_CHARS}, so `cut` means the
 * article itself was clipped rather than merely surrounded by bloat.
 *
 * @param html - the rendered page HTML (`page.content()`).
 * @returns the pipeline input, and whether the budget clipped it.
 */
function boundPipelineInput(html: string): { input: string; cut: boolean } {
  const reduced = stripNonContentHtml(html)
  return reduced.length > MAX_PIPELINE_INPUT_CHARS
    ? { input: reduced.slice(0, MAX_PIPELINE_INPUT_CHARS), cut: true }
    : { input: reduced, cut: false }
}

/**
 * How long a fetch may sit in the concurrency queue before failing fast.
 * Waiting longer cannot help — the per-fetch deadline leaves too little
 * budget to render after dequeue — and failing fast tells the caller to
 * retry or raise `maxConcurrency` instead of hanging until an abort.
 */
const QUEUE_TIMEOUT_MS = 20_000

/** Default per-fetch budget (ms), inside the tool layer's 60s. */
const DEFAULT_TIMEOUT_MS = 45_000

/** Best-effort post-DOM settle wait (ms) so SPA content can finish rendering. */
const SETTLE_MS = 5_000

/**
 * Grace period (ms) for context/browser closes in the cleanup path. A wedged
 * `close()` must never hold a concurrency slot hostage — a leaked slot would
 * fail every later fetch with the queue error until restart.
 */
const CLOSE_GRACE_MS = 2_000

/**
 * One render session: a browser, the context this fetch works in, and the
 * tab it owns. Local backends own the browser too; CDP sessions ride the
 * shared connection, and in `profile` mode the context is the remote
 * browser's default context — shared, never closed, only the tab is.
 */
export interface BrowserSession {
  browser: PlaywrightBrowser
  context: PlaywrightContext
  /** The fetch-owned tab this fetch renders in. */
  page: PlaywrightPage
  /** True when `browser` is the CDP pool's shared connection — never closed per fetch. */
  sharedBrowser?: boolean
  /** True when `context` is the remote default context — close only the page. */
  persistent?: boolean
  /**
   * The P2 capture session riding this fetch's tab, when recording is on and
   * the backend could provide a CDP session. Its JSONL is already being
   * appended to while the fetch runs; {@link closeSession} finishes it (flush
   * + HAR export) on every exit path.
   */
  recorder?: NetworkRecorder
  /**
   * Pages this fetch adopted because a target step opened them (`opensPage`).
   * They are ordinary tabs of the same context; in profile mode nothing else
   * would close them, so {@link closeSession} does.
   */
  adoptedPages?: PlaywrightPage[]
}

/**
 * A single abort deadline composing the caller's signal with this provider's
 * time budget. The timeout reason is kept apart from an outer abort so the
 * error translation can pick `WEB_FETCH_TIMEOUT` over `WEB_ABORTED`.
 */
class Deadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private timedOut = false

  constructor(outer: AbortSignal | undefined, timeoutMs: number) {
    this.signal = this.controller.signal
    this.expiresAt = Date.now() + timeoutMs
    const timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error('playwright fetch deadline'))
    }, timeoutMs)
    if (outer !== undefined) {
      if (outer.aborted) this.controller.abort(outer.reason)
      else outer.addEventListener('abort', () => { this.controller.abort(outer.reason) }, { once: true })
    }
    this.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  }

  /** Whether OUR timer fired (vs an outer cancellation). */
  get isTimeout(): boolean {
    return this.timedOut
  }

  /** Milliseconds left on the budget, floored at 1 for Playwright options. */
  remainingMs(): number {
    return Math.max(1, this.expiresAt - Date.now())
  }
}

/**
 * A bounded async semaphore with abort support. The limit is live-resizable
 * (`resize`) because the config thunk re-reads on every fetch — raising it
 * wakes queued waiters immediately; lowering it lets in-flight holders run
 * out naturally.
 */
class Semaphore {
  private active = 0
  private limit: number
  private readonly queue: Array<{ start: () => void; fail: (error: WebError) => void }> = []

  /** @param limit - how many holders may run at once. */
  constructor(limit: number) {
    this.limit = limit
  }

  /** Apply a new limit, starting queued waiters for any capacity it opens. */
  resize(limit: number): void {
    this.limit = limit
    this.drain()
  }

  /**
   * Take a slot, or queue until one frees. A queued fetch fails fast on the
   * caller's abort signal or after `queueTimeoutMs` without a slot — the
   * queue wait must not eat the whole fetch budget only to die mid-render.
   */
  acquire(signal: AbortSignal, queueTimeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const waiter = {
        start: () => {
          cleanup()
          this.active++
          resolve()
        },
        fail: (error: WebError) => {
          const index = this.queue.indexOf(waiter)
          if (index !== -1) this.queue.splice(index, 1)
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        waiter.fail(new WebError(
          `all ${String(this.limit)} rendering slots stayed busy for ${String(queueTimeoutMs)}ms; retry shortly, or raise the maxConcurrency setting`,
          'WEB_FETCH_TIMEOUT',
        ))
      }, queueTimeoutMs)
      const onAbort = () => {
        waiter.fail(new WebError('web fetch aborted while waiting for a free rendering slot', 'WEB_ABORTED'))
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(): void {
    // A holder finished: give its slot back FIRST, then hand out whatever
    // capacity that opens. (Accounting this the other way around — starting a
    // waiter without dropping the finished holder's count — makes `active`
    // drift one above the limit, so only every other release frees a slot and
    // a queue longer than the limit strands its tail until the queue timeout.)
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.queue.shift()
      if (next === undefined) return
      next.start()
    }
  }
}

/** Validate a request URL: http(s) only, no embedded credentials, bounded. */
function validateFetchUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${String(MAX_URL_LENGTH)}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/** The decodable body kinds, mirroring the HTTP provider's classification. */
type FetchableKind = 'html' | 'text'

/** Classify a `Content-Type` into a decodable kind; undefined = unsupported. */
function classifyContentType(contentType: string | undefined): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === '' || mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** Translate a thrown pipeline error into the seam's WebError taxonomy. */
function translateError(error: unknown, deadline: Deadline): WebError {
  if (deadline.isTimeout) return new WebError('playwright web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  if (deadline.signal.aborted) {
    // An outer cancellation of a queued fetch already carries the precise
    // "waiting for a free rendering slot" message — keep it over the generic abort.
    if (error instanceof WebError) return error
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  if (error instanceof WebError) return error
  return new WebError(`playwright web fetch failed: ${String(error instanceof Error ? error.message : error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * How many distinct capture-failure kinds are remembered for de-duplication,
 * and for how long. Bounded and time-limited on purpose: a wedged capture can
 * produce a distinct message per request (each carrying its own requestId), and
 * the outlet must neither spam once per request nor grow without bound.
 */
export const CAPTURE_ERROR_KINDS_MAX = 64

/** How long a remembered kind suppresses a repeat of itself (ms). */
export const CAPTURE_ERROR_TTL_MS = 10 * 60_000

/**
 * The de-duplication key of a capture failure: the message with its VOLATILE
 * parts removed — parenthesised values (a requestId like `(1000.1)`) and bare
 * numbers — so "getResponseBody(1000.1) failed: …" and
 * "getResponseBody(2000.2) failed: …" are the same KIND and warn once.
 *
 * @param message - the failure text.
 * @returns the stable key.
 */
export function captureErrorKey(message: string): string {
  return message
    .replace(/\([^)]*\)/g, '()')
    .replace(/\d[\d.:-]*/g, '#')
    .trim()
    .slice(0, 200)
}

/**
 * The bounded, TTL'd "have I warned about this already?" set behind the capture
 * failure outlet. Kept as its own class so the policy — one warning per kind,
 * eviction instead of unbounded growth, and eventual re-warning — is unit
 * testable without a browser or a fetch.
 */
export class CaptureErrorReporter {
  private readonly kinds = new Map<string, number>()

  /**
   * @param warn - called with the ORIGINAL message the first time a kind appears.
   * @param options - the bound, the TTL, and an injectable clock.
   */
  constructor(
    private readonly warn: (message: string) => void,
    private readonly options: { maxKinds?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  /** How many kinds are currently remembered (never above the bound). */
  get size(): number {
    return this.kinds.size
  }

  /**
   * Report a failure: warn when this KIND has not been reported recently.
   * @param message - the failure text.
   * @returns true when it warned.
   */
  report(message: string): boolean {
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.ttlMs ?? CAPTURE_ERROR_TTL_MS
    for (const [kind, at] of [...this.kinds]) {
      if (now - at > ttl) this.kinds.delete(kind)
    }
    const key = captureErrorKey(message)
    if (this.kinds.has(key)) return false
    const max = this.options.maxKinds ?? CAPTURE_ERROR_KINDS_MAX
    if (this.kinds.size >= max) {
      // Evict the oldest kind so a genuinely new failure still gets its say
      // while the set stays bounded.
      const oldest = [...this.kinds.entries()].sort(([, left], [, right]) => left - right)[0]
      if (oldest !== undefined) this.kinds.delete(oldest[0])
    }
    this.kinds.set(key, now)
    this.warn(message)
    return true
  }
}

/** A thrown value's best one-line description, for the diagnostic messages. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The launch proxy option for a settings section, with an unusable configured
 * address mapped to {@link WEB_FETCH_PROXY_CODE} (the normalizer's own
 * message never echoes the value, so a `user:pass@` in the field cannot leak
 * here).
 *
 * @param config - the resolved settings section.
 * @returns the launch proxy option, or undefined for a direct connection.
 * @throws {WebError} WEB_FETCH_PROXY when the configured server is unusable.
 */
function resolveProxyOption(config: ProxySettings): PlaywrightProxyOption | undefined {
  try {
    return proxyOptionFor(config)
  } catch (error: unknown) {
    throw new WebError(
      `the proxy server configured in the web-fetch-playwright settings (field proxyServer) is not usable: ${messageOf(error)}. Use host:port or an http(s)/socks4/socks5 URL, or clear it for a direct connection.`,
      WEB_FETCH_PROXY_CODE,
      { cause: error },
    )
  }
}

/**
 * Scrub a configured proxy password out of a diagnostic. Playwright's launch
 * errors can quote the credentials the browser was handed, and this
 * provider's contract is that no proxy error message carries the password.
 *
 * @param message - the upstream error message.
 * @param proxy - the launch proxy option the message may have quoted.
 * @returns the message with any occurrence of the password replaced.
 */
function redactProxyPassword(message: string, proxy: PlaywrightProxyOption): string {
  const password = proxy.password ?? ''
  if (password === '') return message
  return message.split(password).join('***')
}

/**
 * The Playwright-backed fetch provider. Configuration is read through a thunk
 * so committed settings-section changes apply to the next fetch with no
 * re-registration.
 */
export class PlaywrightFetchProvider implements WebFetchProvider {
  readonly id = PLAYWRIGHT_FETCH_PROVIDER_ID

  private readonly semaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY_LOCAL)

  /** Shared CDP connection; injectable so the suite can substitute a fake. */
  protected readonly cdpPool: CdpConnectionPool

  /**
   * The DSH-managed persistent browser. The pool key is the launch descriptor
   * (profile directory, headless, args, proxy, Playwright path), so editing
   * any of those replaces the browser on the next fetch while everything else
   * keeps reusing it. Injectable for the suite.
   */
  protected readonly managedPool: BrowserPool<ManagedLaunch, PlaywrightPersistentContext>

  /**
   * Capture sessions that may still be running, so plugin teardown can flush
   * them (the `ctx.effect` in `index.ts` calls {@link dispose}). Finished ones
   * are pruned on the next recorded fetch and cleared by `dispose`.
   */
  private readonly activeRecorders = new Set<NetworkRecorder>()

  /**
   * Capture failures already reported, so a broken dump directory does not
   * warn once per fetch. Recording is best-effort and invisible otherwise —
   * this is the ONE visible outlet, and it carries the error text only (never
   * a header, a body, or a URL from the dump).
   */
  private readonly captureErrors = new CaptureErrorReporter(message => {
    try {
      console.warn(`dsh-web-fetch-playwright: network capture problem (the fetch is unaffected): ${message}`)
    } catch {
      // a console that refuses to warn must not break the fetch either
    }
  })

  /**
   * The session id generator captures use. Protected so a test (or an embedder)
   * can pin it; the default is process-monotonic and collision-resistant.
   */
  protected nextCaptureSessionId(): string {
    return recorderSessionId()
  }

  /**
   * @param configSource - thunk returning the currently authoritative config.
   * @param cdpPool - optional pool over the CDP backend (tests inject fakes).
   * @param managedPool - optional pool over the managed persistent backend.
   */
  constructor(
    private readonly configSource: () => ResolvedConfig,
    cdpPool?: CdpConnectionPool,
    managedPool?: BrowserPool<ManagedLaunch, PlaywrightPersistentContext>,
  ) {
    this.cdpPool = cdpPool ?? new CdpConnectionPool(defaultCdpConnect)
    this.managedPool = managedPool ?? new BrowserPool(defaultManagedPoolOptions)
  }

  /** Cheap and side-effect free; backend problems surface per fetch instead. */
  available(): boolean {
    return true
  }

  /**
   * Report a capture failure once per KIND (see {@link CaptureErrorReporter}).
   * Recording must never fail a fetch, but it must not be silent either.
   */
  private reportCaptureError(message: string): void {
    this.captureErrors.report(message)
  }

  /**
   * Drop the shared browser handles (plugin teardown): the CDP connection,
   * which merely disconnects from a browser someone else owns, and the
   * managed persistent browser, which this plugin launched and therefore
   * closes (its profile directory stays on disk — that is what makes the
   * logins persist to the next start). Local browsers need nothing: they
   * never outlive their fetch. In-flight fetches keep their leases/pages and
   * close them when they finish.
   */
  async dispose(): Promise<void> {
    // Plugins unload while fetches may still be in flight: flush their
    // captures (JSONL + HAR) before dropping the browsers those fetches use.
    await Promise.all([...this.activeRecorders].map(async (recorder) => { await recorder.finish() }))
    this.activeRecorders.clear()
    await this.cdpPool.dispose()
    await this.managedPool.dispose()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const config = this.configSource()
    const url = validateFetchUrl(request.url)
    const deadline = new Deadline(signal, DEFAULT_TIMEOUT_MS)

    let session: BrowserSession | undefined
    let acquired = false
    try {
      // The live config decides the limit per fetch (explicit setting, else
      // the backend default); raising it immediately starts queued waiters.
      this.semaphore.resize(effectiveMaxConcurrency(config))
      await this.semaphore.acquire(deadline.signal, QUEUE_TIMEOUT_MS)
      acquired = true
      session = await this.openSession(config, deadline, url.toString())
      // An aborted deadline must also interrupt Playwright's own waits:
      // closing the page rejects every pending operation on it (and, for
      // fetch-owned contexts, the context close that follows takes the rest).
      const held = session
      const onAbort = () => { void closeSession(held) }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      // An abort that landed WHILE the session was opening never fires the
      // listener just added (an already-aborted signal does not re-notify), so
      // the fetch would sit in its first navigation until the deadline. Close
      // the session now: the navigation rejects immediately, the recorder
      // flushes, and the fetch reports WEB_ABORTED.
      if (deadline.signal.aborted) onAbort()
      try {
        return await this.retrieve(session, url, config, deadline)
      } finally {
        deadline.signal.removeEventListener('abort', onAbort)
      }
    } catch (error: unknown) {
      throw translateError(error, deadline)
    } finally {
      // Local launches exit; CDP connections merely disconnect. Both closes
      // are grace-bounded so a wedged browser can never pin a concurrency slot.
      await closeSession(session)
      // Only a slot actually taken is given back — a queued fetch that failed
      // to acquire must not hand a phantom slot to the next waiter.
      if (acquired) this.semaphore.release()
    }
  }

  /**
   * Open the configured backend and its per-fetch page. Split out so the
   * test suite can substitute a fake browser.
   * @param config - the resolved settings section.
   * @param deadline - the fetch budget, applied to launch/connect timeouts.
   * @returns the browser session the fetch will use.
   */
  protected async openSession(config: ResolvedConfig, deadline: Deadline, fetchUrl = ''): Promise<BrowserSession> {
    const session = await this.openBackendSession(config, deadline)
    return await this.withRecorder(config, session, fetchUrl)
  }

  /**
   * Attach the P2 capture session to a fresh tab, best-effort in both
   * directions: a backend without `newCDPSession` (or with recording off)
   * simply returns the session unchanged, and any failure to open or start the
   * capture is swallowed — recording never fails a fetch.
   */
  private async withRecorder(config: ResolvedConfig, session: BrowserSession, fetchUrl: string): Promise<BrowserSession> {
    const plan = captureOptionsFor(config)
    if (!plan.enabled) return session
    // Drop captures that already ended (their fetch released them): the set
    // then holds at most the ones live since the previous recorded fetch.
    for (const finished of this.activeRecorders) {
      if (finished.done) this.activeRecorders.delete(finished)
    }
    const openCdp = session.context.newCDPSession?.bind(session.context)
    if (openCdp === undefined) return session
    try {
      const cdp = await openCdp(session.page)
      const recorder = await NetworkRecorder.create({
        session: cdp,
        baseDir: plan.baseDir,
        sessionId: () => this.nextCaptureSessionId(),
        url: fetchUrl,
        backend: config.backend ?? 'local',
        captureBodies: plan.captureBodies,
        maxBodyBytes: plan.maxBodyBytes,
        recordAllResources: plan.recordAllResources,
        onError: (message) => { this.reportCaptureError(message) },
      })
      if (recorder === undefined) {
        // Best-effort by contract: the fetch proceeds unrecorded — but not
        // SILENTLY, or a broken dump path would go unnoticed forever.
        this.reportCaptureError(`could not start a capture session under ${plan.baseDir}`)
        return session
      }
      this.activeRecorders.add(recorder)
      return { ...session, recorder }
    } catch (error: unknown) {
      // Best-effort by contract: the fetch proceeds unrecorded, and the
      // failure is reported as text only (never a header, body, or URL).
      this.reportCaptureError(`could not attach a capture session: ${messageOf(error)}`)
      return session
    }
  }

  /**
   * Open the configured backend and its per-fetch page. Split out so the
   * test suite can substitute a fake browser, and so the recorder can wrap
   * whatever a backend produced.
   * @param config - the resolved settings section.
   * @param deadline - the fetch budget, applied to launch/connect timeouts.
   * @returns the browser session the fetch will use.
   */
  private async openBackendSession(config: ResolvedConfig, deadline: Deadline): Promise<BrowserSession> {
    const timeout = Math.min(deadline.remainingMs(), 20_000)
    // Proxy settings are validated before any launch/connect: an unusable
    // value deserves its own diagnosis rather than being reported as a
    // browser problem. On the CDP backend this value is NOT enforced — see
    // CDP_PROXY_POLICY — it only shapes the launcher command/preview and the
    // explanation in the CDP messages below.
    const proxy = resolveProxyOption(config)
    if (config.backend === 'cdp') {
      // The single policy decision point (CDP_PROXY_POLICY): with the shipped
      // policy this yields nothing and the fetch runs; a `refuse` policy would
      // stop here with WEB_FETCH_PROXY.
      const refusal = cdpProxyRefusal(proxy)
      if (refusal !== undefined) throw refusal
      const endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
      const { source } = await resolveCdpBackend()
      try {
        // One shared connection per provider; this fetch leases a tab — in a
        // throwaway isolated context, or in the remote profile's default
        // context (profile mode), whose persistent logins then apply.
        const lease = await this.cdpPool.acquire(endpoint, timeout, effectiveContextMode(config))
        await installResourceFilter(lease.page)
        return {
          browser: lease.browser,
          context: lease.context,
          page: lease.page,
          sharedBrowser: true,
          persistent: lease.persistent,
        }
      } catch (error: unknown) {
        throw new WebError(
          `cannot connect to the CDP endpoint ${endpoint} (${source}); is the browser started with --remote-debugging-port? Note that ${CDP_PROXY_NOTE}. ${messageOf(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }
    if (config.backend === 'managed') {
      // One persistent browser for the provider's lifetime: `userDataDir`
      // holds the profile, so logins survive across fetches and restarts, and
      // every fetch is a tab in it (never a new browser, never a closed
      // context). headless/args/proxy all belong to the process, so the pool
      // key covers them: editing any of them replaces the browser.
      const launch = managedLaunchFor(config, proxy)
      try {
        const lease = await this.managedPool.acquire(launch, timeout, 'shared')
        await installResourceFilter(lease.page)
        return {
          browser: lease.browser,
          context: lease.context,
          page: lease.page,
          sharedBrowser: true,
          persistent: true,
        }
      } catch (error: unknown) {
        const detail = messageOf(error)
        if (proxy !== undefined) {
          throw new WebError(
            `cannot launch the managed browser through the configured proxy ${redactProxyServer(proxy.server)} (read from the web-fetch-playwright settings section, field proxyServer; the profile is ${launch.userDataDir}): ${redactProxyPassword(detail, proxy)}. Check that the proxy address, bypass list, username, and password are right and reachable — or clear proxyServer for a direct connection.`,
            WEB_FETCH_PROXY_CODE,
            { cause: error },
          )
        }
        throw new WebError(
          `cannot launch the managed persistent browser on ${launch.userDataDir} (${launch.headless ? 'headless' : 'headful'}): ${detail}. Run \`playwright install chromium\`, point the settings path at a playwright/browser executable, or clear the user-data-dir field to use the default profile directory.`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }
    const { chromium, executablePath, source } = await resolvePlaywrightBackend(config.playwrightPath)
    const newContext = (browser: PlaywrightBrowser): (() => Promise<PlaywrightContext>) | undefined => browser.newContext?.bind(browser)
    let browser: PlaywrightBrowser | undefined
    try {
      const args = parseLaunchArgs(config.launchArgs ?? '')
      browser = await chromium.launch({
        headless: effectiveHeadless(config),
        ...(executablePath !== undefined ? { executablePath } : {}),
        // With no proxy configured the key stays absent entirely, so a
        // direct connection is never expressed as a proxy object.
        ...(proxy !== undefined ? { proxy } : {}),
        // Same rule for extra arguments: an empty setting adds no key.
        ...(args.length > 0 ? { args } : {}),
        timeout,
      })
      const create = newContext(browser)
      if (create === undefined) throw new Error('the resolved playwright backend cannot open a browser context')
      const context = await create()
      const page = await context.newPage()
      await installResourceFilter(page)
      return { browser, context, page }
    } catch (error: unknown) {
      // A partial setup (browser launched, then newContext/newPage failed)
      // must not strand the process — closing the browser takes its
      // contexts and pages with it.
      await browser?.close().catch(() => {})
      if (proxy !== undefined) {
        throw new WebError(
          `cannot launch the local browser through the configured proxy ${redactProxyServer(proxy.server)} (read from the web-fetch-playwright settings section, field proxyServer; the browser backend resolved from ${source}): ${redactProxyPassword(messageOf(error), proxy)}. Check that the proxy address, bypass list, username, and password are right and reachable — or clear proxyServer for a direct connection.`,
          WEB_FETCH_PROXY_CODE,
          { cause: error },
        )
      }
      throw new WebError(
        `cannot launch the local browser (${source}); run \`playwright install chromium\` or point the settings path at a playwright/browser executable. ${messageOf(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }

  /**
   * Navigate, settle, and decode one URL inside an open session's tab —
   * waiting out any Cloudflare interstitial within the bounded challenge
   * budget before the final document is read (see the class docs).
   */
  private async retrieve(
    session: BrowserSession,
    url: URL,
    config: ResolvedConfig,
    deadline: Deadline,
  ): Promise<WebFetchResult> {
    const page = session.page
    const challengeWaitMs = effectiveChallengeWaitMs(config)
    // Feature switch: 0 keeps the exact legacy (pre-0.2.5) behavior — the
    // first response decides, no waiting — an escape hatch and the A/B
    // baseline every test proves the bug against.
    const targetsFile = config.targetsFile ?? ''
    // Response tracking is what lets the result describe the document the fetch
    // ends on; targets and consent can both move the browser after the first
    // response, so either of them needs it too.
    const tracksResponses = challengeWaitMs > 0 || config.dismissConsent === true || targetsFile !== ''
    const tracker = tracksResponses ? trackMainFrameResponses(page) : undefined
    // Pages an act opens: the guard leaves the one a target adopts alone (and
    // closes every other), the adopted page's own responses are tracked so the
    // result can describe it, and teardown closes it with the fetch.
    const adopted: PlaywrightPage[] = []
    const adoptedSet = new Set<PlaywrightPage>()
    const openedTrackers = new Map<PlaywrightPage, MainFrameTracker | undefined>()
    const claimPage = (popup: PlaywrightPage): void => {
      if (adoptedSet.has(popup)) return
      adoptedSet.add(popup)
      adopted.push(popup)
      openedTrackers.set(popup, tracksResponses ? trackMainFrameResponses(popup) : undefined)
    }
    guardPopups(page, popup => adoptedSet.has(popup))
    session.adoptedPages = adopted
    let response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
    tracker?.seed(response)

    let challengeEntryResponse: PlaywrightResponse | null = null
    if (challengeWaitMs > 0) {
      let attemptsLeft = effectiveChallengeRetries(config) + 1
      for (;;) {
        const verdict = await this.verdictAfterLoad(page, tracker?.last() ?? response)
        if (verdict === 'blocked') {
          throw new WebError(
            `the site hard-blocked this fetch at its Cloudflare edge (waiting cannot clear it): ${page.url()}`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        if (verdict !== 'challenge') break
        challengeEntryResponse = tracker?.last() ?? response
        const cleared = await this.waitForChallengeClear(page, deadline, challengeWaitMs)
        if (cleared) {
          // The settled document may be the next round of a CHAINED
          // challenge (JS test → Turnstile interstitial): the probe can
          // clear in the gap between rounds, so confirm on the settled
          // DOM. Deliberately content-level — an SPA clear keeps the 403
          // challenge response forever and must still pass here.
          let chained = false
          try { chained = classifyChallengeHtml(await page.content()) === 'challenge' } catch { chained = false }
          if (!chained) break
        }
        if (--attemptsLeft <= 0) {
          const lastStatus = (tracker?.last() ?? response)?.status()
          throw new WebError(
            `the site kept serving a Cloudflare challenge (last status ${lastStatus === undefined ? 'unknown' : String(lastStatus)}) for up to ${String(challengeWaitMs)}ms across ${String(effectiveChallengeRetries(config) + 1)} attempt(s); the browser did not clear it naturally — retry later, raise challengeWaitMs, or use a profile whose browser already holds clearance`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        // Same page, same context — after an expired window OR a chained
        // round: any clearance cookies already earned stay in the jar for
        // this one retry, then everything is torn down as usual.
        response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
        tracker?.seed(response)
      }
    }

    // Final document: the LAST main-frame response when the challenge wait
    // ran (the real page reloads in), else the response goto returned.
    const finalResponse = (challengeWaitMs > 0 ? tracker?.last() : undefined) ?? response
    const kind = classifyContentType(finalResponse?.headers()['content-type'])
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${finalResponse?.headers()['content-type'] ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    // Which target applies is decided before the body is classified, because a
    // target that matched a response this fetch cannot act on must say so rather
    // than be skipped in silence: the early return for non-HTML bodies would
    // otherwise swallow it, which is the "quietly did less" failure this plugin
    // refuses. Choosing is pure, so doing it here costs nothing.
    let selectedTarget: Target | null = null
    if (targetsFile !== '') {
      const loaded = await loadTargets(targetsFile)
      if (!loaded.ok) throw new WebError(loaded.error, WEB_FETCH_TARGET_CODE)
      const selection = selectTarget(loaded.targets, url.toString())
      if (!selection.ok) throw new WebError(selection.error, WEB_FETCH_TARGET_CODE)
      selectedTarget = selection.target
      if (selectedTarget !== null && kind === 'text') {
        throw new WebError(
          `target "${selectedTarget.name}" matched this URL, but the response is ${finalResponse?.headers()['content-type'] ?? 'unknown'}, not a document to act on`,
          WEB_FETCH_TARGET_CODE,
        )
      }
    }

    // The page whose document this fetch will read and describe: the one it
    // navigated to, unless a target step opened another and continued there.
    let documentPage = page
    let finalUrl = page.url()
    // An SPA-style clear swaps the document without navigating: no new
    // response exists to report, so the cleared document reads as served.
    const clearedWithoutNavigation = challengeEntryResponse !== null && finalResponse === challengeEntryResponse
    let statusCode = finalResponse !== null && !clearedWithoutNavigation ? finalResponse.status() : 200
    /**
     * Re-describe the result from the document the browser is actually on.
     *
     * Both a consent click and a target's actions can move the browser after the
     * first response; the settled document is the one about to be read, so its URL
     * and status are the honest ones to report.
     */
    const settledDocument = (): { url: string; statusCode: number } => {
      const settled = (openedTrackers.get(documentPage) ?? tracker)?.last() ?? null
      return settled !== null && settled !== finalResponse
        ? { url: documentPage.url(), statusCode: settled.status() }
        : { url: documentPage.url(), statusCode }
    }

    // Non-HTML decodes straight from the response body; no denoise applies.
    if (kind === 'text') {
      const text = finalResponse !== null ? await finalResponse.text() : await page.content()
      return capResult(finalUrl, statusCode, { kind: 'text', content: text })
    }

    // Best-effort settle for client-rendered content; a timeout just keeps
    // what domcontentloaded already produced.
    await page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})

    // After the settle, not before: a consent manager injects its banner from
    // an async script, so the control usually does not exist yet at
    // domcontentloaded. Opt-in and never load-bearing — a page with no
    // banner, a backend whose page handle has no `evaluate`, and a click that
    // throws all leave the fetch's own outcome alone.
    if (config.dismissConsent === true) {
      const consent = await dismissConsentBanner(page, Math.min(CONSENT_TIMEOUT_MS, deadline.remainingMs()))
      if (consent.problem !== null) {
        console.warn(
          `dsh-web-fetch-playwright: consent banner dismissal problem (the fetch is unaffected): ${consent.problem}`,
        )
      }
      // A full-page consent interstitial stands where the page should be: the
      // click accepts it and the site sends the browser back to the page it
      // interrupted — so the document about to be read is NOT the one this
      // fetch arrived on. Let that navigation land and re-describe the result
      // from the settled document, rather than reporting the interstitial's
      // URL and status next to the accepted page's content.
      if (consent.clicked !== null) {
        await page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})
        const settled = settledDocument()
        finalUrl = settled.url
        statusCode = settled.statusCode
        // "Clicked" is not "done": a gate can ignore the click (measured on
        // booking.com, whose 同意 button does nothing until its own
        // preconditions hold). Reading the gate back as the page would be the
        // silent-wrong-answer this project keeps paying for, so a gate that is
        // still standing ends the fetch loudly instead.
        if (consent.gate && (await isConsentGate(page, Math.min(CONSENT_TIMEOUT_MS, deadline.remainingMs()))) === true) {
          throw new WebError(
            `the consent gate did not clear after accepting it, so the requested page was not reached: ${finalUrl}`,
            WEB_FETCH_CONSENT_CODE,
          )
        }
      }
    }

    // Run the recipe this URL selected. A step that does not hold stops the
    // fetch; the summary line below says what did run.
    let actionSummary: string | null = null
    if (selectedTarget !== null) {
      const outcome = await runTargetActions(page, selectedTarget, {
        remainingMs: () => deadline.remainingMs(),
        claimPage,
      })
      if (!outcome.ok) {
        throw new WebError(
          `target "${selectedTarget.name}" step ${String(outcome.failure.index + 1)} (${outcome.failure.verb}) did not hold: ${outcome.failure.detail} — at ${outcome.failure.url}`,
          WEB_FETCH_ACTION_CODE,
        )
      }
      // A dispatched click can navigate — the recipe's own wait may have been
      // satisfied by the URL alone — so let the navigation land before
      // re-describing the result. Bounded, and only when a click actually went
      // out: a recipe of waits alone must behave exactly as it did before.
      documentPage = outcome.page
      if (outcome.run.clicked) {
        await documentPage.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})
      }
      const settled = settledDocument()
      finalUrl = settled.url
      statusCode = settled.statusCode
      actionSummary = renderActionSummary({ ...outcome.run, finalUrl }, statusCode)
    }

    // Observe mode *is* the fetch: the caller asked for the page's actionable
    // state, so denoised prose would be the wrong answer even though producing
    // it would succeed. Failing loudly when the state cannot be read is the same
    // rule the rest of this file follows.
    if (config.observe === true) {
      const observation = await observePage(documentPage, Math.min(OBSERVE_TIMEOUT_MS, deadline.remainingMs()))
      if (observation === null) {
        throw new WebError(
          'observe mode could not read the page state (the page handle offers no scripting, or the page did not answer)',
          'WEB_PROVIDER_ERROR',
        )
      }
      return capResult(finalUrl, statusCode, { kind: 'text', content: withActionSummary(renderObservation(observation), actionSummary, 'text') })
    }

    const html = await documentPage.content()
    if (!config.denoise) {
      // The tool layer's own turndown renders raw HTML; the checkbox only
      // governs the Readability/DOMPurify stage this provider owns.
      return capResult(finalUrl, statusCode, { kind: 'html', content: withActionSummary(html, actionSummary, 'html') })
    }
    const bounded = boundPipelineInput(html)
    const { markdown } = htmlToMarkdown(bounded.input, finalUrl)
    const result = capResult(finalUrl, statusCode, { kind: 'text', content: withActionSummary(markdown, actionSummary, 'text') })
    return bounded.cut
      ? { ...result, truncated: true }
      : result
  }

  /**
   * Whether the freshly loaded document is a Cloudflare interstitial: the
   * response-level signals first (the documented `cf-mitigated` header, then
   * the 403/503 + cloudflare fallback), then — gated behind
   * {@link isChallengeCompatibleResponse}, because interstitials never ship
   * a plain 200 — the localized title family and structural markers, which
   * also recognize the hard-block page waiting can never clear.
   */
  private async verdictAfterLoad(page: PlaywrightPage, response: PlaywrightResponse | null): Promise<ChallengeVerdict> {
    if (response !== null && classifyChallengeResponse(response.status(), response.headers()) === 'challenge') return 'challenge'
    // Suspicion gate: the content-level fallback only runs on a
    // challenge-compatible response, so a normal article cannot be misread
    // as a challenge no matter what it quotes. A response-less navigation
    // keeps the check — its headers are simply unavailable.
    if (response !== null && !isChallengeCompatibleResponse(response.status(), response.headers())) return 'none'
    // Only HTML documents can be interstitials; classifyContentType already
    // reads a missing content type as html (a response-less navigation).
    if (response === null || classifyContentType(response.headers()['content-type']) === 'html') {
      try {
        return classifyChallengeHtml(await page.content())
      } catch {
        return 'none' // a document we cannot read is not a challenge we can wait on
      }
    }
    return 'none'
  }

  /**
   * The bounded natural wait: poll the live document for challenge markers
   * until they are gone (the user's real browser passed the verification and
   * reloaded into the real page, or swapped it in SPA-style), the per-fetch
   * wait budget runs out, or the fetch's deadline aborts. No clicks, no
   * injected answers — the browser either clears it on its own or it does not.
   *
   * @returns true when the challenge cleared; false when the budget ran out.
   */
  private async waitForChallengeClear(page: PlaywrightPage, deadline: Deadline, challengeWaitMs: number): Promise<boolean> {
    // Keep the settle + decode tail inside the fetch budget: never spend the
    // whole deadline waiting only to time out reading the cleared page.
    const budget = Math.min(challengeWaitMs, deadline.remainingMs() - CHALLENGE_FINISH_RESERVE_MS)
    if (budget <= 0) return false
    const until = Date.now() + budget
    for (;;) {
      if (deadline.signal.aborted) throw new Error('challenge wait aborted')
      if (await probeStillOnChallenge(page)) {
        const remaining = until - Date.now()
        if (remaining <= 0) return false
        await sleep(Math.min(CHALLENGE_POLL_INTERVAL_MS, remaining))
        continue
      }
      // Markers gone: let the fresh document reach domcontentloaded before
      // the caller reads it (the reload may still be committing).
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(deadline.remainingMs(), 2_000) }).catch(() => {})
      return true
    }
  }
}

/** Resolve after `ms` — the bounded wait's inter-poll nap. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Whether a response event belongs to the page's main frame as a document
 * navigation — the filter the challenge wait uses to keep the LAST such
 * response (challenge pages reload the same URL into the real document).
 * Structural members are optional; when the backend does not expose them the
 * check degrades to "looks like a document" so fakes stay usable.
 */
function isMainFrameDocument(response: PlaywrightResponse, page: PlaywrightPage): boolean {
  const request = response.request?.()
  if (request === undefined) return true
  if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) return false
  const resourceType = typeof request.resourceType === 'function' ? request.resourceType() : undefined
  if (resourceType !== undefined && resourceType !== 'document') return false
  if (typeof request.frame === 'function' && typeof page.mainFrame === 'function') {
    return request.frame() === page.mainFrame()
  }
  return true
}

/** The running record of the last main-frame navigation response. */
interface MainFrameTracker {
  /** The most recent main-frame navigation response seen, if any. */
  last(): PlaywrightResponse | null
  /** Pin the tracker to a goto's return (it is that navigation's response). */
  seed(response: PlaywrightResponse | null): void
}

/**
 * Watch the page for main-frame navigation responses so a challenge that
 * reloads into the real document hands the caller THAT response — status,
 * headers — instead of the challenge's. Best-effort: a page without the
 * listener falls back to SPA-style content polling only.
 */
function trackMainFrameResponses(page: PlaywrightPage): MainFrameTracker {
  let last: PlaywrightResponse | null = null
  try {
    page.on?.('response', (response) => {
      if (isMainFrameDocument(response, page)) last = response
    })
  } catch {
    // keep going without response tracking
  }
  return {
    last: () => last,
    seed: (response) => { if (response !== null) last = response },
  }
}

/**
 * Probe the live document for challenge markers. Prefers the in-page probe
 * (`page.evaluate`) — the only thing that can see SPA-style clears — and
 * falls back to reading and classifying the serialized HTML when the backend
 * does not expose evaluate. A probe that throws mid-navigation (execution
 * context destroyed while the challenge reloads) counts as "still on the
 * challenge": the next poll sees the fresh document.
 */
async function probeStillOnChallenge(page: PlaywrightPage): Promise<boolean> {
  if (typeof page.evaluate === 'function') {
    try {
      const verdict = await page.evaluate(CHALLENGE_DOM_PROBE)
      if (typeof verdict === 'boolean') return verdict
    } catch {
      // fall through to the content check
    }
  }
  try {
    return classifyChallengeHtml(await page.content()) !== 'none'
  } catch {
    return true
  }
}

/** Apply the decoded-body cap and flag the cut. */
function capResult(url: string, statusCode: number, body: { kind: 'html' | 'text'; content: string }): WebFetchResult {
  const truncated = body.content.length > MAX_BODY_CHARS
  return {
    url,
    statusCode,
    body: { kind: body.kind, content: truncated ? body.content.slice(0, MAX_BODY_CHARS) : body.content },
    truncated,
  }
}

/**
 * Close a session's fetch-owned tab, then its context unless the context is
 * the remote default context (profile mode — closing it would tear down the
 * whole shared connection), then its browser when the session launched one
 * (local backend). CDP sessions ride the shared connection, which stays
 * open. Every close is grace-bounded so cleanup always completes and the
 * concurrency slot is released even when Playwright hangs.
 */
async function closeSession(session: BrowserSession | undefined): Promise<void> {
  if (session === undefined) return
  // Finish the capture BEFORE the page goes away: the JSONL is already
  // flushed, this writes the HAR while the tab can still answer for a body
  // that is mid-flight. `finish()` is idempotent, so the abort listener and
  // the fetch's own finally may both call it safely.
  if (session.recorder !== undefined) await session.recorder.finish()
  // The pages a target adopted are this fetch's tabs: in profile mode nothing
  // else would close them.
  for (const adopted of session.adoptedPages ?? []) await closeWithGrace(adopted)
  await closeWithGrace(session.page)
  if (session.persistent !== true) await closeWithGrace(session.context)
  if (session.sharedBrowser !== true) await closeWithGrace(session.browser)
}

/** One best-effort `close()` that resolves within the grace period. */
async function closeWithGrace(closeable: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CLOSE_GRACE_MS)
    void closeable.close().then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

/**
 * The real CDP connect the pool runs with: the bundled playwright-core's
 * `connectOverCDP`. Kept as a function (not inline) so the pool constructor
 * stays injectable for tests.
 */
async function defaultCdpConnect(endpoint: string, timeoutMs: number): Promise<PlaywrightBrowser> {
  const { chromium } = await resolveCdpBackend()
  return await chromium.connectOverCDP(endpoint, { timeout: timeoutMs })
}

/**
 * The managed backend's pool wiring: `launchPersistentContext` opens ONE
 * browser over the profile directory, and every lease is a tab in that very
 * context (`shared` mode) — release closes the tab and nothing else, because
 * closing the persistent context would kill the browser and the logins the
 * backend exists to keep. Liveness/`watch` use the context's own `close`
 * signal (`isClosed()`), so a browser the user or the OS killed is relaunched
 * on the next fetch instead of failing every later lease.
 */
const defaultManagedPoolOptions: BrowserPoolOptions<ManagedLaunch, PlaywrightPersistentContext> = {
  open: defaultManagedLaunch,
  keyText: managedLaunchKey,
  acquireContext: handle => ({ context: handle, persistent: true }),
  isLive: handle => handle.isClosed?.() !== true,
  watch: (handle, lost) => { handle.on?.('close', lost) },
}

/**
 * The real managed launch: whichever Playwright serves this plugin, with a
 * PERSISTENT profile directory, the configured headless switch, the resolved
 * proxy, and the extra arguments from `launchArgs`.
 *
 * @param launch - the resolved launch descriptor (also the pool's key).
 * @param timeoutMs - launch budget.
 * @returns the persistent context the pool keeps alive.
 */
async function defaultManagedLaunch(launch: ManagedLaunch, timeoutMs: number): Promise<PlaywrightPersistentContext> {
  const { chromium, executablePath } = await resolvePlaywrightBackend(launch.playwrightPath)
  return await chromium.launchPersistentContext(launch.userDataDir, {
    headless: launch.headless,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(launch.proxy !== undefined ? { proxy: launch.proxy } : {}),
    ...(launch.args.length > 0 ? { args: launch.args } : {}),
    timeout: timeoutMs,
  })
}

/**
 * Abort image/font/media subrequests: the markdown output keeps their URLs
 * but never renders them, so downloading them only spends the budget.
 * Installed on the PAGE (never the context): in profile mode a context-level
 * route would intercept the remote browser's other tabs too. Best-effort —
 * a page that refuses interception still fetches.
 */
async function installResourceFilter(owner: {
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
}): Promise<void> {
  try {
    await owner.route('**/*', async (route) => {
      const type = route.request().resourceType()
      if (type === 'image' || type === 'font' || type === 'media') await route.abort()
      else await route.continue()
    })
  } catch {
    // keep going without the filter
  }
}

/**
 * Close any popup a fetched page spawns so nothing outlives the fetch's tab
 * — `page.close()` does not auto-close windows the page opened, and in
 * profile mode a stray tab would stay in the user's remote browser.
 * Best-effort: a page that refuses listeners just loses the guard.
 */
function guardPopups(page: PlaywrightPage, isClaimed?: (popup: PlaywrightPage) => boolean): void {
  try {
    page.on?.('popup', popup => {
      if (isClaimed === undefined) {
        void popup.close().catch(() => {})
        return
      }
      // A target may adopt this page: the step's waiter is a listener on the
      // same event, registered after this one, so the close waits a tick for
      // that claim. A page nobody claims is still closed, exactly as before.
      setTimeout(() => {
        if (isClaimed(popup)) return
        void popup.close().catch(() => {})
      }, 0)
    })
  } catch {
    // keep going without the guard
  }
}
