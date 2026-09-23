/**
 * Consent-banner dismissal: satisfy ONE intent — "the consent banner is not in
 * the way any more" — by trying its candidates in order and stopping at the
 * first visible hit.
 *
 * The candidate list is the point. It has two kinds, ordered most precise
 * first: `selector` candidates are the stable per-vendor controls of the named
 * consent managers, and the single trailing `text` candidate is the broad rule
 * that catches managers this plugin has never heard of. Because the precise
 * ones get their chance first and the broad one runs only if they all miss, a
 * page is never clicked twice and the broad rule never overrides a vendor's own
 * control.
 *
 * What makes a broad text rule safe is the context guard: the control must
 * already be part of something that looks like consent UI. There are four ways
 * to be, because consent UI comes in two shapes — a box inside a page (a
 * dialog, a consent-named ancestor, a fixed/sticky overlay) and a whole page
 * that IS the consent (a full-page interstitial, which has none of the first
 * three). The fourth signal therefore reads the document itself — URL or title
 * matching the consent vocabulary — and only while the document is short, so a
 * long content page that merely mentions consent cannot license a click.
 *
 * This is a deliberate preference for missing a banner over clicking the wrong
 * thing — an "Accept all" button in the middle of a checkout form is not
 * consent UI, and a wrong click writes the user's *rejection* into their
 * profile, which retrying cannot undo.
 *
 * Scope: the main frame only. Consent managers that render their banner inside
 * an iframe are not covered yet — this waits for a real site that does it,
 * rather than paying for a hypothetical one.
 *
 * Opt-in (`dismissConsent`, default off) because the click is not a neutral
 * act: it records the user's consent in whatever profile the fetch runs in.
 * Best effort in every direction: no banner, a backend whose page handle has no
 * `evaluate`, a stalled probe, an unparseable answer, and a throwing click all
 * leave the fetch's own outcome untouched; the caller reports a `problem` at
 * most.
 *
 * @module dsh-web-fetch-playwright/consent
 */

import type { PlaywrightPage } from './types.ts'

/**
 * The accept-all controls of the consent managers this plugin knows by name,
 * most specific first.
 *
 * Every entry names an accept-all control. A selector that could plausibly be a
 * reject/manage control is deliberately absent: guessing wrong would record a
 * rejection on the user's behalf, so a missing selector is the safer failure.
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
  // An accept-all control that says so, whatever manager it belongs to.
  'button[aria-label*="accept all" i]',
]

/**
 * Labels that mean "accept everything", compared for equality after
 * normalisation (trimmed, collapsed whitespace, lowercased).
 *
 * Equality rather than substring on purpose: "accept necessary only", "accept
 * selected", and "accept and continue to checkout" all *contain* an accept
 * word, and none of them means the user accepted everything.
 */
export const ACCEPT_ALL_LABELS: readonly string[] = [
  // Chinese
  '全部接受',
  '接受全部',
  '全部同意',
  '同意全部',
  '接受所有',
  '接受并继续',
  '同意并继续',
  '我同意',
  '同意',
  '接受',
  // English
  'accept all',
  'accept all cookies',
  'accept cookies',
  'allow all',
  'allow all cookies',
  'agree to all',
  'i agree',
  'accept',
  'agree',
]

/** One way to satisfy the consent intent. */
export type ConsentCandidate =
  /** A named vendor's control, reached by CSS selector. */
  | { readonly kind: 'selector'; readonly selector: string }
  /**
   * A control that says "accept all", reached by its own label — but only
   * inside consent-looking UI (see {@link CONSENT_CONTEXT}).
   */
  | { readonly kind: 'text' }

/**
 * Ancestor text that marks consent UI: the id, class, or aria-label of the
 * control itself, or of up to five ancestors.
 */
export const CONSENT_CONTEXT = /cookie|consent|privacy|gdpr|同意|隐私/i

/** The controls the text candidate is allowed to consider. */
const CONTROLS = 'button, [role="button"], input[type="button" i], input[type="submit" i], a[href]'

/** How long the page gets to answer the dismissal probe. */
export const CONSENT_TIMEOUT_MS = 3_000

/**
 * The intent's candidates, in the order they are tried.
 *
 * Selectors first, the text rule last: the broad rule must never pre-empt a
 * vendor's own control.
 */
export const CONSENT_CANDIDATES: readonly ConsentCandidate[] = [
  ...CONSENT_SELECTORS.map((selector): ConsentCandidate => ({ kind: 'selector', selector })),
  { kind: 'text' },
]

/**
 * One dismissal attempt's outcome.
 *
 * @property clicked - what was clicked, or null when the page offered nothing
 *   (also the outcome for a page that cannot be probed). A selector candidate
 *   reports its selector; the text candidate reports `text:"<label>"`.
 * @property problem - what went wrong, or null. Never fails the fetch.
 * @property gate - whether the click came from the page-level signal, i.e. the
 *   whole document was the gate rather than a box inside a page. Only a gate
 *   click needs its outcome verified: a gate that ignores the click leaves the
 *   caller reading the gate as if it were the page.
 */
export interface ConsentOutcome {
  clicked: string | null
  problem: string | null
  gate: boolean
}

/** Sentinel for {@link raceTimeout}, distinct from any page answer. */
const TIMED_OUT = Symbol('consent-timeout')

/**
 * The in-page half of the dismissal: walk the candidates in order, take the
 * first one that is really there, and click it.
 *
 * In-page rather than `locator().click()` because `PlaywrightPage.evaluate` is
 * already the abstraction's scripting seam (the challenge probe uses it) and
 * stays optional, so minimal backends and test fakes need no new members.
 *
 * Exported so tests can run the real script against real markup instead of
 * asserting against a copy of it. Inside the text pass the work is ordered
 * cheapest first — label comparison, then the context walk, then the layout
 * read — so a page with thousands of controls pays for a layout read only on
 * the few that could be a consent button.
 */
/**
 * The "this document IS the consent UI" test, shared by the dismissal script and
 * the post-click probe so the two can never disagree about what a gate is.
 */
const GATE_TEST_SOURCE = `const consentWords = ${String(CONSENT_CONTEXT)};
  const isConsentDocument = () => {
    const body = document.body;
    if (body === null) return false;
    // innerText is the visible text and is what we want; jsdom (where the tests
    // run) has no layout and no innerText, so fall back to textContent, a
    // superset - which makes the "short page" test harder to pass, i.e. erring
    // towards not clicking.
    const inner = body.innerText;
    const text = typeof inner === 'string' && inner !== '' ? inner : (body.textContent || '');
    if (text.length >= 2000) return false;
    return consentWords.test(location.href + ' ' + document.title);
  };`

export const DISMISS_SCRIPT = `(() => {
  const candidates = ${JSON.stringify(CONSENT_CANDIDATES)};
  const labels = ${JSON.stringify(ACCEPT_ALL_LABELS.map((label) => label.toLowerCase()))};
  const controls = ${JSON.stringify(CONTROLS)};
  ${GATE_TEST_SOURCE}
  const isVisible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 };
  const labelOf = (el) => String((el.getAttribute('aria-label') || el.value || el.textContent) || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const namesConsent = (el) => consentWords.test([el.id || '', typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') || ''].join(' '));
  const styleOf = (el) => { try { return el.ownerDocument.defaultView.getComputedStyle(el) } catch (error) { return null } };
  const inConsentContext = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (namesConsent(node)) return true;
      if (node.getAttribute && (node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true')) return true;
      if (node.tagName === 'DIALOG' && node.hasAttribute('open')) return true;
      const style = styleOf(node);
      if (style && (style.position === 'fixed' || style.position === 'sticky')) return true;
    }
    return false;
  };
  // The fourth signal (isConsentDocument, above) covers a full-page consent
  // interstitial: measured on booking.com, whose gate is
  // /pipl_consent.zh-cn.html titled 需您同意 with a bare <button>同意</button>
  // that has no consent-named ancestor at all.
  const gate = isConsentDocument();
  for (const candidate of candidates) {
    if (candidate.kind === 'selector') {
      let target = null;
      try { target = document.querySelector(candidate.selector) } catch (error) { continue }
      if (target === null || !isVisible(target)) continue;
      try { target.click() } catch (error) { return { clicked: null, problem: candidate.selector + ': ' + String(error), gate: false } }
      return { clicked: candidate.selector, problem: null, gate: false };
    }
    if (candidate.kind === 'text') {
      let found = [];
      try { found = document.querySelectorAll(controls) } catch (error) { continue }
      for (const control of found) {
        const label = labelOf(control);
        if (label === '' || label.length > 40 || labels.indexOf(label) === -1) continue;
        if (!gate && !inConsentContext(control)) continue;
        if (!isVisible(control)) continue;
        try { control.click() } catch (error) { return { clicked: null, problem: 'text "' + label + '": ' + String(error), gate: gate } }
        return { clicked: 'text:"' + label + '"', problem: null, gate: gate };
      }
    }
  }
  return { clicked: null, problem: null, gate: false };
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
 * Whether the document currently on screen is a consent gate.
 *
 * The dismissal used to treat "clicked" as "done": on a gate that ignores the
 * click it went on to read the gate page as the result, which is the same
 * silent-wrong-answer the action model forbids for its steps. The caller asks
 * this after a gate click, so a gate that did not clear becomes a loud failure
 * instead of a plausible-looking page.
 */
export const CONSENT_GATE_PROBE = `(() => {
  ${GATE_TEST_SOURCE}
  return isConsentDocument();
})()`

/**
 * Ask the page whether it is still a consent gate.
 *
 * @param page - the page the fetch is reading.
 * @param timeoutMs - budget for the probe.
 * @returns true/false, or null when the page cannot be asked or did not answer
 *   (an unanswerable page is never treated as a cleared gate).
 */
export async function isConsentGate(page: PlaywrightPage, timeoutMs: number = CONSENT_TIMEOUT_MS): Promise<boolean | null> {
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) return null
  try {
    const answer = await raceTimeout(evaluate(CONSENT_GATE_PROBE), Math.max(0, timeoutMs))
    if (answer === TIMED_OUT) return null
    return answer === true
  } catch {
    return null
  }
}

/**
 * Dismiss a consent banner on `page`, if one is showing.
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
  if (evaluate === undefined) return { clicked: null, problem: null, gate: false }

  let answer: unknown
  try {
    answer = await raceTimeout(evaluate(DISMISS_SCRIPT), Math.max(0, timeoutMs))
  } catch (error: unknown) {
    return { clicked: null, problem: error instanceof Error ? error.message : String(error), gate: false }
  }
  if (answer === TIMED_OUT) return { clicked: null, problem: `the page did not answer within ${String(timeoutMs)}ms`, gate: false }
  // A page handle that answers with something else (a fake, an exotic
  // backend) is read as "no banner" rather than as a failure.
  if (typeof answer !== 'object' || answer === null) return { clicked: null, problem: null, gate: false }

  const { clicked, problem, gate } = answer as { clicked?: unknown; problem?: unknown; gate?: unknown }
  return {
    clicked: typeof clicked === 'string' ? clicked : null,
    problem: typeof problem === 'string' ? problem : null,
    gate: gate === true,
  }
}
