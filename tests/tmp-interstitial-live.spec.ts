/**
 * TEMPORARY live investigation (deleted after running): a consent gate that
 * only records consent, without moving the browser.
 */
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { DISMISS_SCRIPT } from '../src/consent.ts'

describe('live consent interstitial', () => {
  it('investigates whether re-asking for the page gets past the gate', async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
    const page = await browser.contexts()[0]!.newPage()
    const snapshot = () =>
      page.evaluate(() => ({ url: location.href.slice(0, 90), title: document.title, chars: document.body.innerText.length, cookies: document.cookie.slice(0, 300) }))
    try {
      await page.goto('https://www.booking.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(6000)
      const beforeCookie = (await snapshot()).cookies
      console.log('GATE      :', JSON.stringify(await snapshot()))

      const answer = await page.evaluate(DISMISS_SCRIPT)
      console.log('CLICK     :', JSON.stringify(answer))
      await page.waitForTimeout(4000)
      const afterClick = await snapshot()
      console.log('AFTER CLICK:', JSON.stringify(afterClick))
      console.log('cookie changed by the click:', beforeCookie !== afterClick.cookies)

      // Re-ask for the page we were sent to fetch.
      const again = await page.goto('https://www.booking.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(4000)
      const settled = await snapshot()
      console.log('RE-GOTO   :', 'status=' + String(again === null ? 'null' : again.status()), JSON.stringify(settled))

      expect(answer.clicked).toBe('text:"同意"')
    } finally {
      await page.close()
    }
  }, 240_000)
})
