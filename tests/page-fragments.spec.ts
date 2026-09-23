/**
 * The shared page fragments.
 *
 * These tests build their subject the way the scripts do — by splicing the real
 * fragment source into a script and evaluating it in jsdom — so a fragment that
 * references something its bundle forgot to include fails here rather than
 * inside a browser at run time.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { checkScript } from '../src/check.ts'
import { clickScript } from '../src/click.ts'
import { CONSENT_GATE_PROBE, DISMISS_SCRIPT } from '../src/consent.ts'
import { OBSERVE_SCRIPT } from '../src/observe.ts'
import { DISMISS_FRAGMENTS, PAGE_FRAGMENTS, spliceFragments } from '../src/page-fragments.ts'

const LAID_OUT = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }

/** Evaluate an expression with a real bundle spliced in front of it. */
function withFragments<T>(
  fragments: readonly string[],
  expression: string,
  html: string,
  tweak?: (dom: JSDOM) => void,
  url = 'https://example.com/',
): T {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url,
  })
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox'
    return (hidden ? { ...LAID_OUT, width: 0, height: 0 } : LAID_OUT) as DOMRect
  }
  tweak?.(dom)
  return dom.window.eval(`(() => { ${spliceFragments(fragments)} return (${expression}); })()`) as T
}

describe('page fragments', () => {
  it('ships bundles that are self-contained', () => {
    // The failure this catches is the one that bit the extraction: a consumer
    // picked the fragments it thought it needed and named one it had left out.
    expect(withFragments<boolean>(PAGE_FRAGMENTS, 'typeof laidOut === "function" && typeof labelHostOf === "function" && typeof hostOf === "function" && typeof accessibleNameOf === "function" && typeof coverageOf === "function" && typeof roleOf === "function" && typeof matchesOf === "function" && typeof resolveCandidates === "function" && typeof checkedStateOf === "function" && typeof isDisabled === "function" && typeof matchesState === "function"', '')).toBe(true)
    expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'typeof isConsentDocument === "function" && typeof accessibleNameOf === "function"', '')).toBe(true)
  })

  it('ships no script a stray backtick would cut in half', () => {
    // These scripts are template literals; one backtick inside a comment ends the
    // string early and the failure surfaces as a syntax error at typecheck time —
    // or, worse, in the browser. This has now happened three times, so it is
    // checked once for every script instead of once per module.
    const scripts = [
      OBSERVE_SCRIPT,
      DISMISS_SCRIPT,
      CONSENT_GATE_PROBE,
      clickScript([{ kind: 'text', text: 'x' }]),
      checkScript([{ kind: 'text', text: 'x' }], 'checked'),
    ]
    for (const script of scripts) expect(script).not.toContain('`')
  })

  describe('accessibleNameOf', () => {
    it('prefers aria-label, then the label a person reads', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'accessibleNameOf(document.querySelector("#aria"))', '<button id="aria" aria-label="  Allow   all ">Whatever</button>')).toBe('Allow all')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'accessibleNameOf(document.querySelector("input"))', '<label><input type="checkbox"> 全选</label>')).toBe('全选')
    })

    it('uses value only where the value is the label', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'accessibleNameOf(document.querySelector("input"))', '<input type="submit" value="Allow all">')).toBe('Allow all')
      // An untagged checkbox carries the literal string "on"; that is not a name.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'accessibleNameOf(document.querySelector("input"))', '<div><input type="checkbox"></div>')).toBe('')
    })
  })

  describe('hostOf', () => {
    it('says where a control is reachable', () => {
      const html = '<button id="self">go</button><label id="withLabel"><input type="checkbox"></label><div id="plain"><input type="checkbox"></div>'
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hostOf(document.querySelector("#self"))', html)).toBe('self')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hostOf(document.querySelector("#withLabel input"))', html)).toBe('label')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hostOf(document.querySelector("#plain input"))', html)).toBe('hidden')
    })
  })

  describe('coverageOf', () => {
    it('reports a laid-out control that something else sits on', () => {
      const covered = withFragments<string>(PAGE_FRAGMENTS, 'coverageOf(document.querySelector("button"))', '<div id="overlay"></div><button>go</button>', (dom) => {
        const overlay = dom.window.document.getElementById('overlay')
        dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
      })
      expect(covered).toBe('covered')
      const clear = withFragments<string>(PAGE_FRAGMENTS, 'coverageOf(document.querySelector("button"))', '<button>go</button>', (dom) => {
        dom.window.document.elementFromPoint = ((x: number, y: number) => dom.window.document.elementFromPoint === undefined ? null : dom.window.document.querySelector('button')) as unknown as Document['elementFromPoint']
      })
      expect(clear).toBe('')
    })
  })

  describe('roleOf', () => {
    it('reads the role a control has, not only the one it declares', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("button"))', '<button>go</button>')).toBe('button')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("a"))', '<a href="/x">go</a>')).toBe('link')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("input"))', '<input type="submit" value="go">')).toBe('button')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("input"))', '<input type="search">')).toBe('searchbox')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("input"))', '<input type="text">')).toBe('textbox')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("select"))', '<select></select>')).toBe('combobox')
    })

    it('lets a declared role win, and answers nothing for what it does not map', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("div"))', '<div role="tab">go</div>')).toBe('tab')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("a"))', '<a>no href</a>')).toBe('')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'roleOf(document.querySelector("div"))', '<div>plain</div>')).toBe('')
    })
  })

  describe('hitTargetOf', () => {
    it('falls back to the label when the control is laid out but covered', () => {
      // Measured on booking.com's consent gate: the checkbox is 1x1 with the
      // label's styled box drawn over it, so the control is "laid out" and still
      // not something a person can hit. The label is the way in.
      const html = '<input id="cb" type="checkbox"><label id="lab" for="cb"> 全选</label>'
      const answer = withFragments<{ hit: string; host: string; reason: string }>(
        PAGE_FRAGMENTS,
        '(() => { const t = hitTargetOf(document.querySelector("#cb")); return { hit: t.hit === null ? "" : t.hit.id, host: t.host, reason: t.reason } })()',
        html,
        (dom) => {
          const input = dom.window.document.getElementById('cb')
          const label = dom.window.document.getElementById('lab')
          const rect = (width: number, height: number, top: number): DOMRect => ({ width, height, top, left: 0, right: width, bottom: top + height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
          if (input !== null) input.getBoundingClientRect = () => rect(1, 1, 0)
          if (label !== null) label.getBoundingClientRect = () => rect(100, 20, 10)
          const overlay = dom.window.document.createElement('div')
          dom.window.document.elementFromPoint = ((_x: number, y: number) => (y < 10 ? overlay : label)) as unknown as Document['elementFromPoint']
        },
      )
      expect(answer).toEqual({ hit: 'lab', host: 'label', reason: '' })
    })
  })

  describe('hitTargetOf, the reasons a control cannot be acted on', () => {
    it('says nothing for a control a person can hit', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("button")).reason', '<button>go</button>')).toBe('')
    })

    it('counts a hidden input as reachable through its label, and not otherwise', () => {
      // The gate's checkboxes: the input has no box, the label a person clicks does.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("input")).reason', '<label><input type="checkbox"> 全选</label>')).toBe('')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("input")).reason', '<div><input type="checkbox"></div>')).toBe('not laid out')
    })

    it('refuses a disabled control, however it says so', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("button")).reason', '<button disabled>go</button>')).toBe('disabled')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("div")).reason', '<div role="button" aria-disabled="true">go</div>')).toBe('disabled')
      // A control inside a disabled fieldset has no `disabled` of its own, yet
      // activating it does nothing — which is the "clicked, so it worked"
      // failure this check exists to pre-empt.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("button")).reason', '<fieldset disabled><button>go</button></fieldset>')).toBe('disabled')
    })

    it('refuses a control something else is sitting on', () => {
      const covered = withFragments<string>(PAGE_FRAGMENTS, 'hitTargetOf(document.querySelector("button")).reason', '<div id="overlay"></div><button>go</button>', (dom) => {
        const overlay = dom.window.document.getElementById('overlay')
        dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
      })
      expect(covered).toBe('covered')
    })
  })

  describe('checkedStateOf', () => {
    it('reads a form control’s state, and says nothing about controls that have none', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("input"))', '<input type="checkbox" checked>')).toBe('checked')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("input"))', '<input type="radio">')).toBe('unchecked')
      // A text field's `checked` is false in the DOM; reporting that as
      // "unchecked" would be a lie about a control that holds no such state.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("input"))', '<input type="text">')).toBe('')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("button"))', '<button>go</button>')).toBe('')
    })

    it('reads what a custom control announces', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("div"))', '<div role="checkbox" aria-checked="true">x</div>')).toBe('checked')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("div"))', '<div role="checkbox" aria-checked="false">x</div>')).toBe('unchecked')
      // A toggle button says it with aria-pressed.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'checkedStateOf(document.querySelector("button"))', '<button aria-pressed="true">x</button>')).toBe('checked')
    })
  })

  describe('isDisabled and matchesState', () => {
    const of = (expression: string, html: string): unknown => withFragments<unknown>(PAGE_FRAGMENTS, expression, html)

    it('answers disabled however the page says it, for any control', () => {
      expect(of('isDisabled(document.querySelector("button"))', '<button disabled>go</button>')).toBe(true)
      expect(of('isDisabled(document.querySelector("div"))', '<div role="button" aria-disabled="true">go</div>')).toBe(true)
      expect(of('isDisabled(document.querySelector("button"))', '<fieldset disabled><button>go</button></fieldset>')).toBe(true)
      expect(of('isDisabled(document.querySelector("button"))', '<button>go</button>')).toBe(false)
    })

    it('answers the four states, and refuses to answer for a control that has none', () => {
      expect(of('matchesState(document.querySelector("input"), "checked")', '<input type="checkbox" checked>')).toBe(true)
      expect(of('matchesState(document.querySelector("input"), "unchecked")', '<input type="checkbox">')).toBe(true)
      expect(of('matchesState(document.querySelector("div"), "checked")', '<div role="checkbox" aria-checked="true">x</div>')).toBe(true)
      expect(of('matchesState(document.querySelector("button"), "unchecked")', '<button aria-pressed="false">x</button>')).toBe(true)
      expect(of('matchesState(document.querySelector("button"), "enabled")', '<button>x</button>')).toBe(true)
      expect(of('matchesState(document.querySelector("button"), "disabled")', '<button disabled>x</button>')).toBe(true)
      expect(of('matchesState(document.querySelector("button"), "disabled")', '<button>x</button>')).toBe(false)
      expect(of('matchesState(document.querySelector("div"), "enabled")', '<div role="button">x</div>')).toBe(true)
      // A label or a paragraph is not "enabled", it is unaskable — otherwise a
      // candidate that matched the words rather than the control would decide.
      expect(of('matchesState(document.querySelector("label"), "enabled")', '<label><input type="checkbox"> 同意</label>')).toBe(null)
      expect(of('matchesState(document.querySelector("p"), "disabled")', '<p>同意</p>')).toBe(null)
      // Not "unchecked": a text field has no such state, and the caller must know.
      expect(of('matchesState(document.querySelector("input"), "unchecked")', '<input type="text">')).toBe(null)
      expect(of('matchesState(document.querySelector("label"), "checked")', '<label><input type="checkbox"> 全选</label>')).toBe(null)
    })
  })

  describe('resolveCandidates', () => {
    const candidate = (text: string): string => JSON.stringify({ kind: 'text', text, label: `text "${text}"` })

    it('takes the first candidate a person can act on, and reports the ones it passed over', () => {
      const html = '<button id="a">查询</button><div><input id="b" type="checkbox"></div>'
      const answer = withFragments<{ candidate: string | null; tried: string[] }>(
        PAGE_FRAGMENTS,
        `(() => { const found = resolveCandidates([${candidate('没有')}, ${candidate('查询')}]); return { candidate: found.candidate, tried: found.tried } })()`,
        html,
      )
      expect(answer.candidate).toBe('text "查询"')
      // The first candidate missed; the walk stopped at the first one that did
      // not, and says why it went past the other.
      expect(answer.tried).toEqual(['text "没有": no match'])
    })

    it('keeps walking past a control a verb cannot act on', () => {
      // The gate's shape: the <label> carries the words, the checkbox holds the
      // state. A verb that needs the state must not stop on the label.
      const html = '<label id="all"><input id="cb" type="checkbox"> 全选</label>'
      const answer = withFragments<{ control: string; hit: string; tried: string[] }>(
        PAGE_FRAGMENTS,
        `(() => { const found = resolveCandidates([${candidate('全选')}], (el) => checkedStateOf(el) === '' ? 'no state' : ''); return { control: found.control.id, hit: found.hit.id, tried: found.tried } })()`,
        html,
      )
      expect(answer.control).toBe('cb')
      // …and the act lands on the label, which is the part a person can click.
      expect(answer.hit).toBe('all')
      expect(answer.tried).toEqual([])
    })
  })

  describe('visibleTextOf', () => {
    it('reads the page text, falling back where innerText does not exist', () => {
      // jsdom has no innerText, so this exercises the fallback the browser never
      // needs — and proves the fallback is not the empty string.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'visibleTextOf()', '<p>hello</p>')).toContain('hello')
    })
  })

  describe('isConsentDocument', () => {
    it('recognises a short page whose URL or title names consent', () => {
      expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'isConsentDocument()', '<p>需您同意</p>', undefined, 'https://example.com/pipl_consent.zh-cn.html')).toBe(true)
      expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'isConsentDocument()', '<p>cookies</p>', undefined, 'https://example.com/cookie-notice')).toBe(true)
    })

    it('refuses a long page or an unrelated one', () => {
      expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'isConsentDocument()', `<p>${'内容。'.repeat(900)}</p>`, undefined, 'https://example.com/consent')).toBe(false)
      expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'isConsentDocument()', '<p>hello</p>')).toBe(false)
    })
  })
})
