/**
 * Running a target's actions.
 *
 * The runner is deliberately dull: for each step it evaluates the step's condition
 * until it holds, clicks the first reachable candidate, puts the first reachable
 * control into a state and reads it back, or writes a value into the first
 * reachable field and reads that back; a step that does not get
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
import { checkControl, describeCheckFailure } from './check.ts'
import { clickCandidate, describeClickFailure } from './click.ts'
import { FRAGMENT_VISIBLE_TEXT, spliceFragments } from './page-fragments.ts'
import { raceTimeout, TIMED_OUT } from './race.ts'
import { readState } from './state.ts'
import { describeTypeFailure, typeInto } from './type.ts'
import { describeCandidate, describeMatch, matchesTarget, normalizedUrl, urlIsUnder, type ActionStep, type Candidate, type Target, type TargetMatch, type WaitCondition, type WaitStep } from './targets.ts'

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

/** A run's result: the reports and the page it ended on, or the step that did not hold. */
export type ActionOutcome =
  | {
      readonly ok: true
      readonly run: ActionRun
      /**
       * The page the run ended on — the one it started on, or the page an
       * `opensPage` step opened and the rest of the target ran in. The caller
       * reads *this* document, and reports its URL and status.
       */
      readonly page: PlaywrightPage
    }
  | { readonly ok: false; readonly failure: ActionFailure }

/** Options a run needs from its caller. */
export interface ActionOptions {
  /** What is left of the fetch's budget; a step never outlives it. */
  readonly remainingMs: () => number
  readonly stepCeilingMs?: number
  readonly pollMs?: number
  /**
   * Take responsibility for a page an act opened: the caller stops treating it as
   * a stray tab and closes it with the fetch. Called at most once per step, and
   * only while the step is waiting.
   */
  readonly claimPage?: (page: PlaywrightPage) => void
}

/** A short description of a condition, for the summary and for failures. */
export function describeCondition(condition: WaitCondition): string {
  if (condition.kind === 'text') return `text "${condition.text}"${condition.absent === true ? ' to disappear' : ''}`
  if (condition.kind === 'url') return condition.absent === true ? `to have left ${condition.url}` : `url ${condition.url}`
  if (condition.kind === 'state') {
    return `all ${condition.state} over ${condition.candidates.map(describeCandidate).join(' or ')}`
  }
  if (condition.kind === 'response') return `response ${describeMatch(condition.match)}`
  return `wait ${String(condition.ms)}ms`
}

/**
 * The responses the run has watched arrive.
 *
 * A `response` condition is the one condition the page cannot be asked about: the
 * browser reports responses as they arrive, so the run listens from the moment it
 * starts and remembers what came. Four rules, all deliberate:
 *
 * - **What happened before the run is not evidence.** The journal starts empty
 *   when the actions do, so a response the page fetched while it loaded can never
 *   satisfy a wait. If the data was already there, a text or state condition is
 *   the honest way to say so.
 * - **Only the page the run is on.** An arrival is remembered with the page that
 *   reported it, and a wait matches only its own page: after an `opensPage`
 *   adoption, the page the run left cannot answer for the one it moved to.
 * - **An arrival answers one wait, and a burst is one arrival.** A response is an
 *   event, not a state: a wait consumes every matching arrival in hand, so the
 *   duplicate a React double-fetch or a prefetch leaves behind cannot satisfy the
 *   NEXT wait — which would read a page whose data has not arrived, the silent
 *   wrong answer this plugin refuses to give.
 * - **"Arrived" means the data, not the shell.** A main-frame document is the
 *   page itself (`url` is the condition for "where am I"), and a 4xx/5xx is a
 *   failed fetch, so neither can satisfy a wait — though both are still reported
 *   by {@link ResponseLog.last}, because "the page asked for the wrong thing" and
 *   "the page's request failed" are the sentences an author needs.
 */
interface ResponseLog {
  /**
   * Start watching one page's responses.
   *
   * @returns false when the page offers no response seam at all — a `response`
   *   condition cannot be answered then, and the step must fail saying the page
   *   could not be read rather than spend its budget on a wait nobody is feeding.
   */
  arm(page: PlaywrightPage): boolean
  /**
   * Has a matching response arrived on this page? Spends every one it finds.
   *
   * @param page - the page the run is on; another page's arrivals never answer.
   * @param match - the URL pattern.
   */
  arrived(page: PlaywrightPage, match: TargetMatch): boolean
  /**
   * When did the run's requests reach? A watermark taken before a click.
   *
   * A response already in flight when the click was dispatched proves nothing
   * about the click, and only the request's own start can tell the two apart.
   */
  watermark(): number
  /**
   * Has a matching response arrived on this page from a request that started
   * after this watermark — that is, one this act could have caused?
   */
  caused(page: PlaywrightPage, match: TargetMatch, since: number): boolean
  /** The last response this page saw, matching or not, for a failure sentence. */
  last(page: PlaywrightPage): string | null
}

/**
 * Is this response the page's own document rather than something it fetched?
 *
 * Deliberately the opposite default from the challenge wait's filter (which must
 * treat an unknown shape as a document, because it is looking for a navigation):
 * here an unidentifiable response must stay USABLE, or a backend that reports
 * URLs without request details could never satisfy a wait. A document is skipped
 * only when its request actually says so.
 *
 * @param response - the response the page reported.
 * @returns true when the request identifies itself as a document navigation.
 */
function isDocumentResponse(response: { request?: () => { isNavigationRequest?(): boolean; resourceType?(): string } | undefined }): boolean {
  const request = response.request?.()
  if (request === undefined) return false
  if (typeof request.isNavigationRequest === 'function' && request.isNavigationRequest()) return true
  return typeof request.resourceType === 'function' && request.resourceType() === 'document'
}

/** How many arrivals one fetch keeps. A page cannot spend them all, and a chatty
 *  SPA must not grow the journal for the whole budget. */
const RESPONSE_LOG_LIMIT = 2_000

function watchResponses(): ResponseLog {
  /** One response the browser reported. */
  interface Arrival {
    url: string
    page: PlaywrightPage
    /** The sequence number of the request that produced it. */
    started: number
    /** Can it satisfy a wait at all (a fetch that succeeded, not the document)? */
    usable: boolean
    /** Has a wait already consumed it? */
    spent: boolean
    /** The status as reported, for the sentence a timed-out wait fails with. */
    status: number | null
  }
  const arrivals: Arrival[] = []
  const watching = new WeakSet<PlaywrightPage>()
  /** Requests seen, by identity, so a response can be traced to its start. */
  const started = new WeakMap<object, number>()
  /**
   * Requests seen, by URL, oldest first — the fallback for a backend whose
   * response does not hand back the same request object it reported. Without it
   * every arrival would look brand new, and an act already in flight would be
   * credited to the next click.
   */
  const byUrl = new Map<string, number[]>()
  let requests = 0
  const noteRequest = (url: string): number => {
    requests += 1
    const waiting = byUrl.get(url)
    if (waiting === undefined) byUrl.set(url, [requests])
    else waiting.push(requests)
    return requests
  }
  /**
   * Which request a response belongs to, as a sequence number.
   *
   * An arrival nobody can trace to a request is stamped `0` — before every
   * watermark — so it can satisfy a wait but can never be credited to a click.
   * Crediting it would be a guess in the direction this whole feature exists to
   * avoid: the act's credit is claimed only on evidence.
   */
  const startOf = (request: object | undefined, url: string): number => {
    const known = request === undefined ? undefined : started.get(request)
    if (known !== undefined) return known
    return byUrl.get(url)?.shift() ?? 0
  }
  const statusOf = (response: { status?: () => number }): number | null => {
    try {
      return typeof response.status === 'function' ? response.status() : null
    } catch {
      return null
    }
  }
  return {
    arm(page) {
      // A page is watched once. The caller arms a page when it opens and again
      // when it adopts it, and a second listener would record every response
      // twice — which would let one arrival answer two waits.
      if (watching.has(page)) return true
      if (page.on === undefined) return false
      try {
        page.on('request', (request) => {
          const url = request.url?.() ?? ''
          const seq = noteRequest(url)
          if (typeof request === 'object' && request !== null) started.set(request, seq)
        })
        page.on('response', (response) => {
          const url = response.url?.() ?? ''
          // Only a URL that can be compared with a match clause is worth keeping:
          // a `data:` or `blob:` URL has no host to match against.
          if (url === '' || normalizedUrl(url) === null) return
          const request = response.request?.()
          const status = statusOf(response as { status?: () => number })
          const arrival: Arrival = {
            url,
            page,
            // Traced to its request's start when the backend reports one; a
            // response-only seam stamps it `0`, which no watermark can precede.
            started: startOf(request, url),
            usable: !isDocumentResponse(response) && (status === null || status < 400),
            spent: false,
            status,
          }
          arrivals.push(arrival)
          // Spent arrivals go first — they can never answer anything again — and
          // only then the oldest, so the bounded journal still holds what a wait
          // could still consume.
          while (arrivals.length > RESPONSE_LOG_LIMIT) {
            const spentAt = arrivals.findIndex((entry) => entry.spent)
            arrivals.splice(spentAt === -1 ? 0 : spentAt, 1)
          }
        })
        watching.add(page)
        return true
      } catch {
        return false
      }
    },
    arrived(page, match) {
      let held = false
      for (const arrival of arrivals) {
        if (arrival.page !== page || arrival.spent || !arrival.usable) continue
        if (!matchesTarget(match, arrival.url)) continue
        // Every match goes, not just the first: a burst is one arrival's worth of
        // evidence, and the leftover must not answer the next wait.
        arrival.spent = true
        held = true
      }
      return held
    },
    watermark: () => requests,
    caused(page, match, since) {
      return arrivals.some(
        (arrival) => arrival.page === page && arrival.usable && arrival.started > since && matchesTarget(match, arrival.url),
      )
    },
    last(page) {
      for (let index = arrivals.length - 1; index >= 0; index--) {
        const arrival = arrivals[index]
        if (arrival === undefined || arrival.page !== page) continue
        return arrival.status === null ? arrival.url : `${arrival.url} (HTTP ${String(arrival.status)})`
      }
      return null
    },
  }
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
 * @param responses - the run's response journal, when the page can report
 *   responses at all; `null` leaves a `response` condition unanswerable.
 * @returns the verdict, or null when the condition cannot be evaluated at all.
 */
async function conditionHolds(
  currentUrl: string,
  condition: WaitCondition,
  evaluate: ((script: string) => Promise<unknown>) | undefined,
  remainingMs: number,
  responses: ResponseLog | null = null,
  page: PlaywrightPage | null = null,
): Promise<{ held: boolean; why: string } | null> {
  if (condition.kind === 'time') return { held: true, why: '' }
  if (condition.kind === 'url') {
    const under = urlIsUnder(currentUrl, condition.url)
    return { held: condition.absent === true ? !under : under, why: '' }
  }
  if (condition.kind === 'response') {
    // A page nobody is listening to is not "not yet": nothing will ever arrive,
    // so the honest answer is that this condition cannot be read here.
    if (responses === null || page === null) return null
    if (responses.arrived(page, condition.match)) return { held: true, why: '' }
    // What the run did see is the most useful thing a failed wait can say — a
    // recipe waiting on `/api/search` while the page is calling `/api/other`
    // should hear that, not only that its budget ran out.
    const last = responses.last(page)
    return { held: false, why: last === null ? '' : `the last response was ${last}` }
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
  // stalled page as the thing it was waiting for. It is also not worth a sentence
  // of its own: the last poll of a long wait runs with no budget left and would
  // tell the reader "the page did not answer" about a page that answered forty
  // times — the honest message is that the text was not there for as long as the
  // step waited.
  if (answer === TIMED_OUT) return { held: false, why: '' }
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
    if (step === undefined) continue
    // Another act breaks the chain: a wait that follows it is evidence about
    // THAT act, not about this click. Without this stop, one arrival would
    // verify every click before it — including clicks that did nothing.
    if (step.verb !== 'waitFor') return null
    if (step.condition.kind !== 'time') return { index: at, step }
  }
  return null
}

/** A step's wait for the page its act opens. */
interface OpenedPageWait {
  /** The page, or null when none opened in time. */
  readonly page: Promise<PlaywrightPage | null>
  /**
   * Stop waiting, and stop claiming. A step that turns out not to adopt (its act
   * failed, or it was skipped) must let go: otherwise a page arriving later would
   * be claimed by a step that is no longer running, and the guard would leave a
   * stray tab behind.
   */
  cancel(): void
}

/**
 * Wait for the page an act is about to open.
 *
 * The listener goes on **before** the act, because the page can open while the
 * click is still in flight; the first page to arrive is claimed, so the caller's
 * popup guard leaves it alone instead of closing it as a stray tab. A page that
 * refuses listeners answers `null`, which the step reports as "no page opened" —
 * it cannot be awaited, so it cannot be adopted.
 *
 * @param page - the page the act is about to run on.
 * @param timeoutMs - how long to wait for the page to appear.
 * @param pollMs - how often to look.
 * @param claim - told about the page that arrived, before anything else touches it.
 * @returns the wait, whose promise answers the page or null.
 */
function awaitOpenedPage(
  page: PlaywrightPage,
  timeoutMs: number,
  pollMs: number,
  claim?: (page: PlaywrightPage) => void,
): OpenedPageWait {
  let opened: PlaywrightPage | null = null
  let waiting = true
  try {
    page.on?.('popup', (popup) => {
      if (!waiting || opened !== null) return
      opened = popup
      claim?.(popup)
    })
  } catch {
    return { page: Promise.resolve(null), cancel: () => { waiting = false } }
  }
  const promise = (async () => {
    const startedAt = Date.now()
    while (opened === null && waiting && Date.now() - startedAt < timeoutMs) await sleep(pollMs)
    waiting = false
    return opened
  })()
  return { page: promise, cancel: () => { waiting = false } }
}

/**
 * Continue on the page a click was supposed to open.
 *
 * A step that says `opensPage` and opens nothing fails with the sentence this
 * returns: reading the page it stayed on is the silent wrong answer the whole
 * capability exists to prevent.
 *
 * @param waiting - the waiter's promise, from before the act.
 * @param landed - what the click itself reported.
 * @returns the page to continue on and how to report it, or the failure's detail.
 */
async function adoptOpenedPage(
  waiting: Promise<PlaywrightPage | null>,
  landed: string,
): Promise<{ readonly page: PlaywrightPage; readonly detail: string } | { readonly failure: string }> {
  const page = await waiting
  if (page === null) return { failure: `${landed} (the step expects a page to open, and none did)` }
  return { page, detail: `${landed} (it opened a page; the rest of the target runs there)` }
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
  // The page the run is working on. An `opensPage` step replaces it: everything
  // after that step — the rest of the recipe, and the document the fetch reads —
  // belongs to the page the act opened.
  let current = page
  const reports: StepReport[] = []
  // The run's window onto the network, armed only when a step asks for it: a
  // recipe of waits, clicks and fields must not pay for a listener it never reads.
  const responses = watchResponses()
  const watchesResponses = target.actions.some((step) => step.verb === 'waitFor' && step.condition.kind === 'response')
  let responsesReadable = watchesResponses && responses.arm(page)
  // What the confirming condition was at click time, per click step: a wait that
  // already held cannot be evidence that the click changed anything. `null`
  // means the state could not be read, which is not the same as "it held".
  const heldBeforeClick = new Map<number, boolean | null>()
  /** Per click step: the request watermark it was dispatched at. */
  const dispatchedAt = new Map<number, number>()
  /** The page each response wait ran on, so a click is judged on that page. */
  const waitPage = new Map<number, PlaywrightPage>()

  for (const [index, step] of target.actions.entries()) {
    const budget = Math.max(0, Math.min(ceiling, options.remainingMs()))
    const evaluate = current.evaluate?.bind(current)
    const failure = (detail: string): ActionOutcome => ({
      ok: false,
      failure: { index, verb: step.verb, detail, url: current.url() },
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
      const candidates = describeCandidates(step)
      const detail = `candidates: ${candidates}`
      const startedAtClick = Date.now()
      /** What the click reported, once it has run. */
      let landed = detail
      if (budget === 0) {
        const stopped = endStep(`${detail} (only 0ms of the step budget is left)`)
        if (stopped !== null) return stopped
        continue
      }
      const confirming = confirmingWaitAfter(target.actions, index)
      const urlBefore = current.url()
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
      // A response watch is judged by the requests, not by a point-in-time read
      // of what is in hand: a response already IN FLIGHT when the click goes out
      // is invisible to such a read, and it would credit a click that did
      // nothing. The watermark says where the run's requests had reached; the
      // click is credited only if a matching response came from a request that
      // started after it.
      if (confirming !== null && confirming.step.condition.kind === 'response' && responsesReadable) {
        dispatchedAt.set(index, responses.watermark())
      }
      // Registered before the act: the page can open while the click is in
      // flight, and a listener added afterwards would miss it. Both the wait and
      // the click live inside the step's one budget.
      const leftOfStep = (): number => Math.max(1, budget - (Date.now() - startedAtClick))
      const pageWait = step.opensPage === true
        ? awaitOpenedPage(current, leftOfStep(), poll, (opened) => {
            options.claimPage?.(opened)
            // Watch the page from the moment it opens, not from the moment the
            // run adopts it: what it fetches while it loads is exactly what a
            // wait after this step is about.
            if (watchesResponses) responses.arm(opened)
          })
        : null
      /** A click that does not end up adopting must let its wait go. */
      const giveUpPage = (): void => { pageWait?.cancel() }
      const outcome = await clickCandidate(current, step.candidates, leftOfStep(), confirming?.step.condition)
      if (outcome.kind === 'clicked') {
        // The script answers for a text watch; a URL watch was answered above,
        // and the script's `null` must not erase that answer.
        heldBeforeClick.set(index, outcome.before ?? heldBeforeClick.get(index) ?? null)
        landed = outcome.candidate
      } else if (outcome.kind === 'clicked-unreported') {
        // The click went out and the page navigated before the script could say
        // which candidate landed — and with it died the pre-click state. A URL
        // that moved is independent evidence the page changed, so a following
        // wait may judge the click; on the same URL nothing here can show a text
        // wait changed, so the click must not borrow its credit.
        if (confirming !== null && confirming.step.condition.kind === 'text' && current.url() === urlBefore) {
          heldBeforeClick.set(index, true)
        }
        landed = 'a candidate (the page navigated before it could say which)'
      } else {
        giveUpPage()
        const stopped = endStep(describeClickFailure(detail, candidates, outcome))
        if (stopped !== null) return stopped
        continue
      }
      // The click landed; if the step expected a page, continue on it — or fail
      // saying that none opened.
      if (pageWait !== null) {
        const adopted = await adoptOpenedPage(pageWait.page, landed)
        if ('failure' in adopted) {
          const stopped = endStep(adopted.failure)
          if (stopped !== null) return stopped
          continue
        }
        current = adopted.page
        // The rest of the target runs on this page, so the responses a wait can
        // see are this page's. A page that refuses listeners leaves a later
        // response condition unanswerable, which is what it is.
        if (watchesResponses) responsesReadable = responses.arm(adopted.page)
        landed = adopted.detail
      }
      reports.push({ index, verb: step.verb, detail: landed, outcome: 'clicked' })
      continue
    }

    if (step.verb === 'type') {
      const candidates = describeCandidates(step)
      const detail = `candidates: ${candidates}, value ${JSON.stringify(step.value)}`
      if (budget === 0) {
        const stopped = endStep(`${detail} (only 0ms of the step budget is left)`)
        if (stopped !== null) return stopped
        continue
      }
      const outcome = await typeInto(current, step.candidates, step.value, budget)
      if (outcome.kind === 'typed') {
        // The read-back is the verdict, and `was` says whether it replaced
        // something — a field the recipe filled from empty reads differently from
        // one it overwrote, and the summary says which.
        const how = outcome.was === '' ? `now ${JSON.stringify(outcome.value)}` : `was ${JSON.stringify(outcome.was)}, now ${JSON.stringify(outcome.value)}`
        reports.push({ index, verb: step.verb, detail: `${outcome.candidate} (${how})`, outcome: 'met' })
        continue
      }
      if (outcome.kind === 'typed-unreported') {
        // The write went out and the page moved because of it; whether it took the
        // value where the recipe wanted is the next step's business.
        reports.push({ index, verb: step.verb, detail: outcome.candidate, outcome: 'met' })
        continue
      }
      const stopped = endStep(describeTypeFailure(detail, candidates, outcome))
      if (stopped !== null) return stopped
      continue
    }

    if (step.verb === 'check') {
      const candidates = describeCandidates(step)
      const detail = `candidates: ${candidates}, state ${step.state}`
      if (budget === 0) {
        const stopped = endStep(`${detail} (only 0ms of the step budget is left)`)
        if (stopped !== null) return stopped
        continue
      }
      const outcome = await checkControl(current, step.candidates, step.state, budget)
      if (outcome.kind === 'checked') {
        // The verdict is the read-back, not the click: `acted` separates the
        // step that had to do something from the idempotent one, and both report
        // the state the page actually shows.
        const how = outcome.acted ? `was ${outcome.was}, now ${outcome.state}` : `already ${outcome.state}`
        reports.push({ index, verb: step.verb, detail: `${outcome.candidate} (${how})`, outcome: 'met' })
        continue
      }
      const stopped = endStep(describeCheckFailure(detail, candidates, outcome))
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
        if (step.condition.kind === 'response') waitPage.set(index, current)
        const state = await conditionHolds(current.url(), step.condition, evaluate, budget - (Date.now() - startedAt), responsesReadable ? responses : null, current).catch(() => null)
        if (state === null) {
          unanswerable = true
          break
        }
        if (state.held) {
          held = true
          break
        }
        // Keep the last thing the page actually said: the final poll runs with
        // almost no budget left, answers nothing, and must not erase the count
        // that came before it.
        if (state.why !== '') why = state.why
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
  // held *and* to have been about something this click did. Deciding it here,
  // once, keeps the verdict out of the verb's own code.
  const marked = reports.map((report) => {
    if (report.outcome !== 'clicked') return report
    const confirming = confirmingWaitAfter(target.actions, report.index)
    const held = confirming !== null && reports[confirming.index]?.outcome === 'met'
    // A response watch is asked a different question, because it is the one
    // condition that can be satisfied by something the click did not do: did a
    // matching response come from a request that started after the click? The
    // other kinds are read before the click, and one that already held proves
    // nothing about it.
    const confirmingKind = confirming?.step.condition.kind
    const aboutThisClick =
      confirmingKind === 'response'
        ? confirming !== null &&
          dispatchedAt.has(report.index) &&
          responses.caused(waitPage.get(confirming.index) ?? current, confirming.step.condition.match, dispatchedAt.get(report.index) ?? 0)
        : heldBeforeClick.get(report.index) !== true
    return held && aboutThisClick ? report : { ...report, outcome: 'unverified' as const }
  })
  const clicked = marked.some((report) => report.verb === 'click' && report.outcome !== 'skipped')
  return { ok: true, run: { steps: marked, finalUrl: current.url(), clicked }, page: current }
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
