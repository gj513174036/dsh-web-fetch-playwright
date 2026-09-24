#!/usr/bin/env node
/**
 * Standalone capture over CDP — no DSH plugin, no fetch budget, no tool
 * timeout. It attaches to the browser at `--endpoint`, records the tab a human
 * is about to drive, and appends netdump-readable JSONL while it runs.
 *
 * Why it exists: the plugin's recorder only ever sees the tab a *fetch* opens,
 * and a fetch is bounded by the plugin budget plus the tool layer's timeout —
 * so a person clicking through an unfamiliar intranet system has a window of
 * tens of seconds. This script has no such bound: it records until `--minutes`
 * is up, however long that is.
 *
 * Usage:
 *   node tools/his/capture.mjs --url <url> [--out capture.jsonl] [--minutes 15]
 *                              [--endpoint http://127.0.0.1:9222] [--new-tab]
 *
 * Then:
 *   PYTHONPATH=tools/netdump python3 -m netdump summary capture.jsonl
 *
 * Output records are netdump's "simplified" shape (`kind`: request | response |
 * responseBody), which `tools/netdump/netdump/har.py` reads directly.
 *
 * The dump carries plaintext credentials (Cookie / Authorization / bodies), so
 * the file is created 0600 and never leaves the machine it was written on.
 */

import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

/** Read `--name value`, or the fallback. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const url = arg('url', '')
const out = arg('out', 'his-capture.jsonl')
const minutes = Number(arg('minutes', '15'))
const endpoint = arg('endpoint', process.env['CDP_ENDPOINT'] ?? 'http://127.0.0.1:9222')
const forceNewTab = process.argv.includes('--new-tab')

if (url === '' && !forceNewTab) {
  console.error('usage: node tools/his/capture.mjs --url <url> [--out file.jsonl] [--minutes 15]')
  process.exit(2)
}

writeFileSync(out, '')
chmodSync(out, 0o600)

let written = 0
const apiUrls = new Set()
const write = (record) => {
  appendFileSync(out, `${JSON.stringify(record)}\n`)
  written += 1
  if (typeof record['url'] === 'string' && record['url'].includes('/apis/')) {
    apiUrls.add(`${String(record['method'] ?? 'GET')} ${record['url'].split('?')[0]}`)
  }
}

// A stable, human-readable id per request, without touching Playwright internals.
const ids = new WeakMap()
let seq = 0
const idOf = (request) => {
  let id = ids.get(request)
  if (id === undefined) {
    seq += 1
    id = String(seq)
    ids.set(request, id)
  }
  return id
}

const browser = await chromium.connectOverCDP(endpoint)
const context = browser.contexts()[0]
if (context === undefined) {
  console.error('the CDP endpoint exposed no default context — is the browser running with a real profile?')
  process.exit(3)
}

const wanted = url === '' ? '' : new URL(url).host
let page = forceNewTab ? undefined : context.pages().find((candidate) => wanted !== '' && candidate.url().includes(wanted))
let opened = false
if (page === undefined) {
  page = await context.newPage()
  opened = true
  if (url !== '') await page.goto(url, { waitUntil: 'domcontentloaded' })
}

page.on('request', (request) => {
  void (async () => {
    let headers = {}
    try { headers = await request.allHeaders() } catch { headers = request.headers() }
    write({
      kind: 'request',
      requestId: idOf(request),
      url: request.url(),
      method: request.method(),
      requestHeaders: headers,
      postData: request.postData() ?? '',
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    })
  })()
})

page.on('response', (response) => {
  void (async () => {
    const request = response.request()
    let headers = {}
    try { headers = await response.allHeaders() } catch { headers = response.headers() }
    const mime = headers['content-type'] ?? ''
    write({
      kind: 'response',
      requestId: idOf(request),
      url: response.url(),
      status: response.status(),
      responseHeaders: headers,
      responseMimeType: mime,
      timestamp: new Date().toISOString(),
    })
    try {
      const body = await response.text()
      write({
        kind: 'responseBody',
        requestId: idOf(request),
        url: response.url(),
        body,
        mimeType: mime,
        base64Encoded: false,
      })
    } catch {
      // A body that is gone (navigation destroyed it, or it is a stream) is not
      // a failure of the capture: the URL, status and headers are still there.
    }
  })()
})

const deadline = Date.now() + minutes * 60_000
console.log(`recording ${page.url()}`)
console.log(`  tab        : ${opened ? 'opened by this script' : 'an existing tab you already had open'}`)
console.log(`  output     : ${out} (0600)`)
console.log(`  will stop  : ${new Date(deadline).toLocaleTimeString()} (${String(minutes)} min) — Ctrl-C stops earlier, the file stays`)

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  console.log(`  … ${String(written)} records, ${String(apiUrls.size)} API endpoints seen`)
}

console.log(`\nwrote ${String(written)} records to ${out}`)
console.log(`API endpoints seen (${String(apiUrls.size)}):`)
for (const seen of [...apiUrls].sort()) console.log(`  ${seen}`)
// Deliberately NOT browser.close(): over connectOverCDP that can take the
// human's whole browser down. Dropping the connection is enough.
process.exit(0)
