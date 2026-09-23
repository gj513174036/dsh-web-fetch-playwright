/**
 * Running a target's actions.
 *
 * The runner is deliberately dull: for each step it evaluates the step's condition
 * until it holds, clicks the first reachable candidate, or puts the first
 * reachable control into a state and reads it back; a step that does not get
 * there either fails the whole fetch (loudly, naming the step) or, if it was
 * declared `optional`, is skipped and recorded. Nothing here guesses
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
import { checkControl } from './check.ts'
import { clickCandidate } from './click.ts'
import { FRAGMENT_VISIBLE_TEXT, spliceFragments } from './page-fragments.ts'
import { raceTimeout, TIMED_OUT } from './race.ts'
import { readState } from './state.ts'
import { describeCandidate, urlIsUnder, type ActionStep, type Candidate, type Target, type WaitCondition, type WaitStep } from './targets.ts'

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
  /**
   * Did a click actually go out? A click can navigate, so the caller may have to
   * let that land before it describes the document — and only this run knows
   * whether one was dispatched (an `optional` click that was skipped is not).
   */
  readonly clicked: boolean
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
  if (condition.kind === 'state') {
    return `all ${condition.state} over ${condition.candidates.map(describeCandidate).join(' or ')}`
  }
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
 * Is the condition true right now, and if not, what did the page say?
 *
 * The answer carries a short `why` so a step that times out can say what it saw
 * (three of five not checked) instead of only that it waited.
 *
 * @param currentUrl - where the browser is right now.
 * @param condition - the condition to evaluate.
 * @param evaluate - the page's scripting seam, when it has one.
 * @param remainingMs - what is left of the step's budget; one read never outlives it.
 * @returns the verdict, or null when the condition cannot be evaluated at all.
 */
async function conditionHolds(
  currentUrl: string,
  condition: WaitCondition,
  evaluate: ((script: string) => Promise<unknown>) | undefined,
  remainingMs: number,
): Promise<{ held: boolean; why: string } | null> {
  if (condition.kind === 'time') return { held: true, why: '' }
  if (condition.kind === 'url') {
    const under = urlIsUnder(currentUrl, condition.url)
    return { held: condition.absent === true ? !under : under, why: '' }
  }
  if (evaluate === undefined) return null
  if (condition.kind === 'state') {
    // A read that does not answer is "not yet", the same as a text probe that
    // throws: a navigation in flight destroys the execution context, and the next
    // poll is the one that answers. Only a page with no seam at all is
    // unanswerable, and that is the check above.
    return (await readState(evaluate, condition.candidates, condition.state, Math.max(1, remainingMs))) ?? { held: false, why: '' }
  }
  let answer: unknown
  try {
    answer = await raceTimeout(evaluate(textProbeScript(condition.text)), Math.max(1, remainingMs))
  } catch {
    // A poll can fail for a transient reason — the navigation a click causes
    // destroys the execution context — and that is "not yet", not "unreadable".
    // Only a page with no scripting seam at all can never answer.
    return { held: false, why: '' }
  }
  // A read that did not happen is *not* evidence that the text is gone: an
  // `absent` condition that treated "no answer" as "not there" would report a
  // stalled page as the thing it was waiting for.
  if (answer === TIMED_OUT) return { held: false, why: 'the page did not answer' }
  const found = answer === true
  return { held: condition.absent === true ? !found : found, why: '' }
}

/** What a step's candidates look like before anything is tried. */
function describeCandidates(step: { readonly candidates: readonly Candidate[] }): string {
  return step.candidates.map(describeCandidate).join(', ')
}

/**
 * Where a click's judgement comes from: the first `waitFor` after it whose
 * condition is about the page.
 *
 * A fixed wait is not one (the clock passes whether or not the page moved), and
 * neither is an `optional` wait that was skipped — which is why the caller reads
 * the run's reports as well as this recipe position.
 */
function confirmingWaitAfter(actions: readonly ActionStep[], index: number): { index: number; step: WaitStep } | null {
  for (let at = index + 1; at < actions.length; at++) {
    const step = actions[at]
    if (step !== undefined && step.verb === 'waitFor' && step.condition.kind !== 'time') return { index: at, step }
  }
  return null
}

/**
 * Does a URL condition already hold, read from the URL the page is on?
 *
 * The half of "did it already hold before the click" that needs no scripting: a
 * text condition is answered by the click script itself, which can see the page.
 */
function urlConditionHeld(url: string, condition: WaitCondition): boolean {
  if (condition.kind !== 'url') return false
  const under = urlIsUnder(url, condition.url)
  return condition.absent === true ? !under : under
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
  // What the confirming condition was at click time, per click step: a wait that
  // already held cannot be evidence that the click changed anything. `null`
  // means the state could not be read, which is not the same as "it held".
  const heldBeforeClick = new Map<number, boolean | null>()

  for (const [index, step] of target.actions.entries()) {
    const budget = Math.max(0, Math.min(ceiling, options.remainingMs()))
    const failure = (detail: string): ActionOutcome => ({
      ok: false,
      failure: { index, verb: step.verb, detail, url: page.url() },
    })
    /**
     * A step that did not get there. An `optional` one is recorded as skipped and
     * the run carries on (`null`); anything else ends the fetch naming the step.
     * One home for the escape hatch, so no verb can forget it or word it
     * differently.
     */
    const endStep = (detail: string): ActionOutcome | null => {
      if (step.optional === true) {
        reports.push({ index, verb: step.verb, detail, outcome: 'skipped' })
        return null
      }
      return failure(detail)
    }

    if (step.verb === 'click') {
      const detail = `candidates: ${describeCandidates(step)}`
      if (budget === 0) {
        const stopped = endStep(`${detail} (only 0ms of the step budget is left)`)
        if (stopped !== null) return stopped
        continue
      }
      const confirming = confirmingWaitAfter(target.actions, index)
      const urlBefore = page.url()
      if (confirming !== null && confirming.step.condition.kind === 'url') {
        heldBeforeClick.set(index, urlConditionHeld(urlBefore, confirming.step.condition))
      }
      // A state watch is read here, before the click, for the same reason a URL
      // one is: a wait that already held is not evidence that the click did
      // anything. The click script answers for a text watch; the other two kinds
      // are the runner's to ask.
      if (confirming !== null && confirming.step.condition.kind === 'state' && evaluate !== undefined) {
        const read = await readState(evaluate, confirming.step.condition.candidates, confirming.step.condition.state, budget)
        heldBeforeClick.set(index, read?.held ?? null)
      }
      const outcome = await clickCandidate(page, step.candidates, budget, confirming?.step.condition)
      if (outcome.kind === 'clicked') {
        // The script answers for a text watch; a URL watch was answered above,
        // and the script's `null` must not erase that answer.
        heldBeforeClick.set(index, outcome.before ?? heldBeforeClick.get(index) ?? null)
        reports.push({ index, verb: step.verb, detail: outcome.candidate, outcome: 'clicked' })
        continue
      }
      if (outcome.kind === 'clicked-unreported') {
        // The click went out and the page navigated before the script could say
        // which candidate landed — and with it died the pre-click state. A URL
        // that moved is independent evidence the page changed, so a following
        // wait may judge the click; on the same URL nothing here can show a text
        // wait changed, so the click must not borrow its credit.
        if (confirming !== null && confirming.step.condition.kind === 'text' && page.url() === urlBefore) {
          heldBeforeClick.set(index, true)
        }
        reports.push({ index, verb: step.verb, detail: 'a candidate (the page navigated before it could say which)', outcome: 'clicked' })
        continue
      }
      if (outcome.kind === 'unreadable') {
        const stopped = endStep(`${detail} (the page could not be read: ${outcome.problem})`)
        if (stopped !== null) return stopped
        continue
      }
      // Every candidate was passed over: the page says so, with one reason each.
      const why = `no candidate could be clicked, out of ${describeCandidates(step)} — ${outcome.reasons.join('; ')}`
      const stopped = endStep(why)
      if (stopped !== null) return stopped
      continue
    }

    if (step.verb === 'check') {
      const detail = `candidates: ${describeCandidates(step)}, state ${step.state}`
      if (budget === 0) {
        const stopped = endStep(`${detail} (only 0ms of the step budget is left)`)
        if (stopped !== null) return stopped
        continue
      }
      const outcome = await checkControl(page, step.candidates, step.state, budget)
      if (outcome.kind === 'checked') {
        // The verdict is the read-back, not the click: `acted` separates the
        // step that had to do something from the idempotent one, and both report
        // the state the page actually shows.
        const how = outcome.acted ? `was ${outcome.was}, now ${outcome.state}` : `already ${outcome.state}`
        reports.push({ index, verb: step.verb, detail: `${outcome.candidate} (${how})`, outcome: 'met' })
        continue
      }
      const why =
        outcome.kind === 'unchanged'
          ? `${outcome.candidate}: it was ${outcome.was}, the click went out, and it reports ${outcome.now} — the page does not show the change`
          : outcome.kind === 'unverified'
            ? `${detail} (${outcome.problem})`
            : outcome.kind === 'unreadable'
              ? `${detail} (the page could not be read: ${outcome.problem})`
              : `no candidate could be checked, out of ${describeCandidates(step)} — ${outcome.reasons.join('; ')}`
      const stopped = endStep(why)
      if (stopped !== null) return stopped
      continue
    }

    const detail = describeCondition(step.condition)
    const startedAt = Date.now()
    let held = false
    let unanswerable = false
    /** What the last read saw, when the condition's own reader can say. */
    let why = ''

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
        const state = await conditionHolds(page.url(), step.condition, evaluate, budget - (Date.now() - startedAt)).catch(() => null)
        if (state === null) {
          unanswerable = true
          break
        }
        if (state.held) {
          held = true
          break
        }
        why = state.why
        if (Date.now() - startedAt >= budget) break
        await sleep(poll)
      }
    }

    if (held) {
      reports.push({ index, verb: step.verb, detail, outcome: 'met' })
      continue
    }
    const stopped = endStep(
      unanswerable
        ? `${detail} (the page could not be read)`
        : exceedsBudget
          ? `${detail} (only ${String(budget)}ms of the step budget is left)`
          : `${detail}${why === '' ? '' : `: ${why}`} (not met within ${String(budget)}ms)`,
    )
    if (stopped !== null) return stopped
  }

  // The gap a click cannot close by itself: the wait that follows has to have
  // held *and* to have been false at click time, or it says nothing about this
  // click. Deciding it here, once, keeps the verdict out of the verb's own code.
  const marked = reports.map((report) => {
    if (report.outcome !== 'clicked') return report
    const confirming = confirmingWaitAfter(target.actions, report.index)
    const confirmed =
      confirming !== null &&
      reports[confirming.index]?.outcome === 'met' &&
      heldBeforeClick.get(report.index) !== true
    return confirmed ? report : { ...report, outcome: 'unverified' as const }
  })
  const clicked = marked.some((report) => report.verb === 'click' && report.outcome !== 'skipped')
  return { ok: true, run: { steps: marked, finalUrl: page.url(), clicked } }
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
