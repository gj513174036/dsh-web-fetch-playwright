/**
 * The P2 network recorder: ONE CDP session per fetch, attached to the tab that
 * fetch opened, silently capturing the XHR/Fetch/WebSocket traffic of that
 * fetch — URL, method, headers, request payload, response status/headers/body,
 * and WebSocket frames — to disk as it happens.
 *
 * Scope is deliberately narrow (a product decision, not an accident): the
 * session rides a single page, so nothing here calls `Target.setAutoAttach`
 * and nothing observes another tab of a shared browser. What a fetch opened is
 * what gets recorded.
 *
 * Output, under one session directory:
 *
 * - `network.jsonl` — one JSON object per line, appended AS EVENTS ARRIVE, so
 *   a capture in progress is readable without waiting for the fetch to end.
 *   Line kinds (`kind`), and the fields `tools/netdump` reads off them:
 *   - `session` — the header, first line: `fetchUrl`, `backend`, `dir`, the
 *     capture knobs. Deliberately carries NO top-level `url`, so a consumer
 *     that treats "a line with a url" as traffic cannot mistake it for an
 *     exchange;
 *   - `request` — `requestId`, `url`, `method`, `headers`, `postData`,
 *     `resourceType`;
 *   - `response` — `requestId`, `url`, `status`, `statusText`, `mimeType`,
 *     `headers`;
 *   - `responseBody` — `requestId`, `body`, `base64Encoded`, `bodyTruncated`,
 *     `bodyBytes` (only when `captureBodies` read one);
 *   - `finished` — `requestId`, `url`, `status`, `mimeType`, `durationMs`
 *     (plus the body SIZES, never the body again);
 *   - `failed` — `requestId`, `url`, `errorText`, `canceled`;
 *   - `requestExtra` / `responseExtra` — `requestId`, `url`, the AUTHORITATIVE
 *     `headers` set from CDP's ExtraInfo events (plus the associated cookies),
 *     and `hop` (which hop of that `requestId` it belongs to). Pairing is by
 *     hop — index among that requestId's extras against index among its base
 *     events, Playwright's own rule — NOT by "the exchange currently in
 *     flight", because a redirect reuses the requestId and CDP does not
 *     promise that a hop's ExtraInfo arrives after that hop's base event.
 *     A slot whose base event never arrives is flushed after
 *     {@link DEFAULT_EXTRA_HOLD_MS} and marked `unclaimed` (no `url`), while a
 *     requestId the static filter dropped never produces a line at all;
 *   - `websocketCreated` / `websocketFrame` / `websocketClosed` — `requestId`,
 *     `url`, and for a frame `direction` (`sent`/`received`), `opcode`,
 *     `payloadData`;
 *   every line also carries `at` (epoch ms) plus `wallTime`/`timestamp`
 *   (epoch seconds, the spelling CDP itself uses);
 * - `har.json` — the HAR 1.2 export written when the fetch ends (normal,
 *   thrown, or aborted — all three go through {@link NetworkRecorder.finish}).
 *   A single unconvertible record degrades to its own entry instead of costing
 *   the document, and a failed write is reported (never silently dropped).
 *
 * The session directory is claimed with a non-recursive `mkdir` under the base
 * directory ({@link allocateCaptureDirectory}), so two captures can never share
 * a dump; `maxBodyBytes: 0` means NO CAP (the whole body is stored) — see
 * {@link truncateBody}.
 *
 * Credentials are stored VERBATIM (`Cookie`, `Set-Cookie`, `Authorization`,
 * bodies). Protection is filesystem-level and explicit: the directory is mode
 * 0700, every file 0600, the default location is `<cwd>/net-dumps/<session>`
 * (gitignored by this repository), and the README plus the settings card warn
 * that the dumps contain plaintext credentials.
 *
 * Recording is BEST-EFFORT throughout: no failure here — a CDP error, a
 * missing domain, an unwritable directory, a malformed event — may ever fail
 * the fetch. Every step swallows its error into {@link NetworkRecorder.report}.
 *
 * @module dsh-web-fetch-playwright/recorder
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CdpSession } from './types.ts'
import { buildHar, cookiesFromHeader, type HarCookie, type RecordedHttpExchange, type RecordedWebSocket } from './har.ts'

/** The dump file holding the live JSONL event stream. */
export const NETWORK_JSONL_FILE = 'network.jsonl'

/** The HAR 1.2 export written when the capture ends. */
export const HAR_FILE = 'har.json'

/** Directory mode for a session dump: owner-only. */
export const DUMP_DIR_MODE = 0o700

/** File mode for every dump file: owner-only. */
export const DUMP_FILE_MODE = 0o600

/**
 * CDP resource types dropped by default: they are noise for the offline API
 * extraction the dump exists for, and they dominate the volume. `recordAll`
 * keeps them.
 */
export const STATIC_RESOURCE_TYPES = ['image', 'font', 'media', 'stylesheet'] as const

/** Whether a CDP resource type is one of the static ones dropped by default. */
export function isStaticResource(resourceType: string | undefined): boolean {
  if (resourceType === undefined || resourceType === '') return false
  return (STATIC_RESOURCE_TYPES as readonly string[]).includes(resourceType.toLowerCase())
}

/**
 * Cut a body/payload to `maxBytes`, reporting whether it was cut.
 *
 * Byte-accurate for text (the slice is measured in UTF-8 bytes; a multi-byte
 * character straddling the cut is replaced by the decoder, which is the honest
 * representation of a truncated byte stream). For base64 the STORED string is
 * kept at or below the cap too — rounded down to a 4-character boundary so the
 * remainder still decodes — so `maxBodyBytes` bounds both the stored text and
 * the decoded payload.
 *
 * @param body - the raw body as CDP returned it.
 * @param base64 - true when `body` is base64-encoded.
 * @param maxBytes - the cap; a non-positive or non-finite cap means "no cap".
 * @returns the stored body plus the truncation facts.
 */
export function truncateBody(body: string, base64: boolean, maxBytes: number): { body: string; truncated: boolean; bytes: number } {
  const bytes = byteLength(body, base64)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) return { body, truncated: false, bytes }
  if (base64) {
    // ≤ maxBytes characters AND 4-aligned: both the stored string and the
    // decoded payload stay within the cap.
    const keep = Math.max(0, Math.floor(maxBytes / 4) * 4)
    return { body: body.slice(0, keep), truncated: true, bytes }
  }
  return { body: Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true, bytes }
}

/** The decoded byte length of a body (base64 is measured after decoding). */
function byteLength(body: string, base64: boolean): number {
  if (!base64) return Buffer.byteLength(body, 'utf8')
  // A truncated base64 string may pad oddly; the length is an estimate then,
  // which is exactly what `bodyBytes` reports.
  return Math.floor((body.length * 3) / 4)
}

/** The options one capture session runs with. */
export interface RecorderOptions {
  /** The CDP session, already attached to the fetch's page. */
  session: CdpSession
  /**
   * The BASE directory the capture allocates its own session directory under:
   * `<baseDir>/<sessionId>`, where the id comes from {@link RecorderOptions.sessionId}.
   * The default base is `<cwd>/net-dumps` (settings `recordDir` overrides it),
   * so the basename of a default dump path is always `net-dumps`.
   */
  baseDir: string
  /**
   * Allocates the session id (the dump directory's basename). The default is
   * {@link nextCaptureSessionId}, which is collision-resistant even when two
   * allocations share a clock tick; {@link allocateCaptureDirectory} still
   * retries on an existing directory, so a re-used id cannot silently merge
   * two captures.
   */
  sessionId?: () => string
  /** The fetch URL this session belongs to (recorded in the header line). */
  url: string
  /** Backend label for the header line (`local`/`cdp`/`managed`). */
  backend?: string
  /** Fetch response bodies through `Network.getResponseBody`. */
  captureBodies: boolean
  /** Byte cap applied to bodies and frame payloads. */
  maxBodyBytes: number
  /** Keep image/font/media/stylesheet records instead of dropping them. */
  recordAllResources: boolean
  /** Clock, injectable for deterministic tests. */
  now?: () => number
  /**
   * How long an ExtraInfo slot whose base event never arrived is held before
   * its JSONL line is flushed anyway (ms). Short windows keep the stream live;
   * a base event that DOES arrive inside the window still owns the slot, and a
   * base event that shows the resource was dropped as static discards it
   * without a line ever being written.
   */
  extraHoldMs?: number
  /**
   * Where a swallowed recorder error is reported (diagnostics only — the
   * fetch never sees it). Absent = collected in {@link NetworkRecorder.report}.
   */
  onError?: (message: string) => void
}

/** What a finished capture produced. */
export interface RecorderReport {
  /** The session dump directory. */
  dir: string
  /** Absolute path of the JSONL event stream. */
  jsonlPath: string
  /** Absolute path of the HAR export. */
  harPath: string
  /** Recorded XHR/Fetch exchanges (after the static-resource filter). */
  httpCount: number
  /** Recorded WebSocket connections. */
  webSocketCount: number
  /** Recorded WebSocket frames. */
  frameCount: number
  /** Swallowed failures, for diagnostics — never surfaced as a fetch error. */
  errors: string[]
}

/** One recorded event line in the JSONL stream. */
export type RecordedEvent = Record<string, unknown>

/**
 * How long an ExtraInfo slot whose base event never showed up is held before
 * its line is flushed anyway. Short on purpose: the JSONL is meant to be
 * readable while the fetch runs, and a base event either arrives promptly or
 * never does.
 */
export const DEFAULT_EXTRA_HOLD_MS = 250

/**
 * One ExtraInfo event, parked until the hop it belongs to is known. The INDEX
 * is its position among its requestId's extras of the same kind, which is how
 * it is paired with a hop (see {@link NetworkRecorder}).
 */
interface ExtraSlot {
  /** `0` for the first extra of this requestId, `1` for the redirect hop, … */
  index: number
  /** `request` for `requestWillBeSentExtraInfo`, `response` for the response side. */
  kind: 'request' | 'response'
  /** The authoritative header set (with a synthesized `cookie` when needed). */
  headers: Record<string, string>
  /** Cookies decoded from `associatedCookies` (request) or `Set-Cookie` (response). */
  cookies: HarCookie[]
  /** Response extras only: the status from `responseReceivedExtraInfo`. */
  status?: number
  /** Epoch milliseconds of arrival. */
  at: number
  /** Request extras only: the `:path` pseudo-header, for hop matching. */
  path?: string
  /** Request extras only: the `:authority` pseudo-header. */
  authority?: string
  /** True once a hop took it (or the hold window flushed it). */
  claimed?: boolean
  /** The hop index it was claimed for (absent while unclaimed). */
  hop?: number
}

/**
 * Whether an ExtraInfo slot IDENTIFIES a hop: its `:path` and `:authority`
 * pseudo-headers (which Chrome sends on `requestWillBeSentExtraInfo`) name the
 * same target as the hop's base-event URL, and its `:method` agrees when the
 * extra carries one.
 *
 * Both pseudo-headers are REQUIRED: with only one of them a redirect chain
 * inside a single host is ambiguous, and an ambiguous identity must fall back
 * to the index rule rather than guess.
 *
 * @param extra - the ExtraInfo slot's header set.
 * @param hop - the base-event exchange to test against.
 * @returns true when the extra is unambiguously about that hop's request.
 */
export function extraMatchesHop(
  extra: { headers: Record<string, string> },
  hop: { url: string; method: string },
): boolean {
  const path = extra.headers[':path']
  const authority = extra.headers[':authority']
  if (path === undefined || authority === undefined) return false
  let parsed: URL
  try {
    parsed = new URL(hop.url)
  } catch {
    return false
  }
  if (authority.toLowerCase() !== parsed.host.toLowerCase()) return false
  // Chrome's `:path` is the request target: path plus query.
  const target = `${parsed.pathname}${parsed.search}`
  if (path !== target && path !== parsed.pathname) return false
  const method = extra.headers[':method']
  if (method !== undefined && method.toLowerCase() !== hop.method.toLowerCase()) return false
  return true
}

/**
 * The response-side identity: a `responseReceivedExtraInfo` reports the status
 * of the response it belongs to (the `statusCode` param, or Chrome's `:status`
 * pseudo-header), so it identifies the hop whose own response has that status.
 * Response headers carry no path, which is why the status is the only identity
 * available on that side.
 *
 * @param extra - the response ExtraInfo slot.
 * @param hop - the base-event exchange (status known once `responseReceived`
 *   arrived, or immediately for a redirect hop).
 * @returns true when the extra is unambiguously about that hop's response.
 */
export function responseExtraMatchesHop(
  extra: { status?: number; headers: Record<string, string> },
  hop: RecordedHttpExchange,
): boolean {
  const status = extra.status ?? statusFromHeaders(extra.headers)
  return status !== undefined && hop.status === status
}

/** The `:status` pseudo-header of a response ExtraInfo header set, if any. */
function statusFromHeaders(headers: Record<string, string>): number | undefined {
  const raw = headers[':status']
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * One requestId's hop slots: base-event hops plus the ExtraInfo they claim.
 *
 * PAIRING RULE (identity first): an ExtraInfo slot is placed on the hop whose
 * own request/response it NAMES — `:path` + `:authority` (plus `:method` when
 * present) for a request slot, the reported status for a response slot. That is
 * what makes pairing survive the case CDP explicitly allows
 * (`protocol.d.ts`: "Not every requestWillBeSent event will have an additional
 * requestWillBeSentExtraInfo fired for it"): a cached redirect hop with no
 * ExtraInfo of its own no longer steals the next hop's credentials.
 *
 * COVERED, verified against synthetic CDP event streams (the suite drives the
 * canonical, "next hop's extra first", and "this hop's extra after the
 * redirect" orders, plus a hop that has no extra at all):
 *  - every hop has its own extra, in any arrival order relative to its base event;
 *  - a hop has NO extra (a cached 301), and the next hop's extra still lands on
 *    the next hop;
 *  - a response extra that arrives before its hop's `responseReceived` is held
 *    and placed once that hop's status is known.
 *
 * FALLBACK (and its limits): when a slot carries no usable identity (no
 * `:path`/`:authority`, or no status — a minimal CDP implementation or a
 * synthetic event) or several hops match it equally, the arrival index decides
 * ("the Nth extra of a requestId belongs to its Nth hop", Playwright's own
 * rule). That is correct only while every earlier hop of that requestId
 * produced its own extra of the same kind; with an omission it can be off by
 * the number of omissions.
 *
 * NOT COVERED (explicit exceptions): a hop's extra arriving AFTER a LATER hop's
 * extra while both carry no usable identity — nothing in the event names its
 * hop, so the two are locally indistinguishable (Playwright has the same
 * limitation); and a response extra whose status never matches any hop stays
 * unclaimed and is flushed as `unclaimed` after the hold window. Neither order
 * could be reproduced against a real browser in this environment (no launchable
 * Chromium), so these are documented limits, not verified behavior.
 */
interface HopSlots {
  /** The base-event exchanges of this requestId, in hop order. */
  hops: RecordedHttpExchange[]
  /** Request ExtraInfo slots, in arrival order (index ↔ hop index). */
  requestExtras: ExtraSlot[]
  /** Response ExtraInfo slots, in arrival order (index ↔ hop index). */
  responseExtras: ExtraSlot[]
}

/**
 * A capture session over one page's CDP session. Create it with
 * {@link NetworkRecorder.create}, end it with {@link NetworkRecorder.finish}.
 */
export class NetworkRecorder {
  private readonly errors: string[] = []
  /** Exchanges still in flight, keyed by CDP `requestId`. */
  private readonly http = new Map<string, RecordedHttpExchange>()
  /**
   * Every exchange this capture recorded, in the order its request started.
   * This is the HAR's entry list (a redirect hop lands here as its own record,
   * and a still-in-flight exchange is exported too when the fetch is torn
   * down), so the export order never depends on completion timing.
   */
  private readonly recorded: RecordedHttpExchange[] = []
  private readonly skipped = new Set<string>()
  private readonly sockets = new Map<string, RecordedWebSocket>()
  /**
   * Per-requestId HopSlots: the base-event hops in order, plus the ExtraInfo
   * slots in order. Pairing is BY INDEX (Playwright's own
   * `ResponseExtraInfoTracker` does the same with three parallel arrays) — NOT
   * by "whatever exchange is in flight", which misattributes the next hop's
   * early ExtraInfo to the hop that is still open on a redirect.
   */
  private readonly slots = new Map<string, HopSlots>()
  /** ExtraInfo that arrived before its hop existed, awaiting (or holding) a claim. */
  private readonly heldExtras: ExtraSlot[] = []
  private holdTimer: ReturnType<typeof setTimeout> | undefined
  private finished: Promise<RecorderReport> | undefined
  private writes: Promise<void> = Promise.resolve()
  private stopped = false

  private constructor(
    private readonly options: RecorderOptions,
    /** The session directory this capture claimed (base + session id). */
    readonly dir: string,
  ) {}

  /**
   * Start a capture: create the session directory (0700), write the header
   * line, enable the Network domain, and subscribe to the events. Never
   * throws — an unusable session/directory yields `undefined`, and any later
   * failure is swallowed into the report.
   *
   * @param options - the session, its directory, and the capture knobs.
   * @returns the recorder, or undefined when recording cannot start at all.
   */
  static async create(options: RecorderOptions): Promise<NetworkRecorder | undefined> {
    // The base directory is created recursively (it may be nested); the SESSION
    // directory is then claimed with a non-recursive mkdir, so an existing one
    // is an EEXIST we can see and retry instead of silently merging two
    // captures into one dump.
    try {
      await mkdir(options.baseDir, { recursive: true, mode: DUMP_DIR_MODE })
    } catch (error: unknown) {
      return undefined
    }
    const dir = await allocateCaptureDirectory(options.baseDir, options.sessionId ?? nextCaptureSessionId)
    if (dir === undefined) return undefined
    const recorder = new NetworkRecorder(options, dir)
    // The header goes FIRST (before subscribing, so no event can precede it):
    // a reader/parser of a capture in progress always knows what the stream is.
    recorder.append({
      kind: 'session',
      ...recorder.stamps(recorder.now()),
      // NOT `url`: a line with a top-level url reads as traffic to consumers
      // that accept flat records (tools/netdump does), and the header is not
      // an exchange.
      fetchUrl: options.url,
      backend: options.backend,
      dir,
      captureBodies: options.captureBodies,
      maxBodyBytes: options.maxBodyBytes,
      recordAllResources: options.recordAllResources,
      staticResourceTypes: [...STATIC_RESOURCE_TYPES],
    })
    recorder.subscribe()
    try {
      // Network.enable with generous buffers: the extractor wants whole
      // bodies, and CDP otherwise trims its own resource buffer. Enabling can
      // synchronously deliver events already buffered for this session, which
      // is why the header is written before it.
      await options.session.send('Network.enable', {
        maxPostDataSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024,
        maxTotalBufferSize: 100 * 1024 * 1024,
      })
    } catch (error: unknown) {
      recorder.note(`Network.enable failed: ${describe(error)}`)
    }
    return recorder
  }

  /** Absolute path of the JSONL event stream. */
  get jsonlPath(): string {
    return join(this.dir, NETWORK_JSONL_FILE)
  }

  /** Absolute path of the HAR export. */
  get harPath(): string {
    return join(this.dir, HAR_FILE)
  }

  /**
   * End the capture: stop accepting events, await every pending append, then
   * export the HAR 1.2 document. Idempotent — concurrent callers (the fetch
   * teardown and the abort listener) share one completion — and it never
   * throws; check the report's `errors` instead.
   *
   * @returns what the capture produced.
   */
  async finish(): Promise<RecorderReport> {
    if (this.finished !== undefined) return await this.finished
    this.finished = this.complete()
    return await this.finished
  }

  /** Whether this recorder has already ended (its HAR is written/being written). */
  get done(): boolean {
    return this.finished !== undefined
  }

  private async complete(): Promise<RecorderReport> {
    this.stopped = true
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    // Anything still on hold has no hop to belong to: flush it (unless its
    // requestId was dropped as static) so the stream is not silently short.
    this.flushHeldExtras()
    await this.settleWrites()
    const report: RecorderReport = {
      dir: this.dir,
      jsonlPath: this.jsonlPath,
      harPath: this.harPath,
      httpCount: this.recorded.length,
      webSocketCount: this.sockets.size,
      frameCount: [...this.sockets.values()].reduce((total, socket) => total + socket.frames.length, 0),
      errors: [...this.errors],
    }
    try {
      // Every recorded exchange — completed, failed, a redirect hop, or still
      // in flight when the fetch was torn down — in request order.
      const har = buildHar({ http: [...this.recorded], webSockets: [...this.sockets.values()] })
      await writeFile(this.harPath, `${JSON.stringify(har, null, 2)}\n`, { mode: DUMP_FILE_MODE })
    } catch (error: unknown) {
      this.note(`writing ${HAR_FILE} failed: ${describe(error)}`)
      report.errors = [...this.errors]
    }
    try {
      await this.options.session.detach?.()
    } catch {
      // a detach that fails is not worth reporting: the page is going away
    }
    return report
  }

  /** Subscribe to the Network domain events this recorder reduces. */
  private subscribe(): void {
    const session = this.options.session
    const on = (event: string, listener: (params: Record<string, unknown>) => void): void => {
      try {
        session.on(event, params => {
          if (this.stopped || params === null || typeof params !== 'object') return
          try {
            listener(params)
          } catch (error: unknown) {
            this.note(`${event} handler failed: ${describe(error)}`)
          }
        })
      } catch (error: unknown) {
        this.note(`subscribing to ${event} failed: ${describe(error)}`)
      }
    }
    on('Network.requestWillBeSent', params => { this.onRequest(params) })
    on('Network.requestWillBeSentExtraInfo', params => { this.onRequestExtra(params) })
    on('Network.responseReceived', params => { this.onResponse(params) })
    on('Network.responseReceivedExtraInfo', params => { this.onResponseExtra(params) })
    on('Network.loadingFinished', params => { void this.onFinished(params) })
    on('Network.loadingFailed', params => { this.onFailed(params) })
    on('Network.webSocketCreated', params => { this.onSocketCreated(params) })
    on('Network.webSocketFrameSent', params => { this.onSocketFrame(params, 'sent') })
    on('Network.webSocketFrameReceived', params => { this.onSocketFrame(params, 'received') })
    on('Network.webSocketClosed', params => { this.onSocketClosed(params) })
  }

  /**
   * `Network.requestWillBeSent`: start an exchange (or drop it as static).
   *
   * A redirect hop arrives as a new `requestWillBeSent` for the SAME
   * `requestId` carrying `redirectResponse` (the hop that just happened). The
   * in-flight exchange is finalized FIRST — with that hop's status/headers/mime
   * — and emitted as its own `response`/`finished` pair, so a 301→200 chain
   * yields TWO HAR entries instead of one entry that looks like it went
   * straight to the destination. The new request line carries the
   * `redirectResponse` too, which is exactly the shape the offline pipeline
   * uses to backfill a hop.
   */
  private onRequest(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    const request = record(params['request'])
    if (requestId === '' || request === undefined) return
    const resourceType = text(params['type']) || undefined
    const redirectResponse = record(params['redirectResponse'])
    if (!this.options.recordAllResources && isStaticResource(resourceType)) {
      this.skipped.add(requestId)
      return
    }
    if (redirectResponse !== undefined) this.finalizeRedirect(requestId, redirectResponse)
    const slots = this.slotsFor(requestId)
    const exchange: RecordedHttpExchange = {
      requestId,
      startedAtMs: this.now(),
      ...(resourceType === undefined ? {} : { resourceType }),
      method: text(request['method']) || 'GET',
      url: text(request['url']),
      // The ExtraInfo set for THIS hop is authoritative when it is known; the
      // base event's headers are the fallback until (or unless) it arrives.
      requestHeaders: headers(request['headers']),
      ...(typeof request['postData'] === 'string' ? { postData: request['postData'] } : {}),
    }
    const hopIndex = slots.hops.length
    slots.hops.push(exchange)
    // A hop that starts NOW may already have its ExtraInfo on hold (CDP does
    // not promise which of the two arrives first) — claim it for this hop.
    this.claimHeldExtra(requestId, hopIndex, 'request')
    this.http.set(requestId, exchange)
    this.recorded.push(exchange)
    this.append({
      kind: 'request',
      ...this.stamps(exchange.startedAtMs),
      requestId,
      url: exchange.url,
      method: exchange.method,
      resourceType: exchange.resourceType,
      headers: exchange.requestHeaders,
      postData: exchange.postData,
      ...(redirectResponse === undefined ? {} : { redirectResponse: redirectShape(redirectResponse) }),
    })
  }

  /**
   * Close a redirect hop as its own entry: the hop's response becomes a
   * complete `RecordedHttpExchange` (status/headers/mimeType + the moment it
   * finished) and both the in-flight map and a `response`/`finished` line pair
   * are settled before the redirected request starts.
   */
  private finalizeRedirect(requestId: string, redirectResponse: Record<string, unknown>): void {
    const hop = this.http.get(requestId)
    if (hop === undefined) return
    // The hop keeps the ExtraInfo already claimed for it: the index pairing
    // never wrote a later hop's set into this record.
    const shape = redirectShape(redirectResponse)
    if (shape.status !== undefined) hop.status = shape.status
    if (shape.statusText !== undefined) hop.statusText = shape.statusText
    if (shape.mimeType !== undefined) hop.mimeType = shape.mimeType
    hop.responseHeaders = shape.headers
    hop.finishedAtMs = this.now()
    // This hop's status is known NOW, so a response ExtraInfo that arrived
    // early (held, because no hop had that status yet) can finally be placed
    // on this hop by identity.
    const slots = this.slots.get(requestId)
    const hopIndex = slots?.hops.indexOf(hop) ?? -1
    if (slots !== undefined && hopIndex !== -1 && !this.hopHasExtra(slots, 'response', hopIndex)) {
      const queued = slots.responseExtras[hopIndex]
      if (queued !== undefined && queued.claimed !== true) this.claimExtra(requestId, queued, hop, hopIndex)
      else this.claimHeldExtra(requestId, hopIndex, 'response')
    }
    this.append({
      kind: 'response',
      ...this.stamps(hop.finishedAtMs),
      requestId,
      url: hop.url,
      status: hop.status,
      statusText: hop.statusText,
      mimeType: hop.mimeType,
      headers: hop.responseHeaders,
      redirect: true,
    })
    this.append({
      kind: 'finished',
      ...this.stamps(hop.finishedAtMs),
      requestId,
      url: hop.url,
      status: hop.status,
      mimeType: hop.mimeType,
      durationMs: hop.finishedAtMs - hop.startedAtMs,
      redirect: true,
    })
    this.http.delete(requestId)
  }

  /**
   * `Network.requestWillBeSentExtraInfo`: the authoritative request
   * headers/cookies for ONE hop.
   *
   * The slot is indexed by arrival among this requestId's request extras, and
   * claimed when a hop with that index exists — so an extra that arrives
   * BEFORE its own hop (the redirect race) is held, not written into the hop
   * that happens to be open. Claiming is also what writes the JSONL line, so a
   * requestId the static filter drops never leaves an orphan line behind.
   */
  private onRequestExtra(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    if (requestId === '') return
    // Known-static: the base event already decided this resource is dropped.
    if (this.skipped.has(requestId)) return
    const extraHeaders = headers(params['headers'])
    const cookies = associatedCookies(params['associatedCookies'])
    if (Object.keys(extraHeaders).length === 0 && cookies.length === 0) return
    // CDP's extra-info headers are the complete set the browser sent, including
    // the cookies it attached; the base event is frequently missing them.
    const cookieHeader = cookieHeaderFor(extraHeaders, cookies)
    const merged = cookieHeader === undefined ? extraHeaders : { ...extraHeaders, cookie: cookieHeader }
    const slots = this.slotsFor(requestId)
    const slot: ExtraSlot = {
      kind: 'request',
      index: slots.requestExtras.length,
      headers: merged,
      cookies,
      at: this.now(),
    }
    const path = merged[':path']
    if (path !== undefined) slot.path = path
    const authority = merged[':authority']
    if (authority !== undefined) slot.authority = authority
    slots.requestExtras.push(slot)
    const target = this.hopForExtra(slots, slot)
    if (target === undefined) {
      // Its hop is not known yet (the next redirect hop, or a hop whose base
      // event never comes): hold it, and start the flush window.
      this.heldExtras.push(slot)
      this.armHoldTimer()
      return
    }
    this.claimExtra(requestId, slot, slots.hops[target] as RecordedHttpExchange, target)
  }

  /** `Network.responseReceivedExtraInfo`: authoritative response headers/status. */
  private onResponseExtra(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    if (requestId === '') return
    if (this.skipped.has(requestId)) return
    const extraHeaders = headers(params['headers'])
    const statusCode = typeof params['statusCode'] === 'number' ? params['statusCode'] : undefined
    if (Object.keys(extraHeaders).length === 0 && statusCode === undefined) return
    const cookies = cookieHeaders(extraHeaders, ['set-cookie', 'Set-Cookie'])
    const slots = this.slotsFor(requestId)
    const slot: ExtraSlot = {
      kind: 'response',
      index: slots.responseExtras.length,
      headers: extraHeaders,
      cookies,
      at: this.now(),
      ...(statusCode === undefined ? {} : { status: statusCode }),
    }
    slots.responseExtras.push(slot)
    const target = this.hopForExtra(slots, slot)
    if (target === undefined) {
      this.heldExtras.push(slot)
      this.armHoldTimer()
      return
    }
    this.claimExtra(requestId, slot, slots.hops[target] as RecordedHttpExchange, target)
  }

  /**
   * Which hop an ExtraInfo slot belongs to, in priority order:
   *
   *  1. IDENTITY — `:path` + `:authority` naming exactly one hop whose own
   *     request/response has not claimed an extra yet (response slots use the
   *     status instead). This is the only rule that survives a hop WITHOUT an
   *     ExtraInfo event of its own, which CDP explicitly allows
   *     (`protocol.d.ts`: "Not every requestWillBeSent event will have an
   *     additional requestWillBeSentExtraInfo fired for it") — a cached
   *     redirect hop typically has none.
   *  2. INDEX — the slot's arrival index, used only when identity is
   *     unavailable: the extra carries no usable pseudo-header (a minimal
   *     CDP implementation or a synthetic event), or several hops match it
   *     equally. The index rule is correct exactly while every earlier hop of
   *     that requestId produced its own extra of the same kind; if one was
   *     omitted, the index rule can be off by the number of omissions — which
   *     is why it is the fallback and not the primary rule.
   *
   * @param slots - the requestId's hop slots.
   * @param slot - the ExtraInfo slot to place.
   * @returns the hop index, or undefined when the slot must be held.
   */
  private hopForExtra(slots: HopSlots, slot: ExtraSlot): number | undefined {
    const candidates = this.hopIndexesByIdentity(slots, slot)
    if (candidates.length === 1) return candidates[0]
    if (candidates.length === 0 && this.hasUsableIdentity(slot)) {
      // The extra NAMES a target no hop has yet — it belongs to a hop that has
      // not started (the next redirect hop). Hold it: the index fallback would
      // hand it to the hop currently at that index, which is the very
      // misattribution this pairing exists to prevent.
      return undefined
    }
    // Fallback (see above): the arrival index, when that hop exists and has
    // not claimed an extra of this kind yet. Reached only when the identity is
    // unusable (no pseudo-headers at all) or ambiguous (several hops match).
    const indexed = slots.hops[slot.index]
    if (indexed !== undefined && !this.hopHasExtra(slots, slot.kind, slot.index)) return slot.index
    return undefined
  }

  /** Whether a slot carries enough to identify a hop at all. */
  private hasUsableIdentity(slot: ExtraSlot): boolean {
    if (slot.kind === 'request') return slot.headers[':path'] !== undefined && slot.headers[':authority'] !== undefined
    return (slot.status ?? statusFromHeaders(slot.headers)) !== undefined
  }

  /** Every still-unclaimed hop an ExtraInfo slot identifies, in hop order. */
  private hopIndexesByIdentity(slots: HopSlots, slot: ExtraSlot): number[] {
    const candidates: number[] = []
    for (let index = 0; index < slots.hops.length; index++) {
      const hop = slots.hops[index]
      if (hop === undefined || this.hopHasExtra(slots, slot.kind, index)) continue
      const matches = slot.kind === 'request' ? extraMatchesHop(slot, hop) : responseExtraMatchesHop(slot, hop)
      if (matches) candidates.push(index)
    }
    return candidates
  }

  /** Whether a hop already holds an ExtraInfo slot of this kind. */
  private hopHasExtra(slots: HopSlots, kind: 'request' | 'response', hopIndex: number): boolean {
    const list = kind === 'request' ? slots.requestExtras : slots.responseExtras
    return list.some(candidate => candidate.hop === hopIndex)
  }

  /**
   * Claim a held slot for the hop that has just appeared, identity first: a
   * held extra whose `:path`/`:authority` names THIS hop is its own, even when
   * an earlier hop produced no extra at all. Only when no held slot identifies
   * it does the arrival index decide (see {@link hopForExtra} for the fallback's
   * exact applicability).
   */
  private claimHeldExtra(requestId: string, hopIndex: number, kind: 'request' | 'response'): ExtraSlot | undefined {
    const slots = this.slots.get(requestId)
    const hop = slots?.hops[hopIndex]
    if (slots === undefined || hop === undefined) return undefined
    const owned = this.heldExtras.filter(slot => !slot.claimed && slot.kind === kind && this.ownerOf(slot) === requestId)
    const byIdentity = owned.filter(slot => kind === 'request' ? extraMatchesHop(slot, hop) : responseExtraMatchesHop(slot, hop))
    // The index fallback is confined to slots that carry NO usable identity:
    // a slot that names a target (and does not name this hop) belongs to
    // another hop, and must not be handed over just because its arrival index
    // matches — that is the misattribution this pairing exists to prevent.
    const fallback = byIdentity.length === 0
      ? owned.find(slot => slot.index === hopIndex && !this.hasUsableIdentity(slot) && !this.hopHasExtra(slots, kind, hopIndex))
      : undefined
    const chosen = byIdentity.length === 1 ? byIdentity[0] : fallback
    if (chosen === undefined) return undefined
    this.claimExtra(requestId, chosen, hop, hopIndex)
    return chosen
  }

  /** Apply a slot to its hop (authoritative) and write its JSONL line. */
  private claimExtra(requestId: string, slot: ExtraSlot, hop: RecordedHttpExchange, hopIndex: number): void {
    slot.claimed = true
    slot.hop = hopIndex
    const held = this.heldExtras.indexOf(slot)
    if (held !== -1) this.heldExtras.splice(held, 1)
    if (slot.kind === 'request') {
      this.applyRequestExtra(hop, slot)
      this.append({
        kind: 'requestExtra',
        ...this.stamps(slot.at),
        requestId,
        url: hop.url,
        headers: slot.headers,
        cookieCount: slot.cookies.length,
        hop: hopIndex,
      })
      return
    }
    this.applyResponseExtra(hop, slot)
    this.append({
      kind: 'responseExtra',
      ...this.stamps(slot.at),
      requestId,
      url: hop.url,
      statusCode: slot.status,
      headers: slot.headers,
      cookieCount: slot.cookies.length,
      hop: hopIndex,
    })
  }

  /** The request-side effect of a claimed slot: headers + cookies win. */
  private applyRequestExtra(hop: RecordedHttpExchange, slot: ExtraSlot): void {
    hop.requestHeaders = { ...hop.requestHeaders, ...slot.headers }
    hop.requestCookies = slot.cookies
  }

  /** The response-side effect of a claimed slot: headers + status win. */
  private applyResponseExtra(hop: RecordedHttpExchange, slot: ExtraSlot): void {
    hop.responseHeaders = { ...hop.responseHeaders, ...slot.headers }
    if (slot.cookies.length > 0) hop.responseCookies = slot.cookies
    if (hop.status === undefined && slot.status !== undefined) hop.status = slot.status
  }

  private slotsFor(requestId: string): HopSlots {
    const existing = this.slots.get(requestId)
    if (existing !== undefined) return existing
    const created: HopSlots = { hops: [], requestExtras: [], responseExtras: [] }
    this.slots.set(requestId, created)
    return created
  }

  /** Start the flush window for held slots whose base event may never arrive. */
  private armHoldTimer(): void {
    if (this.holdTimer !== undefined || this.stopped) return
    const window = this.options.extraHoldMs ?? DEFAULT_EXTRA_HOLD_MS
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      this.flushHeldExtras()
    }, window)
    // Never keep the host process alive just for a diagnostic line.
    this.holdTimer.unref?.()
  }

  /**
   * Write the line for every slot still held: its base event never arrived
   * inside the window, so the slot is reported on its own (no `url`), which is
   * what "the base event is missing" looks like to the offline pipeline.
   */
  private flushHeldExtras(): void {
    for (const slot of [...this.heldExtras]) {
      if (slot.claimed) continue
      const requestId = this.ownerOf(slot)
      if (requestId === undefined || this.skipped.has(requestId)) continue
      slot.claimed = true
      this.heldExtras.splice(this.heldExtras.indexOf(slot), 1)
      this.append(slot.kind === 'request'
        ? { kind: 'requestExtra', ...this.stamps(slot.at), requestId, headers: slot.headers, cookieCount: slot.cookies.length, hop: slot.index, unclaimed: true }
        : { kind: 'responseExtra', ...this.stamps(slot.at), requestId, statusCode: slot.status, headers: slot.headers, cookieCount: slot.cookies.length, hop: slot.index, unclaimed: true })
    }
  }

  /** Which requestId owns a held slot (its index within that id's arrays). */
  private ownerOf(target: ExtraSlot): string | undefined {
    for (const [requestId, slots] of this.slots) {
      if (slots.requestExtras.includes(target) || slots.responseExtras.includes(target)) return requestId
    }
    return undefined
  }

  /** `Network.responseReceived`: attach status/headers/mimeType. */
  private onResponse(params: Record<string, unknown>): void {
    const exchange = this.exchangeFor(params)
    if (exchange === undefined) return
    const response = record(params['response'])
    if (response === undefined) return
    const status = typeof response['status'] === 'number' ? response['status'] : undefined
    if (status !== undefined) exchange.status = status
    if (typeof response['statusText'] === 'string') exchange.statusText = response['statusText']
    if (typeof response['mimeType'] === 'string') exchange.mimeType = response['mimeType']
    // ExtraInfo headers (which carry the true `Set-Cookie` set) win when that
    // hop's slot was claimed; otherwise this hop's own slot may still be on
    // hold (held until its hop's response pair is complete) and is applied then.
    const responseHeaders = headers(response['headers'])
    if (Object.keys(responseHeaders).length > 0) exchange.responseHeaders = responseHeaders
    const slots = this.slots.get(exchange.requestId)
    const hopIndex = slots?.hops.indexOf(exchange) ?? -1
    if (slots !== undefined && hopIndex !== -1 && !this.hopHasExtra(slots, 'response', hopIndex)) {
      // This hop's response status is known NOW, so a response ExtraInfo that
      // arrived early (or is queued at the index fallback) can be placed:
      // identity first (its status names this hop), then the held/index slot.
      const slot = slots.responseExtras[hopIndex]
      if (slot !== undefined && slot.claimed !== true && !this.hasUsableIdentity(slot)) {
        this.claimExtra(exchange.requestId, slot, exchange, hopIndex)
      } else {
        this.claimHeldExtra(exchange.requestId, hopIndex, 'response')
      }
    }
    this.append({
      kind: 'response',
      ...this.stamps(this.now()),
      requestId: exchange.requestId,
      url: exchange.url,
      status: exchange.status,
      statusText: exchange.statusText,
      mimeType: exchange.mimeType,
      headers: exchange.responseHeaders,
    })
  }

  /** `Network.loadingFinished`: fetch the body (when asked) and close the line. */
  private async onFinished(params: Record<string, unknown>): Promise<void> {
    const exchange = this.exchangeFor(params)
    if (exchange === undefined) return
    if (this.options.captureBodies) {
      try {
        const body = record(await this.options.session.send('Network.getResponseBody', { requestId: exchange.requestId }))
        if (body !== undefined && typeof body['body'] === 'string') {
          const base64 = body['base64Encoded'] === true
          const cut = truncateBody(body['body'], base64, this.options.maxBodyBytes)
          exchange.body = cut.body
          exchange.bodyBase64Encoded = base64
          exchange.bodyTruncated = cut.truncated
          exchange.bodyBytes = cut.bytes
        }
      } catch (error: unknown) {
        // A body that cannot be read (streamed, evicted, page closing during
        // an abort) is not an error worth failing over — the exchange is still
        // reported, only without content.
        this.note(`getResponseBody(${exchange.requestId}) failed: ${describe(error)}`)
      }
    }
    exchange.finishedAtMs = this.now()
    this.http.delete(exchange.requestId)
    if (exchange.body !== undefined) {
      // The body is its own line, in the shape CDP's own getResponseBody
      // response has (`body` + `base64Encoded`), which is what the offline
      // pipeline looks for. The completion line then describes, never repeats,
      // the body.
      this.append({
        kind: 'responseBody',
        ...this.stamps(exchange.finishedAtMs),
        requestId: exchange.requestId,
        url: exchange.url,
        mimeType: exchange.mimeType,
        body: exchange.body,
        base64Encoded: exchange.bodyBase64Encoded === true,
        bodyTruncated: exchange.bodyTruncated,
        bodyBytes: exchange.bodyBytes,
      })
    }
    this.append({
      kind: 'finished',
      ...this.stamps(exchange.finishedAtMs),
      requestId: exchange.requestId,
      url: exchange.url,
      status: exchange.status,
      mimeType: exchange.mimeType,
      bodyTruncated: exchange.bodyTruncated,
      bodyBytes: exchange.bodyBytes,
      durationMs: exchange.finishedAtMs - exchange.startedAtMs,
    })
  }

  /** `Network.loadingFailed`: close the exchange with its error text. */
  private onFailed(params: Record<string, unknown>): void {
    const exchange = this.exchangeFor(params)
    if (exchange === undefined) return
    exchange.errorText = text(params['errorText']) || 'network error'
    exchange.finishedAtMs = this.now()
    this.http.delete(exchange.requestId)
    this.append({
      kind: 'failed',
      ...this.stamps(exchange.finishedAtMs),
      requestId: exchange.requestId,
      url: exchange.url,
      errorText: exchange.errorText,
      canceled: params['canceled'] === true,
    })
  }

  /** `Network.webSocketCreated`: open a socket record. */
  private onSocketCreated(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    const url = text(params['url'])
    if (requestId === '' || url === '') return
    const socket: RecordedWebSocket = { requestId, url, startedAtMs: this.now(), frames: [] }
    this.sockets.set(requestId, socket)
    this.append({ kind: 'websocketCreated', ...this.stamps(socket.startedAtMs), requestId, url })
  }

  /** `Network.webSocketFrameSent` / `webSocketFrameReceived`: one frame. */
  private onSocketFrame(params: Record<string, unknown>, direction: 'sent' | 'received'): void {
    const requestId = text(params['requestId'])
    const socket = this.sockets.get(requestId)
    if (socket === undefined) return
    const frame = record(params['response'])
    if (frame === undefined) return
    const payload = typeof frame['payloadData'] === 'string' ? frame['payloadData'] : ''
    const cut = truncateBody(payload, false, this.options.maxBodyBytes)
    const at = this.now()
    socket.frames.push({
      direction,
      atMs: at,
      opcode: typeof frame['opcode'] === 'number' ? frame['opcode'] : 1,
      payloadData: cut.body,
      ...(cut.truncated ? { payloadTruncated: true } : {}),
    })
    this.append({
      kind: 'websocketFrame',
      ...this.stamps(at),
      requestId,
      url: socket.url,
      direction,
      opcode: typeof frame['opcode'] === 'number' ? frame['opcode'] : 1,
      payloadData: cut.body,
      payloadTruncated: cut.truncated,
    })
  }

  /** `Network.webSocketClosed`: mark the socket complete. */
  private onSocketClosed(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    const socket = this.sockets.get(requestId)
    if (socket === undefined) return
    socket.closed = true
    this.append({ kind: 'websocketClosed', ...this.stamps(this.now()), requestId, url: socket.url, frames: socket.frames.length })
  }

  /** The exchange an event's `requestId` refers to (skipped ids = undefined). */
  private exchangeFor(params: Record<string, unknown>): RecordedHttpExchange | undefined {
    const requestId = text(params['requestId'])
    if (requestId === '') return undefined
    return this.http.get(requestId)
  }

  /**
   * Wait for every pending append — including the ones an ALREADY IN-FLIGHT
   * handler queues while we wait (a `loadingFinished` body read that started
   * before the fetch ended still contributes its `responseBody`/`finished`
   * lines). Looping until the chain stops growing is what makes the JSONL
   * complete before the HAR is built and before `finish()` resolves.
   */
  private async settleWrites(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const pending = this.writes
      await pending
      if (pending === this.writes) return
    }
  }

  /** Append one JSONL line, serialized behind every earlier append. */
  private append(event: RecordedEvent): void {
    const line = `${JSON.stringify({ ...event, session: this.dir })}\n`
    this.writes = this.writes
      .then(async () => { await appendFile(this.jsonlPath, line, { mode: DUMP_FILE_MODE }) })
      .catch((error: unknown) => { this.note(`appending to ${NETWORK_JSONL_FILE} failed: ${describe(error)}`) })
  }

  /** Record a swallowed failure (and forward it to the optional observer). */
  private note(message: string): void {
    this.errors.push(message)
    try {
      this.options.onError?.(message)
    } catch {
      // an observer that throws must not break the capture
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * The timestamp trio every line carries: `at` in epoch milliseconds (this
   * plugin's own clock) plus `wallTime`/`timestamp` in epoch SECONDS — the
   * spelling CDP uses, and what tools consuming the dump expect.
   */
  private stamps(at: number): { at: number; wallTime: number; timestamp: number } {
    const seconds = at / 1000
    return { at, wallTime: seconds, timestamp: seconds }
  }
}

/** Compose a session directory: `<base>/<sessionId>`. */
export function sessionDirectory(baseDir: string, sessionId: string): string {
  return join(baseDir, sessionId)
}

/**
 * Process-monotonic counter appended by {@link nextCaptureSessionId}: two
 * allocations that share a clock tick (and even the same `Math.random` value)
 * still get different ids, and therefore different directories.
 */
let allocationCounter = 0

/**
 * The session id the recorder allocates by default: {@link newCaptureSessionId}
 * plus a process-monotonic 3-hex suffix, so a collision needs an actual
 * filesystem clash rather than a coincident millisecond.
 *
 * @param now - epoch milliseconds (injectable for tests).
 * @param random - a `Math.random` substitute (injectable for tests).
 * @returns a filesystem-safe, sortable, collision-resistant session id.
 */
export function nextCaptureSessionId(now: number = Date.now(), random: () => number = Math.random): string {
  allocationCounter = (allocationCounter + 1) % 0x1000
  return `${newCaptureSessionId(now, random)}-${allocationCounter.toString(16).padStart(3, '0')}`
}

/**
 * Claim a session directory under `baseDir` with a NON-recursive `mkdir`, so an
 * existing directory surfaces as EEXIST and the allocator retries with a fresh
 * id instead of silently merging two captures into one dump (or appending to a
 * previous run's JSONL).
 *
 * @param baseDir - the base directory (expected to exist; created by the caller).
 * @param sessionId - the id generator, called once per attempt.
 * @param attempts - how many candidate ids to try before giving up.
 * @returns the claimed directory, or undefined when none could be claimed.
 */
export async function allocateCaptureDirectory(
  baseDir: string,
  sessionId: () => string,
  attempts = 64,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = join(baseDir, sessionId())
    try {
      // Non-recursive on purpose: the base exists, so EEXIST here means THIS
      // session directory is taken.
      await mkdir(candidate, { mode: DUMP_DIR_MODE })
      return candidate
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') return undefined
    }
  }
  return undefined
}

/**
 * A filesystem-safe, sortable per-capture id: compact UTC timestamp plus four
 * random hex characters. No colons (Windows), no path separators.
 *
 * @param now - epoch milliseconds (injectable for tests).
 * @param random - a `Math.random` substitute (injectable for tests).
 * @returns the session id used as the dump directory's basename.
 */
export function newCaptureSessionId(now: number = Date.now(), random: () => number = Math.random): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const suffix = Math.floor(random() * 0xffff).toString(16).padStart(4, '0')
  return `${stamp}-${suffix}`
}

/** The `redirectResponse` fields the recorder and the JSONL line carry. */
interface RedirectShape {
  headers: Record<string, string>
  status?: number
  statusText?: string
  mimeType?: string
  url?: string
}

/** Narrow CDP's `redirectResponse` to the fields a hop entry needs. */
function redirectShape(response: Record<string, unknown>): RedirectShape {
  const shape: RedirectShape = { headers: headers(response['headers']) }
  if (typeof response['status'] === 'number') shape.status = response['status']
  if (typeof response['statusText'] === 'string') shape.statusText = response['statusText']
  if (typeof response['mimeType'] === 'string') shape.mimeType = response['mimeType']
  if (typeof response['url'] === 'string') shape.url = response['url']
  return shape
}

/**
 * The cookies CDP reports as ATTACHED to a request
 * (`requestWillBeSentExtraInfo.associatedCookies`). Cookies the browser
 * blocked are skipped — they were not sent — and the rest keep their values
 * verbatim.
 */
function associatedCookies(value: unknown): HarCookie[] {
  if (!Array.isArray(value)) return []
  const cookies: HarCookie[] = []
  for (const entry of value) {
    const associated = record(entry)
    if (associated === undefined) continue
    const blocked = associated['blockedReasons']
    if (Array.isArray(blocked) && blocked.length > 0) continue
    const cookie = record(associated['cookie'])
    if (cookie === undefined) continue
    const name = text(cookie['name'])
    if (name === '') continue
    const parsed: HarCookie = { name, value: text(cookie['value']) }
    if (typeof cookie['domain'] === 'string') parsed.domain = cookie['domain']
    if (typeof cookie['path'] === 'string') parsed.path = cookie['path']
    cookies.push(parsed)
  }
  return cookies
}

/**
 * The `Cookie` header to record alongside the extra-info headers: CDP's own
 * header set when it carries one, else one reconstructed from the associated
 * cookies (the offline pipeline reads headers, so without this a capture whose
 * base event lacks the header would lose the session).
 */
function cookieHeaderFor(extraHeaders: Record<string, string>, cookies: readonly HarCookie[]): string | undefined {
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (name.toLowerCase() === 'cookie') return value
  }
  if (cookies.length === 0) return undefined
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

/** Cookies carried by a header map's `Set-Cookie`, in HAR shape. */
function cookieHeaders(headerMap: Record<string, string>, names: readonly string[]): HarCookie[] {
  for (const [name, value] of Object.entries(headerMap)) {
    if (names.includes(name)) return cookiesFromHeader(value)
  }
  return []
}

/** A thrown value's one-line description. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Narrow a CDP params member to a plain object. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Narrow a CDP params member to a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Narrow a CDP headers member (`Record<string,string>`) to a string map. */
function headers(value: unknown): Record<string, string> {
  const source = record(value)
  if (source === undefined) return {}
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(source)) {
    if (typeof raw === 'string') result[name] = raw
  }
  return result
}
