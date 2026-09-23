/**
 * Running a target's actions.
 *
 * The runner is deliberately dull: for each step it evaluates the step's
 * condition until it holds or the step's ceiling runs out, and a step that never
 * holds either fails the whole fetch (loudly, naming the step) or, if it was
 * declared `optional`, is skipped and recorded. Nothing here guesses and nothing
 * degrades quietly — the failure modes this project keeps paying for are "it
 * looked like it worked" and "it quietly did less".
 *
 * The condition is the post-condition. That is why `waitFor` is the verb that
 * carries the honesty of everything after it: a `click` cannot assert its own
 * effect (what a click does differs per page), so the *wait* that follows is what
 * turns "a click was dispatched" into "the page did what the target claims".
 *
 * @module dsh-web-fetch-playwright/actions
 */

import type { PlaywrightPage } from './types.ts'
import { FRAGMENT_VISIBLE_TEXT, spliceFragments } from './page-fragments.ts'
import { urlIsUnder, type Target, type WaitCondition } from './targets.ts'

/** Longest one step may take, before the fetch's own remaining budget caps it. */
export const STEP_CEILING_MS = 10_000

/** How often a condition is re-checked while it is not yet true. */
export const POLL_MS = 250

/** One step's outcome, as the summary reports it. */
export interface StepReport {
  readonly index: number
  readonly verb: string
  /** What the step was waiting for, in words. */
  readonly detail: string
  readonly outcome: 'met' | 'skipped'
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
    const detail = describeCondition(step.condition)
    const startedAt = Date.now()
    const budget = Math.max(0, Math.min(ceiling, options.remainingMs()))
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
    return {
      ok: false,
      failure: {
        index,
        verb: step.verb,
        detail: unanswerable
          ? `${detail} (the page could not be read)`
          : exceedsBudget
            ? `${detail} (only ${String(budget)}ms of the step budget is left)`
            : `${detail} (not met within ${String(budget)}ms)`,
        url: page.url(),
      },
    }
  }

  return { ok: true, run: { steps: reports, finalUrl: page.url() } }
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
  const parts = run.steps.map((step) => {
    const mark = step.outcome === 'skipped' ? 'skipped' : 'met'
    return `${String(step.index + 1)}. ${step.verb} ${step.detail} — ${mark}`
  })
  return `actions: ${parts.join(' · ')} → final document ${run.finalUrl} (HTTP ${String(statusCode)})`
}
