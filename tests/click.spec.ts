/**
 * The `click` verb: the in-page resolver-and-click (run for real in jsdom, so the
 * candidate and reachability rules are exercised rather than restated), and the
 * four shapes an attempt can come back in.
 *
 * jsdom has no layout engine, so every rect is 0×0 out of the box. The harness
 * treats elements as laid out unless a test says otherwise, and stubs
 * `elementFromPoint` with "nothing is on top" unless a test supplies an overlay —
 * the same approach the consent and observe suites take.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CANDIDATE_CONTROLS, CLICK_TIMEOUT_MS, clickCandidate, clickScript, looksLikeNavigation } from '../src/click.ts'
import type { Candidate, WaitCondition } from '../src/targets.ts'
import type { PlaywrightPage } from '../src/types.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

interface ClickAnswer {
  ok: boolean
  candidate?: string
  tried?: string[]
  /** The watched condition's state at the moment of the click. */
  before?: boolean | null
}

/** Run the real script against real markup. */
function runScript(html: string, candidates: readonly Candidate[], tweak?: (dom: JSDOM) => void, watch?: WaitCondition): ClickAnswer {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url: 'https://example.com/search',
  })
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox'
    return (hidden ? { ...LAID_OUT, width: 0, height: 0 } : LAID_OUT) as DOMRect
  }
  dom.window.document.elementFromPoint = (() => null) as unknown as Document['elementFromPoint']
  tweak?.(dom)
  return dom.window.eval(clickScript(candidates, watch)) as ClickAnswer
}

/** Record clicks on one element, so a test can prove which one was hit. */
function track(dom: JSDOM, selector: string, into: string[]): void {
  const element = dom.window.document.querySelector(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.addEventListener('click', () => { into.push(selector) })
}

describe('clickScript', () => {
  it('clicks the first reachable candidate and says what it landed on', () => {
    const html = '<button id="zh">查询</button><button id="en">Search</button>'
    expect(runScript(html, [{ kind: 'text', text: '查询' }])).toEqual({ ok: true, candidate: 'text "查询" -> button', before: null })
    expect(runScript(html, [{ kind: 'text', text: 'Search' }])).toEqual({ ok: true, candidate: 'text "Search" -> button', before: null })
  })

  it('resolves a role with its accessible name', () => {
    // A fragment href, so jsdom does not try to fetch a page it cannot.
    const html = '<a id="go" href="#results">搜索结果</a><button id="other">搜索结果</button>'
    expect(runScript(html, [{ kind: 'role', role: 'link', name: '搜索结果' }])).toEqual({ ok: true, candidate: 'role link "搜索结果" -> link', before: null })
  })

  it('stops at the first reachable candidate instead of trying the later ones', () => {
    // The recipe states the order; the page does not get to reorder it.
    const clicked: string[] = []
    const html = '<button id="first">查询</button><button id="second">查询</button>'
    const answer = runScript(html, [{ kind: 'selector', selector: '#first' }, { kind: 'selector', selector: '#second' }], (dom) => {
      track(dom, '#first', clicked)
      track(dom, '#second', clicked)
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#first" -> button', before: null })
    expect(clicked).toEqual(['#first'])
  })

  it('walks past a candidate that exists but cannot be clicked', () => {
    const clicked: string[] = []
    const html = '<button id="off" disabled>查询</button><button id="on">查询</button>'
    const answer = runScript(html, [{ kind: 'selector', selector: '#off' }, { kind: 'selector', selector: '#on' }], (dom) => {
      track(dom, '#on', clicked)
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#on" -> button', before: null })
    expect(clicked).toEqual(['#on'])
  })

  it('clicks the label a person would hit when the control itself has no box', () => {
    // The gate's shape: a hidden checkbox whose only visible part is its label.
    const clicked: string[] = []
    const html = '<label id="consent-label"><input id="consent" type="checkbox"> 我同意</label>'
    const answer = runScript(html, [{ kind: 'selector', selector: '#consent' }], (dom) => {
      track(dom, '#consent-label', clicked)
    })
    expect(answer).toEqual({ ok: true, candidate: 'selector "#consent" -> label', before: null })
    expect(clicked[0]).toBe('#consent-label')
  })

  it('lists every candidate it passed over, and why', () => {
    const answer = runScript(
      '<button id="off" disabled>查询</button><button id="blocked" aria-disabled="true">Search</button><div><input type="checkbox" aria-label="隐藏的"></div>',
      [
        { kind: 'selector', selector: '#off' },
        { kind: 'selector', selector: '#missing' },
        { kind: 'selector', selector: '#blocked' },
        { kind: 'text', text: '隐藏的' },
        { kind: 'text', text: '没有这个按钮' },
        { kind: 'selector', selector: ':::' },
      ],
    )
    expect(answer).toEqual({
      ok: false,
      tried: [
        'selector "#off": matched 1, none reachable (disabled)',
        'selector "#missing": no match',
        'selector "#blocked": matched 1, none reachable (disabled)',
        'text "隐藏的": matched 1, none reachable (not laid out)',
        'text "没有这个按钮": no match',
        'selector ":::": not a usable selector',
      ],
    })
  })

  it('refuses a control something else is sitting on', () => {
    const answer = runScript('<div id="overlay"></div><button>查询</button>', [{ kind: 'text', text: '查询' }], (dom) => {
      const overlay = dom.window.document.getElementById('overlay')
      dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
    })
    expect(answer).toEqual({ ok: false, tried: ['text "查询": matched 1, none reachable (covered)'] })
  })

  it('reports a click that throws instead of quietly trying the next candidate', () => {
    const clicked: string[] = []
    const answer = runScript('<button id="a">查询</button><button id="b">查询</button>', [
      { kind: 'selector', selector: '#a' },
      { kind: 'selector', selector: '#b' },
    ], (dom) => {
      const first = dom.window.document.getElementById('a')
      if (first !== null) first.click = () => { throw new Error('detached') }
      track(dom, '#b', clicked)
    })
    expect(answer).toEqual({ ok: false, tried: ['selector "#a" -> button: the click threw (Error: detached)'] })
    expect(clicked).toEqual([])
  })

  it('compares a name as a person reads it, not byte for byte', () => {
    // Collapsed whitespace and case: markup rarely matches a recipe exactly.
    const html = '<button id="a">  Search\u00a0 Results </button>'
    expect(runScript(html, [{ kind: 'text', text: 'search results' }])).toEqual({ ok: true, candidate: 'text "search results" -> button', before: null })
  })

  it('reads the condition the next wait will check before it clicks', () => {
    // A wait that was already true is not evidence that the click did anything,
    // so the state has to be read at click time — and this is the only moment it
    // exists.
    const html = '<button id="go">查询</button>'
    const absent: WaitCondition = { kind: 'text', text: '查询结果' }
    expect(runScript(html, [{ kind: 'text', text: '查询' }], undefined, absent)).toEqual({
      ok: true,
      candidate: 'text "查询" -> button',
      before: false,
    })
    const present: WaitCondition = { kind: 'text', text: '查询' }
    expect(runScript(html, [{ kind: 'text', text: '查询' }], undefined, present)).toMatchObject({ before: true })
    // A disappearance condition that is already true is not proof either.
    const gone: WaitCondition = { kind: 'text', text: '加载中', absent: true }
    expect(runScript(html, [{ kind: 'text', text: '查询' }], undefined, gone)).toMatchObject({ before: true })
    expect(runScript(html, [{ kind: 'text', text: '查询' }], undefined, { kind: 'url', url: 'https://example.com/x' })).toMatchObject({ before: null })
  })

  it('carries whatever text the recipe holds, without breaking the script', () => {
    const script = clickScript([{ kind: 'text', text: 'He said "hi"\n查询 \\ end' }, { kind: 'role', role: 'button', name: '查询' }])
    expect(script).not.toContain('`')
    expect(script).toContain(JSON.stringify('He said "hi"\n查询 \\ end'))
    expect(script).toContain(JSON.stringify(CANDIDATE_CONTROLS))
  })
})

describe('clickCandidate', () => {
  const pageWith = (evaluate: (script: string) => Promise<unknown>): PlaywrightPage =>
    ({ evaluate }) as unknown as PlaywrightPage

  it('reads a click, and names the candidate that landed', async () => {
    const outcome = await clickCandidate(pageWith(async () => ({ ok: true, candidate: 'text "查询" -> button' })), [{ kind: 'text', text: '查询' }])
    expect(outcome).toEqual({ kind: 'clicked', candidate: 'text "查询" -> button', before: null })
  })

  it('carries the pre-click state back, and refuses to invent one', async () => {
    const watch: WaitCondition = { kind: 'text', text: '查询结果' }
    let sent = ''
    const held = await clickCandidate(pageWith(async (script) => {
      sent = script
      return { ok: true, candidate: 'text "查询" -> button', before: true }
    }), [{ kind: 'text', text: '查询' }], 5_000, watch)
    expect(held).toMatchObject({ before: true })
    expect(sent).toContain(JSON.stringify('查询结果'))

    const invented = await clickCandidate(pageWith(async () => ({ ok: true, candidate: 'x', before: 'yes' })), [{ kind: 'text', text: '查询' }])
    expect(invented).toMatchObject({ before: null })
  })

  it('reads a navigation as a click the page moved away from, not as a failure', async () => {
    // Clicking a link is the ordinary case; the destroyed context must not be
    // reported as "the control was not there".
    const outcome = await clickCandidate(
      pageWith(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation') }),
      [{ kind: 'text', text: '商品标题' }],
    )
    expect(outcome).toEqual({ kind: 'clicked-unreported' })
  })

  it('does not mistake any other throw for a navigation', async () => {
    const outcome = await clickCandidate(pageWith(async () => { throw new Error('boom') }), [{ kind: 'text', text: 'x' }])
    expect(outcome).toEqual({ kind: 'unreadable', problem: 'boom' })
  })

  it('is unreadable when the page offers no scripting at all', async () => {
    const outcome = await clickCandidate({} as unknown as PlaywrightPage, [{ kind: 'text', text: 'x' }])
    expect(outcome.kind).toBe('unreadable')
    expect(outcome.kind === 'unreadable' ? outcome.problem : '').toContain('no scripting')
  })

  it('gives up on a stalled probe instead of spending the fetch budget', async () => {
    const outcome = await clickCandidate(pageWith(() => new Promise(() => {})), [{ kind: 'text', text: 'x' }], 20)
    expect(outcome.kind).toBe('unreadable')
    expect(outcome.kind === 'unreadable' ? outcome.problem : '').toContain('did not answer')
  })

  it('does not accept an answer that is not a click result', async () => {
    for (const answer of [false, null, 'clicked', 42]) {
      const outcome = await clickCandidate(pageWith(async () => answer), [{ kind: 'text', text: 'x' }])
      expect(outcome.kind).toBe('unreadable')
    }
  })

  it('keeps the reasons a failure reports, and drops what it cannot read', async () => {
    const outcome = await clickCandidate(pageWith(async () => ({ ok: false, tried: ['text "x": no match', 42] })), [{ kind: 'text', text: 'x' }])
    expect(outcome).toEqual({ kind: 'not-clicked', reasons: ['text "x": no match'] })
  })

  it('bounds the default probe well inside a fetch deadline', () => {
    expect(CLICK_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CLICK_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})

describe('looksLikeNavigation', () => {
  it('recognises the ways a page moves out from under a script', () => {
    expect(looksLikeNavigation(new Error('Execution context was destroyed, most likely because of a navigation'))).toBe(true)
    expect(looksLikeNavigation(new Error('Target page, context or browser has been closed'))).toBe(true)
    expect(looksLikeNavigation('frame was detached')).toBe(true)
  })

  it('leaves anything else as an ordinary failure', () => {
    expect(looksLikeNavigation(new Error('detached node'))).toBe(false)
    expect(looksLikeNavigation(new Error('Cannot read properties of null'))).toBe(false)
  })
})
