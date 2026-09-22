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
 *   - `websocketCreated` / `websocketFrame` / `websocketClosed` — `requestId`,
 *     `url`, and for a frame `direction` (`sent`/`received`), `opcode`,
 *     `payloadData`;
 *   every line also carries `at` (epoch ms) plus `wallTime`/`timestamp`
 *   (epoch seconds, the spelling CDP itself uses);
 * - `har.json` — the HAR 1.2 export written when the fetch ends (normal,
 *   thrown, or aborted — all three go through {@link NetworkRecorder.finish}).
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
import { buildHar, type RecordedHttpExchange, type RecordedWebSocket } from './har.ts'

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
   * The session directory. {@link dumpDirectoryFor} composes the default
   * (`<cwd>/net-dumps/<sessionId>`), whose basename is always the session id
   * and whose parent is `net-dumps` unless the settings say otherwise.
   */
  dir: string
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
 * A capture session over one page's CDP session. Create it with
 * {@link NetworkRecorder.create}, end it with {@link NetworkRecorder.finish}.
 */
export class NetworkRecorder {
  private readonly errors: string[] = []
  private readonly http = new Map<string, RecordedHttpExchange>()
  private readonly skipped = new Set<string>()
  private readonly sockets = new Map<string, RecordedWebSocket>()
  private finished: Promise<RecorderReport> | undefined
  private writes: Promise<void> = Promise.resolve()
  private stopped = false

  private constructor(private readonly options: RecorderOptions) {}

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
    const recorder = new NetworkRecorder(options)
    try {
      await mkdir(options.dir, { recursive: true, mode: DUMP_DIR_MODE })
    } catch (error: unknown) {
      return undefined
    }
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
      dir: options.dir,
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

  /** The session directory the dumps live in. */
  get dir(): string {
    return this.options.dir
  }

  /** Absolute path of the JSONL event stream. */
  get jsonlPath(): string {
    return join(this.options.dir, NETWORK_JSONL_FILE)
  }

  /** Absolute path of the HAR export. */
  get harPath(): string {
    return join(this.options.dir, HAR_FILE)
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
    await this.writes
    const report: RecorderReport = {
      dir: this.options.dir,
      jsonlPath: this.jsonlPath,
      harPath: this.harPath,
      httpCount: this.http.size,
      webSocketCount: this.sockets.size,
      frameCount: [...this.sockets.values()].reduce((total, socket) => total + socket.frames.length, 0),
      errors: [...this.errors],
    }
    try {
      const har = buildHar({ http: [...this.http.values()], webSockets: [...this.sockets.values()] })
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
    on('Network.responseReceived', params => { this.onResponse(params) })
    on('Network.loadingFinished', params => { void this.onFinished(params) })
    on('Network.loadingFailed', params => { this.onFailed(params) })
    on('Network.webSocketCreated', params => { this.onSocketCreated(params) })
    on('Network.webSocketFrameSent', params => { this.onSocketFrame(params, 'sent') })
    on('Network.webSocketFrameReceived', params => { this.onSocketFrame(params, 'received') })
    on('Network.webSocketClosed', params => { this.onSocketClosed(params) })
  }

  /** `Network.requestWillBeSent`: start an exchange (or drop it as static). */
  private onRequest(params: Record<string, unknown>): void {
    const requestId = text(params['requestId'])
    const request = record(params['request'])
    if (requestId === '' || request === undefined) return
    const resourceType = text(params['type']) || undefined
    if (!this.options.recordAllResources && isStaticResource(resourceType)) {
      this.skipped.add(requestId)
      return
    }
    const exchange: RecordedHttpExchange = {
      requestId,
      startedAtMs: this.now(),
      ...(resourceType === undefined ? {} : { resourceType }),
      method: text(request['method']) || 'GET',
      url: text(request['url']),
      requestHeaders: headers(request['headers']),
      ...(typeof request['postData'] === 'string' ? { postData: request['postData'] } : {}),
    }
    this.http.set(requestId, exchange)
    this.append({
      kind: 'request',
      ...this.stamps(exchange.startedAtMs),
      requestId,
      url: exchange.url,
      method: exchange.method,
      resourceType: exchange.resourceType,
      headers: exchange.requestHeaders,
      postData: exchange.postData,
    })
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
    const responseHeaders = headers(response['headers'])
    if (Object.keys(responseHeaders).length > 0) exchange.responseHeaders = responseHeaders
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

  /** Append one JSONL line, serialized behind every earlier append. */
  private append(event: RecordedEvent): void {
    const line = `${JSON.stringify({ ...event, session: this.options.dir })}\n`
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
