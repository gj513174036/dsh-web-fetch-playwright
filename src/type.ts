/**
 * The `type` verb's in-page half: put a value into a field, and make the page
 * hear about it.
 *
 * The failure this exists to prevent is quiet and specific: setting `.value` on
 * an input changes what the DOM holds and tells the page nothing. A framework's
 * own state still says the field is empty, the submit sends nothing, and the
 * recipe reads a results page it never asked for. So the write is three things,
 * not one:
 *
 * - **Focus first.** Pages that reveal or validate on focus need it, and a field
 *   a person could not have focused is not a field this verb can honestly fill.
 * - **Write through the prototype's setter.** React (and anything else that keeps
 *   a copy of the value) installs its own `value` property on the element and
 *   remembers what it last saw; assigning the element's property updates its copy
 *   and its tracker together, so the change looks like no change. Calling the
 *   *prototype's* setter moves the tracker's feet, which is what makes the
 *   `input` event that follows mean something.
 * - **Announce it.** `input` and `change`, bubbling, which is what listeners and
 *   form libraries act on. Plain `Event`s, not `InputEvent`s: frameworks listen
 *   for the name, and an `InputEvent` would have to claim an `inputType` for a
 *   keystroke that never happened. Nothing here presses keys at all — a page that
 *   needs real key events needs a `press` verb, and that is its own ticket.
 *
 * A field that is not an `input` (a `contenteditable`, a custom `role="textbox"`)
 * is written by replacing its text content, which is the closest thing to "the
 * value" that element has.
 *
 * Then it reads the field back, after a frame, for the same reason `check` does:
 * a controlled component can take the change and then re-render the old value,
 * and "I wrote it" is not "it is there". What the page *does* with the value — a
 * search, a lookup, a form submit — is the `waitFor` that follows.
 *
 * @module dsh-web-fetch-playwright/type
 */

import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { actFailure, askPage, seamFailure, sharedStepFailure, type ProbeAnswer } from './race.ts'
import { labelledCandidates, type Candidate } from './targets.ts'
import type { PlaywrightPage } from './types.ts'

/** How long the page gets to answer the type probe (the write, plus the read-back). */
export const TYPE_TIMEOUT_MS = 5_000

/** What one `type` attempt came to. */
export type TypeOutcome =
  /**
   * The field reports the value the recipe asked for. `was` is what it held
   * before, so a summary can say whether this replaced something.
   */
  | { readonly kind: 'typed'; readonly candidate: string; readonly was: string; readonly value: string }
  /**
   * The write went out and the field now holds something else — a page that
   * reverted it, a formatter, a `maxlength` that cut it short. The step fails:
   * the page did not take what the recipe asked for.
   */
  | { readonly kind: 'mismatch'; readonly candidate: string; readonly was: string; readonly value: string; readonly wanted: string }
  /**
   * The write went out and the page navigated before the field could be read
   * back. Not a failure: the navigation is the page's reaction to the write, and
   * the `waitFor` after this step is what judges whether it was the right one —
   * the same reading as a click that navigated.
   */
  | { readonly kind: 'typed-unreported'; readonly candidate: string }
  /** The write went out and the field could not be read back (the field is gone). */
  | { readonly kind: 'unverified'; readonly problem: string }
  /** No candidate named a field that takes text; `reasons` holds one entry per candidate tried. */
  | { readonly kind: 'not-typed'; readonly reasons: readonly string[] }
  /** The page could not be asked at all, which is never a written field. */
  | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * The in-page half: resolve, look, focus, write, announce, read back.
 *
 * @param candidates - the recipe's ordered candidates.
 * @param value - the text to write.
 * @returns a script returning a `TypeOutcome`-shaped object.
 */
export function typeScript(candidates: readonly Candidate[], value: string): string {
  return `(async () => {
  const candidates = ${JSON.stringify(labelledCandidates(candidates))};
  const value = ${JSON.stringify(value)};
  ${spliceFragments(PAGE_FRAGMENTS)}
  // Only a field a person could write into, and not one that refuses writing:
  // read-only is not "unreachable" for a click or a check, so it is asked here.
  const accept = (el) => {
    if (!takesTextField(el)) return 'it is not a field that takes text';
    if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') return 'it is read-only';
    return '';
  };
  const found = resolveCandidates(candidates, accept);
  if (found.control === null) return { ok: false, attempted: null, why: null, tried: found.tried };
  const field = found.control;
  // The write goes into the *control*, so the summary names the control: the hit
  // is only where a click would have landed.
  const landed = found.candidate + ' -> ' + kindOfElement(field);
  const before = valueOfField(field);
  try { field.focus(); } catch (error) { /* a backend without focus still gets the write */ }
  try {
    const tag = field.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      // The prototype's setter, not the element's property: a framework that
      // tracks the value installs its own property and would see no change.
      const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor !== undefined && descriptor.set !== undefined) descriptor.set.call(field, value);
      else field.value = value;
    } else {
      field.textContent = value;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) {
    return { ok: false, attempted: null, why: null, tried: found.tried.concat(landed + ': writing into it threw (' + String(error) + ')') };
  }
  // Let the page react first, then read the field it is showing now, the same way
  // check judges its own act.
  await settleFrame();
  const live = currentControlOf(field, candidates, accept);
  if (live === null) return { ok: false, attempted: landed, why: 'the field could not be read back after typing (it is gone)', tried: found.tried };
  return { ok: true, candidate: landed, was: before, value: valueOfField(live), wanted: value };
})()`
}

/** A type attempt whose value is not in the field. */
export type TypeFailure = Exclude<TypeOutcome, { readonly kind: 'typed' } | { readonly kind: 'typed-unreported' }>

/**
 * How a failed write reads to the person holding the error.
 *
 * @param detail - the step's own description (`candidates: …, value …`).
 * @param candidates - the candidate list, for the message about passing over all of them.
 * @param outcome - the failure.
 * @returns one sentence for the fetch to fail with.
 */
export function describeTypeFailure(detail: string, candidates: string, outcome: TypeFailure): string {
  if (outcome.kind === 'mismatch') {
    return `${outcome.candidate}: ${JSON.stringify(outcome.wanted)} was written into it (it held ${JSON.stringify(outcome.was)}) and it now holds ${JSON.stringify(outcome.value)} — the page did not take it`
  }
  if (outcome.kind === 'not-typed') return `no candidate could be typed into, out of ${candidates} — ${outcome.reasons.join('; ')}`
  return sharedStepFailure(detail, outcome) ?? detail
}

/** The fields only a `type` answer carries, on top of the seam's shared shape. */
interface TypeAnswer extends ProbeAnswer {
  readonly was?: unknown
  readonly value?: unknown
  readonly wanted?: unknown
}

/**
 * Write a value into a field, and prove it is there.
 *
 * @param page - the page the fetch has open.
 * @param candidates - the recipe's ordered candidates.
 * @param value - the text to write.
 * @param timeoutMs - budget for the attempt; must stay inside the step's ceiling.
 * @returns what happened, in the five shapes {@link TypeOutcome} allows.
 */
export async function typeInto(
  page: PlaywrightPage,
  candidates: readonly Candidate[],
  value: string,
  timeoutMs: number = TYPE_TIMEOUT_MS,
): Promise<TypeOutcome> {
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) {
    return { kind: 'unreadable', problem: 'the page offers no scripting, so no field could be written into' }
  }
  const answer = await askPage(evaluate, typeScript(candidates, value), timeoutMs)
  if (answer.kind !== 'answer') {
    // A submit that navigates tears the context down mid-write: the write went
    // out and the page moved because of it, which is the page taking the input —
    // the following step is what says whether it took it where the recipe wanted.
    const verdict = seamFailure(answer, 'type', timeoutMs)
    return verdict?.kind === 'navigated'
      ? { kind: 'typed-unreported', candidate: 'the field (the page navigated before it could be read back)' }
      : { kind: 'unreadable', problem: verdict?.problem ?? 'the page did not answer' }
  }
  const shape = answer.value as TypeAnswer
  if (shape.ok === true) {
    if (typeof shape.value !== 'string' || typeof shape.wanted !== 'string') {
      return { kind: 'unreadable', problem: 'the page answered with something other than a type result' }
    }
    const candidate = typeof shape.candidate === 'string' ? shape.candidate : 'a candidate'
    const was = typeof shape.was === 'string' ? shape.was : ''
    return shape.value === shape.wanted
      ? { kind: 'typed', candidate, was, value: shape.value }
      : { kind: 'mismatch', candidate, was, value: shape.value, wanted: shape.wanted }
  }
  const failure = actFailure(shape, 'the field could not be read back')
  return failure.kind === 'unverified' ? failure : { kind: 'not-typed', reasons: failure.reasons }
}
