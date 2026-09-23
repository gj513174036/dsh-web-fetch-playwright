/**
 * Bounding one call into the page, and naming what came back.
 *
 * Every probe this plugin makes runs on a page it does not control: the
 * execution context can be destroyed mid-call (a click navigates), a stalled
 * script can outlive the fetch, and a backend's scripting seam may simply never
 * answer. The answer to all three is the same — give the call a budget and take
 * a sentinel back when the budget runs out — and it had been written out three
 * times before this module existed (the consent probe, the observe probe, the
 * click probe), which is exactly the kind of copy that drifts.
 *
 * The losing promise is not abandoned: it keeps the rejection handler attached
 * below, so a late failure is handled rather than surfacing as an unhandled
 * rejection.
 *
 * @module dsh-web-fetch-playwright/race
 */

/** Sentinel for {@link raceTimeout}, distinct from any answer a page can give. */
export const TIMED_OUT = Symbol('dsh-web-fetch-timed-out')

/**
 * Settle `work`, or give up after `ms`.
 *
 * @param work - the promise to bound.
 * @param ms - the budget in milliseconds.
 * @returns the value, or {@link TIMED_OUT}.
 */
export function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(TIMED_OUT) }, ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** What one call into the page came back with. */
export type PageAnswer =
  /** The page answered with an object, which is what every probe here returns. */
  | { readonly kind: 'answer'; readonly value: Record<string, unknown> }
  /** The page did not answer inside the budget. */
  | { readonly kind: 'timeout' }
  /** The call itself threw — a navigation in flight, a detached frame, a closed page. */
  | { readonly kind: 'failed'; readonly error: unknown }
  /** The page answered, but not with the shape a probe returns. */
  | { readonly kind: 'unexpected' }

/**
 * Ask the page one question, bounded.
 *
 * The four outcomes are the four things a caller has to tell apart: an answer to
 * read, a page that did not answer in time, a call that threw (which a *click*
 * has to read as "the page moved under me", not as a failure), and an answer that
 * is not a probe's answer. Naming them once is what keeps five probes from each
 * writing their own version of the same three lines.
 *
 * @param evaluate - the page's scripting seam.
 * @param script - the script to run.
 * @param timeoutMs - the budget for this one call.
 * @returns which of the four happened.
 */
export async function askPage(
  evaluate: (script: string) => Promise<unknown>,
  script: string,
  timeoutMs: number,
): Promise<PageAnswer> {
  let answer: unknown
  try {
    answer = await raceTimeout(evaluate(script), Math.max(0, timeoutMs))
  } catch (error: unknown) {
    return { kind: 'failed', error }
  }
  if (answer === TIMED_OUT) return { kind: 'timeout' }
  if (typeof answer !== 'object' || answer === null) return { kind: 'unexpected' }
  return { kind: 'answer', value: answer as Record<string, unknown> }
}

/** A rejection, as a message a caller can put in front of a user. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Does this failure describe the page moving out from under the script?
 *
 * A click (or a check, or a write) is what caused it, so it cannot be read as
 * "the control was not there" — and a phrase list is the only signal the seam
 * gives. Kept narrow and in one place: anything else stays an honest "the page
 * could not be read".
 *
 * @param error - what the scripting seam rejected with.
 * @returns true when the page most likely navigated.
 */
export function looksLikeNavigation(error: unknown): boolean {
  const message = messageOf(error)
  return /execution context was destroyed|navigat|target closed|context or browser has been closed|frame was detached|has been closed/i.test(message)
}

/**
 * What a call that did not answer means to a verb that acted.
 *
 * `null` means the page *did* answer and the caller should read it; otherwise the
 * verb maps the verdict into its own vocabulary (`clicked-unreported`,
 * `unverified`, `unreadable`) — the wording differs per verb, the reading does
 * not.
 *
 * @param answer - what came back.
 * @param what - the noun for the unexpected case, e.g. `check`.
 * @param timeoutMs - the budget the call had, for the message.
 * @returns the verdict, or null when there is an answer to read.
 */
export function seamFailure(
  answer: PageAnswer,
  what: string,
  timeoutMs: number,
): { readonly kind: 'navigated' } | { readonly kind: 'unreadable'; readonly problem: string } | null {
  if (answer.kind === 'failed') {
    return looksLikeNavigation(answer.error)
      ? { kind: 'navigated' }
      : { kind: 'unreadable', problem: messageOf(answer.error) }
  }
  if (answer.kind === 'timeout') return { kind: 'unreadable', problem: `the page did not answer within ${String(timeoutMs)}ms` }
  if (answer.kind === 'unexpected') return { kind: 'unreadable', problem: `the page answered with something other than a ${what} result` }
  return null
}

/**
 * The two failures every acting verb words the same way, or `null` when this one
 * is the verb's own to explain.
 *
 * @param detail - the step's own description, which the message starts from.
 * @param outcome - a failure whose kind is `unverified` or `unreadable`.
 * @returns the sentence, or null when the caller has its own.
 */
export function sharedStepFailure(detail: string, outcome: { readonly kind: string; readonly problem?: string }): string | null {
  if (outcome.kind === 'unverified') return `${detail} (${outcome.problem ?? 'the act could not be confirmed'})`
  if (outcome.kind === 'unreadable') return `${detail} (the page could not be read: ${outcome.problem ?? 'it did not answer'})`
  return null
}

/**
 * The fields every acting verb's script answers with, as they arrive.
 *
 * All `unknown` on purpose: this is the boundary where a page's answer stops
 * being trusted. Each verb extends it with the fields only it returns, and
 * narrows every one before use.
 */
export interface ProbeAnswer {
  readonly ok?: unknown
  readonly candidate?: unknown
  readonly attempted?: unknown
  readonly why?: unknown
  readonly tried?: unknown
}

/** What the failure half of an act's answer says. */
export type ActVerdict =
  /** The act went out and its read-back did not happen. */
  | { readonly kind: 'unverified'; readonly problem: string }
  /** Nothing was acted on; one reason per candidate that was passed over. */
  | { readonly kind: 'passed-over'; readonly reasons: readonly string[] }

/**
 * Read the failure half of an act's answer.
 *
 * Every acting verb's script answers the same way when it fails: `attempted` names
 * the candidate whose act went out before the read-back died, or `tried` holds one
 * reason per candidate that was passed over. One reader, so `check` and `type`
 * cannot disagree about what a lost read-back means.
 *
 * @param shape - the answer's fields.
 * @param lostReason - what to say when the page did not explain itself.
 * @returns which of the two happened.
 */
export function actFailure(shape: ProbeAnswer, lostReason: string): ActVerdict {
  if (typeof shape['attempted'] === 'string') {
    const why = typeof shape['why'] === 'string' ? shape['why'] : lostReason
    return { kind: 'unverified', problem: `${shape['attempted']}: ${why}` }
  }
  const tried = shape['tried']
  return { kind: 'passed-over', reasons: Array.isArray(tried) ? tried.filter((entry): entry is string => typeof entry === 'string') : [] }
}
