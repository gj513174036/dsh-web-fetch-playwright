/**
 * Waiting on state: are all the controls the candidates name in that state?
 *
 * Text cannot express what a gate requires. Its five consents, its select-all and
 * its accept button say nothing in words that could be matched — `checkboxes 5
 * (unchecked 5)` is the whole story — so a recipe that has to know whether the
 * precondition holds asks the page the way the page keeps it: in state.
 *
 * Three decisions shape the code:
 *
 * - **The scope is the first candidate that can answer.** The candidates are
 *   walked in the recipe's order and the first one naming at least one control
 *   that can *answer* the question defines the set; later ones are not
 *   consulted. That is the same ordered-candidate rule every verb follows, and it
 *   keeps a fallback candidate from silently widening the set the condition is
 *   about. A control that cannot be asked — a `<label>` that carries the words, a
 *   text field whose `checked` is always `false` — is dropped rather than counted
 *   as "not in the state".
 * - **Reachability is not asked.** A hidden 1×1 checkbox under its own label is
 *   exactly what a gate uses, and whether it is *checked* has nothing to do with
 *   whether a person could click it. `check` asks both questions; this one asks
 *   only the state.
 * - **Nothing matched is not a failure yet.** The page may still be rendering, so
 *   the poll keeps asking until the step's budget runs out, and only then does the
 *   step fail — with what it saw rather than a bare timeout.
 *
 * The state read itself is `page-fragments`', the same one `check` verifies with
 * (`checkedStateOf`, `isDisabled`), so the two can never disagree about what the
 * page says.
 *
 * @module dsh-web-fetch-playwright/state
 */

import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { askPage } from './race.ts'
import { labelledCandidates, type Candidate, type WaitState } from './targets.ts'

/** How long one read of the page gets; the step's own budget caps the poll loop. */
export const STATE_READ_TIMEOUT_MS = 5_000

/**
 * What one read of the page said about a condition.
 *
 * The same shape every waiting condition answers with — text, URL and state — so
 * the runner has one verdict to poll on and one sentence to fail with.
 */
export interface StateRead {
  readonly held: boolean
  /** Why it does not hold, in words a failure message can use (`''` when it holds). */
  readonly why: string
}

/**
 * The in-page half: pick the scope, then ask every control in it.
 *
 * @param candidates - the condition's ordered candidates.
 * @param state - the state every control in the scope has to be in.
 * @returns a script returning `{ ok: true, scope, total, notInState, holds,
 *   sample }` or `{ ok: false, tried }` with one reason per candidate that named
 *   nothing answerable.
 */
export function stateProbeScript(candidates: readonly Candidate[], state: WaitState): string {
  return `(() => {
  const candidates = ${JSON.stringify(labelledCandidates(candidates))};
  const want = ${JSON.stringify(state)};
  ${spliceFragments(PAGE_FRAGMENTS)}
  const tried = [];
  let scope = null;
  for (const candidate of candidates) {
    const matches = matchesOf(candidate);
    const unmatched = unmatchedReasonOf(candidate, matches);
    if (unmatched !== null) { tried.push(unmatched); continue }
    const answerable = matches.filter((el) => matchesState(el, want) !== null);
    if (answerable.length === 0) { tried.push(passedOver(candidate, matches.length, ['nothing it names can be asked that'])); continue }
    scope = { label: candidate.label, controls: answerable };
    break;
  }
  if (scope === null) return { ok: false, tried: tried };
  const notInState = scope.controls.filter((el) => matchesState(el, want) !== true);
  const first = notInState.length === 0 ? null : notInState[0];
  return {
    ok: true,
    scope: scope.label,
    total: scope.controls.length,
    notInState: notInState.length,
    holds: notInState.length === 0,
    sample: first === null ? '' : (accessibleNameOf(first) || first.tagName.toLowerCase()).slice(0, 40),
  };
})()`
}

/**
 * Read the condition once.
 *
 * @param evaluate - the page's scripting seam, already bound.
 * @param candidates - the condition's ordered candidates.
 * @param state - the wanted state.
 * @param timeoutMs - budget for this one read.
 * @returns what the page said, or `null` when it did not answer at all (a
 *   transient failure is "not yet", and the caller polls again).
 */
export async function readState(
  evaluate: (script: string) => Promise<unknown>,
  candidates: readonly Candidate[],
  state: WaitState,
  timeoutMs: number = STATE_READ_TIMEOUT_MS,
): Promise<StateRead | null> {
  const answer = await askPage(evaluate, stateProbeScript(candidates, state), timeoutMs)
  // Anything other than an answer is "not yet" here: the caller polls again, and
  // its own budget is what ends the step.
  if (answer.kind !== 'answer') return null
  const shape = answer.value as { ok?: unknown; scope?: unknown; total?: unknown; notInState?: unknown; holds?: unknown; sample?: unknown; tried?: unknown }
  if (shape.ok !== true) {
    const tried = Array.isArray(shape.tried) ? shape.tried.filter((entry): entry is string => typeof entry === 'string') : []
    return {
      held: false,
      why: tried.length === 0
        ? 'no control it names could be read'
        : `no candidate named a control that can be asked this (${tried.join('; ')})`,
    }
  }
  if (shape.holds === true) return { held: true, why: '' }
  const scope = typeof shape.scope === 'string' ? shape.scope : 'the candidates'
  const total = typeof shape.total === 'number' ? shape.total : 0
  const notInState = typeof shape.notInState === 'number' ? shape.notInState : 0
  const sample = typeof shape.sample === 'string' ? shape.sample : ''
  return { held: false, why: `${String(notInState)} of ${String(total)} controls in ${scope} are not ${state}${sample === '' ? '' : ` (e.g. "${sample}")`}` }
}
