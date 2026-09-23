/**
 * Bounding one call into the page.
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
