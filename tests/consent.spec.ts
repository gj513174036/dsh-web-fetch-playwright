/**
 * Consent-banner dismissal: the candidate list, the in-page script that walks
 * it, and the guarantee that no failure on the page can change a fetch's
 * outcome.
 *
 * The page handle is faked structurally — `dismissConsentBanner` only reaches
 * the optional `evaluate` seam — while the script itself runs for real in
 * jsdom, so the matching and guard rules are exercised rather than restated.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CONSENT_SELECTORS, CONSENT_TIMEOUT_MS, DISMISS_SCRIPT, dismissConsentBanner } from '../src/consent.ts'
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

/**
 * The in-page half, run for real. jsdom has no layout engine, so every rect is
 * 0×0 out of the box; the harness treats elements as laid out unless a test
 * says otherwise, which keeps the visibility rules under test instead of
 * silently disabled.
 */
describe('DISMISS_SCRIPT', () => {
  const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0 }

  interface Answer {
    clicked: string | null
    problem: string | null
  }

  function run(html: string, tweak?: (dom: JSDOM) => void, url = 'https://example.com/', title = ''): Answer {
    const head = title === '' ? '' : `<title>${title}</title>`
    const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${html}</body></html>`, {
      runScripts: 'outside-only',
      url,
    })
    dom.window.Element.prototype.getBoundingClientRect = (() => ({
      ...LAID_OUT,
      toJSON: () => LAID_OUT,
    })) as unknown as Element['getBoundingClientRect']
    tweak?.(dom)
    return dom.window.eval(DISMISS_SCRIPT) as Answer
  }

  /** Make only elements whose id matches `invisibleId` report no box. */
  const hideById = (dom: JSDOM, invisibleId: string): void => {
    const dom2 = dom.window.document.getElementById(invisibleId)
    if (dom2 !== null) {
      dom2.getBoundingClientRect = (() => ({ width: 0, height: 0 })) as unknown as Element['getBoundingClientRect']
    }
  }

  it('prefers a named vendor control over the broad text rule', () => {
    const answer = run(
      '<div class="cookie-banner"><button id="onetrust-accept-btn-handler">Accept All</button>' +
        '<button>Accept All</button></div>',
    )
    expect(answer).toEqual({ clicked: '#onetrust-accept-btn-handler', problem: null })
  })

  it('clicks an unknown manager by its label inside consent UI', () => {
    const answer = run('<div class="cc-window cookie-notice"><button>Accept All</button></div>')
    expect(answer).toEqual({ clicked: 'text:"accept all"', problem: null })
  })

  it('accepts a Chinese label', () => {
    const answer = run('<div id="consent-dialog">同意我们使用 Cookie<button>全部接受</button></div>')
    expect(answer).toEqual({ clicked: 'text:"全部接受"', problem: null })
  })

  it('reads the accessible name off a submit input', () => {
    const answer = run('<div role="dialog"><input type="submit" value="Allow all"></div>')
    expect(answer).toEqual({ clicked: 'text:"allow all"', problem: null })
  })

  it('takes a dialog as consent context on its own', () => {
    const answer = run('<div role="dialog"><button>I agree</button></div>')
    expect(answer).toEqual({ clicked: 'text:"i agree"', problem: null })
  })

  it('takes a fixed overlay as consent context on its own', () => {
    const answer = run('<div data-overlay><button>Accept all</button></div>', (dom) => {
      dom.window.getComputedStyle = ((el: Element) =>
        ({ position: el.hasAttribute('data-overlay') ? 'fixed' : 'static' })) as unknown as typeof dom.window.getComputedStyle
    })
    expect(answer).toEqual({ clicked: 'text:"accept all"', problem: null })
  })

  it('refuses a label that only looks like consent', () => {
    // Same label, no consent UI anywhere around it: an "Accept all" in a
    // checkout form must not be clicked. This is the guard's whole purpose.
    expect(run('<form><button>Accept all</button></form>').clicked).toBeNull()
    expect(run('<div>Accept all</div>').clicked).toBeNull()
  })

  it('refuses near-miss labels', () => {
    const banner = (label: string) => `<div class="cookie-banner"><button>${label}</button></div>`
    expect(run(banner('Accept necessary only')).clicked).toBeNull()
    expect(run(banner('Accept selected')).clicked).toBeNull()
    expect(run(banner('Accept and continue to checkout')).clicked).toBeNull()
    expect(run(banner('Manage settings')).clicked).toBeNull()
    expect(run(banner('Reject all')).clicked).toBeNull()
  })

  it('skips a control that is not laid out', () => {
    const dom = () => run('<div class="cookie-banner"><button id="b">Accept All</button></div>', (d) => hideById(d, 'b'))
    expect(dom().clicked).toBeNull()
  })

  it('is a no-op on a page with no banner', () => {
    expect(run('<main><p>Just an article.</p></main>')).toEqual({ clicked: null, problem: null })
  })

  it('clicks the accept control of a full-page consent interstitial', () => {
    // Measured shape: booking.com's gate is /pipl_consent.zh-cn.html titled
    // 需您同意 with a bare <button>同意</button> that has no consent-named
    // ancestor — none of the three box signals hold, so the fourth (the
    // document IS the consent UI) is what has to carry it.
    const answer = run(
      '<p>我们使用 Cookie 为您提供更个性化的体验。</p><button>同意</button>',
      undefined,
      'https://www.example.com/pipl_consent.zh-cn.html?target_page=%2F',
      '需您同意',
    )
    expect(answer).toEqual({ clicked: 'text:"同意"', problem: null })
  })

  it('clicks a bare Accept/Agree on a consent page', () => {
    expect(run('<button>Accept</button>', undefined, 'https://example.com/cookie-notice', 'Consent').clicked).toBe('text:"accept"')
    expect(run('<button>Agree</button>', undefined, 'https://example.com/privacy-gate', 'Before you continue').clicked).toBe('text:"agree"')
  })

  it('refuses the same button when the page is not a consent page', () => {
    expect(run('<p>我们使用 Cookie。</p><button>同意</button>').clicked).toBeNull()
    expect(run('<button>Accept</button>').clicked).toBeNull()
  })

  it('refuses a consent-looking URL on a long page', () => {
    // The short-page half of the fourth signal: a content page that merely
    // mentions consent in its URL must not license a click on any button.
    const long = `<p>${'内容。'.repeat(900)}</p><button>同意</button>`
    expect(run(long, undefined, 'https://example.com/consent-policy-explained').clicked).toBeNull()
  })

  it('reports a throwing click instead of swallowing it', () => {
    const answer = run('<div class="cookie-banner"><button id="b">Accept All</button></div>', (dom) => {
      const button = dom.window.document.getElementById('b')
      if (button !== null) {
        button.click = () => {
          throw new Error('detached')
        }
      }
    })
    expect(answer.clicked).toBeNull()
    expect(answer.problem).toContain('detached')
  })
})
