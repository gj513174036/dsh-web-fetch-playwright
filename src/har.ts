/**
 * HAR 1.2 assembly for a capture session: the recorded exchange/socket model
 * the network recorder produces, plus the (pure, dependency-free) conversion
 * into a HAR document — `log.version`, `log.creator`, and one `log.entries`
 * entry per XHR/Fetch exchange, with WebSocket traffic carried on the
 * `_webSocketMessages` extension Chrome's own HAR export uses (HAR 1.2 has no
 * native WebSocket support).
 *
 * Credentials are kept VERBATIM: `Cookie`, `Set-Cookie`, `Authorization`, and
 * any token in a body are written exactly as the browser saw them. That is the
 * point of the capture (the offline pipeline needs them to reproduce a
 * session), and the reason the recorder's output is 0600 inside a 0700
 * directory and the README warns about it.
 *
 * Host-only and import-free: the assembler is pure (its only non-language
 * dependency is the Node `Buffer` global, used for byte sizes) so its
 * structure can be asserted without a browser, a CDP session, or the
 * filesystem.
 *
 * ROBUSTNESS CONTRACT: one malformed URL or one unconvertible record may never
 * cost the whole document. Every percent-decode falls back to the raw text
 * ({@link queryStringOf}), and {@link buildHar} converts each entry behind its
 * own guard — a failing entry is emitted in a degraded shape (URL, method,
 * status where known, and the reason in `_error`) instead of aborting the
 * export.
 *
 * @module dsh-web-fetch-playwright/har
 */

/** One recorded header, as HAR spells it. */
export interface HarHeader {
  name: string
  value: string
}

/** One recorded cookie, as HAR spells it. */
export interface HarCookie {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: string
  httpOnly?: boolean
  secure?: boolean
}

/** One recorded HTTP exchange (request + response), before HAR shaping. */
export interface RecordedHttpExchange {
  /** CDP `requestId` (the key every later event for this exchange carries). */
  requestId: string
  /** Epoch milliseconds when `requestWillBeSent` arrived. */
  startedAtMs: number
  /** CDP resource type (`XHR`, `Fetch`, `Document`, …). */
  resourceType?: string
  method: string
  url: string
  /** Request headers as the browser sent them (credentials included). */
  requestHeaders: Record<string, string>
  /** Request body (`requestWillBeSent.request.postData`), when present. */
  postData?: string
  status?: number
  statusText?: string
  /** Response headers verbatim (`Set-Cookie` included). */
  responseHeaders?: Record<string, string>
  mimeType?: string
  /** Response body from `Network.getResponseBody`, already truncated. */
  body?: string
  /** True when CDP returned the body base64-encoded (binary payloads). */
  bodyBase64Encoded?: boolean
  /**
   * Request cookies decoded from `Network.requestWillBeSentExtraInfo`'s
   * `associatedCookies` — the authoritative set (the `Cookie` header is only a
   * fallback, because the base `requestWillBeSent` often omits it).
   */
  requestCookies?: HarCookie[]
  /**
   * Response cookies from `Network.responseReceivedExtraInfo`'s headers (the
   * authoritative `Set-Cookie` set; the base event's headers are the fallback).
   */
  responseCookies?: HarCookie[]
  /** True when `maxBodyBytes` cut the body. */
  bodyTruncated?: boolean
  /** Original body size in bytes, before truncation. */
  bodyBytes?: number
  /** Epoch milliseconds when the exchange finished (body included). */
  finishedAtMs?: number
  /** `Network.loadingFailed` text, when the exchange failed. */
  errorText?: string
}

/** The direction of a WebSocket frame. */
export type WebSocketFrameDirection = 'sent' | 'received'

/** One recorded WebSocket frame. */
export interface RecordedWebSocketFrame {
  direction: WebSocketFrameDirection
  /** Epoch milliseconds when the frame was observed. */
  atMs: number
  /** WebSocket opcode (1 = text, 2 = binary, 8 = close, …). */
  opcode: number
  /** Frame payload, truncated like a body when `maxBodyBytes` applies. */
  payloadData: string
  /** True when `maxBodyBytes` cut the payload. */
  payloadTruncated?: boolean
}

/** One recorded WebSocket connection and its frames. */
export interface RecordedWebSocket {
  /** CDP `requestId` of the handshake. */
  requestId: string
  url: string
  startedAtMs: number
  /** True once `Network.webSocketClosed` arrived. */
  closed?: boolean
  frames: RecordedWebSocketFrame[]
}

/** A HAR `_webSocketMessages` entry (Chrome's extension shape). */
export interface HarWebSocketMessage {
  type: 'send' | 'receive'
  /** Epoch milliseconds when the frame was observed. */
  time: number
  opcode: number
  data: string
  /** True when the stored payload was truncated. */
  _truncated?: boolean
}

/** A HAR 1.2 entry (the subset this plugin emits, plus the WS extension). */
export interface HarEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    cookies: HarCookie[]
    headers: HarHeader[]
    queryString: HarHeader[]
    headersSize: number
    bodySize: number
    postData?: { mimeType: string; text: string }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    cookies: HarCookie[]
    headers: HarHeader[]
    content: { size: number; mimeType: string; text?: string; encoding?: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
  /** CDP resource type this entry came from. */
  _resourceType?: string
  /** `Network.loadingFailed` text, when the exchange failed. */
  _error?: string
  /** WebSocket frames (only on WebSocket entries). */
  _webSocketMessages?: HarWebSocketMessage[]
}

/** A HAR 1.2 document (only the members this plugin writes). */
export interface HarDocument {
  log: {
    version: '1.2'
    creator: { name: string; version: string }
    entries: HarEntry[]
  }
}

/** What {@link buildHar} takes: the recorded session. */
export interface HarInput {
  http: readonly RecordedHttpExchange[]
  webSockets: readonly RecordedWebSocket[]
  /** `log.creator`; defaults to this plugin. */
  creator?: { name: string; version: string }
}

/** Default `log.creator` for dumps this plugin writes. */
export const HAR_CREATOR = { name: 'dsh-web-fetch-playwright', version: '1.2' } as const

/** CDP's `Network.responseReceived`/`loadingFinished` shape guard helpers. */
export function headersToHar(headers: Record<string, string> | undefined): HarHeader[] {
  if (headers === undefined) return []
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

/**
 * Split a header value list into name/value pairs, preserving duplicates and
 * original order. CDP hands headers as a single map (duplicates joined with
 * `\n`), so multi-value headers are recovered here.
 */
export function expandHeaderValues(value: string): string[] {
  return value.split('\n')
}

/** Parse a `Cookie:` / `Set-Cookie:` value into HAR cookies (values verbatim). */
export function cookiesFromHeader(value: string): HarCookie[] {
  const cookies: HarCookie[] = []
  for (const rawPart of expandHeaderValues(value)) {
    for (const part of rawPart.split(';')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const equals = trimmed.indexOf('=')
      if (equals <= 0) continue
      const cookieName = trimmed.slice(0, equals).trim()
      const cookieValue = trimmed.slice(equals + 1).trim()
      if (/^(path|domain|expires|max-age|httponly|secure|samesite)$/i.test(cookieName)) continue
      cookies.push({ name: cookieName, value: cookieValue })
    }
  }
  return cookies
}

/**
 * Query-string pairs of a URL, as HAR spells them.
 *
 * A malformed pair (`%zz`, a bare `%`, an invalid UTF-8 sequence) must not cost
 * the export: each half is decoded behind its own guard and falls back to the
 * RAW text, so the query is still reported verbatim instead of being dropped or
 * throwing out of the whole HAR build. The fragment is not part of the query.
 *
 * @param url - the recorded URL.
 * @returns the name/value pairs, decoded where decoding succeeds.
 */
export function queryStringOf(url: string): HarHeader[] {
  const query = url.indexOf('?')
  if (query === -1) return []
  const hash = url.indexOf('#', query)
  const raw = url.slice(query + 1, hash === -1 ? undefined : hash)
  const pairs: HarHeader[] = []
  for (const part of raw.split('&')) {
    if (part === '') continue
    const equals = part.indexOf('=')
    pairs.push(equals === -1
      ? { name: safeDecode(part), value: '' }
      : { name: safeDecode(part.slice(0, equals)), value: safeDecode(part.slice(equals + 1)) })
  }
  return pairs
}

/**
 * `decodeURIComponent` that never throws: on failure the input is returned
 * unchanged (the raw text is the honest representation of a value that is not
 * valid percent-encoding).
 *
 * @param text - the raw (possibly encoded) text.
 * @returns the decoded text, or the raw text when decoding fails.
 */
export function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** The elapsed milliseconds of one exchange (0 for missing/reversed stamps). */
export function millisecondsBetween(startMs: number | undefined, endMs: number | undefined): number {
  if (startMs === undefined || endMs === undefined || endMs < startMs) return 0
  return endMs - startMs
}

/**
 * Build the HAR 1.2 document for a capture session.
 *
 * Each record is converted behind its own guard: an entry that cannot be shaped
 * (a NaN timestamp, a value the converter did not anticipate) is written in a
 * DEGRADED form — URL, method, status where known, and the reason in `_error` —
 * so one bad record never takes the other entries down with it. This function
 * never throws.
 *
 * @param input - the recorded exchanges and sockets.
 * @returns a HAR 1.2 document (`log.version`, `log.creator`, `log.entries`).
 */
export function buildHar(input: HarInput): HarDocument {
  const entries: HarEntry[] = []
  for (const exchange of input.http) {
    try {
      entries.push(toHttpEntry(exchange))
    } catch (error: unknown) {
      entries.push(degradedHttpEntry(exchange, error))
    }
  }
  for (const socket of input.webSockets) {
    try {
      entries.push(toWebSocketEntry(socket))
    } catch (error: unknown) {
      entries.push(degradedWebSocketEntry(socket, error))
    }
  }
  entries.sort((left, right) => Date.parse(left.startedDateTime) - Date.parse(right.startedDateTime))
  return {
    log: {
      version: '1.2',
      creator: input.creator ?? { ...HAR_CREATOR },
      entries,
    },
  }
}

/** An ISO timestamp that cannot throw, whatever the recorded clock says. */
function safeIso(epochMs: number): string {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : new Date(0).toISOString()
}

/** The degraded shape of an exchange whose conversion failed. */
function degradedHttpEntry(exchange: RecordedHttpExchange, error: unknown): HarEntry {
  return {
    startedDateTime: safeIso(exchange.startedAtMs),
    time: 0,
    request: {
      method: exchange.method === '' ? 'GET' : exchange.method,
      url: exchange.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: exchange.status ?? 0,
      statusText: exchange.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: exchange.mimeType ?? 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    ...(exchange.resourceType === undefined ? {} : { _resourceType: exchange.resourceType }),
    _error: `entry conversion failed: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/** The degraded shape of a WebSocket whose conversion failed. */
function degradedWebSocketEntry(socket: RecordedWebSocket, error: unknown): HarEntry {
  return {
    startedDateTime: safeIso(socket.startedAtMs),
    time: 0,
    request: {
      method: 'GET',
      url: socket.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: 'WebSocket',
    _webSocketMessages: [],
    _error: `entry conversion failed: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/** One recorded exchange as a HAR entry. */
function toHttpEntry(exchange: RecordedHttpExchange): HarEntry {
  const requestHeaders = headersToHar(exchange.requestHeaders)
  const responseHeaders = headersToHar(exchange.responseHeaders)
  const contentType = exchange.responseHeaders?.['content-type'] ?? exchange.responseHeaders?.['Content-Type']
  const mimeType = exchange.mimeType ?? (contentType === undefined ? 'x-unknown' : contentType.split(';')[0]?.trim() ?? 'x-unknown')
  const size = exchange.bodyBytes ?? (exchange.body === undefined ? 0 : Buffer.byteLength(exchange.body, 'utf8'))
  const content: HarEntry['response']['content'] = { size, mimeType }
  if (exchange.body !== undefined) {
    content.text = exchange.body
    if (exchange.bodyBase64Encoded === true) content.encoding = 'base64'
  }
  const startedAt = exchange.startedAtMs
  const time = millisecondsBetween(startedAt, exchange.finishedAtMs)
  return {
    startedDateTime: safeIso(startedAt),
    time,
    request: {
      method: exchange.method,
      url: exchange.url,
      httpVersion: 'HTTP/1.1',
      // The ExtraInfo-derived set is authoritative; the Cookie header is the
      // fallback for a capture where that event never arrived.
      cookies: exchange.requestCookies ?? cookieHeaders(exchange.requestHeaders, ['cookie', 'Cookie']),
      headers: requestHeaders,
      queryString: queryStringOf(exchange.url),
      headersSize: -1,
      bodySize: exchange.postData === undefined ? 0 : Buffer.byteLength(exchange.postData, 'utf8'),
      ...(exchange.postData === undefined
        ? {}
        : { postData: { mimeType: contentType ?? 'application/octet-stream', text: exchange.postData } }),
    },
    response: {
      status: exchange.status ?? 0,
      statusText: exchange.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: exchange.responseCookies ?? cookieHeaders(exchange.responseHeaders, ['set-cookie', 'Set-Cookie']),
      headers: responseHeaders,
      content,
      redirectURL: exchange.responseHeaders?.['location'] ?? exchange.responseHeaders?.['Location'] ?? '',
      headersSize: -1,
      bodySize: content.size,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    ...(exchange.resourceType === undefined ? {} : { _resourceType: exchange.resourceType }),
    ...(exchange.errorText === undefined ? {} : { _error: exchange.errorText }),
  }
}

/** One recorded WebSocket as a HAR entry carrying `_webSocketMessages`. */
function toWebSocketEntry(socket: RecordedWebSocket): HarEntry {
  const messages: HarWebSocketMessage[] = socket.frames.map(frame => ({
    type: frame.direction === 'sent' ? 'send' : 'receive',
    time: frame.atMs,
    opcode: frame.opcode,
    data: frame.payloadData,
    ...(frame.payloadTruncated === true ? { _truncated: true } : {}),
  }))
  const lastAt = socket.frames.length === 0 ? socket.startedAtMs : socket.frames[socket.frames.length - 1]?.atMs ?? socket.startedAtMs
  return {
    startedDateTime: safeIso(socket.startedAtMs),
    time: millisecondsBetween(socket.startedAtMs, lastAt),
    request: {
      method: 'GET',
      url: socket.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: queryStringOf(socket.url),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      // The handshake: 101 when it completed, 0 when the socket was still
      // open (or failed) when the fetch ended.
      status: socket.closed === true ? 101 : 0,
      statusText: socket.closed === true ? 'Switching Protocols' : '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: 'WebSocket',
    _webSocketMessages: messages,
  }
}

/** Cookies carried by one of the header spellings in `names`. */
function cookieHeaders(headers: Record<string, string> | undefined, names: readonly string[]): HarCookie[] {
  if (headers === undefined) return []
  for (const [name, value] of Object.entries(headers)) {
    if (names.includes(name)) return cookiesFromHeader(value)
  }
  return []
}
