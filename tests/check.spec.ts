/**
 * The `check` verb: the in-page resolve → look → act → read-back (run for real
 * in jsdom) and the five shapes one attempt can come back in.
 *
 * The fixture is the gate that forced the verb: a hidden `<input>` whose words
 * live in the `<label>` around it. jsdom has no layout engine, so the harness
 * treats every element as laid out except the checkboxes it hides on purpose —
 * which is exactly the shape that makes the label the clickable part.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CHECK_TIMEOUT_MS, checkControl, checkScript } from '../src/check.ts'
import type { Candidate } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

interface CheckAnswer {
  ok: boolean
  candidate?: string
  was?: string
  state?: string
  /** On success: had to click for it (the idempotent case answers false). */
  acted?: boolean
  /** On failure: the candidate whose click went out before the read-back died. */
  attempted?: string | null
  why?: string | null
  tried?: string[]
}

/** A gate-shaped checkbox: the input has no box, the label around it does. */
const GATE = '<label id="all"><input id="cb" type="checkbox"> 全选</label>'

/** Run the real script against real markup, awaiting the read-back. */
async function runScript(html: string, candidates: readonly Candidate[], state: 'checked' | 'unchecked', tweak?: (dom: JSDOM) => void): Promise<CheckAnswer> {
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
  return (await dom.window.eval(checkScript(candidates, state))) as CheckAnswer
}

/** Give one element a box again, for the controls the harness hides by default. */
function show(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.getBoundingClientRect = (() => ({ ...LAID_OUT })) as unknown as Element['getBoundingClientRect']
}

/** Count clicks on one element, so a test can prove whether it was acted on. */
function track(dom: JSDOM, selector: string, into: string[]): void {
  const element = dom.window.document.querySelector(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.addEventListener('click', () => { into.push(selector) })
}

describe('checkScript', () => {
  it('ticks a hidden input through the label a person clicks, and reads it back', async () => {
    const clicked: string[] = []
    const seen: { dom?: JSDOM } = {}
    const answer = await runScript(GATE, [{ kind: 'selector', selector: '#cb' }], 'checked', (dom) => {
      seen.dom = dom
      track(dom, '#all', clicked)
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#cb" -> label', was: 'unchecked', state: 'checked', acted: true })
    // The label is what was clicked (jsdom then bounces the forwarded click off
    // the input back up to it, which is why the count is not the point) and the
    // control it forwards to is the one that ended up ticked.
    expect(clicked[0]).toBe('#all')
    expect((seen.dom?.window.document.getElementById('cb') as HTMLInputElement).checked).toBe(true)
  })

  it('leaves a control that already holds the wanted state alone', async () => {
    // Idempotent: acting again must not undo the first act.
    const clicked: string[] = []
    const answer = await runScript('<input id="cb" type="checkbox" checked>', [{ kind: 'selector', selector: '#cb' }], 'checked', (dom) => {
      show(dom, '#cb')
      track(dom, '#cb', clicked)
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#cb" -> checkbox', was: 'checked', state: 'checked', acted: false })
    expect(clicked).toEqual([])
  })

  it('can set the opposite state when that is what the recipe asks for', async () => {
    const answer = await runScript('<input id="cb" type="checkbox" checked>', [{ kind: 'selector', selector: '#cb' }], 'unchecked', (dom) => {
      show(dom, '#cb')
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#cb" -> checkbox', was: 'checked', state: 'unchecked', acted: true })
  })

  it('reports the state the page kept, not the one the click caused', async () => {
    // The measured failure: a DOM click flips `checked`, then the page's own
    // render reverts it. Reading back too early would call that a success.
    const answer = await runScript(GATE, [{ kind: 'selector', selector: '#cb' }], 'checked', (dom) => {
      const input = dom.window.document.getElementById('cb') as HTMLInputElement
      input.addEventListener('click', () => { setTimeout(() => { input.checked = false }, 0) })
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#cb" -> label', was: 'unchecked', state: 'unchecked', acted: true })
  })

  it('finds a custom control by its announced state, and sets it', async () => {
    const answer = await runScript(
      '<div id="cb" role="checkbox" aria-checked="false" aria-label="全选">全选</div>',
      [{ kind: 'text', text: '全选' }],
      'checked',
      (dom) => {
        const control = dom.window.document.getElementById('cb')
        control?.addEventListener('click', () => control.setAttribute('aria-checked', 'true'))
      },
    )
    expect(answer).toEqual({ ok: true, candidate: 'text "全选" -> checkbox', was: 'unchecked', state: 'checked', acted: true })
  })

  it('treats a toggle button’s aria-pressed as its state', async () => {
    const answer = await runScript('<button id="b" aria-pressed="false">筛选</button>', [{ kind: 'selector', selector: '#b' }], 'checked', (dom) => {
      const button = dom.window.document.getElementById('b')
      button?.addEventListener('click', () => button.setAttribute('aria-pressed', 'true'))
    })
    expect(answer).toMatchObject({ ok: true, was: 'unchecked', state: 'checked' })
  })

  it('lists every candidate it passed over, and why', async () => {
    const answer = await runScript(
      '<button id="off" disabled>全选</button><button id="plain">全选</button><div><input id="loose" type="checkbox"></div>',
      [
        { kind: 'selector', selector: '#missing' },
        { kind: 'selector', selector: '#loose' },
        { kind: 'selector', selector: '#off' },
        { kind: 'selector', selector: '#plain' },
        { kind: 'selector', selector: ':::' },
      ],
      'checked',
    )
    expect(answer).toEqual({
      ok: false,
      attempted: null,
      why: null,
      tried: [
        'selector "#missing": no match',
        'selector "#loose": matched 1, none reachable (not laid out)',
        'selector "#off": matched 1, none reachable (disabled)',
        'selector "#plain": matched 1, not usable (it is not a control that holds a checked state)',
        'selector ":::": not a usable selector',
      ],
    })
  })

  it('refuses a control that holds no state, rather than calling it unchecked', async () => {
    // A text field has `checked === false` in the DOM; reading that as
    // "unchecked" would be a lie about a control that has no such state.
    const answer = await runScript('<input id="q" type="text">', [{ kind: 'selector', selector: '#q' }], 'checked')
    expect(answer.ok).toBe(false)
    expect(answer.tried?.[0]).toContain('not a control that holds a checked state')
  })

  it('refuses a control something else is sitting on', async () => {
    const answer = await runScript(
      '<div id="overlay"></div><div id="cb" role="checkbox" aria-checked="false">全选</div>',
      [{ kind: 'selector', selector: '#cb' }],
      'checked',
      (dom) => {
        const overlay = dom.window.document.getElementById('overlay')
        dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
      },
    )
    expect(answer.ok).toBe(false)
    expect(answer.tried?.[0]).toContain('none reachable (covered)')
  })

  it('reports an act whose read-back never happened instead of claiming the state', async () => {
    // The control disappears on the click (a page that re-renders it away): the
    // act went out, so this is not "no candidate", and it is not a state either.
    const answer = await runScript(GATE, [{ kind: 'selector', selector: '#cb' }], 'checked', (dom) => {
      const input = dom.window.document.getElementById('cb')
      input?.addEventListener('click', () => { input.remove() })
    })
    expect(answer.ok).toBe(false)
    expect(answer.attempted).toBe('selector "#cb" -> label')
    expect(answer.why).toContain('could not be read back')
  })

  it('carries whatever text the recipe holds, without breaking the script', () => {
    const script = checkScript([{ kind: 'text', text: 'He said "hi"\n全选 \\ end' }], 'unchecked')
    expect(script).not.toContain('`')
    expect(script).toContain(JSON.stringify('He said "hi"\n全选 \\ end'))
    expect(script).toContain(JSON.stringify('unchecked'))
  })
})

describe('checkControl', () => {
  const pageWith = (evaluate: (script: string) => Promise<unknown>): PlaywrightPage =>
    ({ evaluate }) as unknown as PlaywrightPage

  it('reads a verified state, and whether the attempt had to act', async () => {
    const acted = await checkControl(
      pageWith(async () => ({ ok: true, candidate: 'text "全选" -> label', was: 'unchecked', state: 'checked', acted: true })),
      [{ kind: 'text', text: '全选' }],
      'checked',
    )
    expect(acted).toEqual({ kind: 'checked', candidate: 'text "全选" -> label', state: 'checked', was: 'unchecked', acted: true })

    const already = await checkControl(
      pageWith(async () => ({ ok: true, candidate: 'text "全选" -> label', was: 'checked', state: 'checked', acted: false })),
      [{ kind: 'text', text: '全选' }],
      'checked',
    )
    expect(already).toEqual({ kind: 'checked', candidate: 'text "全选" -> label', state: 'checked', was: 'checked', acted: false })
  })

  it('calls a control that did not end in the wanted state a revert', async () => {
    const outcome = await checkControl(
      pageWith(async () => ({ ok: true, candidate: 'selector "#cb" -> label', was: 'unchecked', state: 'unchecked', acted: true })),
      [{ kind: 'selector', selector: '#cb' }],
      'checked',
    )
    expect(outcome).toEqual({ kind: 'unchanged', candidate: 'selector "#cb" -> label', was: 'unchecked', now: 'unchecked' })
  })

  it('never accepts an act whose read-back did not happen', async () => {
    const gone = await checkControl(
      pageWith(async () => ({ ok: false, attempted: 'selector "#cb" -> label', why: 'the control could not be read back after ticking it', tried: [] })),
      [{ kind: 'selector', selector: '#cb' }],
      'checked',
    )
    expect(gone.kind).toBe('unverified')
    expect(gone.kind === 'unverified' ? gone.problem : '').toContain('could not be read back')

    // A navigation tears the context down mid-act: same verdict, its own words.
    const navigated = await checkControl(
      pageWith(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation') }),
      [{ kind: 'selector', selector: '#cb' }],
      'checked',
    )
    expect(navigated).toEqual({ kind: 'unverified', problem: 'the page navigated before the state could be read back' })
  })

  it('reports the candidates it passed over', async () => {
    const outcome = await checkControl(
      pageWith(async () => ({ ok: false, attempted: null, tried: ['text "全选": no match', 42] })),
      [{ kind: 'text', text: '全选' }],
      'checked',
    )
    expect(outcome).toEqual({ kind: 'not-checked', reasons: ['text "全选": no match'] })
  })

  it('is unreadable when the page offers no scripting, stalls, or answers nonsense', async () => {
    expect((await checkControl({} as unknown as PlaywrightPage, [{ kind: 'text', text: 'x' }], 'checked')).kind).toBe('unreadable')
    expect((await checkControl(pageWith(() => new Promise(() => {})), [{ kind: 'text', text: 'x' }], 'checked', 20)).kind).toBe('unreadable')
    for (const answer of [false, null, 'checked', { ok: true, candidate: 'x', was: 'checked' }, { ok: true, candidate: 'x', was: 'checked', state: 'yes' }]) {
      expect((await checkControl(pageWith(async () => answer), [{ kind: 'text', text: 'x' }], 'checked')).kind).toBe('unreadable')
    }
  })

  it('bounds the default probe well inside a fetch deadline', () => {
    expect(CHECK_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CHECK_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
