/**
 * Targets: the file's validation and the URL rules that pick one.
 *
 * Both are pure, so everything here is a direct assertion on behaviour rather
 * than on a browser: what a bad file says, and which target a URL gets.
 */
import { describe, expect, it } from 'vitest'
import { matchesTarget, normalizedUrl, parseTargets, selectTarget } from '../src/targets.ts'
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
      { "verb": "waitFor", "condition": { "kind": "time", "ms": 250 }, "optional": true }`
    const step = targetsOf(file(actions))[0]?.actions
    expect(step?.[1]?.condition).toEqual({ kind: 'text', text: '加载中', absent: true })
    expect(step?.[2]?.condition).toEqual({ kind: 'url', url: 'https://a.example/results' })
    expect(step?.[3]?.condition).toEqual({ kind: 'url', url: 'https://a.example/gate', absent: true })
    expect(step?.[4]).toEqual({ verb: 'waitFor', condition: { kind: 'time', ms: 250 }, optional: true })
  })

  it('names the place in the file that is wrong', () => {
    expect(errorOf('{ nope }')).toContain('not valid JSON')
    expect(errorOf('[]')).toContain('targets file')
    expect(errorOf('{ "targets": {} }')).toContain('"targets" array')
    expect(errorOf('{ "targets": [], "extra": 1 }')).toContain('unknown key "extra"')
    expect(errorOf(file(waitText, '{ "kind": "regex", "url": "https://a.example/x" }'))).toContain('targets[0].match.kind')
    expect(errorOf(file(waitText, '{ "kind": "prefix", "url": "not a url" }'))).toContain('targets[0].match.url')
    expect(errorOf(file(''))).toContain('targets[0].actions')
    expect(errorOf(file('{ "verb": "click" }'))).toContain('targets[0].actions[0].verb')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "text", "text": "" } }'))).toContain('.condition.text')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "time", "ms": -1 } }'))).toContain('.condition.ms')
    expect(errorOf(file('{ "verb": "waitFor", "condition": { "kind": "text", "text": "x" }, "condtion": 1 }'))).toContain('unknown key "condtion"')
    expect(errorOf(file(waitText, undefined, ''))).toContain('targets[0].name')
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
