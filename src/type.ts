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
 *   form libraries act on. Nothing here presses keys: a page that needs real key
 *   events needs a `press` verb, and that is its own ticket.
 *
 * Then it reads the field back, after a frame, for the same reason `check` does:
 * a controlled component can take the change and then re-render the old value,
 * and "I wrote it" is not "it is there". What the page *does* with the value — a
 * search, a lookup, a form submit — is the `waitFor` that follows.
 *
 * @module dsh-web-fetch-playwright/type
 */

import { looksLikeNavigation } from './click.ts'
import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { askPage, messageOf } from './race.ts'
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
  /** The write went out and the field could not be read back (the page moved, or it is gone). */
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
    return { ok: false, attempted: null, why: null, tried: found.tried.concat(found.landed + ': writing into it threw (' + String(error) + ')') };
  }
  // Let the page react before believing anything, the same frame check waits.
  await new Promise((resolve) => {
    try { requestAnimationFrame(() => { setTimeout(resolve, 0) }) } catch (error) { setTimeout(resolve, 0) }
  });
  const live = field.isConnected === true ? field : resolveCandidates(candidates, accept).control;
  if (live === null) return { ok: false, attempted: found.landed, why: 'the field could not be read back after typing (it is gone)', tried: found.tried };
  return { ok: true, candidate: found.landed, was: before, value: valueOfField(live), wanted: value };
})()`
}

/**
 * What the page answered, in the shape the script returns.
 *
 * Every field is `unknown` on purpose: this is the boundary where a page's answer
 * stops being trusted, and each one is narrowed before it is used.
 */
interface TypeAnswer {
  readonly ok?: unknown
  readonly candidate?: unknown
  readonly was?: unknown
  readonly value?: unknown
  readonly wanted?: unknown
  readonly attempted?: unknown
  readonly why?: unknown
  readonly tried?: unknown
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
  if (answer.kind === 'failed') {
    // A submit that navigates can tear the context down mid-write; the field then
    // cannot be read back, and an unproven write is not a written field.
    if (looksLikeNavigation(answer.error)) return { kind: 'unverified', problem: 'the page navigated before the field could be read back' }
    return { kind: 'unreadable', problem: messageOf(answer.error) }
  }
  if (answer.kind === 'timeout') return { kind: 'unreadable', problem: `the page did not answer within ${String(timeoutMs)}ms` }
  if (answer.kind === 'unexpected') return { kind: 'unreadable', problem: 'the page answered with something other than a type result' }
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
  if (typeof shape.attempted === 'string') {
    const why = typeof shape.why === 'string' ? shape.why : 'the field could not be read back'
    return { kind: 'unverified', problem: `${shape.attempted}: ${why}` }
  }
  const reasons = Array.isArray(shape.tried) ? shape.tried.filter((entry): entry is string => typeof entry === 'string') : []
  return { kind: 'not-typed', reasons }
}
