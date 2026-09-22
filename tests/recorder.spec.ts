/**
 * The P2 network recorder over a fake CDP session: the JSONL stream appended
 * WHILE the capture runs, the request/response/body reduction (including the
 * `maxBodyBytes` cut), WebSocket lifecycle and frames, the static-resource
 * filter, the HAR 1.2 export written by `finish()`, the 0700/0600 permissions,
 * and the best-effort guarantees (a broken domain or a broken filesystem never
 * escapes).
 *
 * Filesystem cases run in throwaway temp directories; nothing here launches a
 * browser.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHar, cookiesFromHeader, headersToHar, queryStringOf, type HarDocument } from '../src/har.ts'
import {
  HAR_FILE,
  NETWORK_JSONL_FILE,
  NetworkRecorder,
  isStaticResource,
  newCaptureSessionId,
  sessionDirectory,
  truncateBody,
  type RecorderReport,
} from '../src/recorder.ts'
import type { CdpSession } from '../src/types.ts'

/** A fake CDP session that records commands and replays events on demand. */
class FakeCdpSession implements CdpSession {
  readonly sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
  detachCalls = 0
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()

  /**
   * @param options.bodies - what `Network.getResponseBody` answers per requestId
   *   (an `Error` makes the read fail, like an evicted/streamed resource).
   * @param options.failEnable - make `Network.enable` reject.
   */
  constructor(private readonly options: {
    bodies?: Record<string, { body: string; base64Encoded?: boolean } | Error>
    failEnable?: boolean
  } = {}) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params })
    if (method === 'Network.enable') {
      if (this.options.failEnable === true) throw new Error('Network domain is not available')
      return {}
    }
    if (method === 'Network.getResponseBody') {
      const requestId = String(params?.['requestId'] ?? '')
      const entry = this.options.bodies?.[requestId]
      if (entry === undefined) throw new Error(`No resource with given identifier found (${requestId})`)
      if (entry instanceof Error) throw entry
      return { body: entry.body, base64Encoded: entry.base64Encoded === true }
    }
    return {}
  }

  on(event: string, listener: (params: Record<string, unknown>) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return undefined
  }

  async detach(): Promise<void> { this.detachCalls++ }

  /** Replay one protocol event to every listener. */
  emit(event: string, params: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(params)
  }

  /** The request ids `Network.getResponseBody` was called for, in order. */
  bodyReads(): string[] {
    return this.sent
      .filter(entry => entry.method === 'Network.getResponseBody')
      .map(entry => String(entry.params?.['requestId'] ?? ''))
  }

  /** Whether a protocol command was sent at all. */
  didSend(method: string): boolean {
    return this.sent.some(entry => entry.method === method)
  }
}

/** One `Network.requestWillBeSent` payload. */
function requestEvent(over: {
  requestId?: string
  type?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  postData?: string
} = {}): Record<string, unknown> {
  return {
    requestId: over.requestId ?? '1',
    type: over.type ?? 'XHR',
    documentURL: 'https://app.example.com/',
    request: {
      url: over.url ?? 'https://api.example.com/v1/login',
      method: over.method ?? 'POST',
      headers: over.headers ?? {
        'content-type': 'application/json',
        cookie: 'session=abc123; theme=dark',
        authorization: 'Bearer tok-123',
      },
      ...(over.postData === undefined ? {} : { postData: over.postData }),
    },
  }
}

/** One `Network.responseReceived` payload. */
function responseEvent(over: {
  requestId?: string
  status?: number
  statusText?: string
  mimeType?: string
  headers?: Record<string, string>
} = {}): Record<string, unknown> {
  return {
    requestId: over.requestId ?? '1',
    type: 'XHR',
    response: {
      url: 'https://api.example.com/v1/login',
      status: over.status ?? 200,
      statusText: over.statusText ?? 'OK',
      mimeType: over.mimeType ?? 'application/json',
      headers: over.headers ?? { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'sid=xyz; Path=/' },
    },
  }
}

/** Read the JSONL dump as decoded lines. */
function readJsonl(dir: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(dir, NETWORK_JSONL_FILE), 'utf8')
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Poll until `predicate` holds (appendFile is async; the capture is live). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error('condition not reached in time')
}

/** Wait for the JSONL to hold at least `count` lines. */
async function waitForLines(dir: string, count: number): Promise<void> {
  await waitFor(() => existsSync(join(dir, NETWORK_JSONL_FILE)) && readJsonl(dir).length >= count)
}

describe('NetworkRecorder', () => {
  let root: string
  let dir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-recorder-'))
    dir = join(root, 'session-1')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** Create a recorder over a fresh fake session (default: capture bodies). */
  async function recorderWith(
    session: FakeCdpSession,
    over: Partial<Parameters<typeof NetworkRecorder.create>[0]> = {},
  ): Promise<NetworkRecorder> {
    const recorder = await NetworkRecorder.create({
      session,
      dir,
      url: 'https://app.example.com/page',
      backend: 'local',
      captureBodies: true,
      maxBodyBytes: 1024,
      recordAllResources: false,
      ...over,
    })
    expect(recorder).toBeDefined()
    return recorder as NetworkRecorder
  }

  it('opens the session directory, enables the Network domain, and appends events while the fetch runs', async () => {
    const session = new FakeCdpSession()
    const recorder = await recorderWith(session)

    // The directory exists with the owner-only mode before any event arrives.
    expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(session.didSend('Network.enable')).toBe(true)
    expect(recorder.jsonlPath).toBe(join(dir, NETWORK_JSONL_FILE))

    // A header line lands immediately. It deliberately has NO top-level `url`
    // (a line with a url reads as traffic to the offline pipeline).
    await waitForLines(dir, 1)
    expect(readJsonl(dir)[0]).toMatchObject({ kind: 'session', fetchUrl: 'https://app.example.com/page', backend: 'local' })
    expect(readJsonl(dir)[0]).not.toHaveProperty('url')

    // Events are on disk BEFORE finish() — the whole point of the live stream.
    session.emit('Network.requestWillBeSent', requestEvent({ postData: '{"user":"u","pw":"p"}' }))
    session.emit('Network.responseReceived', responseEvent())
    await waitForLines(dir, 3)
    expect(recorder.done).toBe(false)

    const lines = readJsonl(dir)
    expect(lines[1]).toMatchObject({
      kind: 'request',
      requestId: '1',
      method: 'POST',
      url: 'https://api.example.com/v1/login',
      resourceType: 'XHR',
      postData: '{"user":"u","pw":"p"}',
    })
    // Credentials ride along verbatim, by design.
    expect((lines[1]?.['headers'] as Record<string, string>)['cookie']).toBe('session=abc123; theme=dark')
    expect((lines[1]?.['headers'] as Record<string, string>)['authorization']).toBe('Bearer tok-123')
    expect(lines[2]).toMatchObject({ kind: 'response', status: 200, mimeType: 'application/json' })
  })

  it('reads the response body after loadingFinished and stores it truncated to maxBodyBytes', async () => {
    const body = JSON.stringify({ token: 'tok-123', payload: 'x'.repeat(500) })
    const session = new FakeCdpSession({ bodies: { '1': { body } } })
    const recorder = await recorderWith(session, { maxBodyBytes: 64 })

    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1', encodedDataLength: body.length })
    await waitForLines(dir, 5)

    const lines = readJsonl(dir)
    const bodyLine = lines.find(line => line['kind'] === 'responseBody')
    // The body is its own line in CDP's shape, so the offline pipeline finds it.
    expect(bodyLine).toMatchObject({ kind: 'responseBody', requestId: '1', base64Encoded: false, bodyTruncated: true })
    expect(String(bodyLine?.['body']).length).toBe(64)
    expect(Number(bodyLine?.['bodyBytes'])).toBe(Buffer.byteLength(body, 'utf8'))
    const finished = lines.find(line => line['kind'] === 'finished')
    expect(finished).toMatchObject({ kind: 'finished', requestId: '1', status: 200, bodyTruncated: true })
    expect(finished).not.toHaveProperty('body') // sizes only, never the body twice
    expect(session.bodyReads()).toEqual(['1'])

    const report = await recorder.finish()
    expect(report.httpCount).toBe(1)
    const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
    expect(String(har.log.entries[0]?.response.content.text).length).toBe(64)
    expect(har.log.entries[0]?.response.content.size).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('stores base64 bodies 4-character aligned when truncating', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: 'A'.repeat(400), base64Encoded: true } } })
    await recorderWith(session, { maxBodyBytes: 90 })
    session.emit('Network.requestWillBeSent', requestEvent({ type: 'Fetch' }))
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })

    await waitForLines(dir, 5)
    const bodyLine = readJsonl(dir).find(line => line['kind'] === 'responseBody')
    expect(bodyLine?.['base64Encoded']).toBe(true)
    expect(String(bodyLine?.['body']).length % 4).toBe(0)
    expect(String(bodyLine?.['body']).length).toBeLessThanOrEqual(90)
    expect(String(bodyLine?.['body']).length).toBeGreaterThan(0)
  })

  it('skips the body read entirely when captureBodies is off', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{"a":1}' } } })
    await recorderWith(session, { captureBodies: false })
    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })

    await waitForLines(dir, 4)
    expect(session.bodyReads()).toEqual([])
    expect(readJsonl(dir).some(line => line['kind'] === 'responseBody')).toBe(false)
  })

  it('drops image/font/media/stylesheet records by default and keeps them when configured', async () => {
    // Default: a stylesheet request is dropped, an XHR is kept.
    const defaultSession = new FakeCdpSession()
    const defaultRecorder = await recorderWith(defaultSession)
    defaultSession.emit('Network.requestWillBeSent', requestEvent({ requestId: 'css', type: 'Stylesheet', url: 'https://app.example.com/app.css' }))
    defaultSession.emit('Network.requestWillBeSent', requestEvent({ requestId: 'img', type: 'Image', url: 'https://app.example.com/logo.png' }))
    defaultSession.emit('Network.requestWillBeSent', requestEvent({ requestId: 'api', type: 'Fetch', url: 'https://api.example.com/v1/items' }))
    await waitForLines(dir, 2)
    const kinds = readJsonl(dir).filter(line => line['kind'] === 'request')
    expect(kinds.map(line => line['requestId'])).toEqual(['api'])
    const defaultReport = await defaultRecorder.finish()
    expect(defaultReport.httpCount).toBe(1)

    // A dropped id stays dropped: its later response body is not recorded.
    defaultSession.emit('Network.responseReceived', responseEvent({ requestId: 'css' }))
    defaultSession.emit('Network.loadingFinished', { requestId: 'css' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(readJsonl(dir).some(line => line['requestId'] === 'css' && line['kind'] === 'finished')).toBe(false)

    // recordAllResources keeps them.
    rmSync(dir, { recursive: true, force: true })
    const allSession = new FakeCdpSession()
    const allRecorder = await recorderWith(allSession, { recordAllResources: true })
    allSession.emit('Network.requestWillBeSent', requestEvent({ requestId: 'css', type: 'Stylesheet' }))
    allSession.emit('Network.requestWillBeSent', requestEvent({ requestId: 'img', type: 'Image' }))
    await waitForLines(dir, 3)
    expect(readJsonl(dir).filter(line => line['kind'] === 'request')).toHaveLength(2)
    const allReport = await allRecorder.finish()
    expect(allReport.httpCount).toBe(2)
  })

  it('records the WebSocket lifecycle and both frame directions', async () => {
    const session = new FakeCdpSession()
    const recorder = await recorderWith(session)
    session.emit('Network.webSocketCreated', { requestId: 'ws1', url: 'wss://stream.example.com/socket' })
    session.emit('Network.webSocketFrameSent', { requestId: 'ws1', response: { opcode: 1, payloadData: '{"subscribe":"trades"}' } })
    session.emit('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 1, payloadData: '{"price":42}' } })
    session.emit('Network.webSocketClosed', { requestId: 'ws1' })
    await waitForLines(dir, 5)

    const lines = readJsonl(dir)
    expect(lines[1]).toMatchObject({ kind: 'websocketCreated', requestId: 'ws1', url: 'wss://stream.example.com/socket' })
    expect(lines[1]?.['wallTime']).toEqual(expect.any(Number)) // epoch seconds, as CDP spells it
    expect(lines[2]).toMatchObject({ kind: 'websocketFrame', direction: 'sent', opcode: 1, payloadData: '{"subscribe":"trades"}' })
    expect(lines[3]).toMatchObject({ kind: 'websocketFrame', direction: 'received', payloadData: '{"price":42}' })
    expect(lines[4]).toMatchObject({ kind: 'websocketClosed', requestId: 'ws1', frames: 2 })

    const report = await recorder.finish()
    expect(report).toMatchObject({ webSocketCount: 1, frameCount: 2 })
    const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
    const entry = har.log.entries.find(candidate => candidate._resourceType === 'WebSocket')
    expect(entry?.request.url).toBe('wss://stream.example.com/socket')
    expect(entry?._webSocketMessages).toEqual([
      { type: 'send', time: expect.any(Number), opcode: 1, data: '{"subscribe":"trades"}' },
      { type: 'receive', time: expect.any(Number), opcode: 1, data: '{"price":42}' },
    ])
  })

  it('writes a HAR 1.2 document on finish() and is idempotent', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{"ok":true}' } } })
    const recorder = await recorderWith(session)
    session.emit('Network.requestWillBeSent', requestEvent({ postData: '{"user":"u"}' }))
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: '2', url: 'https://api.example.com/v1/fail' }))
    session.emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_CONNECTION_REFUSED' })

    const report = await recorder.finish()
    const again = await recorder.finish()
    expect(again).toEqual(report)
    expect(session.detachCalls).toBe(1)

    const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('dsh-web-fetch-playwright')
    expect(har.log.entries).toHaveLength(2)
    const [ok, failed] = har.log.entries
    expect(ok?.request.method).toBe('POST')
    expect(ok?.request.url).toBe('https://api.example.com/v1/login')
    expect(ok?.request.postData?.text).toBe('{"user":"u"}')
    expect(ok?.request.headers).toEqual(expect.arrayContaining([
      { name: 'cookie', value: 'session=abc123; theme=dark' },
      { name: 'authorization', value: 'Bearer tok-123' },
    ]))
    expect(ok?.request.cookies).toEqual([
      { name: 'session', value: 'abc123' },
      { name: 'theme', value: 'dark' },
    ])
    expect(ok?.response.status).toBe(200)
    expect(ok?.response.headers).toEqual(expect.arrayContaining([{ name: 'set-cookie', value: 'sid=xyz; Path=/' }]))
    expect(ok?.response.cookies).toEqual([{ name: 'sid', value: 'xyz' }])
    expect(ok?.response.content.text).toBe('{"ok":true}')
    expect(ok?._resourceType).toBe('XHR')
    expect(failed?._error).toBe('net::ERR_CONNECTION_REFUSED')
    expect(report.errors).toEqual([])
  })

  it('keeps a failing exchange in both outputs, without a body', async () => {
    const session = new FakeCdpSession({ bodies: { '1': new Error('No resource with given identifier found') } })
    const recorder = await recorderWith(session)
    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent({ status: 502, statusText: 'Bad Gateway' }))
    session.emit('Network.loadingFinished', { requestId: '1' })

    const report = await recorder.finish()
    expect(report.httpCount).toBe(1)
    expect(report.errors.join('\n')).toContain('getResponseBody(1) failed')
    const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries[0]?.response.status).toBe(502)
    expect(har.log.entries[0]?.response.content.text).toBeUndefined()
  })

  it('writes a HAR even when the fetch failed or was aborted mid-capture', async () => {
    const session = new FakeCdpSession()
    const recorder = await recorderWith(session)
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: 'pending' }))
    // Nothing finishes: the fetch is torn down (error/abort) with an exchange
    // still in flight. The dump must still be complete and valid.
    const report = await recorder.finish()
    expect(report.httpCount).toBe(1)
    const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries).toHaveLength(1)
    expect(har.log.entries[0]?.response.status).toBe(0)
    expect(har.log.entries[0]?.request.url).toBe('https://api.example.com/v1/login')
  })

  it('keeps going when Network.enable fails, reporting the failure', async () => {
    const session = new FakeCdpSession({ failEnable: true })
    const recorder = await recorderWith(session)
    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    const report = await recorder.finish()
    expect(report.errors.join('\n')).toContain('Network.enable failed')
    expect(report.httpCount).toBe(1)
    expect(readJsonl(dir).some(line => line['kind'] === 'finished')).toBe(true)
  })

  it('ignores malformed events and unknown request ids instead of failing', async () => {
    const session = new FakeCdpSession()
    const recorder = await recorderWith(session)
    session.emit('Network.responseReceived', { requestId: 'unknown' })
    session.emit('Network.loadingFinished', { requestId: 'unknown' })
    session.emit('Network.loadingFailed', { requestId: 'unknown' })
    session.emit('Network.webSocketFrameSent', { requestId: 'unknown', response: { payloadData: 'x' } })
    session.emit('Network.webSocketClosed', { requestId: 'unknown' })
    session.emit('Network.requestWillBeSent', null as unknown as Record<string, unknown>)
    session.emit('Network.requestWillBeSent', { requestId: 'no-request' })
    session.emit('Network.webSocketCreated', { url: 'wss://x/' })

    const report = await recorder.finish()
    expect(report.httpCount).toBe(0)
    expect(report.webSocketCount).toBe(0)
    expect(report.errors).toEqual([])
    expect(readJsonl(dir)).toHaveLength(1) // only the header line
  })

  it('never throws when the dump directory cannot be created', async () => {
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const recorder = await NetworkRecorder.create({
      session: new FakeCdpSession(),
      dir: join(blocker, 'nested'),
      url: 'https://app.example.com/',
      captureBodies: true,
      maxBodyBytes: 128,
      recordAllResources: false,
    })
    expect(recorder).toBeUndefined()
  })

  it('keeps a session directory per capture, beside the base directory', async () => {
    expect(sessionDirectory('/tmp/base', 'abc')).toBe(join('/tmp/base', 'abc'))
    const recorder = await recorderWith(new FakeCdpSession(), { dir: sessionDirectory(root, 'two') })
    expect(recorder.dir).toBe(join(root, 'two'))
    expect(existsSync(recorder.jsonlPath)).toBe(true)
  })

  it('writes files with the owner-only mode', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{}' } } })
    const recorder = await recorderWith(session)
    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    const report = await recorder.finish()
    if (process.platform === 'win32') return
    expect(statSync(report.jsonlPath).mode & 0o777).toBe(0o600)
    expect(statSync(report.harPath).mode & 0o777).toBe(0o600)
  })
})

describe('truncateBody', () => {
  it('leaves a body under the cap (or unbounded) untouched', () => {
    expect(truncateBody('hello', false, 1024)).toEqual({ body: 'hello', truncated: false, bytes: 5 })
    expect(truncateBody('hello', false, 0)).toEqual({ body: 'hello', truncated: false, bytes: 5 })
    expect(truncateBody('hello', false, -1)).toEqual({ body: 'hello', truncated: false, bytes: 5 })
    expect(truncateBody('hello', false, Number.NaN)).toEqual({ body: 'hello', truncated: false, bytes: 5 })
  })

  it('cuts text by bytes and reports the original size', () => {
    const cut = truncateBody('abcdefghij', false, 4)
    expect(cut).toEqual({ body: 'abcd', truncated: true, bytes: 10 })
  })

  it('keeps a base64 remainder decodable (4-character aligned, within the cap)', () => {
    const cut = truncateBody('A'.repeat(100), true, 60)
    expect(cut.truncated).toBe(true)
    expect(cut.body.length).toBe(60) // ≤ the cap and a multiple of 4
    expect(cut.body.length % 4).toBe(0)
    expect(cut.bytes).toBe(75) // the ORIGINAL decoded size of 100 base64 chars
  })
})

describe('isStaticResource', () => {
  it('matches the static types CDP reports, whatever the case', () => {
    for (const type of ['Image', 'Font', 'Media', 'Stylesheet', 'image', 'font', 'media', 'stylesheet']) {
      expect(isStaticResource(type), type).toBe(true)
    }
  })

  it('keeps the business traffic', () => {
    for (const type of ['XHR', 'Fetch', 'Document', 'Script', 'WebSocket', 'Preflight', undefined, '']) {
      expect(isStaticResource(type), String(type)).toBe(false)
    }
  })
})

describe('newCaptureSessionId', () => {
  it('is sortable, filesystem-safe, and unique enough', () => {
    const first = newCaptureSessionId(Date.UTC(2026, 8, 22, 15, 25, 30), () => 0.5)
    const second = newCaptureSessionId(Date.UTC(2026, 8, 22, 15, 25, 31), () => 0.5)
    expect(first).toBe('20260922T152530Z-7fff') // floor(0.5 * 0xffff)
    expect(first < second).toBe(true)
    expect(first).not.toMatch(/[:/\\ ]/)
    expect(newCaptureSessionId(0, () => 0)).toMatch(/^19\d{6}T\d{6}Z-0000$/)
  })
})

describe('HAR assembly helpers', () => {
  it('turns headers into HAR pairs and splits multi-value headers', () => {
    expect(headersToHar(undefined)).toEqual([])
    expect(headersToHar({ a: '1', b: '2' })).toEqual([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])
  })

  it('parses cookies verbatim and ignores attributes', () => {
    expect(cookiesFromHeader('sid=xyz; Path=/; HttpOnly; Secure; theme=dark')).toEqual([
      { name: 'sid', value: 'xyz' },
      { name: 'theme', value: 'dark' },
    ])
    expect(cookiesFromHeader('not-a-cookie')).toEqual([])
  })

  it('extracts the query string', () => {
    expect(queryStringOf('https://api.example.com/v1/items?limit=10&q=a%20b')).toEqual([
      { name: 'limit', value: '10' },
      { name: 'q', value: 'a b' },
    ])
    expect(queryStringOf('https://api.example.com/v1/items')).toEqual([])
  })

  it('orders entries by start time and keeps the creator configurable', () => {
    const har = buildHar({
      creator: { name: 'test', version: '9' },
      http: [
        { requestId: 'b', startedAtMs: 2_000, method: 'GET', url: 'https://x/b', requestHeaders: {} },
        { requestId: 'a', startedAtMs: 1_000, method: 'GET', url: 'https://x/a', requestHeaders: {} },
      ],
      webSockets: [],
    })
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator).toEqual({ name: 'test', version: '9' })
    expect(har.log.entries.map(entry => entry.request.url)).toEqual(['https://x/a', 'https://x/b'])
    expect(har.log.entries[0]?.cache).toEqual({})
    expect(har.log.entries[0]?.timings).toEqual({ send: 0, wait: 0, receive: 0 })
  })
})

/** The report type is part of the module's public shape. */
const reportShape: RecorderReport = {
  dir: '/tmp/d', jsonlPath: '/tmp/d/network.jsonl', harPath: '/tmp/d/har.json',
  httpCount: 0, webSocketCount: 0, frameCount: 0, errors: [],
}
void reportShape
