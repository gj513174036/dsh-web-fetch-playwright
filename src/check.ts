/**
 * The `check` verb's in-page half: satisfy a precondition by putting a control
 * into a state, in the way a person does it.
 *
 * Everything measured on the gate that forced this verb shapes the code:
 *
 * - The five consent checkboxes are hidden `<input>`s whose only words live in
 *   the `<label>` around them. An actionability-checked click on the input times
 *   out; a click on the label works. So the control is resolved through the same
 *   walk `click` uses — the control itself, else the `<label>` that forwards a
 *   click to it — and the *label* is what gets clicked.
 * - Acting twice must not undo the first act: a control already in the wanted
 *   state is left alone.
 * - "The click landed" is not "the precondition now holds": the state is read
 *   back, and only a control that reports the wanted state makes the step pass.
 *   A DOM `.click()` on a React-owned input flips `checked` and is then reverted
 *   by the page's own render, which is why the read-back happens after the page
 *   has had a frame to react — and why it re-reads the control the page is
 *   showing now rather than the node we happened to grab.
 *
 * Unlike `click`, this verb *does* assert its own effect, because unlike a click
 * a state is something the page can be asked about. That is the whole difference
 * between the two verbs.
 *
 * @module dsh-web-fetch-playwright/check
 */

import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { actFailure, askPage, seamFailure, sharedStepFailure, type ProbeAnswer } from './race.ts'
import { labelledCandidates, type Candidate } from './targets.ts'
import type { PlaywrightPage } from './types.ts'

/** How long the page gets to answer the check probe (the click, plus the read-back). */
export const CHECK_TIMEOUT_MS = 5_000

/** The two states a control can be put into, and read back. */
export type ControlState = 'checked' | 'unchecked'

/** What one `check` attempt came to. */
export type CheckOutcome =
  /**
   * The control reports the wanted state. `acted` says whether this attempt had
   * to do anything for it: `false` is the idempotent case, where the state
   * already held and the control was deliberately left alone.
   */
  | { readonly kind: 'checked'; readonly candidate: string; readonly state: ControlState; readonly was: ControlState; readonly acted: boolean }
  /**
   * The act went out and the control still does not report the wanted state —
   * a page that reverted it, or a control that never reacted to the click at
   * all. The step fails either way: the precondition does not hold.
   */
  | { readonly kind: 'unchanged'; readonly candidate: string; readonly was: ControlState; readonly now: ControlState }
  /** The act went out and the state could not be read back (the page moved, or the control is gone). */
  | { readonly kind: 'unverified'; readonly problem: string }
  /** No candidate could be checked; `reasons` holds one entry per candidate tried. */
  | { readonly kind: 'not-checked'; readonly reasons: readonly string[] }
  /** The page could not be asked at all, which is never a satisfied precondition. */
  | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * The in-page half: resolve, look before acting, act, then read back.
 *
 * The answer's shape is what the wrapper judges: `ok` plus a state means the
 * control was read (with `acted` saying whether anything had to be clicked);
 * `attempted` without `ok` means the click went out but the read-back did not
 * happen; neither means nothing was tried.
 *
 * @param candidates - the recipe's ordered candidates.
 * @param state - the state the control has to end in.
 * @returns a script returning a `CheckOutcome`-shaped object.
 */
export function checkScript(candidates: readonly Candidate[], state: ControlState): string {
  return `(async () => {
  const candidates = ${JSON.stringify(labelledCandidates(candidates))};
  const want = ${JSON.stringify(state)};
  ${spliceFragments(PAGE_FRAGMENTS)}
  // Only a control that holds a state can be checked — which is also what keeps
  // a text candidate from stopping on the <label> that merely carries the words.
  const accept = (el) => checkedStateOf(el) === '' ? 'it is not a control that holds a checked state' : '';
  const found = resolveCandidates(candidates, accept);
  if (found.control === null) return { ok: false, attempted: null, why: null, tried: found.tried };
  const control = found.control;
  const before = checkedStateOf(control);
  if (before === want) return { ok: true, candidate: found.landed, was: before, state: before, acted: false };
  const threw = clickFailureOf(found.hit);
  if (threw !== '') return { ok: false, attempted: null, why: null, tried: found.tried.concat(found.landed + ': the click threw (' + threw + ')') };
  // Let the page react first, then read the control it is showing now — the same
  // walk and the same filter, so a page that replaced the control cannot be read
  // through whatever else happens to carry the same name.
  await settleFrame();
  const live = currentControlOf(control, candidates, accept);
  const after = live === null ? '' : checkedStateOf(live);
  if (after === '') return { ok: false, attempted: found.landed, why: 'the control could not be read back after ticking it (it is gone, or no longer reports a checked state)', tried: found.tried };
  return { ok: true, candidate: found.landed, was: before, state: after, acted: true };
})()`
}

/** A check attempt that did not satisfy the precondition. */
export type CheckFailure = Exclude<CheckOutcome, { readonly kind: 'checked' }>

/**
 * How a failed check reads to the person holding the error.
 *
 * @param detail - the step's own description (`candidates: …`).
 * @param candidates - the candidate list, for the message about passing over all of them.
 * @param outcome - the failure.
 * @returns one sentence for the fetch to fail with.
 */
export function describeCheckFailure(detail: string, candidates: string, outcome: CheckFailure): string {
  if (outcome.kind === 'unchanged') {
    return `${outcome.candidate}: it was ${outcome.was}, the click went out, and it reports ${outcome.now} — the page does not show the change`
  }
  if (outcome.kind === 'not-checked') return `no candidate could be checked, out of ${candidates} — ${outcome.reasons.join('; ')}`
  return sharedStepFailure(detail, outcome) ?? detail
}

/** A page answer that is one of the two states, or nothing. */
function stateOf(value: unknown): ControlState | null {
  return value === 'checked' || value === 'unchecked' ? value : null
}

/**
 * Put a control into a state, and prove it.
 *
 * @param page - the page the fetch has open.
 * @param candidates - the recipe's ordered candidates.
 * @param state - the state the control has to end in.
 * @param timeoutMs - budget for the attempt; must stay inside the step's ceiling.
 * @returns what happened, in the five shapes {@link CheckOutcome} allows.
 */
export async function checkControl(
  page: PlaywrightPage,
  candidates: readonly Candidate[],
  state: ControlState,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) {
    return { kind: 'unreadable', problem: 'the page offers no scripting, so no candidate could be tried' }
  }
  const answer = await askPage(evaluate, checkScript(candidates, state), timeoutMs)
  if (answer.kind !== 'answer') {
    // The act itself can navigate; the state then cannot be read back, and a
    // precondition that cannot be shown to hold is not one this verb can call
    // satisfied.
    const verdict = seamFailure(answer, 'check', timeoutMs)
    return verdict?.kind === 'navigated'
      ? { kind: 'unverified', problem: 'the page navigated before the state could be read back' }
      : { kind: 'unreadable', problem: verdict?.problem ?? 'the page did not answer' }
  }
  const shape = answer.value as ProbeAnswer & { state?: unknown; was?: unknown; acted?: unknown }
  if (shape.ok === true) {
    const now = stateOf(shape.state)
    const was = stateOf(shape.was)
    if (now === null || was === null) return { kind: 'unreadable', problem: 'the page answered with a state that is neither checked nor unchecked' }
    const candidate = typeof shape.candidate === 'string' ? shape.candidate : 'a candidate'
    return now === state
      ? { kind: 'checked', candidate, state: now, was, acted: shape.acted === true }
      : { kind: 'unchanged', candidate, was, now }
  }
  const failure = actFailure(shape, 'the state could not be read back')
  return failure.kind === 'unverified' ? failure : { kind: 'not-checked', reasons: failure.reasons }
}
