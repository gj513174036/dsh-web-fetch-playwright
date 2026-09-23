/**
 * Observe mode: the in-page collector (run for real in jsdom) and the shape of
 * the report the caller receives.
 *
 * The fixture is the shape that motivated the mode: a gate that lists what it
 * wants, whose five checkboxes are hidden inputs whose only words live in the
 * labels around them.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { OBSERVE_CONTROL_LIMIT, OBSERVE_SCRIPT, observePage, renderObservation } from '../src/observe.ts'
import type { Observation } from '../src/observe.ts'
import type { PlaywrightPage } from '../src/types.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

const GATE = `
<form>
  <label><input type="checkbox"> 全选</label>
  <label><input type="checkbox"> 本人已满18周岁，并已阅读、理解且同意《条款和条件》</label>
  <label><input type="checkbox"> 本人同意将本人的个人信息进行跨境传输</label>
  <button>同意</button>
  <button disabled>不同意并关闭网页/应用程序</button>
  <a href="/privacy">《隐私声明》</a>
</form>`

/** Run the real collector, with the checkbox inputs hidden the way a gate hides them. */
function collect(html: string, tweak?: (dom: JSDOM) => void): Observation {
  const dom = new JSDOM(`<!doctype html><html><head><title>需您同意</title></head><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url: 'https://example.com/pipl_consent.zh-cn.html',
  })
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox'
    return (hidden ? { ...LAID_OUT, width: 0, height: 0 } : LAID_OUT) as DOMRect
  }
  tweak?.(dom)
  return dom.window.eval(OBSERVE_SCRIPT) as Observation
}

describe('OBSERVE_SCRIPT', () => {
  it('reports the preconditions a label never mentions', () => {
    const seen = collect(GATE)
    expect(seen.counts.checkboxes).toBe(3)
    expect(seen.counts.uncheckedCheckboxes).toBe(3)
    expect(seen.counts.buttons).toBe(2)
    expect(seen.counts.links).toBe(1)
    expect(seen.counts.forms).toBe(1)
  })

  it('names a hidden control by the label a person would click, and says so', () => {
    const seen = collect(GATE)
    const boxes = seen.controls.filter((control) => control.kind === 'checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes.map((box) => box.label)).toEqual([
      '全选',
      '本人已满18周岁，并已阅读、理解且同意《条款和条件》',
      '本人同意将本人的个人信息进行跨境传输',
    ])
    // The part that matters: the input is not laid out, its label is.
    expect(boxes.every((box) => box.host === 'label')).toBe(true)
    expect(boxes.every((box) => box.state === 'unchecked')).toBe(true)
  })

  it('carries disabled state, which is how a gate says "not yet"', () => {
    const seen = collect(GATE)
    const buttons = seen.controls.filter((control) => control.kind === 'button')
    expect(buttons.find((button) => button.label === '不同意并关闭网页/应用程序')?.state).toBe('disabled')
    expect(buttons.find((button) => button.label === '同意')?.state).toBe('')
  })

  it('says when a laid-out control is covered by something else', () => {
    const seen = collect('<div id="overlay"></div><button>同意</button>', (dom) => {
      const overlay = dom.window.document.getElementById('overlay')
      dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
    })
    expect(seen.controls[0]?.label).toBe('同意')
    expect(seen.controls[0]?.state).toContain('covered')
  })

  it('caps the head of the visible text and the control list', () => {
    const long = `<p>${'内容。'.repeat(900)}</p>`
    expect(collect(long).textHead.length).toBe(600)
    const many = Array.from({ length: OBSERVE_CONTROL_LIMIT + 40 }, (_, i) => `<button>按钮 ${String(i)}</button>`).join('')
    const seen = collect(many)
    expect(seen.controls).toHaveLength(OBSERVE_CONTROL_LIMIT)
    expect(seen.controlsTotal).toBeGreaterThan(OBSERVE_CONTROL_LIMIT)
  })

  it('keeps page order among reachable controls', () => {
    // A planner reads the report the way a person reads the page: top to bottom.
    const seen = collect('<label><input type="checkbox"> 全选</label><button>同意</button>')
    expect(seen.controls.map((control) => control.label)).toEqual(['全选', '同意'])
    expect(seen.controls[0]?.host).toBe('label')
    expect(seen.controls[1]?.host).toBe('self')
  })

  it('places the unreachable tail last, and says why it is unreachable', () => {
    // No label around it and not laid out of its own accord: a click cannot
    // reach this one, unlike the checkbox above.
    const seen = collect('<div><input type="checkbox" aria-label="隐形的框"></div><button>同意</button>')
    expect(seen.controls.map((control) => control.label)).toEqual(['同意', '隐形的框'])
    expect(seen.controls[1]?.host).toBe('hidden')
    expect(seen.counts.checkboxes).toBe(1)
  })
})

describe('observePage', () => {
  const pageWith = (evaluate: (script: string) => Promise<unknown>): PlaywrightPage =>
    ({ evaluate }) as unknown as PlaywrightPage

  it('is a quiet null when the page cannot be asked', async () => {
    expect(await observePage({} as unknown as PlaywrightPage)).toBeNull()
    expect(await observePage(pageWith(async () => {
      throw new Error('Execution context was destroyed')
    }))).toBeNull()
  })

  it('does not accept an answer that is not an observation', async () => {
    expect(await observePage(pageWith(async () => false))).toBeNull()
    expect(await observePage(pageWith(async () => ({ title: 'no url, no controls' })))).toBeNull()
  })

  it('reads a well-formed answer', async () => {
    const seen = await observePage(pageWith(async () => ({
      url: 'https://example.com/gate',
      title: '需您同意',
      textHead: '需您同意',
      counts: { uncheckedCheckboxes: 5 },
      controlsTotal: 7,
      controls: [{ kind: 'checkbox', label: '全选', host: 'label', state: 'unchecked' }],
    })))
    expect(seen?.counts.uncheckedCheckboxes).toBe(5)
    expect(seen?.controls[0]?.host).toBe('label')
  })
})

describe('renderObservation', () => {
  const seen: Observation = {
    url: 'https://example.com/gate',
    title: '需您同意',
    textHead: '需您同意 请阅读《隐私声明》',
    counts: { controls: 9, reachable: 6, buttons: 2, links: 1, checkboxes: 3, uncheckedCheckboxes: 3, selects: 0, forms: 1, iframes: 0 },
    controlsTotal: 9,
    controls: [
      { kind: 'button', label: '同意', host: 'self', state: '' },
      { kind: 'checkbox', label: '全选', host: 'label', state: 'unchecked' },
    ],
  }

  it('leads with the counts, because that is where a precondition hides', () => {
    const text = renderObservation(seen)
    expect(text).toContain('# Page state: 需您同意')
    expect(text).toContain('URL: https://example.com/gate')
    expect(text).toMatch(/checkboxes 3 \(unchecked 3\)/)
    expect(text).toContain('> 需您同意 请阅读《隐私声明》')
  })

  it('explains why a control is reachable through its label', () => {
    const text = renderObservation(seen)
    expect(text).toContain('1. [button] "同意"')
    expect(text).toContain('2. [checkbox] "全选" - unchecked (visible as its label)')
    expect(text).toContain('## Controls (2 of 9; reachable first)')
  })

  it('does not invent numbers for counts the page did not send', () => {
    const text = renderObservation({ ...seen, counts: {} })
    expect(text).toContain('controls 0')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('undefined')
  })
})
