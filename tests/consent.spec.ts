/**
 * Consent-banner dismissal: the in-page probe's contract, and the guarantee
 * that no failure on the page can change a fetch's outcome.
 *
 * The page handle is faked structurally — `dismissConsentBanner` only reaches
 * the optional `evaluate` seam — so these tests drive the real selector list
 * and the real answer parsing.
 */
import { describe, expect, it } from 'vitest'
import { CONSENT_SELECTORS, CONSENT_TIMEOUT_MS, dismissConsentBanner } from '../src/consent.ts'
import type { PlaywrightPage } from '../src/types.ts'

/** A page whose only member is a scripted `evaluate`. */
function pageWith(evaluate: (script: string) => Promise<unknown>): PlaywrightPage {
  return { evaluate } as unknown as PlaywrightPage
}

describe('dismissConsentBanner', () => {
  it('sends every known accept-all selector to the page, in order', async () => {
    let sent = ''
    const outcome = await dismissConsentBanner(pageWith(async (script) => {
      sent = script
      return { clicked: null, problem: null }
    }))
    expect(outcome).toEqual({ clicked: null, problem: null })
    // The script carries the whole ordered list, JSON-encoded.
    for (const selector of CONSENT_SELECTORS) expect(sent).toContain(JSON.stringify(selector))
    expect(sent.indexOf(JSON.stringify(CONSENT_SELECTORS[0]))).toBeLessThan(
      sent.indexOf(JSON.stringify(CONSENT_SELECTORS[CONSENT_SELECTORS.length - 1] ?? '')),
    )
  })

  it('reports the selector the page clicked', async () => {
    const outcome = await dismissConsentBanner(pageWith(async () => ({ clicked: '#truste-consent-button', problem: null })))
    expect(outcome).toEqual({ clicked: '#truste-consent-button', problem: null })
  })

  it('reads a page that offered no banner as a no-op, not a problem', async () => {
    expect(await dismissConsentBanner(pageWith(async () => ({ clicked: null, problem: null }))))
      .toEqual({ clicked: null, problem: null })
  })

  it('never throws when the page cannot run the probe', async () => {
    const outcome = await dismissConsentBanner(pageWith(async () => {
      throw new Error('Execution context was destroyed')
    }))
    expect(outcome.clicked).toBeNull()
    expect(outcome.problem).toBe('Execution context was destroyed')
  })

  it('never throws when the answer is not the shape it expects', async () => {
    // The challenge probe's fake evaluate answers a boolean; so does a handle
    // this module knows nothing about. Neither may be read as "clicked".
    expect(await dismissConsentBanner(pageWith(async () => false))).toEqual({ clicked: null, problem: null })
    expect(await dismissConsentBanner(pageWith(async () => null))).toEqual({ clicked: null, problem: null })
    expect(await dismissConsentBanner(pageWith(async () => ({ clicked: 42, problem: 7 }))))
      .toEqual({ clicked: null, problem: null })
  })

  it('is a silent no-op on a page handle without `evaluate`', async () => {
    const outcome = await dismissConsentBanner({} as unknown as PlaywrightPage)
    expect(outcome).toEqual({ clicked: null, problem: null })
  })

  it('gives up on a stalled probe instead of spending the fetch budget', async () => {
    const outcome = await dismissConsentBanner(pageWith(() => new Promise(() => {})), 20)
    expect(outcome.clicked).toBeNull()
    expect(outcome.problem).toContain('did not answer')
  })

  it('bounds the default probe well inside a fetch deadline', () => {
    expect(CONSENT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CONSENT_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
