/**
 * Running a target's actions.
 *
 * The page is faked to the member the runner actually uses (its URL and its
 * scripting seam), so each case states a condition and observes the outcome: met,
 * skipped, clicked, unverified, or the failure that names the step.
 */
import { describe, expect, it } from 'vitest'
import { describeCondition, renderActionSummary, runTargetActions, textProbeScript } from '../src/actions.ts'
import { CLICK_SCRIPT_MARKER } from '../src/click.ts'
import type { ActionFailure, ActionRun } from '../src/actions.ts'
import type { ActionStep, Candidate, CheckStep, ClickStep, Target, TypeStep, WaitStep } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const target = (...steps: readonly ActionStep[]): Target => ({
  name: 't',
  match: { kind: 'prefix', url: 'https://a.example/search' },
  actions: steps,
})

const text = (value: string, absent?: boolean): WaitStep =>
  absent === true ? { verb: 'waitFor', condition: { kind: 'text', text: value, absent: true } } : { verb: 'waitFor', condition: { kind: 'text', text: value } }

const click = (...candidates: readonly Candidate[]): ClickStep => ({ verb: 'click', candidates })

const check = (candidates: readonly Candidate[], state: 'checked' | 'unchecked' = 'checked'): CheckStep => ({ verb: 'check', candidates, state })

const type = (candidates: readonly Candidate[], value: string): TypeStep => ({ verb: 'type', candidates, value })

function pageWith(options: { url?: string; evaluate?: (script: string) => Promise<unknown> }): PlaywrightPage {
  const base = { url: () => options.url ?? 'https://a.example/search' }
  return (options.evaluate === undefined ? base : { ...base, evaluate: options.evaluate }) as unknown as PlaywrightPage
}

/**
 * A page that answers the click probe and the text probes separately, so one
 * fake can stand behind a recipe that both clicks and waits.
 */
function clickPage(answer: unknown | (() => unknown)): PlaywrightPage {
  return pageWith({
    evaluate: async (script) => {
      // Only the click script carries a watch.
      if (!script.includes(CLICK_SCRIPT_MARKER)) return true
      return typeof answer === 'function' ? (answer as () => unknown)() : answer
    },
  })
}

/**
 * A page that answers the check probe and nothing else.
 *
 * The two probes are told apart by a marker unique to each script: only the
 * check script passes an `accept` filter, and only the state script asks a
 * `want` without one.
 */
function checkPage(answer: unknown): PlaywrightPage {
  return pageWith({ evaluate: async (script) => (script.includes('const accept = ') ? answer : true) })
}

/** A page that answers the type probe and nothing else. */
function typePage(answer: unknown): PlaywrightPage {
  return pageWith({ evaluate: async (script) => (script.includes('const value = ') ? answer : true) })
}

/** A page that answers the state probe and nothing else. */
function statePage(answer: unknown): PlaywrightPage {
  return pageWith({
    evaluate: async (script) => (script.includes('const want = ') && !script.includes('const accept = ') ? answer : true),
  })
}

/**
 * One beat of a scripted page, as a browser reports it: a request going out and
 * its response landing. `requestAt` and `at` are when each happens — `arm` is the
 * moment the run opens its journal (something already in flight), `probe` is when
 * an act runs, `timer` is after `afterMs`.
 */
interface ResponseBeat {
  url: string
  at: 'arm' | 'probe'
  /** When the request went out; defaults to the moment the response lands. */
  requestAt?: 'arm' | 'probe'
  /** The status the response carries; 500 models a failed fetch. */
  status?: number
  /** True when the response is a document navigation, not a fetch. */
  document?: boolean
}

/**
 * A page that reports requests and responses the way a browser does, so the
 * journal's rules can be stated one at a time: what the run already had in hand,
 * what was in flight when an act went out, what a burst leaves behind.
 *
 * The click probe is the act (`CLICK_SCRIPT_MARKER`), which is also when a beat
 * marked `probe` fires — while the click is in flight, the race the condition
 * exists for.
 */
function responsePage(beats: readonly ResponseBeat[]): PlaywrightPage {
  const requestListeners: ((request: { url(): string }) => void)[] = []
  const responseListeners: ((response: unknown) => void)[] = []
  /** One stable request object per beat — a browser hands back the same one. */
  const requests = beats.map((beat) => ({
    url: () => beat.url,
    resourceType: () => (beat.document === true ? 'document' : 'xhr'),
  }))
  let armed = false
  const fireRequest = (index: number): void => {
    for (const listener of requestListeners) listener(requests[index] as { url(): string })
  }
  const fireResponse = (index: number): void => {
    const beat = beats[index]
    const response = {
      url: () => beat?.url ?? '',
      status: () => beat?.status ?? 200,
      headers: () => ({}),
      text: async () => '',
      // A document beat says so through its request, the way a real one does.
      request: () => requests[index],
    }
    for (const listener of responseListeners) listener(response)
  }
  return {
    url: () => 'https://a.example/search',
    on: (event: string, listener: (() => void) | ((request: { url(): string }) => void)) => {
      if (event === 'request') {
        requestListeners.push(listener as (request: { url(): string }) => void)
        return undefined
      }
      if (event !== 'response') return undefined
      responseListeners.push(listener as (response: unknown) => void)
      if (!armed) {
        armed = true
        // Everything in flight when the run opens its journal goes out now, in
        // order — a page that fetched on load — and the beats whose response is
        // already in hand land now too.
        for (const [index, beat] of beats.entries()) {
          if (beat.requestAt === 'arm' || (beat.requestAt === undefined && beat.at !== 'probe')) fireRequest(index)
        }
        for (const [index, beat] of beats.entries()) {
          if (beat.at === 'arm') fireResponse(index)
        }
      }
      return undefined
    },
    evaluate: async (script: string) => {
      if (script.includes(CLICK_SCRIPT_MARKER)) {
        for (const [index, beat] of beats.entries()) {
          if (beat.at !== 'probe') continue
          if (beat.requestAt !== 'arm') fireRequest(index)
          fireResponse(index)
        }
        return { ok: true, candidate: 'selector "#go"' }
      }
      return true
    },
  } as unknown as PlaywrightPage
}

/** A `waitFor` on a response whose URL is under `https://a.example/api/search`. */
const responseWait = (kind: 'prefix' | 'exact' = 'prefix'): WaitStep => ({
  verb: 'waitFor',
  condition: { kind: 'response', match: { kind, url: 'https://a.example/api/search' } },
})

const allChecked = { ok: true, scope: 'selector "input[type=checkbox]"', total: 5, notInState: 0, holds: true, sample: '' }

const options = { remainingMs: () => 5_000, stepCeilingMs: 20, pollMs: 1 }

describe('runTargetActions', () => {
  it('reports a text condition that holds', async () => {
    const outcome = await runTargetActions(pageWith({ evaluate: async () => true }), target(text('结果')), options)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps).toEqual([{ index: 0, verb: 'waitFor', detail: 'text "结果"', outcome: 'met' }])
  })

  it('honours a disappearance condition', async () => {
    const outcome = await runTargetActions(pageWith({ evaluate: async () => false }), target(text('加载中', true)), options)
    expect(outcome.ok).toBe(true)
  })

  it('fails loudly when a condition never holds, naming the step', async () => {
    const outcome = await runTargetActions(pageWith({ evaluate: async () => false }), target(text('结果')), options)
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.index).toBe(0)
    expect(failure.verb).toBe('waitFor')
    expect(failure.detail).toContain('text "结果"')
    expect(failure.url).toBe('https://a.example/search')
  })

  it('does not accept an unreadable page as success', async () => {
    // The scripting seam is optional; a condition that needs it cannot be
    // assumed to hold when the handle cannot answer.
    const outcome = await runTargetActions(pageWith({}), target(text('结果')), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('could not be read')
  })

  it('waits for a URL, and stops when it never arrives', async () => {
    const arrived = await runTargetActions(pageWith({ url: 'https://a.example/results?page=1' }), target({ verb: 'waitFor', condition: { kind: 'url', url: 'https://a.example/results' } }), options)
    expect(arrived.ok).toBe(true)
    const missed = await runTargetActions(pageWith({ url: 'https://a.example/other' }), target({ verb: 'waitFor', condition: { kind: 'url', url: 'https://a.example/results' } }), options)
    expect(missed.ok).toBe(false)
  })

  it('treats a fixed wait as satisfied once it has elapsed', async () => {
    const outcome = await runTargetActions(pageWith({}), target({ verb: 'waitFor', condition: { kind: 'time', ms: 1 } }), options)
    expect(outcome.ok).toBe(true)
  })

  it('does not pretend a fixed wait happened when it cannot fit', async () => {
    // Sleeping the shortened time and reporting met would be a step claiming
    // something untrue; the wait did not elapse.
    const tight = { remainingMs: () => 5_000, stepCeilingMs: 20, pollMs: 1 }
    const outcome = await runTargetActions(pageWith({}), target({ verb: 'waitFor', condition: { kind: 'time', ms: 60_000 } }), tight)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('of the step budget is left')
  })

  it('keeps polling when a read fails transiently', async () => {
    // A click's navigation destroys the execution context, and the next poll is
    // the one that answers: a transient failure is "not yet", not "unreadable".
    let calls = 0
    const outcome = await runTargetActions(
      pageWith({ evaluate: async () => { calls += 1; if (calls === 1) throw new Error('Execution context was destroyed'); return true } }),
      target(text('结果')),
      options,
    )
    expect(outcome.ok).toBe(true)
    expect(calls).toBeGreaterThan(1)
  })

  it('never reads a page that did not answer as the thing having gone', async () => {
    // A throw or a timeout is "we do not know"; for an `absent` condition that
    // must not be read as "it is gone", which would report a stalled page as the
    // thing the recipe was waiting for.
    const gone = text('加载中', true)
    const stalled = await runTargetActions(pageWith({ evaluate: () => new Promise(() => {}) }), target(gone), options)
    expect(stalled.ok).toBe(false)
    expect((stalled as { failure: ActionFailure }).failure.detail).toContain('text "加载中" to disappear')

    const throwing = await runTargetActions(
      pageWith({ evaluate: async () => { throw new Error('Execution context was destroyed') } }),
      target(gone),
      options,
    )
    expect(throwing.ok).toBe(false)
  })

  it('can wait to have left a URL, not only to have arrived at one', async () => {
    const left: WaitStep = { verb: 'waitFor', condition: { kind: 'url', url: 'https://a.example/search', absent: true } }
    const gone = await runTargetActions(pageWith({ url: 'https://a.example/results' }), target(left), options)
    expect(gone.ok).toBe(true)
    const stayed = await runTargetActions(pageWith({ url: 'https://a.example/search?q=1' }), target(left), options)
    expect(stayed.ok).toBe(false)
    expect((stayed as { failure: ActionFailure }).failure.detail).toContain('to have left')
  })

  it('holds a response condition once the matching response arrives', async () => {
    // The one condition the page cannot be asked about: the run listens, and the
    // arrival is the answer.
    const outcome = await runTargetActions(responsePage([{ url: 'https://a.example/api/search?kw=x', at: 'arm' }]), target(responseWait()), options)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps).toEqual([
      { index: 0, verb: 'waitFor', detail: 'response under https://a.example/api/search', outcome: 'met' },
    ])
  })

  it('ignores a response that does not match, and says what it did see', async () => {
    const outcome = await runTargetActions(responsePage([{ url: 'https://a.example/api/other', at: 'arm' }]), target(responseWait()), options)
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.detail).toContain('response under https://a.example/api/search')
    // A recipe waiting on the wrong endpoint should hear which one the page
    // actually called, not only that its budget ran out.
    expect(failure.detail).toContain('the last response was https://a.example/api/other')
  })

  it('never reports a response condition met when nobody is listening', async () => {
    // No response seam at all is not "not yet": nothing will ever arrive, so the
    // step must fail saying the page could not be read.
    const outcome = await runTargetActions(pageWith({ evaluate: async () => true }), target(responseWait()), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('could not be read')
  })

  it('will not call a failed fetch or the page itself "the data arrived"', async () => {
    // A 500 is a failed fetch and a document is the page shell: neither is the
    // answer a recipe is waiting for. Both are still named in the failure, so the
    // author hears what the page actually did.
    const failed = await runTargetActions(responsePage([{ url: 'https://a.example/api/search', at: 'arm', status: 500 }]), target(responseWait()), options)
    expect(failed.ok).toBe(false)
    expect((failed as { failure: ActionFailure }).failure.detail).toContain('the last response was https://a.example/api/search (HTTP 500)')

    const document = await runTargetActions(responsePage([{ url: 'https://a.example/api/search', at: 'arm', document: true }]), target(responseWait()), options)
    expect(document.ok).toBe(false)
    // A document is the page itself, and `url` is the condition for "where am I".
    expect((document as { failure: ActionFailure }).failure.detail).toContain('response under https://a.example/api/search')
  })

  it('credits a click with the response it caused', async () => {
    // The request goes out while the click is in flight — the race a listener
    // armed at the wait would lose — so the wait holds and the click is verified.
    const outcome = await runTargetActions(
      responsePage([{ url: 'https://a.example/api/search?kw=x', at: 'probe' }]),
      target(click({ kind: 'selector', selector: '#go' }), responseWait()),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['clicked', 'met'])
  })

  it('does not credit a click with a response the run already had', async () => {
    // The arrival is in the journal before the click even goes out, and nothing
    // has spent it: the wait after the click consumes it, so the wait holding
    // says nothing about the click.
    const outcome = await runTargetActions(
      responsePage([{ url: 'https://a.example/api/search?kw=1', at: 'arm' }]),
      target(click({ kind: 'selector', selector: '#go' }), responseWait()),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('does not credit a click with a response that was already in flight', async () => {
    // The request went out before the click, and only its answer lands during the
    // wait: an arrival in hand at dispatch time is invisible to any "what is in
    // hand" read, so the watermarks are what tell the two apart.
    const outcome = await runTargetActions(
      responsePage([{ url: 'https://a.example/api/search?kw=1', requestAt: 'arm', at: 'probe' }]),
      target(click({ kind: 'selector', selector: '#go' }), responseWait()),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('credits a click when the arrival in hand was already spent by an earlier wait', async () => {
    // The mirror of the case above: an arrival an earlier wait consumed cannot be
    // consumed again, so it is not evidence against this click — and counting it
    // as such would mark a genuinely-caused click unverified.
    const outcome = await runTargetActions(
      responsePage([
        { url: 'https://a.example/api/search?kw=1', at: 'arm' },
        { url: 'https://a.example/api/search?kw=2', at: 'probe' },
      ]),
      target(responseWait(), click({ kind: 'selector', selector: '#go' }), responseWait()),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['met', 'clicked', 'met'])
  })

  it('spends a burst, so a duplicate cannot answer the next wait', async () => {
    // A React double-fetch leaves two arrivals behind one act. If only the first
    // were spent, the next wait would hold instantly on the leftover and the run
    // would read a page whose data has not arrived — the silent wrong answer.
    const outcome = await runTargetActions(
      responsePage([
        { url: 'https://a.example/api/search?kw=1', at: 'arm' },
        { url: 'https://a.example/api/search?kw=1', at: 'arm' },
      ]),
      target(responseWait(), responseWait()),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.index).toBe(1)
    expect(failure.detail).toContain('response under https://a.example/api/search')
  })

  it('never lets the page it left answer for the one it moved to', async () => {
    // After an `opensPage` adoption the run is on the opened page, and the page it
    // left is still reporting traffic — which must not satisfy a wait on the new
    // one. Without page tagging this wait holds, and the fetch reads the old
    // page's data as the new page's answer.
    const opened = responsePage([])
    let fromThePageItLeft: ((response: unknown) => void) | undefined
    let delivered = false
    const lateUrl = 'https://a.example/api/search?from=the-first-page'
    const opener = {
      url: () => 'https://a.example/search',
      evaluate: async (script: string) => (script.includes(CLICK_SCRIPT_MARKER) ? { ok: true, candidate: 'selector "#go" -> link' } : true),
      on: (event: string, listener: (payload: never) => void) => {
        if (event === 'response') {
          fromThePageItLeft = listener as unknown as (response: unknown) => void
          return undefined
        }
        if (event !== 'popup') return undefined
        queueMicrotask(() => {
          listener(opened as never)
          // In flight when the click went out; it lands while the NEW page is
          // being waited on. Its delivery is asserted below, so this case cannot
          // pass just because the arrival never came.
          setTimeout(() => {
            delivered = true
            fromThePageItLeft?.({
              url: () => lateUrl,
              status: () => 200,
              headers: () => ({}),
              text: async () => '',
              request: () => ({ url: () => lateUrl }),
            })
          }, 5)
        })
        return undefined
      },
    } as unknown as PlaywrightPage
    const outcome = await runTargetActions(
      opener,
      target({ verb: 'click', candidates: [{ kind: 'selector', selector: '#go' }], opensPage: true }, responseWait()),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.index).toBe(1)
    expect(failure.detail).toContain('response under https://a.example/api/search')
    // The arrival really happened, on the page the run had left.
    expect(delivered).toBe(true)
  })

  it('never lets one wait verify a click that another act came after', async () => {
    // The chain stop: a wait may only confirm the act immediately before it. Here
    // the cookie click is followed by another click, so the response the second
    // click caused says nothing about the first — reporting it "clicked" would be
    // a click credited with somebody else's arrival.
    const outcome = await runTargetActions(
      responsePage([
        { url: 'https://a.example/api/other', at: 'arm' },
        { url: 'https://a.example/api/search?kw=x', at: 'probe' },
      ]),
      target(
        click({ kind: 'selector', selector: '#cookie' }),
        { verb: 'waitFor', condition: { kind: 'time', ms: 1 } },
        click({ kind: 'selector', selector: '#go' }),
        responseWait(),
      ),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met', 'clicked', 'met'])
  })

  it('describes a response condition as the match it carries', () => {
    expect(describeCondition(responseWait().condition)).toBe('response under https://a.example/api/search')
    expect(describeCondition(responseWait('exact').condition)).toBe('response exactly https://a.example/api/search')
  })

  it('skips an optional step that does not hold and carries on', async () => {
    const outcome = await runTargetActions(
      pageWith({ evaluate: async (script) => script.includes('late') }),
      target(text('gone', true), text('late')),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['met', 'met'])
    const skipped = await runTargetActions(
      pageWith({ evaluate: async () => false }),
      target({ ...text('结果'), optional: true }, { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(skipped.ok).toBe(true)
    if (!skipped.ok) return
    expect(skipped.run.steps.map((step) => step.outcome)).toEqual(['skipped', 'met'])
  })

  it('reports the document it ended on', async () => {
    const outcome = await runTargetActions(pageWith({ url: 'https://a.example/after', evaluate: async () => true }), target(text('结果')), options)
    expect(outcome.ok && outcome.run.finalUrl).toBe('https://a.example/after')
  })
})

describe('runTargetActions, the type verb', () => {
  it('reports what it wrote, and whether it replaced something', async () => {
    const filled = await runTargetActions(
      typePage({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '', value: '维生素D', wanted: '维生素D' }),
      target(type([{ kind: 'selector', selector: '#kw' }], '维生素D')),
      options,
    )
    expect(filled.ok && filled.run.steps).toEqual([
      { index: 0, verb: 'type', detail: 'selector "#kw" -> searchbox (now "维生素D")', outcome: 'met' },
    ])

    const replaced = await runTargetActions(
      typePage({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '旧查询', value: '维生素D', wanted: '维生素D' }),
      target(type([{ kind: 'selector', selector: '#kw' }], '维生素D')),
      options,
    )
    expect(replaced.ok && replaced.run.steps[0]?.detail).toBe('selector "#kw" -> searchbox (was "旧查询", now "维生素D")')
  })

  it('fails when the page did not take the value, saying what it holds instead', async () => {
    // The controlled-component revert: the write landed and the page re-rendered
    // the old value, so the field a person sees is still empty.
    const outcome = await runTargetActions(
      typePage({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '', value: '', wanted: '维生素D' }),
      target(type([{ kind: 'selector', selector: '#kw' }], '维生素D')),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.verb).toBe('type')
    expect(failure.url).toBe('https://a.example/search')
    expect(failure.detail).toBe('selector "#kw" -> searchbox: "维生素D" was written into it (it held "") and it now holds "" — the page did not take it')
  })

  it('fails when no candidate is a field that takes text, naming each one', async () => {
    const outcome = await runTargetActions(
      typePage({ ok: false, attempted: null, tried: ['selector "#cb": matched 1, not usable (it is not a field that takes text)', 'text "关键字": no match'] }),
      target(type([{ kind: 'selector', selector: '#cb' }], 'x')),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.detail).toContain('no candidate could be typed into, out of selector "#cb"')
    expect(failure.detail).toContain('selector "#cb": matched 1, not usable (it is not a field that takes text)')
    expect(failure.detail).toContain('text "关键字": no match')
  })

  it('skips an optional type that cannot be written, and runs the rest', async () => {
    const outcome = await runTargetActions(
      typePage({ ok: false, attempted: null, tried: ['text "关键字": no match'] }),
      target({ ...type([{ kind: 'text', text: '关键字' }], 'x'), optional: true }, { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['skipped', 'met'])
  })

  it('reports a write whose page navigated as done, not as a failure', async () => {
    // The navigation is the page's reaction to the write; whether it was the
    // right reaction is what the following step is for.
    const outcome = await runTargetActions(
      pageWith({ evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation') } }),
      target(type([{ kind: 'selector', selector: '#kw' }], '维生素D'), { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['met', 'met'])
    expect(outcome.run.steps[0]?.detail).toContain('the page navigated')
  })

  it('does not send a write to a page it has no budget left for', async () => {
    let asked = 0
    const page = pageWith({ evaluate: async () => { asked += 1; return { ok: true } } })
    const outcome = await runTargetActions(page, target(type([{ kind: 'selector', selector: '#kw' }], 'x')), { remainingMs: () => 0, stepCeilingMs: 20, pollMs: 1 })
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('only 0ms of the step budget is left')
    expect(asked).toBe(0)
  })
})

describe('runTargetActions, the state condition', () => {
  const condition = (state: 'checked' | 'unchecked' | 'enabled' | 'disabled'): WaitStep => ({
    verb: 'waitFor',
    condition: { kind: 'state', state, candidates: [{ kind: 'selector', selector: 'input[type=checkbox]' }] },
  })

  it('reports the condition that held, and what it was about', async () => {
    const outcome = await runTargetActions(statePage(allChecked), target(condition('checked')), options)
    expect(outcome.ok && outcome.run.steps).toEqual([
      {
        index: 0,
        verb: 'waitFor',
        detail: 'all checked over selector "input[type=checkbox]"',
        outcome: 'met',
      },
    ])
  })

  it('fails with what the page said, not only that it waited', async () => {
    const outcome = await runTargetActions(
      statePage({ ok: true, scope: 'selector "input[type=checkbox]"', total: 5, notInState: 3, holds: false, sample: '全选' }),
      target(condition('checked')),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.detail).toContain('all checked over selector "input[type=checkbox]"')
    expect(failure.detail).toContain('3 of 5 controls in selector "input[type=checkbox]" are not checked (e.g. "全选")')
    expect(failure.detail).toContain('not met within')
    expect(failure.url).toBe('https://a.example/search')
  })

  it('says when nothing could be asked at all', async () => {
    const outcome = await runTargetActions(statePage({ ok: false, tried: ['text "全选": no match'] }), target(condition('checked')), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('no candidate named a control that can be asked this (text "全选": no match)')
  })

  it('cannot be answered by a page with no scripting seam', async () => {
    const outcome = await runTargetActions(pageWith({}), target(condition('checked')), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('could not be read')
  })

  it('reads a state watch before the click, so a wait that already held proves nothing', async () => {
    // The click's confirmation rule is "the wait changed", and a state wait is no
    // exception: it is read before the click like a URL one.
    const holds = { ok: true, scope: 'selector "#a"', total: 1, notInState: 0, holds: true, sample: '' }
    const page = pageWith({
      evaluate: async (script) => {
        if (script.includes('const accept = ')) return holds
        if (script.includes('const want = ')) return holds
        if (script.includes(CLICK_SCRIPT_MARKER)) return { ok: true, candidate: 'selector "#a" -> button' }
        return true
      },
    })
    const outcome = await runTargetActions(
      page,
      target(click({ kind: 'selector', selector: '#a' }), {
        verb: 'waitFor',
        condition: { kind: 'state', state: 'checked', candidates: [{ kind: 'selector', selector: '#a' }] },
      }),
      options,
    )
    expect(outcome.ok && outcome.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('keeps the last thing the page said when the final poll runs out of budget', async () => {
    // The last poll gets whatever budget is left, which can be nothing: it must
    // not erase the count the poll before it reported.
    let calls = 0
    const page = pageWith({
      evaluate: async (script) => {
        if (script.includes('const want = ') && !script.includes('const accept = ')) {
          calls += 1
          if (calls === 1) return { ok: true, scope: 'selector "#a"', total: 3, notInState: 2, holds: false, sample: '全选' }
          return new Promise(() => {})
        }
        return true
      },
    })
    const outcome = await runTargetActions(page, target(condition('checked')), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('2 of 3 controls in selector "#a" are not checked (e.g. "全选")')
  })

  it('is skipped like any other optional step', async () => {
    const outcome = await runTargetActions(
      statePage({ ok: true, scope: 'x', total: 2, notInState: 1, holds: false, sample: '' }),
      target({ ...condition('enabled'), optional: true }, { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['skipped', 'met'])
  })
})

describe('runTargetActions, a step that opens a page', () => {
  const openedPage = (url: string): PlaywrightPage =>
    ({ url: () => url, evaluate: async () => true }) as unknown as PlaywrightPage

  /** A page whose click opens `opened`, the way a `target="_blank"` link does. */
  function openerPage(opened: PlaywrightPage | null): PlaywrightPage {
    return {
      url: () => 'https://a.example/search',
      evaluate: async (script: string) => (script.includes(CLICK_SCRIPT_MARKER) ? { ok: true, candidate: 'selector "#go" -> link' } : true),
      on: (event: string, listener: (page: PlaywrightPage) => void) => {
        if (event === 'popup' && opened !== null) queueMicrotask(() => listener(opened))
      },
    } as unknown as PlaywrightPage
  }

  const opener = { verb: 'click', candidates: [{ kind: 'selector', selector: '#go' }], opensPage: true } as const

  it('continues on the page the click opened, and hands it back', async () => {
    const opened = openedPage('https://b.example/results')
    const claimed: PlaywrightPage[] = []
    const outcome = await runTargetActions(
      openerPage(opened),
      target(opener, text('结果')),
      { ...options, claimPage: (page) => claimed.push(page) },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The run ended on the opened page, and said so.
    expect(outcome.page).toBe(opened)
    expect(outcome.run.finalUrl).toBe('https://b.example/results')
    expect(outcome.run.steps[0]?.detail).toContain('it opened a page')
    // Claimed before anything else could close it as a stray tab.
    expect(claimed).toEqual([opened])
    // A page appearing is the click's effect, so the step is not "unverified".
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['clicked', 'met'])
  })

  it('fails loudly when the step expects a page and none opens', async () => {
    const outcome = await runTargetActions(openerPage(null), target(opener), options)
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.verb).toBe('click')
    expect(failure.detail).toContain('the step expects a page to open, and none did')
    expect(failure.url).toBe('https://a.example/search')
  })

  it('leaves a step that does not expect a page alone', async () => {
    // The same page, the same popup — and a step that did not ask for one keeps
    // reading where it stands (the guard's business, not the runner's).
    const outcome = await runTargetActions(openerPage(openedPage('https://b.example/x')), target(click({ kind: 'selector', selector: '#go' }), text('结果')), options)
    expect(outcome.ok && outcome.run.finalUrl).toBe('https://a.example/search')
    expect(outcome.ok && outcome.page.url()).toBe('https://a.example/search')
  })
})

describe('runTargetActions, the check verb', () => {
  it('reports the state the page ended in, and whether the step had to act for it', async () => {
    const acted = await runTargetActions(
      checkPage({ ok: true, candidate: 'text "全选" -> label', was: 'unchecked', state: 'checked', acted: true }),
      target(check([{ kind: 'text', text: '全选' }])),
      options,
    )
    expect(acted.ok && acted.run.steps).toEqual([
      { index: 0, verb: 'check', detail: 'text "全选" -> label (was unchecked, now checked)', outcome: 'met' },
    ])

    const already = await runTargetActions(
      checkPage({ ok: true, candidate: 'text "全选" -> label', was: 'checked', state: 'checked', acted: false }),
      target(check([{ kind: 'text', text: '全选' }])),
      options,
    )
    expect(already.ok && already.run.steps[0]?.detail).toBe('text "全选" -> label (already checked)')
  })

  it('fails when the page did not keep the change', async () => {
    // The measured failure: the click flips the state and the page reverts it.
    // A check that cannot show the state holds is not a satisfied precondition.
    const outcome = await runTargetActions(
      checkPage({ ok: true, candidate: 'selector "#cb" -> label', was: 'unchecked', state: 'unchecked', acted: true }),
      target(check([{ kind: 'selector', selector: '#cb' }])),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.index).toBe(0)
    expect(failure.verb).toBe('check')
    expect(failure.url).toBe('https://a.example/search')
    expect(failure.detail).toBe('selector "#cb" -> label: it was unchecked, the click went out, and it reports unchecked — the page does not show the change')
  })

  it('fails when no candidate can be checked, naming each one', async () => {
    const outcome = await runTargetActions(
      checkPage({ ok: false, attempted: null, tried: ['text "全选": no match', 'selector "#cb": matched 1, none reachable (not laid out)'] }),
      target(check([{ kind: 'text', text: '全选' }])),
      options,
    )
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.detail).toContain('no candidate could be checked, out of text "全选"')
    expect(failure.detail).toContain('selector "#cb": matched 1, none reachable (not laid out)')
  })

  it('fails when the state could not be read back at all', async () => {
    const outcome = await runTargetActions(
      checkPage({ ok: false, attempted: 'selector "#cb" -> label', why: 'the control could not be read back after ticking it', tried: [] }),
      target(check([{ kind: 'selector', selector: '#cb' }])),
      options,
    )
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('could not be read back')
  })

  it('skips an optional check that cannot be satisfied, and runs the rest', async () => {
    const outcome = await runTargetActions(
      checkPage({ ok: false, attempted: null, tried: ['text "记住我": no match'] }),
      target({ ...check([{ kind: 'text', text: '记住我' }]), optional: true }, { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['skipped', 'met'])
    expect(outcome.run.steps[0]?.detail).toContain('text "记住我": no match')
  })

  it('does not send a check to a page it has no budget left for', async () => {
    let asked = 0
    const page = pageWith({ evaluate: async () => { asked += 1; return { ok: true } } })
    const outcome = await runTargetActions(page, target(check([{ kind: 'text', text: '全选' }])), { remainingMs: () => 0, stepCeilingMs: 20, pollMs: 1 })
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('only 0ms of the step budget is left')
    expect(asked).toBe(0)
  })
})

describe('runTargetActions, the click verb', () => {
  const landed = { ok: true, candidate: 'text "查询" -> button' }

  it('clicks, and counts the click as confirmed by the wait that follows', async () => {
    // The page answered the pre-click read with "not there yet", which is what
    // makes the wait that follows evidence: it changed.
    const read = { ok: true, candidate: 'text "查询" -> button', before: false }
    const outcome = await runTargetActions(clickPage(read), target(click({ kind: 'text', text: '查询' }), text('结果')), options)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps).toEqual([
      { index: 0, verb: 'click', detail: 'text "查询" -> button', outcome: 'clicked' },
      { index: 1, verb: 'waitFor', detail: 'text "结果"', outcome: 'met' },
    ])
  })

  it('marks a click that nothing after it confirmed as unverified', async () => {
    // A recipe may end on a click; the summary then has to show the gap rather
    // than let "clicked" read as "it worked".
    const last = await runTargetActions(clickPage(landed), target(click({ kind: 'text', text: '查询' })), options)
    expect(last.ok && last.run.steps.map((step) => step.outcome)).toEqual(['unverified'])

    // A fixed wait asserts nothing about the page, so it confirms nothing.
    const timed = await runTargetActions(clickPage(landed), target(click({ kind: 'text', text: '查询' }), { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }), options)
    expect(timed.ok && timed.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])

    // An optional wait that was skipped confirms nothing either.
    const skipped = await runTargetActions(
      pageWith({
        evaluate: async (script) => (script.includes('const candidates = ') ? landed : false),
      }),
      target(click({ kind: 'text', text: '查询' }), { ...text('也许出现'), optional: true }),
      options,
    )
    expect(skipped.ok && skipped.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'skipped'])
  })

  it('does not accept a wait that was already true as proof the click worked', async () => {
    // The wait the recipe puts after a click only means something if it was
    // false when the click went out; otherwise a no-op click reads as verified.
    const already = { ok: true, candidate: 'text "查询" -> button', before: true }
    const outcome = await runTargetActions(clickPage(already), target(click({ kind: 'text', text: '查询' }), text('结果')), options)
    expect(outcome.ok && outcome.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('reads a URL confirmation from where the page was before the click', async () => {
    const after: WaitStep = { verb: 'waitFor', condition: { kind: 'url', url: 'https://a.example/results' } }
    let url = 'https://a.example/search'
    const moving = {
      url: () => url,
      evaluate: async (script: string) => {
        if (!script.includes('const candidates = ')) return true
        url = 'https://a.example/results'
        return landed
      },
    } as unknown as PlaywrightPage
    const moved = await runTargetActions(moving, target(click({ kind: 'text', text: '查询' }), after), options)
    expect(moved.ok && moved.run.steps.map((step) => step.outcome)).toEqual(['clicked', 'met'])

    // Already on the results URL: the wait proves nothing about the click.
    const waiting = { url: () => 'https://a.example/results', evaluate: async () => landed } as unknown as PlaywrightPage
    const stayed = await runTargetActions(waiting, target(click({ kind: 'text', text: '查询' }), after), options)
    expect(stayed.ok && stayed.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('counts a click whose page navigated out from under it, and lets the wait judge it', async () => {
    // The script's answer — including the pre-click read — died with the page,
    // but the URL moved, which is evidence enough for the wait to judge.
    let url = 'https://a.example/search'
    const navigated = await runTargetActions(
      {
        url: () => url,
        evaluate: async (script: string) => {
          if (!script.includes('const candidates = ')) return true
          url = 'https://a.example/results'
          throw new Error('Execution context was destroyed, most likely because of a navigation')
        },
      } as unknown as PlaywrightPage,
      target(click({ kind: 'text', text: '商品标题' }), text('结果')),
      options,
    )
    expect(navigated.ok).toBe(true)
    if (!navigated.ok) return
    expect(navigated.run.steps.map((step) => step.outcome)).toEqual(['clicked', 'met'])
    expect(navigated.run.steps[0]?.detail).toContain('the page navigated')

    // Same URL after the lost answer: nothing here can show the text wait
    // changed, so the click does not get to call itself confirmed.
    const samePage = await runTargetActions(
      clickPage(() => { throw new Error('Execution context was destroyed, most likely because of a navigation') }),
      target(click({ kind: 'text', text: '商品标题' }), text('结果')),
      options,
    )
    expect(samePage.ok && samePage.run.steps.map((step) => step.outcome)).toEqual(['unverified', 'met'])
  })

  it('fails loudly when every candidate was passed over, and says why for each', async () => {
    const missed = { ok: false, tried: ['selector "#off": matched 1, none reachable (disabled)', 'text "查询": no match'] }
    const outcome = await runTargetActions(clickPage(missed), target(click({ kind: 'text', text: '查询' })), options)
    expect(outcome.ok).toBe(false)
    const failure = (outcome as { failure: ActionFailure }).failure
    expect(failure.index).toBe(0)
    expect(failure.verb).toBe('click')
    expect(failure.url).toBe('https://a.example/search')
    expect(failure.detail).toContain('no candidate could be clicked, out of text "查询"')
    expect(failure.detail).toContain('selector "#off": matched 1, none reachable (disabled)')
    expect(failure.detail).toContain('text "查询": no match')
  })

  it('fails when the page cannot be read at all, since that is not a click', async () => {
    const outcome = await runTargetActions(clickPage(false), target(click({ kind: 'text', text: '查询' })), options)
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('the page could not be read')
  })

  it('skips an optional click that cannot land, and runs the rest', async () => {
    const outcome = await runTargetActions(
      clickPage({ ok: false, tried: ['text "关闭广告": no match'] }),
      target({ ...click({ kind: 'text', text: '关闭广告' }), optional: true }, { verb: 'waitFor', condition: { kind: 'time', ms: 1 } }),
      options,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.steps.map((step) => step.outcome)).toEqual(['skipped', 'met'])
    expect(outcome.run.steps[0]?.detail).toContain('text "关闭广告": no match')
  })

  it('does not send a click to a page it has no budget left for', async () => {
    let asked = 0
    const page = pageWith({ evaluate: async () => { asked += 1; return landed } })
    const outcome = await runTargetActions(page, target(click({ kind: 'text', text: '查询' })), { remainingMs: () => 0, stepCeilingMs: 20, pollMs: 1 })
    expect(outcome.ok).toBe(false)
    expect((outcome as { failure: ActionFailure }).failure.detail).toContain('only 0ms of the step budget is left')
    expect(asked).toBe(0)
  })
})

describe('textProbeScript', () => {
  it('carries the needle safely, whatever it contains', () => {
    const script = textProbeScript('He said "hi"\n结果 \\ end')
    expect(script).not.toContain('`')
    expect(script).toContain(JSON.stringify('He said "hi"\n结果 \\ end'))
  })
})

describe('renderActionSummary', () => {
  const run: ActionRun = {
    steps: [
      { index: 0, verb: 'waitFor', detail: 'text "结果"', outcome: 'met' },
      { index: 1, verb: 'waitFor', detail: 'text "弹窗" to disappear', outcome: 'skipped' },
      { index: 2, verb: 'click', detail: 'text "查询" -> button', outcome: 'unverified' },
      { index: 3, verb: 'click', detail: 'selector "#next" -> link', outcome: 'clicked' },
    ],
    finalUrl: 'https://a.example/results',
    clicked: true,
  }

  it('is one line that says what ran and where it ended', () => {
    // No markup: the caller wraps it for the body it is writing.
    const summary = renderActionSummary(run, 200)
    expect(summary.startsWith('actions: ')).toBe(true)
    expect(summary).not.toContain('\n')
    expect(summary).toContain('1. waitFor text "结果" — met')
    expect(summary).toContain('2. waitFor text "弹窗" to disappear — skipped')
    expect(summary).toContain('3. click text "查询" -> button — clicked (unverified)')
    expect(summary).toContain('4. click selector "#next" -> link — clicked')
    expect(summary).toContain('final document https://a.example/results (HTTP 200)')
  })
})

describe('describeCondition', () => {
  it('reads like what it waits for', () => {
    expect(describeCondition({ kind: 'text', text: 'x' })).toBe('text "x"')
    expect(describeCondition({ kind: 'text', text: 'x', absent: true })).toBe('text "x" to disappear')
    expect(describeCondition({ kind: 'url', url: 'https://a.example/x' })).toBe('url https://a.example/x')
    expect(describeCondition({ kind: 'time', ms: 250 })).toBe('wait 250ms')
    expect(describeCondition({ kind: 'state', state: 'checked', candidates: [{ kind: 'selector', selector: '#a' }] })).toBe('all checked over selector "#a"')
    expect(describeCondition({
      kind: 'state',
      state: 'enabled',
      candidates: [{ kind: 'selector', selector: '#a' }, { kind: 'text', text: '同意' }],
    })).toBe('all enabled over selector "#a" or text "同意"')
  })
})
