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
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHar, cookiesFromHeader, headersToHar, queryStringOf, safeDecode, type HarDocument } from '../src/har.ts'
import {
  allocateCaptureDirectory,
  HAR_FILE,
  NETWORK_JSONL_FILE,
  NetworkRecorder,
  isStaticResource,
  newCaptureSessionId,
  nextCaptureSessionId,
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

  /**
   * Create a recorder over a fresh fake session (default: capture bodies).
   * `baseDir` + a FIXED `sessionId` keep the dump path predictable, which is
   * what most cases assert against; the allocation cases below drive the
   * default generator instead.
   */
  async function recorderWith(
    session: FakeCdpSession,
    over: Partial<Omit<Parameters<typeof NetworkRecorder.create>[0], 'session'>> = {},
  ): Promise<NetworkRecorder> {
    const recorder = await NetworkRecorder.create({
      session,
      baseDir: root,
      sessionId: () => 'session-1',
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
      baseDir: join(blocker, 'nested'),
      url: 'https://app.example.com/',
      captureBodies: true,
      maxBodyBytes: 128,
      recordAllResources: false,
    })
    expect(recorder).toBeUndefined()
  })

  it('keeps a session directory per capture, beside the base directory', async () => {
    expect(sessionDirectory('/tmp/base', 'abc')).toBe(join('/tmp/base', 'abc'))
    const recorder = await recorderWith(new FakeCdpSession(), { sessionId: () => 'two' })
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

/** The P2 repair round: robustness, ExtraInfo merging, redirects, allocation. */
describe('NetworkRecorder robustness (bad URLs, bad records)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-hard-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function readJsonl(dir: string): Array<Record<string, unknown>> {
    return readFileSync(join(dir, NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('keeps a malformed query pair verbatim instead of throwing', () => {
    expect(queryStringOf('https://api.example.com/v1/x?q=%zz')).toEqual([{ name: 'q', value: '%zz' }])
    expect(queryStringOf('https://api.example.com/v1/x?a=1&b=%&c=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '%' },
      { name: 'c', value: '2' },
    ])
    expect(queryStringOf('wss://stream.example.com/s?x=%zz')).toEqual([{ name: 'x', value: '%zz' }])
    // Valid encoding still decodes, and the fragment is not part of the query.
    expect(queryStringOf('https://x/?q=%E4%B8%AD#frag')).toEqual([{ name: 'q', value: '中' }])
    expect(safeDecode('%E4%B8%AD')).toBe('中')
    expect(safeDecode('%zz')).toBe('%zz')
  })

  it('degrades ONE unconvertible entry instead of losing the document', () => {
    // A record whose shape the converter did not anticipate: enumerating its
    // headers throws, which used to take the WHOLE export down with it.
    const hostileHeaders = new Proxy<Record<string, string>>({}, {
      ownKeys: () => { throw new Error('hostile header map') },
    })
    const har = buildHar({
      http: [
        { requestId: 'bad', startedAtMs: 1_500, method: 'GET', url: 'https://x/?q=%zz', requestHeaders: {}, responseHeaders: hostileHeaders },
        { requestId: 'ok1', startedAtMs: 1_000, method: 'GET', url: 'https://x/one', requestHeaders: { cookie: 'a=1' } },
        { requestId: 'ok2', startedAtMs: 2_000, method: 'POST', url: 'https://x/two', requestHeaders: {}, postData: '{}' },
      ],
      webSockets: [{ requestId: 's', url: 'wss://x/?x=%zz', startedAtMs: Number.NaN, frames: [] }],
    })
    expect(har.log.entries).toHaveLength(4)
    const urls = har.log.entries.map(entry => entry.request.url)
    expect(urls).toContain('https://x/one')
    expect(urls).toContain('https://x/two')
    const degraded = har.log.entries.find(entry => entry.request.url === 'https://x/?q=%zz')
    expect(degraded?._error).toContain('entry conversion failed')
    expect(degraded?.response.status).toBe(0)
    // A NaN clock is handled in place (the entry keeps its data) rather than
    // degrading, and a malformed WebSocket query is kept verbatim.
    const socket = har.log.entries.find(entry => entry.request.url === 'wss://x/?x=%zz')
    expect(socket?._resourceType).toBe('WebSocket')
    expect(socket?.request.queryString).toEqual([{ name: 'x', value: '%zz' }])
    expect(socket?._error).toBeUndefined()
  })

  it('keeps a NaN timestamp (an entry with an unusable clock is not lost)', () => {
    const har = buildHar({
      http: [{ requestId: 'weird', startedAtMs: Number.NaN, method: 'GET', url: 'https://x/one', requestHeaders: { cookie: 'a=1' } }],
      webSockets: [],
    })
    expect(har.log.entries).toHaveLength(1)
    expect(har.log.entries[0]?.request.url).toBe('https://x/one')
    expect(har.log.entries[0]?.request.cookies).toEqual([{ name: 'a', value: '1' }])
    expect(har.log.entries[0]?.startedDateTime).toBe(new Date(0).toISOString())
    expect(har.log.entries[0]?._error).toBeUndefined()
  })

  it('still writes har.json when the capture mixes a bad URL with good ones', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{"a":1}' }, '2': { body: '{"b":2}' } } })
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'mixed', url: 'https://app.example.com/', captureBodies: true, maxBodyBytes: 1024, recordAllResources: false,
    })
    expect(recorder).toBeDefined()
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: '1', url: 'https://api.example.com/v1/broken?q=%zz' }))
    session.emit('Network.responseReceived', responseEvent({ requestId: '1' }))
    session.emit('Network.loadingFinished', { requestId: '1' })
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: '2', url: 'https://api.example.com/v1/good' }))
    session.emit('Network.responseReceived', responseEvent({ requestId: '2' }))
    session.emit('Network.loadingFinished', { requestId: '2' })

    const report = await recorder?.finish()
    expect(report?.errors).toEqual([])
    const har = JSON.parse(readFileSync(join(root, 'mixed', HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries.map(entry => entry.request.url).sort()).toEqual([
      'https://api.example.com/v1/broken?q=%zz',
      'https://api.example.com/v1/good',
    ])
    expect(har.log.entries.find(entry => entry.request.url.includes('%zz'))?.request.queryString).toEqual([{ name: 'q', value: '%zz' }])
    // The JSONL has both exchanges too (nothing was dropped from the stream).
    const kinds = readJsonl(join(root, 'mixed')).map(line => line['kind'])
    expect(kinds.filter(kind => kind === 'finished')).toHaveLength(2)
  })

  it('reports a failed HAR write instead of swallowing it', async () => {
    const reported: string[] = []
    const session = new FakeCdpSession()
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'blocked', url: 'https://app.example.com/', captureBodies: true, maxBodyBytes: 64, recordAllResources: false,
      onError: message => { reported.push(message) },
    })
    expect(recorder).toBeDefined()
    const dir = join(root, 'blocked')
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: '1', headers: { cookie: 'session=abc123', authorization: 'Bearer tok-123' } }))
    // Make the HAR path unwritable: a DIRECTORY where the file goes.
    rmSync(join(dir, HAR_FILE), { force: true })
    mkdirSync(join(dir, HAR_FILE))

    const report = await recorder?.finish()
    expect(report?.errors.join('\n')).toContain('writing har.json failed')
    expect(reported.join('\n')).toContain('writing har.json failed')
    // Only the error text is reported — never a header or a body from the dump.
    expect(reported.join('\n')).not.toContain('abc123')
    expect(reported.join('\n')).not.toContain('tok-123')
    // The JSONL stream is unaffected, so the capture is still fully readable.
    expect(readJsonl(dir).some(line => line['kind'] === 'request')).toBe(true)
  })
})

/** ExtraInfo events are the authoritative header/cookie source. */
describe('NetworkRecorder ExtraInfo merging', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-extra-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function readJsonl(dir: string): Array<Record<string, unknown>> {
    return readFileSync(join(dir, NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  }

  /** A recorder with a fixed session directory. */
  async function recorder(session: FakeCdpSession): Promise<NetworkRecorder> {
    const created = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'extra', url: 'https://app.example.com/', captureBodies: true, maxBodyBytes: 1024, recordAllResources: false,
    })
    expect(created).toBeDefined()
    return created as NetworkRecorder
  }

  const REQUEST_EXTRA = {
    requestId: '1',
    headers: { ':authority': 'api.example.com', 'content-type': 'application/json' },
    associatedCookies: [
      { cookie: { name: 'session', value: 'abc123', domain: 'api.example.com', path: '/' }, blockedReasons: [] },
      { cookie: { name: 'csrf', value: 'zz9', domain: 'api.example.com', path: '/' }, blockedReasons: [] },
      { cookie: { name: 'blocked', value: 'nope' }, blockedReasons: ['SecureOnly'] },
    ],
  }

  const RESPONSE_EXTRA = {
    requestId: '1',
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'sid=xyz; Path=/; HttpOnly' },
  }

  it('merges request ExtraInfo that arrives BEFORE the base event (cookies win)', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{}' } } })
    const rec = await recorder(session)
    session.emit('Network.requestWillBeSentExtraInfo', REQUEST_EXTRA)
    session.emit('Network.requestWillBeSent', requestEvent({ headers: { 'content-type': 'application/json' } }))
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    const report = await rec.finish()
    expect(report.httpCount).toBe(1)

    const lines = readJsonl(join(root, 'extra'))
    const extraLine = lines.find(line => line['kind'] === 'requestExtra')
    expect(extraLine).toBeDefined()
    const extraHeaders = extraLine?.['headers'] as Record<string, string>
    // The Cookie header is reconstructed from associatedCookies (blocked ones dropped).
    expect(extraHeaders['cookie']).toBe('session=abc123; csrf=zz9')
    expect(extraHeaders[':authority']).toBe('api.example.com')
    expect(extraLine?.['cookieCount']).toBe(2)

    const requestLine = lines.find(line => line['kind'] === 'request')
    expect((requestLine?.['headers'] as Record<string, string>)['cookie']).toBe('session=abc123; csrf=zz9')

    const har = JSON.parse(readFileSync(join(root, 'extra', HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries[0]?.request.cookies).toEqual([
      { name: 'session', value: 'abc123', domain: 'api.example.com', path: '/' },
      { name: 'csrf', value: 'zz9', domain: 'api.example.com', path: '/' },
    ])
  })

  it('merges request ExtraInfo that arrives AFTER the base event', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{}' } } })
    const rec = await recorder(session)
    // The base event arrives first WITHOUT any cookie header.
    session.emit('Network.requestWillBeSent', requestEvent({ headers: { 'content-type': 'application/json' } }))
    session.emit('Network.requestWillBeSentExtraInfo', REQUEST_EXTRA)
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    await rec.finish()

    const lines = readJsonl(join(root, 'extra'))
    expect(lines.some(line => line['kind'] === 'requestExtra')).toBe(true)
    const har = JSON.parse(readFileSync(join(root, 'extra', HAR_FILE), 'utf8')) as HarDocument
    // The HAR carries the late-arriving authoritative set, and the extra row
    // lets the offline pipeline merge it even though the request row came first.
    expect(har.log.entries[0]?.request.headers).toEqual(expect.arrayContaining([
      { name: ':authority', value: 'api.example.com' },
    ]))
    expect(har.log.entries[0]?.request.cookies?.map(cookie => cookie.name)).toEqual(['session', 'csrf'])
  })

  it('merges response ExtraInfo (before and after) and exposes Set-Cookie', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{}' } } })
    const rec = await recorder(session)
    session.emit('Network.requestWillBeSent', requestEvent())
    // Extra AFTER the base response event.
    session.emit('Network.responseReceived', responseEvent({ headers: { 'content-type': 'application/json' } }))
    session.emit('Network.responseReceivedExtraInfo', RESPONSE_EXTRA)
    session.emit('Network.loadingFinished', { requestId: '1' })
    await rec.finish()

    const lines = readJsonl(join(root, 'extra'))
    const extraLine = lines.find(line => line['kind'] === 'responseExtra')
    expect(extraLine).toMatchObject({ statusCode: 200, cookieCount: 1 })
    expect((extraLine?.['headers'] as Record<string, string>)['set-cookie']).toBe('sid=xyz; Path=/; HttpOnly')

    const har = JSON.parse(readFileSync(join(root, 'extra', HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries[0]?.response.headers).toEqual(expect.arrayContaining([
      { name: 'set-cookie', value: 'sid=xyz; Path=/; HttpOnly' },
    ]))
    expect(har.log.entries[0]?.response.cookies).toEqual([{ name: 'sid', value: 'xyz' }])
  })

  it('ignores ExtraInfo for a request the static filter dropped', async () => {
    const session = new FakeCdpSession()
    const rec = await recorder(session)
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: 'img', type: 'Image' }))
    session.emit('Network.requestWillBeSentExtraInfo', { ...REQUEST_EXTRA, requestId: 'img' })
    session.emit('Network.responseReceivedExtraInfo', { ...RESPONSE_EXTRA, requestId: 'img' })
    await rec.finish()
    const kinds = readJsonl(join(root, 'extra')).map(line => line['kind'])
    expect(kinds).toEqual(['session'])
  })
})

/** Redirect hops become their own entries. */
describe('NetworkRecorder redirect chains', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-redirect-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('turns a 301 → 200 chain into two HAR entries', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{"ok":true}' } } })
    const rec = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'chain', url: 'https://app.example.com/', captureBodies: true, maxBodyBytes: 1024, recordAllResources: false,
    })
    expect(rec).toBeDefined()
    // Hop 1: the initial request.
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: '1', url: 'http://app.example.com/old', method: 'GET' }))
    // Hop 2: the SAME requestId, carrying hop 1's response.
    session.emit('Network.requestWillBeSent', {
      requestId: '1',
      type: 'Document',
      redirectResponse: {
        url: 'http://app.example.com/old',
        status: 301,
        statusText: 'Moved Permanently',
        mimeType: 'text/html',
        headers: { location: 'https://app.example.com/new', 'content-length': '0' },
      },
      request: { url: 'https://app.example.com/new', method: 'GET', headers: { accept: 'text/html' } },
    })
    session.emit('Network.responseReceived', responseEvent({ requestId: '1', status: 200, mimeType: 'application/json' }))
    session.emit('Network.loadingFinished', { requestId: '1' })

    const report = await rec?.finish()
    expect(report?.httpCount).toBe(2)

    const lines = readFileSync(join(root, 'chain', NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const redirects = lines.filter(line => line['redirect'] === true)
    expect(redirects.map(line => line['kind'])).toEqual(['response', 'finished'])
    expect(redirects[0]).toMatchObject({ requestId: '1', status: 301, url: 'http://app.example.com/old' })
    // The redirected request row carries redirectResponse, which is the shape
    // the offline pipeline backfills a hop from.
    const secondRequest = lines.filter(line => line['kind'] === 'request')[1]
    expect(secondRequest?.['url']).toBe('https://app.example.com/new')
    expect((secondRequest?.['redirectResponse'] as Record<string, unknown>)['status']).toBe(301)

    const har = JSON.parse(readFileSync(join(root, 'chain', HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries).toHaveLength(2)
    const [hop, final] = har.log.entries
    expect(hop?.request.url).toBe('http://app.example.com/old')
    expect(hop?.response.status).toBe(301)
    expect(hop?.response.headers).toEqual(expect.arrayContaining([{ name: 'location', value: 'https://app.example.com/new' }]))
    expect(final?.request.url).toBe('https://app.example.com/new')
    expect(final?.response.status).toBe(200)
    expect(final?.response.content.text).toBe('{"ok":true}')
  })
})

/** Session directories are allocated, never shared. */
describe('NetworkRecorder directory allocation', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-alloc-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('gives two same-clock, same-random allocations different directories', async () => {
    const fixed = () => nextCaptureSessionId(1_700_000_000_000, () => 0.5)
    const first = await allocateCaptureDirectory(root, fixed)
    const second = await allocateCaptureDirectory(root, fixed)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    expect(newCaptureSessionId(1_700_000_000_000, () => 0.5)).toBe(newCaptureSessionId(1_700_000_000_000, () => 0.5))
    expect(nextCaptureSessionId(1_700_000_000_000, () => 0.5)).not.toBe(nextCaptureSessionId(1_700_000_000_000, () => 0.5))
  })

  it('retries past an existing session directory instead of merging into it', async () => {
    const taken = join(root, 'taken')
    mkdirSync(taken)
    const ids = ['taken', 'taken', 'free']
    let calls = 0
    const allocated = await allocateCaptureDirectory(root, () => ids[calls++] ?? 'later')
    expect(allocated).toBe(join(root, 'free'))
    expect(calls).toBe(3)

    // A generator that can never find a free slot gives up (never throws).
    const stuck = await allocateCaptureDirectory(root, () => 'taken', 3)
    expect(stuck).toBeUndefined()
  })

  it('keeps two recorders created in the same millisecond apart', async () => {
    const first = await NetworkRecorder.create({ session: new FakeCdpSession(), baseDir: root, url: 'https://a/', captureBodies: false, maxBodyBytes: 64, recordAllResources: false })
    const second = await NetworkRecorder.create({ session: new FakeCdpSession(), baseDir: root, url: 'https://b/', captureBodies: false, maxBodyBytes: 64, recordAllResources: false })
    expect(first?.dir).toBeDefined()
    expect(second?.dir).toBeDefined()
    expect(first?.dir).not.toBe(second?.dir)
    expect(existsSync(first?.jsonlPath ?? '')).toBe(true)
    expect(existsSync(second?.jsonlPath ?? '')).toBe(true)
    await first?.finish()
    await second?.finish()
  })
})

/** The maxBodyBytes = 0 semantics, pinned. */
describe('NetworkRecorder body cap semantics', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-cap-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('maxBodyBytes 0 means NO cap: the whole body is stored', async () => {
    const body = 'x'.repeat(5_000)
    const session = new FakeCdpSession({ bodies: { '1': { body } } })
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'nocap', url: 'https://app.example.com/', captureBodies: true, maxBodyBytes: 0, recordAllResources: false,
    })
    session.emit('Network.requestWillBeSent', requestEvent())
    session.emit('Network.responseReceived', responseEvent())
    session.emit('Network.loadingFinished', { requestId: '1' })
    await recorder?.finish()

    const lines = readFileSync(join(root, 'nocap', NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const bodyLine = lines.find(line => line['kind'] === 'responseBody')
    expect(bodyLine?.['body']).toBe(body)
    expect(bodyLine?.['bodyTruncated']).toBe(false)
    expect(bodyLine?.['bodyBytes']).toBe(5_000)
  })
})

/**
 * The real-browser case: only runs where a launchable Chromium exists (it
 * self-skips otherwise, like the repo's integration suite). It exists because
 * "does a real browser's Cookie/Set-Cookie actually land in the dump?" can only
 * be answered by a real browser; the fake-session cases above pin the merging
 * logic itself.
 */
describe('NetworkRecorder real-browser capture (self-skipping)', () => {
  it('records a real Cookie/Set-Cookie round trip', { timeout: 120_000 }, async () => {
    const { chromium } = await import('playwright-core')
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    const server = createServer((request, response) => {
      if (request.url === '/set') {
        response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=real-cookie; Path=/' })
        response.end('<!doctype html><html><body>set</body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? '' }))
    })
    const root = mkdtempSync(join(tmpdir(), 'dsh-recorder-real-'))
    try {
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
      const address = server.address()
      if (address === null || typeof address === 'string') return
      const origin = `http://127.0.0.1:${String(address.port)}`
      try {
        browser = await chromium.launch({ headless: true, timeout: 60_000 })
      } catch (error: unknown) {
        console.warn(`skipping real-browser network capture: no launchable Chromium (${error instanceof Error ? error.message : String(error)})`)
        return
      }
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(`${origin}/set`)
      const cdp = await context.newCDPSession(page)
      const recorder = await NetworkRecorder.create({
        session: cdp, baseDir: root, sessionId: () => 'real', url: `${origin}/set`, captureBodies: true, maxBodyBytes: 4096, recordAllResources: true,
      })
      expect(recorder).toBeDefined()
      // A same-origin XHR must carry the cookie the previous response set.
      await page.evaluate(async (target: string) => {
        await fetch(target, { credentials: 'include' })
      }, `${origin}/api`)
      await new Promise(resolve => { setTimeout(resolve, 300) })
      await recorder?.finish()

      const dir = join(root, 'real')
      const lines = readFileSync(join(dir, NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(lines.some(line => line['kind'] === 'requestExtra' || line['kind'] === 'responseExtra')).toBe(true)
      const har = JSON.parse(readFileSync(join(dir, HAR_FILE), 'utf8')) as HarDocument
      const cookies = har.log.entries.flatMap(entry => entry.request.cookies.map(cookie => cookie.name))
      expect(cookies).toContain('sid')
      expect(har.log.entries.flatMap(entry => entry.response.cookies.map(cookie => cookie.name))).toContain('sid')
    } finally {
      await browser?.close().catch(() => {})
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * t15/R1: ExtraInfo belongs to a HOP, not to "whatever is in flight". A
 * redirect reuses the requestId, and CDP does not promise that a hop's
 * requestWillBeSentExtraInfo arrives after that hop's requestWillBeSent — so
 * pairing is by arrival index per requestId (the same rule Playwright's own
 * ResponseExtraInfoTracker uses), with a claim whenever a hop with that index
 * exists.
 */
describe('NetworkRecorder per-hop ExtraInfo pairing (t15/R1)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-hop-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** The two hops' ExtraInfo events, each with its own cookie. */
  const EXTRA_HOP1 = {
    requestId: '1',
    headers: { ':authority': 'app.example.com', ':path': '/old' },
    associatedCookies: [{ cookie: { name: 'hop1', value: 'cookie-one', domain: 'app.example.com', path: '/' }, blockedReasons: [] }],
  }
  const EXTRA_HOP2 = {
    requestId: '1',
    headers: { ':authority': 'api.example.com', ':path': '/v1/items', 'x-hop': 'two' },
    associatedCookies: [{ cookie: { name: 'hop2', value: 'cookie-two', domain: 'api.example.com', path: '/' }, blockedReasons: [] }],
  }
  const BASE_HOP1 = requestEvent({ requestId: '1', url: 'http://app.example.com/old', method: 'GET', headers: { accept: 'text/html' } })
  const BASE_HOP2 = {
    requestId: '1',
    type: 'Fetch',
    redirectResponse: {
      url: 'http://app.example.com/old',
      status: 301,
      statusText: 'Moved Permanently',
      mimeType: 'text/html',
      headers: { location: 'https://api.example.com/v1/items' },
    },
    request: { url: 'https://api.example.com/v1/items', method: 'GET', headers: { accept: 'application/json' } },
  }

  /** Replay one chain in the given event order and return the HAR. */
  async function chain(order: Array<Record<string, unknown>>, name: string): Promise<HarDocument> {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{"ok":true}' } } })
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => name, url: 'http://app.example.com/old',
      captureBodies: true, maxBodyBytes: 1024, recordAllResources: false,
    })
    expect(recorder).toBeDefined()
    for (const event of order) {
      const kind = String(event['__event'])
      const payload = { ...event }
      delete payload['__event']
      session.emit(kind, payload)
    }
    session.emit('Network.responseReceived', responseEvent({ requestId: '1', status: 200, mimeType: 'application/json' }))
    session.emit('Network.loadingFinished', { requestId: '1' })
    await recorder?.finish()
    return JSON.parse(readFileSync(join(root, name, HAR_FILE), 'utf8')) as HarDocument
  }

  /** Assert each hop kept its OWN cookie and headers. */
  function expectHopOwnership(har: HarDocument, label: string): void {
    expect(har.log.entries, label).toHaveLength(2)
    const [hop1, hop2] = har.log.entries
    expect(hop1?.response.status, label).toBe(301)
    expect(hop1?.request.cookies?.map(cookie => cookie.name), label).toEqual(['hop1'])
    expect(hop1?.request.headers.some(header => header.name === 'x-hop'), label).toBe(false)
    expect(hop2?.response.status, label).toBe(200)
    expect(hop2?.request.cookies?.map(cookie => cookie.name), label).toEqual(['hop2'])
    expect(hop2?.request.headers).toEqual(expect.arrayContaining([{ name: 'x-hop', value: 'two' }]))
    // The 301 hop never inherits the destination's headers.
    expect(hop1?.request.headers).toEqual(expect.arrayContaining([{ name: ':authority', value: 'app.example.com' }]))
  }

  it('keeps each hop\'s own ExtraInfo — canonical order (base, extra, base, extra)', async () => {
    const har = await chain([
      { __event: 'Network.requestWillBeSent', ...BASE_HOP1 },
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP1 },
      { __event: 'Network.requestWillBeSent', ...BASE_HOP2 },
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP2 },
    ], 'canonical')
    expectHopOwnership(har, 'canonical')
  })

  it('keeps each hop\'s own ExtraInfo when the next hop\'s ExtraInfo arrives EARLY (the race)', async () => {
    const har = await chain([
      { __event: 'Network.requestWillBeSent', ...BASE_HOP1 },
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP1 },
      // hop2's extra BEFORE hop2's base event — the reported race.
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP2 },
      { __event: 'Network.requestWillBeSent', ...BASE_HOP2 },
    ], 'early')
    expectHopOwnership(har, 'early')
  })

  it('keeps each hop\'s own ExtraInfo when a hop\'s ExtraInfo arrives LATE (after the redirect)', async () => {
    const har = await chain([
      { __event: 'Network.requestWillBeSent', ...BASE_HOP1 },
      { __event: 'Network.requestWillBeSent', ...BASE_HOP2 },
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP1 },
      { __event: 'Network.requestWillBeSentExtraInfo', ...EXTRA_HOP2 },
    ], 'late')
    expectHopOwnership(har, 'late')
  })

  it('pairs response ExtraInfo with its own hop as well', async () => {
    const session = new FakeCdpSession({ bodies: { '1': { body: '{}' } } })
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'resp', url: 'http://app.example.com/old',
      captureBodies: true, maxBodyBytes: 1024, recordAllResources: false,
    })
    session.emit('Network.requestWillBeSent', BASE_HOP1)
    session.emit('Network.responseReceivedExtraInfo', { requestId: '1', statusCode: 301, headers: { location: 'https://api.example.com/v1/items', 'set-cookie': 'hop1=one; Path=/' } })
    session.emit('Network.requestWillBeSent', BASE_HOP2)
    session.emit('Network.responseReceived', responseEvent({ requestId: '1', status: 200, mimeType: 'application/json' }))
    session.emit('Network.responseReceivedExtraInfo', { requestId: '1', statusCode: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'hop2=two; Path=/' } })
    session.emit('Network.loadingFinished', { requestId: '1' })
    await recorder?.finish()

    const har = JSON.parse(readFileSync(join(root, 'resp', HAR_FILE), 'utf8')) as HarDocument
    expect(har.log.entries).toHaveLength(2)
    expect(har.log.entries[0]?.response.cookies?.map(cookie => cookie.name)).toEqual(['hop1'])
    expect(har.log.entries[1]?.response.cookies?.map(cookie => cookie.name)).toEqual(['hop2'])
  })
})

/** t15/R2: ExtraInfo for a request the static filter drops leaves no line. */
describe('NetworkRecorder ExtraInfo vs the static filter (t15/R2)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-recorder-static-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function readJsonl(dir: string): Array<Record<string, unknown>> {
    return readFileSync(join(dir, NETWORK_JSONL_FILE), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('writes NO line when ExtraInfo arrives before a base event that proves it static', async () => {
    const session = new FakeCdpSession()
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'static', url: 'https://app.example.com/',
      captureBodies: true, maxBodyBytes: 64, recordAllResources: false,
    })
    // ExtraInfo FIRST (no base event yet), then the base event that drops it.
    session.emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'img',
      headers: { ':authority': 'cdn.example.com', ':path': '/logo.png' },
      associatedCookies: [{ cookie: { name: 'cdn', value: 'secret-cookie' }, blockedReasons: [] }],
    })
    session.emit('Network.requestWillBeSent', requestEvent({ requestId: 'img', type: 'Image', url: 'https://cdn.example.com/logo.png' }))
    session.emit('Network.responseReceivedExtraInfo', { requestId: 'img', statusCode: 200, headers: { 'content-type': 'image/png' } })
    const report = await recorder?.finish()

    expect(report?.httpCount).toBe(0)
    const kinds = readJsonl(join(root, 'static')).map(line => line['kind'])
    expect(kinds).toEqual(['session']) // no orphan requestExtra/responseExtra line
    expect(readFileSync(join(root, 'static', NETWORK_JSONL_FILE), 'utf8')).not.toContain('secret-cookie')
  })

  it('flushes a held slot whose base event never arrives, marked unclaimed', async () => {
    const session = new FakeCdpSession()
    const recorder = await NetworkRecorder.create({
      session, baseDir: root, sessionId: () => 'orphan', url: 'https://app.example.com/',
      captureBodies: true, maxBodyBytes: 64, recordAllResources: false, extraHoldMs: 10,
    })
    session.emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'ghost',
      headers: { ':authority': 'api.example.com', ':path': '/v1/ghost' },
      associatedCookies: [{ cookie: { name: 'g', value: 'v' }, blockedReasons: [] }],
    })
    await new Promise(resolve => { setTimeout(resolve, 40) }) // past the hold window
    await recorder?.finish()

    const lines = readJsonl(join(root, 'orphan'))
    const extra = lines.find(line => line['kind'] === 'requestExtra')
    expect(extra).toMatchObject({ requestId: 'ghost', unclaimed: true, cookieCount: 1 })
    expect(extra).not.toHaveProperty('url') // no hop to name
  })
})
