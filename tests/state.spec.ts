/**
 * The state condition: the in-page read (run for real in jsdom) and the wrapper
 * that turns it into "held" or a sentence a failure message can use.
 *
 * The fixture is the gate that motivated the condition: hidden checkboxes whose
 * words live in the labels around them, which is exactly the shape where a
 * condition that asked about reachability would read the wrong thing.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { STATE_READ_TIMEOUT_MS, readState, stateProbeScript } from '../src/state.ts'
import type { Candidate, WaitState } from '../src/targets.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

interface StateAnswer {
  ok: boolean
  scope?: string
  total?: number
  notInState?: number
  holds?: boolean
  sample?: string
  tried?: string[]
}

const GATE = `
  <label id="all"><input id="a" type="checkbox"> 全选</label>
  <label><input id="b" type="checkbox" checked> 我已满18周岁</label>
  <label><input id="c" type="checkbox"> 我同意跨境传输</label>`

/** Run the real script against real markup. */
function runScript(html: string, candidates: readonly Candidate[], state: WaitState, tweak?: (dom: JSDOM) => void): StateAnswer {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url: 'https://example.com/gate',
  })
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox'
    return (hidden ? { ...LAID_OUT, width: 0, height: 0 } : LAID_OUT) as DOMRect
  }
  dom.window.document.elementFromPoint = (() => null) as unknown as Document['elementFromPoint']
  tweak?.(dom)
  return dom.window.eval(stateProbeScript(candidates, state)) as StateAnswer
}

const boxes: Candidate = { kind: 'selector', selector: 'input[type=checkbox]' }

describe('stateProbeScript', () => {
  it('reports how many of the scope are not in the state, and names one of them', () => {
    // The hidden inputs have no box of their own; a state question does not care.
    const answer = runScript(GATE, [boxes], 'checked')
    expect(answer).toEqual({
      ok: true,
      scope: 'selector "input[type=checkbox]"',
      total: 3,
      notInState: 2,
      holds: false,
      sample: '全选',
    })
  })

  it('holds when every control in the scope is in the state', () => {
    const html = '<input id="a" type="checkbox" checked><input id="b" type="checkbox" checked>'
    expect(runScript(html, [boxes], 'checked')).toMatchObject({ holds: true, total: 2, notInState: 0 })
    expect(runScript('<input id="a" type="checkbox"><input id="b" type="checkbox">', [boxes], 'unchecked')).toMatchObject({ holds: true, total: 2 })
  })

  it('answers enabled and disabled of any control', () => {
    const html = '<button id="go">同意</button><button id="no" disabled>不同意</button>'
    expect(runScript(html, [{ kind: 'selector', selector: 'button' }], 'enabled')).toMatchObject({ holds: false, total: 2, notInState: 1, sample: '不同意' })
    expect(runScript(html, [{ kind: 'selector', selector: '#go' }], 'enabled')).toMatchObject({ holds: true, total: 1 })
    expect(runScript(html, [{ kind: 'selector', selector: '#no' }], 'disabled')).toMatchObject({ holds: true, total: 1 })
  })

  it('takes the first candidate that can answer, and keeps walking past one that cannot', () => {
    // The gate's own shape: the words "全选" name both the label (no state) and
    // the checkbox it is for. The scope is the control that can be asked, and the
    // hidden input is readable whether or not a person could click it.
    const answer = runScript(GATE, [{ kind: 'text', text: '全选' }], 'checked')
    expect(answer).toMatchObject({ ok: true, scope: 'text "全选"', total: 1, holds: false })
    const later = runScript(GATE, [{ kind: 'text', text: '全选' }, boxes], 'checked')
    expect(later).toMatchObject({ ok: true, scope: 'text "全选"', total: 1 })
  })

  it('drops controls that cannot be asked, and refuses a scope that has none left', () => {
    // A text field's `checked` is always false in the DOM; counting it would let
    // it decide a question about checkboxes.
    const mixed = '<input id="q" type="text" value="x"><input id="a" type="checkbox" checked>'
    expect(runScript(mixed, [{ kind: 'selector', selector: 'input' }], 'checked')).toMatchObject({ holds: true, total: 1 })

    const answer = runScript('<input id="q" type="text">', [{ kind: 'selector', selector: 'input' }], 'checked')
    expect(answer.ok).toBe(false)
    expect(answer.tried?.[0]).toBe('selector "input": matched 1, nothing it names can be asked that')
  })

  it('reads a custom control’s announced state', () => {
    const html = '<div role="checkbox" aria-checked="true" aria-label="全选">全选</div>'
    expect(runScript(html, [{ kind: 'text', text: '全选' }], 'checked')).toMatchObject({ holds: true, total: 1 })
    const pressed = '<button aria-pressed="false">筛选</button>'
    expect(runScript(pressed, [{ kind: 'text', text: '筛选' }], 'unchecked')).toMatchObject({ holds: true, total: 1 })
  })

  it('says why nothing could be asked, candidate by candidate', () => {
    const answer = runScript(GATE, [{ kind: 'selector', selector: '#missing' }, { kind: 'selector', selector: ':::' }], 'checked')
    expect(answer).toEqual({
      ok: false,
      tried: ['selector "#missing": no match', 'selector ":::": not a usable selector'],
    })
  })
})

describe('readState', () => {
  const evaluateOf = (answer: unknown) => async (): Promise<unknown> => answer

  it('turns an answer into held, or into a sentence with the count', async () => {
    const held = await readState(evaluateOf({ ok: true, scope: 'selector "#a"', total: 5, notInState: 0, holds: true, sample: '' }), [boxes], 'checked')
    expect(held).toEqual({ held: true, why: '' })

    const off = await readState(evaluateOf({ ok: true, scope: 'selector "#a"', total: 5, notInState: 3, holds: false, sample: '全选' }), [boxes], 'checked')
    expect(off).toEqual({ held: false, why: '3 of 5 controls in selector "#a" are not checked (e.g. "全选")' })

    const none = await readState(evaluateOf({ ok: true, scope: 'selector "#a"', total: 2, notInState: 2, holds: false, sample: '' }), [boxes], 'enabled')
    expect(none?.why).toBe('2 of 2 controls in selector "#a" are not enabled')
  })

  it('reports a scope nothing could answer as not held, with the reasons', async () => {
    const outcome = await readState(evaluateOf({ ok: false, tried: ['text "全选": no match'] }), [boxes], 'checked')
    expect(outcome?.held).toBe(false)
    expect(outcome?.why).toBe('no candidate named a control that can be asked this (text "全选": no match)')
  })

  it('answers nothing when the page does not', async () => {
    // "Not yet", not "unreadable": a navigation in flight destroys the execution
    // context and the next poll is the one that answers.
    expect(await readState(async () => { throw new Error('Execution context was destroyed') }, [boxes], 'checked')).toBeNull()
    expect(await readState(() => new Promise(() => {}), [boxes], 'checked', 20)).toBeNull()
    for (const answer of [false, null, 'held', 42]) {
      expect(await readState(evaluateOf(answer), [boxes], 'checked')).toBeNull()
    }
  })

  it('carries the state and the candidates into the script', () => {
    const script = stateProbeScript([{ kind: 'text', text: '全选' }], 'disabled')
    expect(script).toContain(JSON.stringify('disabled'))
    expect(script).toContain(JSON.stringify('全选'))
  })

  it('bounds one read well inside a fetch deadline', () => {
    expect(STATE_READ_TIMEOUT_MS).toBeGreaterThan(0)
    expect(STATE_READ_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
