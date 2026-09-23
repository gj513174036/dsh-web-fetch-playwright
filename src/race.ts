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
