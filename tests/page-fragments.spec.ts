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
    expect(withFragments<boolean>(PAGE_FRAGMENTS, 'typeof laidOut === "function" && typeof labelHostOf === "function" && typeof hostOf === "function" && typeof accessibleNameOf === "function" && typeof coverageOf === "function" && typeof roleOf === "function" && typeof reachabilityOf === "function"', '')).toBe(true)
    expect(withFragments<boolean>(DISMISS_FRAGMENTS, 'typeof isConsentDocument === "function" && typeof accessibleNameOf === "function"', '')).toBe(true)
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

  describe('reachabilityOf', () => {
    it('says nothing for a control a person can hit', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("button"))', '<button>go</button>')).toBe('')
    })

    it('counts a hidden input as reachable through its label, and not otherwise', () => {
      // The gate's checkboxes: the input has no box, the label a person clicks does.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("input"))', '<label><input type="checkbox"> 全选</label>')).toBe('')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("input"))', '<div><input type="checkbox"></div>')).toBe('not laid out')
    })

    it('refuses a disabled control, however it says so', () => {
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("button"))', '<button disabled>go</button>')).toBe('disabled')
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("div"))', '<div role="button" aria-disabled="true">go</div>')).toBe('disabled')
      // A control inside a disabled fieldset has no `disabled` of its own, yet
      // activating it does nothing — which is the "clicked, so it worked"
      // failure this check exists to pre-empt.
      expect(withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("button"))', '<fieldset disabled><button>go</button></fieldset>')).toBe('disabled')
    })

    it('refuses a control something else is sitting on', () => {
      const covered = withFragments<string>(PAGE_FRAGMENTS, 'reachabilityOf(document.querySelector("button"))', '<div id="overlay"></div><button>go</button>', (dom) => {
        const overlay = dom.window.document.getElementById('overlay')
        dom.window.document.elementFromPoint = (() => overlay) as unknown as Document['elementFromPoint']
      })
      expect(covered).toBe('covered')
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
