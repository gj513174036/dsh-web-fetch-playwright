/**
 * Targets: the file's validation and the URL rules that pick one.
 *
 * Both are pure, so everything here is a direct assertion on behaviour rather
 * than on a browser: what a bad file says, and which target a URL gets.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeCandidate, matchesTarget, normalizedUrl, parseTargets, selectTarget } from '../src/targets.ts'
import type { Target } from '../src/targets.ts'

/** One target's file, with `actions` being the comma-separated steps. */
const file = (actions: string, match = '{ "kind": "prefix", "url": "https://a.example/search" }', name = 'search') =>
  `{ "targets": [ { "name": "${name}", "match": ${match}, "actions": [${actions}] } ] }`

const waitText = '{ "verb": "waitFor", "condition": { "kind": "text", "text": "结果" } }'

/** Parse and return the targets, failing the test with the parse error if there is one. */
function targetsOf(text: string): readonly Target[] {
  const parsed = parseTargets(text)
  if (!parsed.ok) throw new Error(`expected a valid file, got: ${parsed.error}`)
  return parsed.targets
}

const errorOf = (text: string): string => {
  const parsed = parseTargets(text)
  if (parsed.ok) throw new Error('expected the file to be rejected')
  return parsed.error
}

describe('normalizedUrl', () => {
  it('keeps scheme, host and path, and drops the rest', () => {
    expect(normalizedUrl('https://a.example/pr/x?kw=1#top')).toBe('https://a.example/pr/x')
    expect(normalizedUrl('http://a.example:8080/')).toBe('http://a.example:8080/')
  })

  it('refuses what is not an http(s) URL', () => {
    expect(normalizedUrl('ftp://a.example/x')).toBeNull()
    expect(normalizedUrl('not a url')).toBeNull()
  })
})

describe('matchesTarget', () => {
  const prefix = (url: string): { kind: 'prefix'; url: string } => ({ kind: 'prefix', url })

  it('matches an exact URL only exactly', () => {
    expect(matchesTarget({ kind: 'exact', url: 'https://a.example/pr' }, 'https://a.example/pr?kw=1')).toBe(true)
    expect(matchesTarget({ kind: 'exact', url: 'https://a.example/pr' }, 'https://a.example/pr/x')).toBe(false)
  })

  it('matches a prefix only at a path boundary', () => {
    // The rule that keeps a recipe from catching its neighbours by accident.
    expect(matchesTarget(prefix('https://a.example/pr'), 'https://a.example/pr/x')).toBe(true)
    expect(matchesTarget(prefix('https://a.example/pr'), 'https://a.example/pr')).toBe(true)
    expect(matchesTarget(prefix('https://a.example/pr'), 'https://a.example/proxy')).toBe(false)
    expect(matchesTarget(prefix('https://a.example/pr/'), 'https://a.example/pr/x')).toBe(true)
  })

  it('ignores the query string and hash, so tracking parameters do not defeat it', () => {
    expect(matchesTarget(prefix('https://a.example/search'), 'https://a.example/search?kw=x&gclid=y')).toBe(true)
  })

  it('does not cross host or scheme', () => {
    expect(matchesTarget(prefix('https://a.example/x'), 'https://b.example/x')).toBe(false)
    expect(matchesTarget(prefix('https://a.example/x'), 'http://a.example/x')).toBe(false)
  })
})

describe('selectTarget', () => {
  const one = (name: string, url: string, kind: 'exact' | 'prefix' = 'prefix'): Target => ({
    name,
    match: { kind, url },
    actions: [{ verb: 'waitFor', condition: { kind: 'time', ms: 1 } }],
  })

  it('says nothing matched rather than failing', () => {
    expect(selectTarget([one('a', 'https://a.example/x')], 'https://other.example/')).toEqual({ ok: true, target: null })
    expect(selectTarget([], 'https://a.example/x')).toEqual({ ok: true, target: null })
  })

  it('prefers the longest, most specific match', () => {
    const targets = [one('wide', 'https://a.example/'), one('narrow', 'https://a.example/pr')]
    const chosen = selectTarget(targets, 'https://a.example/pr/1')
    expect(chosen.ok && chosen.target?.name).toBe('narrow')
  })

  it('refuses to choose between two equally specific matches', () => {
    const targets = [one('a', 'https://a.example/pr'), one('b', 'https://a.example/pr')]
    const chosen = selectTarget(targets, 'https://a.example/pr/1')
    expect(chosen.ok).toBe(false)
    expect(chosen.ok ? '' : chosen.error).toContain('equally specifically')
  })
})

describe('the recipes committed under targets/', () => {
  it('all parse, so a file that cannot be loaded can never be committed', () => {
    // A recipe is read on every fetch, and one bad key makes *every* fetch fail
    // (the file is parsed before any URL is matched) — so the files that ship as
    // verification assets are held to the same strictness as the parser.
    const dir = new URL('../targets/', import.meta.url)
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const parsed = parseTargets(readFileSync(new URL(name, dir), 'utf8'))
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`)
      expect(parsed.targets.length).toBeGreaterThan(0)
      for (const target of parsed.targets) expect(target.actions.length).toBeGreaterThan(0)
    }
  })
})

describe('parseTargets', () => {
  it('reads a well-formed file', () => {
    const targets = targetsOf(file(waitText))
    expect(targets).toHaveLength(1)
    expect(targets[0]?.name).toBe('search')
    expect(targets[0]?.actions[0]).toEqual({ verb: 'waitFor', condition: { kind: 'text', text: '结果' } })
  })

  it('reads every condition kind', () => {
    const actions = `${waitText},
      { "verb": "waitFor", "condition": { "kind": "text", "text": "加载中", "absent": true } },
      { "verb": "waitFor", "condition": { "kind": "url", "url": "https://a.example/results" } },
      { "verb": "waitFor", "condition": { "kind": "url", "url": "https://a.example/gate", "absent": true } },
      { "verb": "waitFor", "condition": { "kind": "time", "ms": 250 }, "optional": true },
      { "verb": "waitFor", "condition": { "kind": "response", "match": { "kind": "prefix", "url": "https://a.example/api/search" } } }`
    const step = targetsOf(file(actions))[0]?.actions
    const conditionOf = (index: number): unknown => {
      const entry = step?.[index]
      return entry?.verb === 'waitFor' ? entry.condition : undefined
    }
    expect(conditionOf(1)).toEqual({ kind: 'text', text: '加载中', absent: true })
    expect(conditionOf(2)).toEqual({ kind: 'url', url: 'https://a.example/results' })
    expect(conditionOf(3)).toEqual({ kind: 'url', url: 'https://a.example/gate', absent: true })
    expect(step?.[4]).toEqual({ verb: 'waitFor', condition: { kind: 'time', ms: 250 }, optional: true })
    expect(conditionOf(5)).toEqual({ kind: 'response', match: { kind: 'prefix', url: 'https://a.example/api/search' } })
  })

  it('reads a response condition, whose match is a target match', () => {
    // One match clause in the vocabulary, parsed by the same code: a response is
    // selected by its URL exactly the way a target is.
    const cond = (match: string): string => `{ "verb": "waitFor", "condition": { "kind": "response", "match": ${match} } }`
    expect(targetsOf(file(cond('{ "kind": "exact", "url": "https://a.example/api/search" }')))[0]?.actions[0]).toEqual({
      verb: 'waitFor',
      condition: { kind: 'response', match: { kind: 'exact', url: 'https://a.example/api/search' } },
    })
    expect(targetsOf(file(cond('{ "kind": "prefix", "url": "https://a.example/api/" }')))[0]?.actions[0]).toMatchObject({
      condition: { kind: 'response', match: { kind: 'prefix', url: 'https://a.example/api/' } },
    })
  })

  it('refuses a response condition whose match is missing, malformed or widened', () => {
    const cond = (body: string): string => file(`{ "verb": "waitFor", "condition": { "kind": "response"${body} } }`)
    expect(errorOf(cond(''))).toContain('condition.match: expected an object')
    expect(errorOf(cond(', "match": { "kind": "regex", "url": "https://a.example/api" }'))).toContain('.condition.match.kind: expected "exact" or "prefix"')
    // The same silent-widening refusal a target's match gets, for the same reason.
    expect(errorOf(cond(', "match": { "kind": "prefix", "url": "https://a.example/api?q=1" }'))).toContain('comparison ignores the query string and hash')
    // No `absent`: a response is an event, and "none ever arrives" is the budget.
    expect(errorOf(cond(', "match": { "kind": "prefix", "url": "https://a.example/api" }, "absent": true'))).toContain('unknown key "absent" (allowed: "kind", "match")')
  })

  it('reads a state condition over a candidate list, in all four states', () => {
    const cond = (state: string, candidates = '[ { "selector": "input[type=checkbox]" } ]'): string =>
      `{ "verb": "waitFor", "condition": { "kind": "state", "state": "${state}", "candidates": ${candidates} } }`
    for (const state of ['checked', 'unchecked', 'enabled', 'disabled']) {
      const parsed = targetsOf(file(cond(state)))[0]?.actions[0]
      expect(parsed).toEqual({
        verb: 'waitFor',
        condition: { kind: 'state', state, candidates: [{ kind: 'selector', selector: 'input[type=checkbox]' }] },
      })
    }
    const mixed = targetsOf(file(cond('checked', '[ { "text": "全选" }, { "role": "checkbox", "name": "全选" } ]')))[0]?.actions[0]
    const condition = mixed?.verb === 'waitFor' ? mixed.condition : undefined
    expect(condition).toMatchObject({ candidates: [{ kind: 'text', text: '全选' }, { kind: 'role', role: 'checkbox', name: '全选' }] })
  })

  it('refuses a state condition that names no state, no control, or a state that is not one', () => {
    const cond = (body: string): string => file(`{ "verb": "waitFor", "condition": ${body} }`)
    expect(errorOf(cond('{ "kind": "state", "state": "hidden", "candidates": [ { "text": "x" } ] }'))).toContain('.condition.state: expected "checked", "unchecked", "enabled" or "disabled"')
    expect(errorOf(cond('{ "kind": "state", "state": "checked" }'))).toContain('.condition.candidates')
    expect(errorOf(cond('{ "kind": "state", "state": "checked", "candidates": [] }'))).toContain('a state condition with no candidates')
    expect(errorOf(cond('{ "kind": "state", "state": "checked", "candidates": [ { "text": "x" } ], "absent": true }'))).toContain('unknown key "absent"')
    expect(errorOf(cond('{ "kind": "regex" }'))).toContain('expected "text", "url", "time", "state" or "response"')
  })

  it('names the place in the file that is wrong', () => {
    expect(errorOf('{ nope }')).toContain('not valid JSON')
    expect(errorOf('[]')).toContain('targets file')
    expect(errorOf('{ "targets": {} }')).toContain('"targets" array')
    expect(errorOf('{ "targets": [], "extra": 1 }')).toContain('unknown key "extra"')
    expect(errorOf(file(waitText, '{ "kind": "regex", "url": "https://a.example/x" }'))).toContain('targets[0].match.kind')
    expect(errorOf(file(waitText, '{ "kind": "prefix", "url": "not a url" }'))).toContain('targets[0].match.url')
    expect(errorOf(file(''))).toContain('targets[0].actions')
    expect(errorOf(file('{ "verb": "press", "key": "Enter" }'))).toContain('targets[0].actions[0].verb')
    expect(errorOf(file('{ "verb": "click" }'))).toContain('targets[0].actions[0].candidates')
    expect(errorOf(file('{ "verb": "click", "candidates": [] }'))).toContain('can never name a control')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "text", "text": "" } }'))).toContain('.condition.text')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "time", "ms": -1 } }'))).toContain('.condition.ms')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "text", "text": "x" }, "condtion": 1 }'))).toContain('unknown key "condtion"')
    expect(errorOf(file(waitText, undefined, ''))).toContain('targets[0].name')
  })

  it('reads a click step and every candidate kind, in the order written', () => {
    const click = `{ "verb": "click", "candidates": [
      { "selector": "#search-btn" },
      { "text": "查询" },
      { "role": "button", "name": "Search" } ] }`
    expect(targetsOf(file(click))[0]?.actions[0]).toEqual({
      verb: 'click',
      candidates: [
        { kind: 'selector', selector: '#search-btn' },
        { kind: 'text', text: '查询' },
        { kind: 'role', role: 'button', name: 'Search' },
      ],
    })
  })

  it('reads a click that expects a page to open', () => {
    const click = `{ "verb": "click", "candidates": [ { "text": "商品标题" } ], "opensPage": true }`
    expect(targetsOf(file(click))[0]?.actions[0]).toEqual({
      verb: 'click',
      candidates: [{ kind: 'text', text: '商品标题' }],
      opensPage: true,
    })
    expect(errorOf(file('{ "verb": "click", "candidates": [ { "text": "x" } ], "opensPage": "yes" }'))).toContain('.opensPage: expected a boolean')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "time", "ms": 1 }, "opensPage": true }'))).toContain('unknown key "opensPage"')
  })

  it('keeps `optional` available on a click, since a popup may or may not be there', () => {
    const click = `{ "verb": "click", "candidates": [ { "text": "关闭" } ], "optional": true }`
    expect(targetsOf(file(click))[0]?.actions[0]).toEqual({ verb: 'click', candidates: [{ kind: 'text', text: '关闭' }], optional: true })
  })

  it('refuses a candidate that is malformed, ambiguous or unnamed', () => {
    const click = (candidates: string): string => file(`{ "verb": "click", "candidates": [${candidates}] }`)
    // One kind per candidate: mixing them would smuggle in an order the recipe
    // should state itself.
    expect(errorOf(click('{ "selector": "#a", "text": "b" }'))).toContain('unknown key "text"')
    expect(errorOf(click('{ "selector": "" }'))).toContain('.candidates[0].selector')
    expect(errorOf(click('{ "text": "   " }'))).toContain('.candidates[0].text')
    expect(errorOf(click('{ "role": "button" }'))).toContain('.candidates[0].name')
    expect(errorOf(click('{ "name": "查询" }'))).toContain('beside a "role"')
    expect(errorOf(click('{ "id": "a" }'))).toContain('.candidates[0]: expected one of')
    expect(errorOf(click('"#a"'))).toContain('.candidates[0]: expected an object')
    expect(errorOf(click('{ "role": "", "name": "x" }'))).toContain('.candidates[0].role')
    expect(errorOf(file('{ "verb": "click", "candidates": [ { "text": "x" } ], "condtion": 1 }'))).toContain('unknown key "condtion"')
    expect(errorOf(file('{ "verb": "waitFor", "candidates": [ { "text": "x" } ] }'))).toContain('unknown key "candidates"')
  })

  it('reads a check step, with the state it has to end in', () => {
    // Omitted state means "tick it": the verb's whole point is satisfying a
    // precondition, and a checkbox is what it is usually asked for.
    const defaulted = `{ "verb": "check", "candidates": [ { "text": "全选" } ] }`
    expect(targetsOf(file(defaulted))[0]?.actions[0]).toEqual({
      verb: 'check',
      candidates: [{ kind: 'text', text: '全选' }],
      state: 'checked',
    })
    const explicit = `{ "verb": "check", "candidates": [ { "selector": "#cb" } ], "state": "unchecked", "optional": true }`
    expect(targetsOf(file(explicit))[0]?.actions[0]).toEqual({
      verb: 'check',
      candidates: [{ kind: 'selector', selector: '#cb' }],
      state: 'unchecked',
      optional: true,
    })
  })

  it('refuses a check that names no control, no state, or a state that is not one', () => {
    const check = (step: string): string => file(step)
    expect(errorOf(check('{ "verb": "check" }'))).toContain('.candidates')
    expect(errorOf(check('{ "verb": "check", "candidates": [] }'))).toContain('can never name a control')
    expect(errorOf(check('{ "verb": "check", "candidates": [ { "text": "x" } ], "state": "enabled" }'))).toContain('.state: expected "checked" or "unchecked"')
    // A condition belongs to waitFor, not to a step that names a control.
    expect(errorOf(check('{ "verb": "check", "candidates": [ { "text": "x" } ], "condition": { "kind": "text", "text": "y" } }'))).toContain('unknown key "condition"')
  })

  it('reads a type step, with the value it has to write', () => {
    const typed = `{ "verb": "type", "candidates": [ { "selector": "#kw" }, { "text": "关键字" } ], "value": "维生素D" }`
    expect(targetsOf(file(typed))[0]?.actions[0]).toEqual({
      verb: 'type',
      candidates: [{ kind: 'selector', selector: '#kw' }, { kind: 'text', text: '关键字' }],
      value: '维生素D',
    })
    // An empty value is a real instruction: clear the field.
    expect(targetsOf(file('{ "verb": "type", "candidates": [ { "selector": "#kw" } ], "value": "" }'))[0]?.actions[0])
      .toMatchObject({ value: '' })
    expect(targetsOf(file('{ "verb": "type", "candidates": [ { "selector": "#kw" } ], "value": "x", "optional": true }'))[0]?.actions[0])
      .toMatchObject({ optional: true })
  })

  it('refuses a type step with no value, no field, or a value that is not text', () => {
    const typed = (body: string): string => file(body)
    expect(errorOf(typed('{ "verb": "type", "candidates": [ { "selector": "#kw" } ] }'))).toContain('.value: expected the text')
    expect(errorOf(typed('{ "verb": "type", "candidates": [ { "selector": "#kw" } ], "value": 250 }'))).toContain('.value: expected the text')
    expect(errorOf(typed('{ "verb": "type", "value": "x" }'))).toContain('.candidates')
    expect(errorOf(typed('{ "verb": "type", "candidates": [ { "selector": "#kw" } ], "value": "x", "condition": { "kind": "time", "ms": 1 } }'))).toContain('unknown key "condition"')
  })

  it('describes a candidate the same way everywhere it is named', () => {
    expect(describeCandidate({ kind: 'selector', selector: '#a' })).toBe('selector "#a"')
    expect(describeCandidate({ kind: 'text', text: '查询' })).toBe('text "查询"')
    expect(describeCandidate({ kind: 'role', role: 'button', name: 'Search' })).toBe('role button "Search"')
  })

  it('allows two targets to share a name, since names never select', () => {
    const two = `{ "targets": [ { "name": "same", "match": { "kind": "exact", "url": "https://a.example/x" }, "actions": [${waitText}] }, { "name": "same", "match": { "kind": "exact", "url": "https://a.example/y" }, "actions": [${waitText}] } ] }`
    expect(targetsOf(two)).toHaveLength(2)
  })

  it('refuses a URL that carries a query string or hash, which comparison ignores', () => {
    // Writing them would widen the match silently: .../search?q=1 would also
    // match .../search/other.
    expect(errorOf(file(waitText, '{ "kind": "prefix", "url": "https://a.example/search?q=1" }'))).toContain('ignores the query string')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "url", "url": "https://a.example/x#top" } }'))).toContain('ignores the query string')
  })
})
