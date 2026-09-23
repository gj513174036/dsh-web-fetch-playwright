/**
 * Running a target's actions.
 *
 * The runner is deliberately dull: for each step it either evaluates the step's
 * condition until it holds, or clicks the first reachable candidate; a step that
 * does not get there either fails the whole fetch (loudly, naming the step) or,
 * if it was declared `optional`, is skipped and recorded. Nothing here guesses
 * and nothing degrades quietly — the failure modes this project keeps paying for
 * are "it looked like it worked" and "it quietly did less".
 *
 * The condition is the post-condition. That is why `waitFor` is the verb that
 * carries the honesty of everything after it: a `click` cannot assert its own
 * effect (what a click does differs per page), so the *wait* that follows is what
 * turns "a click was dispatched" into "the page did what the target claims". A
 * click with no such wait after it is reported as **unverified** — the gap is
 * shown rather than hidden, which is the whole point of the summary.
 *
 * @module dsh-web-fetch-playwright/actions
 */

import type { PlaywrightPage } from './types.ts'
import { clickCandidate } from './click.ts'
import { FRAGMENT_VISIBLE_TEXT, spliceFragments } from './page-fragments.ts'
import { describeCandidate, urlIsUnder, type ActionStep, type ClickStep, type Target, type WaitCondition, type WaitStep } from './targets.ts'

/** Longest one step may take, before the fetch's own remaining budget caps it. */
export const STEP_CEILING_MS = 10_000

/** How often a condition is re-checked while it is not yet true. */
export const POLL_MS = 250

/** How one step ended, as the summary reports it. */
export type StepOutcome =
  /** A condition held. */
  | 'met'
  /** An `optional` step did not, and the run carried on without it. */
  | 'skipped'
  /** A click was dispatched, and a later step confirmed the page changed. */
  | 'clicked'
  /** A click was dispatched, and no later `waitFor` confirmed anything. */
  | 'unverified'

/** One step's outcome, as the summary reports it. */
export interface StepReport {
  readonly index: number
  readonly verb: string
  /** What the step did or waited for, in words. */
  readonly detail: string
  readonly outcome: StepOutcome
}

/** What a completed run leaves behind. */
export interface ActionRun {
  readonly steps: readonly StepReport[]
  /** The document the actions ended on. */
  readonly finalUrl: string
}

/** Why a run stopped. */
export interface ActionFailure {
  readonly index: number
  readonly verb: string
  readonly detail: string
  /** Where the browser was when the step gave up. */
  readonly url: string
}

/** A run's result: the reports, or the step that did not hold. */
export type ActionOutcome = { readonly ok: true; readonly run: ActionRun } | { readonly ok: false; readonly failure: ActionFailure }

/** Options a run needs from its caller. */
export interface ActionOptions {
  /** What is left of the fetch's budget; a step never outlives it. */
  readonly remainingMs: () => number
  readonly stepCeilingMs?: number
  readonly pollMs?: number
}

/** A short description of a condition, for the summary and for failures. */
export function describeCondition(condition: WaitCondition): string {
  if (condition.kind === 'text') return `text "${condition.text}"${condition.absent === true ? ' to disappear' : ''}`
  if (condition.kind === 'url') return condition.absent === true ? `to have left ${condition.url}` : `url ${condition.url}`
  return `wait ${String(condition.ms)}ms`
}

/**
 * The in-page half of a text condition.
 *
 * Reads the visible text (falling back to textContent where innerText does not
 * exist) and reports whether it contains the needle. The needle is
 * JSON-encoded, so any text — quotes, newlines, Chinese — is safe in the script.
 *
 * @param text - the text to look for.
 * @returns a script returning a boolean.
 */
export function textProbeScript(text: string): string {
  return `(() => {
    ${spliceFragments([FRAGMENT_VISIBLE_TEXT])}
    return visibleTextOf().indexOf(${JSON.stringify(text)}) >= 0;
  })()`
}

/** Sleep, so a wait can be bounded and a fixed wait can be honoured. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Is the condition true right now?
 *
 * @param currentUrl - where the browser is right now.
 * @param condition - the condition to evaluate.
 * @param evaluate - the page's scripting seam, when it has one.
 * @returns true/false, or null when the condition cannot be evaluated at all.
 */
async function conditionHolds(
  currentUrl: string,
  condition: WaitCondition,
  evaluate: ((script: string) => Promise<unknown>) | undefined,
): Promise<boolean | null> {
  if (condition.kind === 'time') return true
  if (condition.kind === 'url') {
    const under = urlIsUnder(currentUrl, condition.url)
    return condition.absent === true ? !under : under
  }
  if (evaluate === undefined) return null
  let found: boolean
  try {
    found = (await evaluate(textProbeScript(condition.text))) === true
  } catch {
    // A poll can fail for a transient reason — the navigation a click causes
    // destroys the execution context — and that is "not yet", not "unreadable".
    // Only a page with no scripting seam at all can never answer.
    return false
  }
  return condition.absent === true ? !found : found
}

/** What a click step's candidates look like before anything is tried. */
function describeCandidates(step: ClickStep): string {
  return step.candidates.map(describeCandidate).join(', ')
}

/**
 * Does a step after this one confirm that a click's effect happened?
 *
 * A `waitFor` confirms when it reported `met` and its condition is about the
 * page — text or URL. A fixed wait asserts nothing (the clock passed whether or
 * not the page moved), and an `optional` wait that was skipped confirms nothing
 * either, which is why this reads the reports rather than the recipe alone.
 */
function clickConfirmed(actions: readonly ActionStep[], reports: readonly StepReport[], index: number): boolean {
  return reports.some((report) => {
    if (report.index <= index || report.outcome !== 'met') return false
    const step = actions[report.index]
    return step !== undefined && step.verb === 'waitFor' && step.condition.kind !== 'time'
  })
}

/**
 * Run a target's actions against the page the fetch has open.
 *
 * @param page - the settled page.
 * @param target - the target whose URL matched.
 * @param options - budget and polling knobs.
 * @returns every step's report, or the step that did not hold.
 */
export async function runTargetActions(
  page: PlaywrightPage,
  target: Target,
  options: ActionOptions,
): Promise<ActionOutcome> {
  const ceiling = options.stepCeilingMs ?? STEP_CEILING_MS
  const poll = options.pollMs ?? POLL_MS
  const evaluate = page.evaluate?.bind(page)
  const reports: StepReport[] = []

  for (const [index, step] of target.actions.entries()) {
    const budget = Math.max(0, Math.min(ceiling, options.remainingMs()))
    const failure = (detail: string): ActionOutcome => ({
      ok: false,
      failure: { index, verb: step.verb, detail, url: page.url() },
    })

    if (step.verb === 'click') {
      const detail = `candidates: ${describeCandidates(step)}`
      if (budget === 0) {
        if (step.optional === true) {
          reports.push({ index, verb: step.verb, detail: `${detail} (no budget left)`, outcome: 'skipped' })
          continue
        }
        return failure(`${detail} (only 0ms of the step budget is left)`)
      }
      const outcome = await clickCandidate(page, step.candidates, budget)
      if (outcome.kind === 'clicked') {
        reports.push({ index, verb: step.verb, detail: outcome.candidate, outcome: 'clicked' })
        continue
      }
      if (outcome.kind === 'clicked-unreported') {
        // The click went out and the page navigated before the script could say
        // which candidate landed. The following wait, if any, is what judges it.
        reports.push({ index, verb: step.verb, detail: 'a candidate (the page navigated before it could say which)', outcome: 'clicked' })
        continue
      }
      if (outcome.kind === 'unreadable') {
        const why = `${detail} (the page could not be read: ${outcome.problem})`
        if (step.optional === true) {
          reports.push({ index, verb: step.verb, detail: why, outcome: 'skipped' })
          continue
        }
        return failure(why)
      }
      // Every candidate was passed over: the page says so, with one reason each.
      const why = `no candidate could be clicked, out of ${describeCandidates(step)} — ${outcome.reasons.join('; ')}`
      if (step.optional === true) {
        reports.push({ index, verb: step.verb, detail: why, outcome: 'skipped' })
        continue
      }
      return failure(why)
    }

    const detail = describeCondition(step.condition)
    const startedAt = Date.now()
    let held = false
    let unanswerable = false

    // A fixed wait that does not fit in what is left has not happened. Sleeping
    // the shortened time and calling it met is the "claims something untrue"
    // failure this runner exists to avoid.
    const exceedsBudget = step.condition.kind === 'time' && step.condition.ms > budget
    if (exceedsBudget) {
      // fall through to the failure (or skip) below
    } else if (step.condition.kind === 'time') {
      await sleep(step.condition.ms)
      held = true
    } else {
      for (;;) {
        const state = await conditionHolds(page.url(), step.condition, evaluate).catch(() => null)
        if (state === null) {
          unanswerable = true
          break
        }
        if (state) {
          held = true
          break
        }
        if (Date.now() - startedAt >= budget) break
        await sleep(poll)
      }
    }

    if (held) {
      reports.push({ index, verb: step.verb, detail, outcome: 'met' })
      continue
    }
    if (step.optional === true) {
      reports.push({ index, verb: step.verb, detail, outcome: 'skipped' })
      continue
    }
    return failure(
      unanswerable
        ? `${detail} (the page could not be read)`
        : exceedsBudget
          ? `${detail} (only ${String(budget)}ms of the step budget is left)`
          : `${detail} (not met within ${String(budget)}ms)`,
    )
  }

  // The gap a click cannot close by itself: with no later `waitFor` that held,
  // the summary must not imply the page changed. Marking it here, once, keeps
  // the verdict out of the verb's own code.
  const marked = reports.map((report) =>
    report.outcome === 'clicked' && !clickConfirmed(target.actions, reports, report.index)
      ? { ...report, outcome: 'unverified' as const }
      : report,
  )
  return { ok: true, run: { steps: marked, finalUrl: page.url() } }
}

/**
 * Render the run as the one line the caller sees at the top of the body.
 *
 * The result shape is closed (ADR-0003), so the body is the only channel that
 * can say which document this is and what was done to reach it. The line itself
 * carries no markup: the caller wraps it as a blockquote in markdown bodies and
 * as a blockquote *element* in HTML ones, so it reads as the same thing either
 * way instead of appearing as literal "> actions:" text inside raw HTML.
 *
 * @param run - the completed run.
 * @param statusCode - the status of the document the run ended on.
 * @returns one line.
 */
export function renderActionSummary(run: ActionRun, statusCode: number): string {
  const parts = run.steps.map((step) => `${String(step.index + 1)}. ${step.verb} ${step.detail} — ${markOf(step.outcome)}`)
  return `actions: ${parts.join(' · ')} → final document ${run.finalUrl} (HTTP ${String(statusCode)})`
}

/** How one outcome reads in the summary line. */
function markOf(outcome: StepOutcome): string {
  if (outcome === 'skipped') return 'skipped'
  if (outcome === 'unverified') return 'clicked (unverified)'
  if (outcome === 'clicked') return 'clicked'
  return 'met'
}
