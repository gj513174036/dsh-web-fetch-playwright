#!/usr/bin/env node
/**
 * probe-site.mjs — classify how hard one page is to take data from.
 *
 * Read-only: opens one tab per URL in the already-running browser, records that
 * tab's traffic over CDP, reads a few interaction signals from the DOM, closes
 * the tab, prints one JSON line per URL.
 *
 * Why this exists next to `web_fetch` + `netdump`: those two are the canonical
 * path for a site we are going to run (they produce a real capture on disk), but
 * they also hand back the whole page body. Sweeping a dozen sites to find out
 * *which kind of site* needs the action model does not need the bodies — only the
 * verdict — so this keeps the sweep cheap and the transcript small.
 *
 * The verdict is deliberately coarse, and it says what the fetch already
 * achieved, because that is what decides whether an action model is needed at
 * all:
 *
 *   ok-no-actions   the served document already holds the content
 *   api-replayable  little served text, but replayable JSON endpoints exist
 *   api-opaque      little served text, endpoints look signed/unreplayable
 *   needs-action    little text, no JSON endpoint, but load-more/tabs present
 *   login-gated     a login wall stands where the content should be
 *   unclear         none of the above held
 *
 * Usage: node tools/probe/probe-site.mjs <url> [<url> ...]
 */

import { chromium } from 'playwright-core'

/** Hosts whose JSON is telemetry, not data. */
const TELEMETRY =
  /google-analytics|googletagmanager|doubleclick|sentry|facebook|hotjar|criteo|segment|mixpanel|amplitude|clarity|baidu|umeng|growingio|sensorsdata|newrelic|datadog|optimizely|branch\.io|adjust|appsflyer|cloudflareinsights|cdn-cgi|sentry\.io|histats|matomo|piwik/i

/** JSON-ish payloads that are plausibly the page's data. */
const DATA_MIME = /json|graphql/i

/** Serialise a URL to its template form so repeats collapse. */
const template = (raw) => {
  const url = new URL(raw)
  return `${url.origin}${url.pathname.replace(/\/\d{3,}/g, '/{id}')}`
}

/** Strip the query string when reporting (it is usually the interesting part, but long). */
const brief = (raw) => {
  const url = new URL(raw)
  const query = url.search === '' ? '' : `${url.search.slice(0, 40)}${url.search.length > 40 ? '…' : ''}`
  return `${url.origin}${url.pathname}${query}`
}

async function probe(browser, target) {
  const context = browser.contexts()[0]
  const page = await context.newPage()
  const traffic = []
  let session = null
  try {
    session = await context.newCDPSession(page)
    await session.send('Network.enable')
    session.on('Network.responseReceived', (event) => {
      const { response, type } = event
      traffic.push({
        type,
        status: response.status,
        mime: response.mimeType ?? '',
        url: response.url,
      })
    })
  } catch {
    session = null
  }

  try {
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const documentMime = response === null ? '' : (response.headers()['content-type'] ?? '')
    await page.waitForTimeout(8_000)

    const dom = await page.evaluate(() => {
      const text = document.body === null ? '' : document.body.innerText
      const count = (selector) => document.querySelectorAll(selector).length
      const has = (pattern) => pattern.test(text)
      return {
        title: document.title.slice(0, 90),
        textChars: text.length,
        buttons: count('button, [role="button"]'),
        links: count('a[href]'),
        expandables: count('[role="tab"], [aria-expanded], details'),
        canvases: count('canvas'),
        images: count('img'),
        loadMore: has(/load more|show more|加载更多|查看更多|更多结果|\+\s*more/i),
        loginWall: has(/sign in|log in|登录|注册/i),
        paywall: has(/subscribe|members only|upgrade|订阅|会员专享|开通会员/i),
      }
    })

    const data = traffic.filter((entry) => DATA_MIME.test(entry.mime) && !TELEMETRY.test(entry.url))
    const groups = new Map()
    for (const entry of data) {
      const key = `${entry.status} ${template(entry.url)}`
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    const endpoints = [...groups.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, calls]) => `${key} ×${String(calls)}`)

    const looksSigned = data.some((entry) => /[?&](sign|sig|token|hmac|_signature|timestamp|nonce)=/i.test(entry.url))
    // The primary question is "did the fetch already get the content?", because
    // that is what decides whether anything else is needed at all. Endpoints are
    // the secondary question: they are how a *crawler* would replay it, and a
    // page can have both (server-rendered copy plus account/config APIs that
    // carry no content — examine.com is exactly that).
    const verdict =
      dom.loginWall && dom.textChars < 800
        ? 'login-gated'
        : dom.textChars >= 2_000
          ? 'ok-no-actions'
          : data.length > 0
            ? looksSigned
              ? 'api-opaque'
              : 'api-replayable'
            : dom.loadMore || dom.expandables > 0
              ? 'needs-action'
              : 'unclear'

    return {
      url: target,
      status: response === null ? null : response.status(),
      finalUrl: page.url(),
      documentMime,
      verdict,
      contentChars: dom.textChars,
      jsonEndpoints: data.length,
      endpointsSigned: looksSigned,
      title: dom.title,
      signals: {
        buttons: dom.buttons,
        links: dom.links,
        expandables: dom.expandables,
        loadMore: dom.loadMore,
        loginWall: dom.loginWall,
        paywall: dom.paywall,
        canvases: dom.canvases,
        images: dom.images,
      },
      endpoints,
    }
  } catch (error) {
    return { url: target, error: String(error).split('\n')[0].slice(0, 140) }
  } finally {
    await page.close().catch(() => {})
  }
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
for (const target of process.argv.slice(2)) {
  const result = await probe(browser, target)
  console.log(JSON.stringify(result))
}
// Never `browser.close()` on a connectOverCDP handle: drop the socket instead.
process.exit(0)
