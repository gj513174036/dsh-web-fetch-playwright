/**
 * The `type` verb: the in-page write and read-back (run for real in jsdom) and
 * the five shapes one attempt can come back in.
 *
 * The point of the verb is not that the DOM holds the value — it is that the page
 * *hears about it*. So the tests watch the events, keep a copy of the value the
 * way a framework does, and revert it the way a controlled component does.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { TYPE_TIMEOUT_MS, typeInto, typeScript } from '../src/type.ts'
import type { Candidate } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

interface TypeAnswer {
  ok: boolean
  candidate?: string
  was?: string
  value?: string
  wanted?: string
  attempted?: string | null
  why?: string | null
  tried?: string[]
}

/** Run the real script against real markup, awaiting the read-back. */
async function runScript(html: string, candidates: readonly Candidate[], value: string, tweak?: (dom: JSDOM) => void, url = 'https://example.com/form'): Promise<TypeAnswer> {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url,
  })
  dom.window.Element.prototype.getBoundingClientRect = (() => ({ ...LAID_OUT })) as unknown as Element['getBoundingClientRect']
  dom.window.document.elementFromPoint = (() => null) as unknown as Document['elementFromPoint']
  tweak?.(dom)
  return (await dom.window.eval(typeScript(candidates, value))) as TypeAnswer
}

describe('typeScript', () => {
  it('writes the value and tells the page it happened', async () => {
    const heard: string[] = []
    const answer = await runScript('<input id="kw" type="search">', [{ kind: 'selector', selector: '#kw' }], '维生素D', (dom) => {
      const field = dom.window.document.getElementById('kw')
      field?.addEventListener('input', () => { heard.push(`input:${(field as HTMLInputElement).value}`) })
      field?.addEventListener('change', () => { heard.push(`change:${(field as HTMLInputElement).value}`) })
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '', value: '维生素D', wanted: '维生素D' })
    // The events are the whole point: a value the page never hears about is the
    // false success this verb exists to avoid.
    expect(heard).toEqual(['input:维生素D', 'change:维生素D'])
  })

  it('replaces an existing value instead of appending to it', async () => {
    const answer = await runScript('<input id="kw" type="text" value="旧值">', [{ kind: 'selector', selector: '#kw' }], '新值')
    expect(answer).toMatchObject({ ok: true, was: '旧值', value: '新值' })
  })

  it('writes through the prototype setter, which is what moves a framework’s tracker', async () => {
    // A controlled input installs its own `value` property and forwards it to the
    // native one while remembering what it last saw. Assigning the element's
    // property therefore updates the tracker too — the change looks like no
    // change and the page never reacts to the event that follows. Writing through
    // the prototype's setter leaves the tracker behind, which is what makes the
    // page see a difference.
    const viaOwnSetter: string[] = []
    const answer = await runScript('<input id="kw" type="search">', [{ kind: 'selector', selector: '#kw' }], '新查询', (dom) => {
      const field = dom.window.document.getElementById('kw') as HTMLInputElement
      const native = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')
      Object.defineProperty(field, 'value', {
        configurable: true,
        get: () => String(native?.get?.call(field) ?? ''),
        set: (value: string) => {
          viaOwnSetter.push(value)
          native?.set?.call(field, value)
        },
      })
    })
    expect(answer).toMatchObject({ ok: true, value: '新查询' })
    // The element's own property was never used, so a tracker living there saw
    // nothing and the page will notice the difference.
    expect(viaOwnSetter).toEqual([])
  })

  it('reports the value the page kept, not the one that was written', async () => {
    // The controlled-component revert: the write lands, the page re-renders the
    // old value, and reading back too early (or not at all) would call it done.
    const answer = await runScript('<input id="kw" type="search">', [{ kind: 'selector', selector: '#kw' }], '维生素D', (dom) => {
      const field = dom.window.document.getElementById('kw') as HTMLInputElement
      field.addEventListener('input', () => { setTimeout(() => { field.value = '' }, 0) })
    })
    expect(answer).toMatchObject({ ok: true, wanted: '维生素D', value: '' })
  })

  it('finds a field by the words a person reads, and by its role', async () => {
    const labelled = '<label for="kw">关键字</label><input id="kw" type="text">'
    expect(await runScript(labelled, [{ kind: 'text', text: '关键字' }], 'x')).toMatchObject({ ok: true, candidate: 'text "关键字" -> textbox' })
    const branded = '<div role="searchbox" aria-label="站内搜索"></div>'
    expect(await runScript(branded, [{ kind: 'role', role: 'searchbox', name: '站内搜索' }], 'x')).toMatchObject({ ok: true, candidate: 'role searchbox "站内搜索" -> searchbox' })
  })

  it('writes into a contenteditable field, replacing what is there', async () => {
    const answer = await runScript('<div id="ed" contenteditable="true" role="textbox">旧内容</div>', [{ kind: 'selector', selector: '#ed' }], '新内容')
    expect(answer).toMatchObject({ ok: true, was: '旧内容', value: '新内容' })
  })

  it('refuses a field that does not take text, and one that refuses writing', async () => {
    const checkbox = await runScript('<input id="cb" type="checkbox">', [{ kind: 'selector', selector: '#cb' }], 'x')
    expect(checkbox.ok).toBe(false)
    expect(checkbox.tried?.[0]).toContain('not usable (it is not a field that takes text)')

    const readonly = await runScript('<input id="kw" type="text" readonly>', [{ kind: 'selector', selector: '#kw' }], 'x')
    expect(readonly.ok).toBe(false)
    expect(readonly.tried?.[0]).toContain('not usable (it is read-only)')
    const ariaReadonly = await runScript('<div id="kw" role="textbox" aria-readonly="true"></div>', [{ kind: 'selector', selector: '#kw' }], 'x')
    expect(ariaReadonly.tried?.[0]).toContain('not usable (it is read-only)')
  })

  it('refuses a field that is unreachable, disabled or hidden behind something else', async () => {
    const hidden = await runScript('<div><input id="kw" type="text"></div>', [{ kind: 'selector', selector: '#kw' }], 'x', (dom) => {
      const field = dom.window.document.getElementById('kw')
      if (field !== null) field.getBoundingClientRect = (() => ({ width: 0, height: 0 })) as unknown as Element['getBoundingClientRect']
    })
    expect(hidden.ok).toBe(false)
    expect(hidden.tried?.[0]).toContain('none reachable (not laid out)')

    const disabled = await runScript('<input id="kw" type="text" disabled>', [{ kind: 'selector', selector: '#kw' }], 'x')
    expect(disabled.tried?.[0]).toContain('none reachable (disabled)')

    const covered = await runScript('<div id="overlay"></div><input id="kw" type="text">', [{ kind: 'selector', selector: '#kw' }], 'x', (dom) => {
      const overlay = dom.window.document.getElementById('overlay')
      dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
    })
    expect(covered.tried?.[0]).toContain('none reachable (covered)')
  })

  it('lists every candidate it passed over, and why', async () => {
    const answer = await runScript('<input id="kw" type="text">', [{ kind: 'selector', selector: '#missing' }, { kind: 'selector', selector: ':::' }], 'x')
    expect(answer).toEqual({ ok: false, attempted: null, why: null, tried: ['selector "#missing": no match', 'selector ":::": not a usable selector'] })
  })

  it('reports a write whose read-back never happened instead of claiming the value', async () => {
    const answer = await runScript('<input id="kw" type="text">', [{ kind: 'selector', selector: '#kw' }], 'x', (dom) => {
      const field = dom.window.document.getElementById('kw')
      field?.addEventListener('input', () => { field.remove() })
    })
    expect(answer.ok).toBe(false)
    expect(answer.attempted).toBe('selector "#kw" -> textbox')
    expect(answer.why).toContain('could not be read back')
  })

  it('carries whatever the recipe holds, without breaking the script', () => {
    const script = typeScript([{ kind: 'text', text: '关键字' }], 'He said "hi"\n维生素D \\ end')
    expect(script).not.toContain('`')
    expect(script).toContain(JSON.stringify('He said "hi"\n维生素D \\ end'))
  })
})

describe('typeInto', () => {
  const pageWith = (evaluate: (script: string) => Promise<unknown>): PlaywrightPage =>
    ({ evaluate }) as unknown as PlaywrightPage

  it('reads a written value, and whether it replaced something', async () => {
    const fresh = await typeInto(pageWith(async () => ({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '', value: 'x', wanted: 'x' })), [{ kind: 'selector', selector: '#kw' }], 'x')
    expect(fresh).toEqual({ kind: 'typed', candidate: 'selector "#kw" -> searchbox', was: '', value: 'x' })

    const replaced = await typeInto(pageWith(async () => ({ ok: true, candidate: 'selector "#kw" -> textbox', was: '旧值', value: 'x', wanted: 'x' })), [{ kind: 'selector', selector: '#kw' }], 'x')
    expect(replaced).toEqual({ kind: 'typed', candidate: 'selector "#kw" -> textbox', was: '旧值', value: 'x' })
  })

  it('calls a field that holds something else a mismatch, and says what it holds', async () => {
    const outcome = await typeInto(
      pageWith(async () => ({ ok: true, candidate: 'selector "#kw" -> searchbox', was: '', value: '', wanted: '维生素D' })),
      [{ kind: 'selector', selector: '#kw' }],
      '维生素D',
    )
    expect(outcome).toEqual({ kind: 'mismatch', candidate: 'selector "#kw" -> searchbox', was: '', value: '', wanted: '维生素D' })
  })

  it('never accepts a write whose read-back did not happen', async () => {
    const gone = await typeInto(
      pageWith(async () => ({ ok: false, attempted: 'selector "#kw" -> textbox', why: 'the field could not be read back after typing (it is gone)', tried: [] })),
      [{ kind: 'selector', selector: '#kw' }],
      'x',
    )
    expect(gone.kind).toBe('unverified')
    expect(gone.kind === 'unverified' ? gone.problem : '').toContain('could not be read back')

    // A write that navigated is the page taking the input, not a failure: the
    // navigation is its reaction to the write, and the step after this judges it.
    const navigated = await typeInto(
      pageWith(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation') }),
      [{ kind: 'selector', selector: '#kw' }],
      'x',
    )
    expect(navigated.kind).toBe('typed-unreported')
  })

  it('reports the candidates it passed over', async () => {
    const outcome = await typeInto(pageWith(async () => ({ ok: false, attempted: null, tried: ['text "关键字": no match', 42] })), [{ kind: 'text', text: '关键字' }], 'x')
    expect(outcome).toEqual({ kind: 'not-typed', reasons: ['text "关键字": no match'] })
  })

  it('is unreadable when the page offers no scripting, stalls, or answers nonsense', async () => {
    expect((await typeInto({} as unknown as PlaywrightPage, [{ kind: 'text', text: 'x' }], 'v')).kind).toBe('unreadable')
    expect((await typeInto(pageWith(() => new Promise(() => {})), [{ kind: 'text', text: 'x' }], 'v', 20)).kind).toBe('unreadable')
    for (const answer of [false, null, 'typed', { ok: true, candidate: 'x', value: 1, wanted: 'v' }]) {
      expect((await typeInto(pageWith(async () => answer), [{ kind: 'text', text: 'x' }], 'v')).kind).toBe('unreadable')
    }
  })

  it('bounds the default probe well inside a fetch deadline', () => {
    expect(TYPE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(TYPE_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
