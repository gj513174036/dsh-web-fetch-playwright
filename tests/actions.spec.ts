/**
 * Running a target's actions.
 *
 * The page is faked to the two members the runner actually uses (its URL and its
 * scripting seam), so each case states a condition and observes the outcome: met,
 * skipped, or the failure that names the step.
 */
import { describe, expect, it } from 'vitest'
import { describeCondition, renderActionSummary, runTargetActions, textProbeScript } from '../src/actions.ts'
import type { ActionFailure, ActionRun } from '../src/actions.ts'
import type { Target, WaitStep } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const target = (...steps: readonly WaitStep[]): Target => ({
  name: 't',
  match: { kind: 'prefix', url: 'https://a.example/search' },
  actions: steps,
})

const text = (value: string, absent?: boolean): WaitStep =>
  absent === true ? { verb: 'waitFor', condition: { kind: 'text', text: value, absent: true } } : { verb: 'waitFor', condition: { kind: 'text', text: value } }

function pageWith(options: { url?: string; evaluate?: (script: string) => Promise<unknown> }): PlaywrightPage {
  const base = { url: () => options.url ?? 'https://a.example/search' }
  return (options.evaluate === undefined ? base : { ...base, evaluate: options.evaluate }) as unknown as PlaywrightPage
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
    ],
    finalUrl: 'https://a.example/results',
  }

  it('is one line that says what ran and where it ended', () => {
    const summary = renderActionSummary(run, 200)
    expect(summary.startsWith('> actions: ')).toBe(true)
    expect(summary).not.toContain('\n')
    expect(summary).toContain('1. waitFor text "结果" — met')
    expect(summary).toContain('2. waitFor text "弹窗" to disappear — skipped')
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
