/**
 * Running a target's actions.
 *
 * The page is faked to the member the runner actually uses (its URL and its
 * scripting seam), so each case states a condition and observes the outcome: met,
 * skipped, clicked, unverified, or the failure that names the step.
 */
import { describe, expect, it } from 'vitest'
import { describeCondition, renderActionSummary, runTargetActions, textProbeScript } from '../src/actions.ts'
import type { ActionFailure, ActionRun } from '../src/actions.ts'
import type { ActionStep, Candidate, ClickStep, Target, WaitStep } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const target = (...steps: readonly ActionStep[]): Target => ({
  name: 't',
  match: { kind: 'prefix', url: 'https://a.example/search' },
  actions: steps,
})

const text = (value: string, absent?: boolean): WaitStep =>
  absent === true ? { verb: 'waitFor', condition: { kind: 'text', text: value, absent: true } } : { verb: 'waitFor', condition: { kind: 'text', text: value } }

const click = (...candidates: readonly Candidate[]): ClickStep => ({ verb: 'click', candidates })

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
      if (!script.includes('const candidates = ')) return true
      return typeof answer === 'function' ? (answer as () => unknown)() : answer
    },
  })
}

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

  it('can wait to have left a URL, not only to have arrived at one', async () => {
    const left: WaitStep = { verb: 'waitFor', condition: { kind: 'url', url: 'https://a.example/search', absent: true } }
    const gone = await runTargetActions(pageWith({ url: 'https://a.example/results' }), target(left), options)
    expect(gone.ok).toBe(true)
    const stayed = await runTargetActions(pageWith({ url: 'https://a.example/search?q=1' }), target(left), options)
    expect(stayed.ok).toBe(false)
    expect((stayed as { failure: ActionFailure }).failure.detail).toContain('to have left')
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
  })
})
