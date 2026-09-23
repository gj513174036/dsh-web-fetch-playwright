/**
 * Consent-banner dismissal: click the "accept all" control of the consent
 * managers this plugin knows, before the document is read.
 *
 * Opt-in (`dismissConsent`, default off) because the click is not a neutral
 * act: it records the user's consent in whatever profile the fetch runs in —
 * the real profile on the CDP and DSH-managed backends — and it is best
 * effort in every direction. A page with no banner, a backend whose page
 * handle has no `evaluate`, a selector that matches nothing, and a click that
 * throws all leave the fetch's own outcome untouched; the caller reports a
 * `problem` at most.
 *
 * Every entry in {@link CONSENT_SELECTORS} names an accept-all control. A
 * selector that could plausibly be a reject/manage control is deliberately
 * absent: guessing wrong would record a *rejection* on the user's behalf, so
 * a missing selector is the safer failure.
 *
 * @module dsh-web-fetch-playwright/consent
 */

import type { PlaywrightPage } from './types.ts'

/**
 * Accept-all controls, most specific first; the first visible match wins.
 *
 * Measured on cn.iherb.com, whose TrustArc banner renders
 * `#truste-consent-button` with the label 全部接受.
 */
export const CONSENT_SELECTORS: readonly string[] = [
  // OneTrust
  '#onetrust-accept-btn-handler',
  // TrustArc
  '#truste-consent-button',
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  // Didomi
  '#didomi-notice-agree-button',
  // Osano
  '.osano-cm-accept-all',
  // Usercentrics
  '[data-testid="uc-accept-all-button"]',
  // CookieYes
  '.cky-btn-accept',
  // Complianz
  '.cmplz-btn.cmplz-accept',
  // Iubenda
  '.iubenda-cs-accept-btn',
  // Klaro
  '.klaro .cm-btn-accept-all',
  // Google Funding Choices
  '.fc-cta-consent',
  // Quantcast Choice (summary view: primary = agree, secondary = options)
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  // Last resort: an accept-all control that says so, in any language-neutral
  // aria label. `*=` keeps it to "accept all", never a bare "accept".
  'button[aria-label*="accept all" i]',
]

/** How long the page gets to answer the dismissal probe. */
export const CONSENT_TIMEOUT_MS = 3_000

/**
 * One dismissal attempt's outcome.
 *
 * @property clicked - the selector whose control was clicked, or null when
 *   the page offered none (also the outcome for a page that cannot be probed).
 * @property problem - what went wrong, or null. Never fails the fetch.
 */
export interface ConsentOutcome {
  clicked: string | null
  problem: string | null
}

/** Sentinel for {@link raceTimeout}, distinct from any page answer. */
const TIMED_OUT = Symbol('consent-timeout')

/**
 * The in-page half of the dismissal: walk {@link CONSENT_SELECTORS} in order,
 * take the first control that is actually laid out, and click it.
 *
 * In-page rather than `locator().click()` because `PlaywrightPage.evaluate` is
 * already the abstraction's scripting seam (the challenge probe uses it) and
 * stays optional, so minimal backends and test fakes need no new members.
 * `getBoundingClientRect` — not `isVisible` — decides visibility because it is
 * one call for both the hidden-ancestor and zero-size cases, and a click is
 * attempted on exactly one element per page: the first match wins, so a site
 * running two consent managers cannot be double-answered.
 */
const DISMISS_SCRIPT = `(() => {
  const selectors = ${JSON.stringify(CONSENT_SELECTORS)};
  for (const selector of selectors) {
    let target = null;
    try { target = document.querySelector(selector); } catch (error) { continue; }
    if (target === null) continue;
    const box = target.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    try { target.click(); } catch (error) { return { clicked: null, problem: selector + ': ' + String(error) }; }
    return { clicked: selector, problem: null };
  }
  return { clicked: null, problem: null };
})()`

/**
 * Settle `work`, or give up after `ms` — the page's execution context can be
 * destroyed mid-call, and a stalled probe must not spend the fetch's budget.
 *
 * @param work - the promise to bound.
 * @param ms - the budget in milliseconds.
 * @returns the value, or {@link TIMED_OUT}.
 */
function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(TIMED_OUT) }, ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Dismiss a known consent banner on `page`, if one is showing.
 *
 * @param page - the page the fetch just loaded.
 * @param timeoutMs - budget for the probe; must stay well inside the fetch's
 *   own deadline.
 * @returns what was clicked (if anything) and what went wrong (if anything).
 */
export async function dismissConsentBanner(
  page: PlaywrightPage,
  timeoutMs: number = CONSENT_TIMEOUT_MS,
): Promise<ConsentOutcome> {
  // Bound first: the optional member is read once, and calling it through the
  // bind keeps the receiver real Playwright's implementation expects.
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) return { clicked: null, problem: null }

  let answer: unknown
  try {
    answer = await raceTimeout(evaluate(DISMISS_SCRIPT), Math.max(0, timeoutMs))
  } catch (error: unknown) {
    return { clicked: null, problem: error instanceof Error ? error.message : String(error) }
  }
  if (answer === TIMED_OUT) return { clicked: null, problem: `the page did not answer within ${String(timeoutMs)}ms` }
  // A page handle that answers with something else (a fake, an exotic
  // backend) is read as "no banner" rather than as a failure.
  if (typeof answer !== 'object' || answer === null) return { clicked: null, problem: null }

  const { clicked, problem } = answer as { clicked?: unknown; problem?: unknown }
  return {
    clicked: typeof clicked === 'string' ? clicked : null,
    problem: typeof problem === 'string' ? problem : null,
  }
}
