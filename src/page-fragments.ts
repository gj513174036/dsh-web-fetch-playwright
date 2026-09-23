/**
 * The page fragments every in-page script shares.
 *
 * Four scripts now read the same page and would otherwise each answer the same
 * questions in their own words: does this element occupy layout, which
 * `<label>` controls it, what is its accessible name, what is its role, and is
 * something else sitting on top of it. Two of those answers are non-obvious and
 * both were learned the hard way on a real consent gate:
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
 * label (submit / button / reset), then the controlling label's text for form
 * controls, then a field's `placeholder`, then the element's own text. An
 * untagged checkbox deliberately falls through to its label rather than
 * answering `on`.
 */
export const FRAGMENT_ACCESSIBLE_NAME = `const accessibleNameOf = (el) => {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const candidates = [el.getAttribute('aria-label')];
    if (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) candidates.push(el.value);
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      // A label is what the field is called; a placeholder is only a hint, so the
      // label goes first even though the placeholder is nearer to hand.
      const host = labelHostOf(el);
      if (host !== null) candidates.push(host.textContent);
      candidates.push(el.getAttribute('placeholder'));
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

/**
 * The element's role, as far as a target needs one.
 *
 * A small mapping rather than the ARIA specification: the roles a target
 * actually names (button, link, checkbox, radio, tab, textbox, searchbox,
 * combobox), with the explicit `role` attribute first because it overrides the
 * tag. An element outside the mapping answers `''` — it stays reachable by
 * selector or by text, so the gap costs one candidate kind, never a control.
 *
 * Roles come from a fixed table instead of the accessibility tree because the
 * scripts run in whatever backend the fetch has, and the tree is not part of the
 * seam this plugin owns.
 */
export const FRAGMENT_ROLE = `const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit !== '') return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'option') return 'option';
    return '';
  };`

/**
 * Is this control disabled, however it says so?
 *
 * One answer, asked by everything that needs it: a click or a check must not be
 * aimed at a control that cannot react, and a state condition must be able to
 * ask whether a control is disabled at all. Three carriers, because the DOM has
 * three: the property, `aria-disabled` for custom controls, and a disabled
 * `<fieldset>` around it (which the control itself says nothing about).
 */
export const FRAGMENT_DISABLED = `const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true' || (el.closest !== undefined && el.closest('fieldset[disabled]') !== null);`

/**
 * Where a click on this control has to land, or why it cannot land at all.
 *
 * The single answer to "how would a person do this", asked *before* anything is
 * clicked, and the question turned out to have a longer answer than the first
 * draft assumed. A disabled control does nothing (including one inside a
 * disabled `<fieldset>`, which carries no `disabled` of its own — the HTML
 * exception for a fieldset's first `<legend>` is deliberately not modelled,
 * because refusing a control that would have worked is the cheap direction).
 * Whether it is disabled is {@link FRAGMENT_DISABLED}'s answer, not a second
 * one. Anything else is asked the same question twice: is the control itself
 * hit-able, and if not, is the `<label>` that forwards a click to it?
 *
 * That second question is not a fallback for a hidden input only. Measured on
 * booking.com's consent gate, whose five `<input type="checkbox">` are 1×1 px
 * with a 897×20 `<label for=…>` beside them: the input *is* laid out, so a
 * "laid out or not" test declares it hittable — and then `elementFromPoint` at
 * its centre finds the styled span the label draws over it. A person ticks that
 * box by clicking the label, and now so does the plugin.
 *
 * @returns the element to act on (`hit`), where it was found (`self` or
 *   `label`), and the reason when there is none.
 */
export const FRAGMENT_HIT_TARGET = `const hitTargetOf = (el) => {
    if (isDisabled(el)) return { hit: null, host: null, reason: 'disabled' };
    if (laidOut(el) && coverageOf(el) === '') return { hit: el, host: 'self', reason: '' };
    const label = labelHostOf(el);
    if (label !== null && laidOut(label) && coverageOf(label) === '') return { hit: label, host: 'label', reason: '' };
    return { hit: null, host: null, reason: !laidOut(el) && (label === null || !laidOut(label)) ? 'not laid out' : 'covered' };
  };`

/**
 * The controls a `text` or `role` candidate is allowed to consider.
 *
 * Deliberately one neighbourhood for both kinds: a text candidate names a
 * control by the words a person reads (its label, its value, its placeholder),
 * and a role candidate names one by what it is — a search box a `type` step will
 * write into is found by text or by `role: "searchbox"` just as a button is.
 * Order within the page decides between matches, which is why the winner is
 * named in the summary rather than left implicit.
 */
export const CANDIDATE_CONTROLS = 'button, a[href], input, select, textarea, label, summary, [role], [contenteditable="true"]'

/**
 * Turning one candidate into the elements it names.
 *
 * Names are compared the way a person reads them — trimmed, whitespace
 * collapsed, case-folded — and by equality, never by substring. A selector that
 * the browser cannot parse answers `null` rather than throwing, because "this
 * selector is unusable" is a reason to report, not a reason to stop.
 */
export const FRAGMENT_CANDIDATE_MATCH = `const CONTROLS = ${JSON.stringify(CANDIDATE_CONTROLS)};
  const collapsed = (value) => String(value || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const matchesOf = (candidate) => {
    if (candidate.kind === 'selector') {
      try { return Array.prototype.slice.call(document.querySelectorAll(candidate.selector)) }
      catch (error) { return null }
    }
    let found = [];
    try { found = Array.prototype.slice.call(document.querySelectorAll(CONTROLS)) } catch (error) { return [] }
    const wantedName = collapsed(candidate.kind === 'text' ? candidate.text : candidate.name);
    const wantedRole = candidate.kind === 'role' ? candidate.role : null;
    return found.filter((el) => {
      if (wantedRole !== null && roleOf(el) !== wantedRole) return false;
      return collapsed(accessibleNameOf(el)) === wantedName;
    });
  };`

/**
 * Walking an ordered candidate list to the first control that can be acted on.
 *
 * The one implementation behind every verb that names a control, so `click`,
 * `check` and whatever comes next cannot drift on the questions that matter:
 * which candidate wins (the first usable one, in the recipe's order), where the
 * act has to land (the control itself, or the `<label>` that forwards to it),
 * and what to say about the candidates that were passed over.
 *
 * `accept` is how a verb states what it can act on at all — `check` refuses a
 * control that holds no state, so `{ "text": "全选" }` on a gate whose `<label>`
 * carries those words keeps walking until it reaches the checkbox the label is
 * for, instead of stopping on the label and failing. Reachability is still asked
 * first: an unusable control that is also unreachable is reported as unreachable.
 *
 * A usable candidate ends the walk — later ones are not tried behind the
 * author's back, whether or not the act that follows works out.
 *
 * @returns `control`/`hit` (`null` when nothing was usable), how the winner reads
 *   in a summary (`landed`), and one reason per candidate that was passed over.
 */
export const FRAGMENT_RESOLVE = `const resolveCandidates = (candidates, accept) => {
    const tried = [];
    for (const candidate of candidates) {
      const matches = matchesOf(candidate);
      if (matches === null) { tried.push(candidate.label + ': not a usable selector'); continue }
      if (matches.length === 0) { tried.push(candidate.label + ': no match'); continue }
      let chosen = null;
      const unreachable = [];
      const unusable = [];
      for (const el of matches) {
        const target = hitTargetOf(el);
        if (target.hit === null) { if (unreachable.indexOf(target.reason) < 0) unreachable.push(target.reason); continue }
        const refusal = accept === undefined ? '' : accept(el);
        if (refusal !== '') { if (unusable.indexOf(refusal) < 0) unusable.push(refusal); continue }
        chosen = { control: el, hit: target.hit, host: target.host };
        break;
      }
      if (chosen === null) {
        const parts = [];
        if (unreachable.length > 0) parts.push('none reachable (' + unreachable.join(', ') + ')');
        if (unusable.length > 0) parts.push('not usable (' + unusable.join(', ') + ')');
        tried.push(candidate.label + ': matched ' + matches.length + ', ' + parts.join(', '));
        continue;
      }
      // The one wording for what a step landed on, so a summary, a failure
      // message and a test cannot describe the same act three ways.
      const landed = candidate.label + ' -> ' + (roleOf(chosen.hit) || chosen.hit.tagName.toLowerCase());
      return { candidate: candidate.label, landed: landed, control: chosen.control, hit: chosen.hit, tried: tried };
    }
    return { candidate: null, landed: null, control: null, hit: null, tried: tried };
  };

  /** Click the resolved element, answering the throw as a message instead of raising it. */
  const clickFailureOf = (hit) => {
    try { hit.click(); return '' } catch (error) { return String(error) }
  };`

/**
 * What state a control is in, when it is a control that has one.
 *
 * The single answer to "is this ticked", read before acting and read again after
 * — by `check` to verify its own step, and by the state conditions `waitFor`
 * grows. Three carriers, in the order a person would trust them: a form
 * checkbox or radio, then `aria-checked` (what a custom control announces), then
 * `aria-pressed` (its toggle-button equivalent). Anything else answers `''`:
 * "this control has no such state" is a fact the caller needs, and `false` would
 * be a lie about a text field.
 */
export const FRAGMENT_CHECKED_STATE = `const checkedStateOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return el.checked === true ? 'checked' : 'unchecked';
    const checked = el.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') return checked === 'true' ? 'checked' : 'unchecked';
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'false') return pressed === 'true' ? 'checked' : 'unchecked';
    return '';
  };`

/**
 * The page's visible text.
 *
 * `innerText` is what a person sees; it does not exist everywhere (jsdom, where
 * the tests run, has no layout), so the fallback is `textContent` — a superset,
 * which makes a "is this page short" test harder to pass, i.e. erring towards
 * doing nothing. Shared because two scripts ask this question for different
 * reasons: one to size the document, one to look for text.
 */
export const FRAGMENT_VISIBLE_TEXT = `const visibleTextOf = () => {
    const body = document.body;
    if (body === null) return '';
    const inner = body.innerText;
    return typeof inner === 'string' && inner !== '' ? inner : (body.textContent || '');
  };`

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
    if (visibleTextOf().length >= 2000) return false;
    return consentWords.test(location.href + ' ' + document.title);
  };`

/**
 * Is this control in that state — the question a condition waits on.
 *
 * `null` is the important answer: this control *cannot be asked*. A text field
 * has a `checked` property that is `false`, and a `<label>` has no state at all,
 * so answering `false` to "is it checked" would let a scope full of things that
 * are not checkboxes decide the condition. The caller drops those instead.
 *
 * Enabled and disabled are asked of any control, because `isDisabled` has an
 * answer for every element; checked and unchecked are asked of the controls that
 * hold a state, which is the same read `check` verifies with.
 */
export const FRAGMENT_STATE_MATCH = `const matchesState = (el, wanted) => {
    if (wanted === 'enabled') return !isDisabled(el);
    if (wanted === 'disabled') return isDisabled(el);
    const state = checkedStateOf(el);
    if (state === '') return null;
    return state === wanted;
  };`

/** The page-reading fragments, in the order they must be declared. */
export const PAGE_FRAGMENTS: readonly string[] = [
  FRAGMENT_VISIBLE_TEXT,
  FRAGMENT_LAID_OUT,
  FRAGMENT_LABEL_HOST,
  FRAGMENT_HOST,
  FRAGMENT_ACCESSIBLE_NAME,
  FRAGMENT_ROLE,
  FRAGMENT_COVERAGE,
  FRAGMENT_DISABLED,
  FRAGMENT_HIT_TARGET,
  FRAGMENT_CANDIDATE_MATCH,
  FRAGMENT_RESOLVE,
  FRAGMENT_CHECKED_STATE,
  FRAGMENT_STATE_MATCH,
]

/** The consent fragments, in the order they must be declared. */
export const CONSENT_FRAGMENTS: readonly string[] = [FRAGMENT_CONSENT_WORDS, FRAGMENT_VISIBLE_TEXT, FRAGMENT_CONSENT_DOCUMENT]

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
  // Bundles overlap on purpose (the consent bundle carries the text helper its
  // document test needs, and the dismissal bundle also takes the whole page set),
  // so identical fragments are emitted once. A repeated declaration would be a
  // syntax error in the browser, which is a poor way to find out.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const fragment of fragments) {
    if (seen.has(fragment)) continue
    seen.add(fragment)
    unique.push(fragment)
  }
  return unique.join('\n  ')
}
