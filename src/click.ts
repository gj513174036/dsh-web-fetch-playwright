/**
 * The `click` verb's in-page half: walk an ordered candidate list, and click the
 * first candidate that is *reachable*.
 *
 * Reachability is checked before the click, never inferred from it: the control
 * must exist, occupy layout (itself or through the `<label>` that forwards a
 * click to it), be free of anything sitting on top of it, and not be disabled.
 * All of that — the walk, the four questions, the reasons a candidate was passed
 * over — lives in `page-fragments`, shared with `check` so the two cannot drift.
 *
 * Two honesty rules shape the code:
 *
 * - **The click does not assert its own effect.** What a click does differs per
 *   page, so a universal post-condition could only be a guess. This verb reports
 *   which candidate landed, and nothing more; the `waitFor` after it is the
 *   assertion, and the summary marks a click that no later `waitFor` confirmed
 *   (see `actions.ts`). "A click was dispatched, so it must have worked" is the
 *   failure mode this whole feature exists to remove.
 * - **A click that navigates is not a failure.** The navigation can destroy the
 *   execution context before the script returns its answer, so that one error is
 *   recognised and reported as "clicked, and the page moved before the script
 *   could say which candidate landed". Reporting it as unreachable would fail
 *   every recipe whose click is a link.
 *
 * @module dsh-web-fetch-playwright/click
 */

import type { PlaywrightPage } from './types.ts'
import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { askPage, messageOf } from './race.ts'
import { labelledCandidates, type Candidate, type WaitCondition } from './targets.ts'

/** How long the page gets to answer the click probe. */
export const CLICK_TIMEOUT_MS = 5_000

/** What one click attempt came to. */
export type ClickOutcome =
  /**
   * A candidate was reachable and its click was dispatched. `before` is the
   * watched condition's state *at the moment of the click* — `true` means the
   * condition the recipe waits for next was already true, so that wait cannot be
   * evidence that this click did anything.
   */
  | { readonly kind: 'clicked'; readonly candidate: string; readonly before: boolean | null }
  /**
   * The click went out and the page navigated before the script could report
   * which candidate landed. Not a failure — the following `waitFor` is what says
   * whether the page did what the target claims.
   */
  | { readonly kind: 'clicked-unreported' }
  /** No candidate could be clicked; `reasons` holds one entry per candidate tried. */
  | { readonly kind: 'not-clicked'; readonly reasons: readonly string[] }
  /** The page could not be asked at all, which is never a click. */
  | { readonly kind: 'unreadable'; readonly problem: string }

/**
 * The in-page resolver and click.
 *
 * Each candidate's description is computed here, by
 * {@link describeCandidate}, and travels into the script as a `label` — one
 * wording for the summary, the failure message and the recipe, instead of a
 * second copy of the phrasing that can drift.
 *
 * `watch` is the condition a later `waitFor` will check. Reading it *before* the
 * click is what lets the runner tell "the page moved because of this click" from
 * "the text was already there" — a wait that already held proves nothing about
 * the click. Only text can be read here; a URL condition is the runner's to
 * answer, since it has the page's own URL.
 *
 * @param candidates - the recipe's ordered candidates.
 * @param watch - the text condition the next `waitFor` will check, if any.
 * @returns a script returning a `ClickOutcome`-shaped object.
 */
export function clickScript(candidates: readonly Candidate[], watch?: WaitCondition): string {
  const watched = watch !== undefined && watch.kind === 'text' ? JSON.stringify({ text: watch.text, absent: watch.absent === true }) : 'null'
  return `(() => {
  const candidates = ${JSON.stringify(labelledCandidates(candidates))};
  const watch = ${watched};
  ${spliceFragments(PAGE_FRAGMENTS)}
  const before = watch === null ? null : (visibleTextOf().indexOf(watch.text) >= 0) !== watch.absent;
  const found = resolveCandidates(candidates);
  if (found.control === null) return { ok: false, tried: found.tried };
  // A usable candidate ends the walk whether or not its click worked: the order is
  // the recipe's, so a later candidate must not be tried behind the author's back.
  // A throw is reported rather than silently moved past.
  const threw = clickFailureOf(found.hit);
  if (threw !== '') return { ok: false, tried: found.tried.concat(found.landed + ': the click threw (' + threw + ')') };
  return { ok: true, candidate: found.landed, before: before };
})()`
}

/**
 * Does this failure describe the page moving out from under the script?
 *
 * The click is what caused it, so it cannot be read as "the control was not
 * there" — and a phrase list is the only signal the seam gives. Kept narrow and
 * in one place: anything else stays an honest "the page could not be read".
 *
 * @param error - what the scripting seam rejected with.
 * @returns true when the page most likely navigated.
 */
export function looksLikeNavigation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /execution context was destroyed|navigat|target closed|context or browser has been closed|frame was detached|has been closed/i.test(message)
}

/**
 * Resolve and click, from the outside.
 *
 * @param page - the page the fetch has open.
 * @param candidates - the recipe's ordered candidates.
 * @param timeoutMs - budget for the attempt; must stay inside the step's ceiling.
 * @param watch - the condition the next `waitFor` will check, when it is a text
 *   one; the page reads it before clicking, so a wait that already held is not
 *   mistaken for proof that the click did something.
 * @returns what happened, in the four shapes {@link ClickOutcome} allows.
 */
export async function clickCandidate(
  page: PlaywrightPage,
  candidates: readonly Candidate[],
  timeoutMs: number = CLICK_TIMEOUT_MS,
  watch?: WaitCondition,
): Promise<ClickOutcome> {
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) {
    return { kind: 'unreadable', problem: 'the page offers no scripting, so no candidate could be tried' }
  }
  const answer = await askPage(evaluate, clickScript(candidates, watch), timeoutMs)
  if (answer.kind === 'failed') {
    // The click is what moved the page out from under the script, so this is a
    // click that could not report — not a control that was not there.
    if (looksLikeNavigation(answer.error)) return { kind: 'clicked-unreported' }
    return { kind: 'unreadable', problem: messageOf(answer.error) }
  }
  if (answer.kind === 'timeout') return { kind: 'unreadable', problem: `the page did not answer within ${String(timeoutMs)}ms` }
  if (answer.kind === 'unexpected') return { kind: 'unreadable', problem: 'the page answered with something other than a click result' }
  const shape = answer.value as { ok?: unknown; candidate?: unknown; tried?: unknown; before?: unknown }
  if (shape.ok === true) {
    return {
      kind: 'clicked',
      candidate: typeof shape.candidate === 'string' ? shape.candidate : 'a candidate',
      // Only a real boolean is an answer; anything else leaves the pre-click
      // state unknown, which the runner reads as "not known to have held".
      before: typeof shape.before === 'boolean' ? shape.before : null,
    }
  }
  const reasons = Array.isArray(shape.tried) ? shape.tried.filter((entry): entry is string => typeof entry === 'string') : []
  return { kind: 'not-clicked', reasons }
}
