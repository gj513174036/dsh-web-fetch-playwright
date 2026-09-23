/**
 * The page fragments every in-page script shares.
 *
 * Three scripts now read the same page and would otherwise each answer the same
 * four questions in their own words: does this element occupy layout, which
 * `<label>` controls it, what is its accessible name, and is something else
 * sitting on top of it. Two of those answers are non-obvious and both were
 * learned the hard way on a real consent gate:
 *
 * - A hidden checkbox has no text of its own, so its name lives in the label
 *   around it — and its `value` is the literal string `on`, which must never be
 *   mistaken for a name.
 * - Laid out is not the same as clickable: a checkbox can measure fine while
 *   something sits over it, and a click aimed at it lands elsewhere.
 *
 * Fragments are declared as source text rather than functions because the
 * scripts are injected as strings. Two consequences: nothing here may contain a
 * backtick (it would end the template literal the script is built from), and the
 * order of {@link PAGE_FRAGMENTS} matters, because `accessibleNameOf` and
 * `coverageOf` call the fragments declared before them.
 *
 * @module dsh-web-fetch-playwright/page-fragments
 */

/**
 * Does the element occupy layout?
 *
 * The single answer to "is this visible" for every script here. It is a layout
 * read, not a visibility opinion: an element inside a hidden ancestor reports no
 * box, which is what we want.
 */
export const FRAGMENT_LAID_OUT = `const laidOut = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 };`

/**
 * The `<label>` that controls this element, or null.
 *
 * A label forwards a click to its control and carries the words for it, which is
 * why this is how a hidden input is reached and named.
 */
export const FRAGMENT_LABEL_HOST = `const labelHostOf = (el) => {
    if (el.closest === undefined) return null;
    const id = el.getAttribute('id');
    try { return el.closest('label') || (id ? document.querySelector('label[for="' + id.replace(/["\\\\]/g, '') + '"]') : null) } catch (error) { return null }
  };`

/**
 * The element's accessible-ish name, collapsed and unsliced.
 *
 * Order: `aria-label`, then `value` for the input types where the value *is* the
 * label (submit / button / reset), then `placeholder` for fields, then the
 * controlling label's text for form controls, then the element's own text. An
 * untagged checkbox deliberately falls through to its label rather than
 * answering `on`.
 */
export const FRAGMENT_ACCESSIBLE_NAME = `const accessibleNameOf = (el) => {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const candidates = [el.getAttribute('aria-label')];
    if (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) candidates.push(el.value);
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      candidates.push(el.getAttribute('placeholder'));
      const host = labelHostOf(el);
      if (host !== null) candidates.push(host.textContent);
    }
    candidates.push(el.textContent);
    for (const candidate of candidates) {
      const text = String(candidate || '').trim().replace(/\\s+/g, ' ');
      if (text !== '') return text;
    }
    return '';
  };`

/**
 * `covered` when something else sits at the element's centre, else `''`.
 *
 * A laid-out control can still be unclickable — a styled overlay swallows the
 * click while the element measures fine — so anything that is about to act on a
 * control asks this first.
 */
export const FRAGMENT_COVERAGE = `const coverageOf = (el) => {
    if (!laidOut(el)) return '';
    const box = el.getBoundingClientRect();
    let at = null;
    try { at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) } catch (error) { at = null }
    if (at === null) return '';
    return at === el || el.contains(at) ? '' : 'covered';
  };`

/**
 * Where this control is actually reachable: itself, through its label, or
 * nowhere.
 *
 * The answer `check` acts on. Only a real `<label>` forwards a click to its
 * control, so an unlaid-out input outside a label is simply not reachable — an
 * arbitrary parent is not a substitute.
 */
export const FRAGMENT_HOST = `const hostOf = (el) => {
    if (laidOut(el)) return 'self';
    const host = labelHostOf(el);
    return host !== null && laidOut(host) ? 'label' : 'hidden';
  };`

/** The words that mark consent UI, shared so no two scripts can disagree. */
export const CONSENT_CONTEXT = /cookie|consent|privacy|gdpr|同意|隐私/i

/** Declares the consent vocabulary inside a script. */
export const FRAGMENT_CONSENT_WORDS = `const consentWords = ${String(CONSENT_CONTEXT)};`

/**
 * Is the whole document the consent UI?
 *
 * The fourth consent signal, for a full-page interstitial (measured on
 * booking.com, whose gate is `/pipl_consent.zh-cn.html` titled 需您同意 with a
 * bare `<button>同意</button>` that has no consent-named ancestor at all). It
 * only counts while the document is small, so a long content page that merely
 * mentions consent in its URL or title cannot license a click.
 */
export const FRAGMENT_CONSENT_DOCUMENT = `const isConsentDocument = () => {
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

/** The page-reading fragments, in the order they must be declared. */
export const PAGE_FRAGMENTS: readonly string[] = [
  FRAGMENT_LAID_OUT,
  FRAGMENT_LABEL_HOST,
  FRAGMENT_HOST,
  FRAGMENT_ACCESSIBLE_NAME,
  FRAGMENT_COVERAGE,
]

/** The consent fragments, in the order they must be declared. */
export const CONSENT_FRAGMENTS: readonly string[] = [FRAGMENT_CONSENT_WORDS, FRAGMENT_CONSENT_DOCUMENT]

/**
 * What the consent dismissal needs: the vocabulary plus the control fragments it
 * names controls with.
 *
 * It takes the whole page set rather than a hand-picked subset on purpose — a
 * consumer that picks fragments itself eventually names one it did not include,
 * and the failure only shows up at run time inside the browser. Unused
 * declarations cost nothing.
 */
export const DISMISS_FRAGMENTS: readonly string[] = [...CONSENT_FRAGMENTS, ...PAGE_FRAGMENTS]

/**
 * Splice fragments into one script body.
 *
 * @param fragments - the fragments to include, in declaration order.
 * @returns the fragment source, indented to sit inside a script.
 */
export function spliceFragments(fragments: readonly string[]): string {
  return fragments.join('\n  ')
}
