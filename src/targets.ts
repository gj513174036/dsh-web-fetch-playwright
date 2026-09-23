/**
 * Targets: the named recipe that tells one URL how to be fetched.
 *
 * A target says how to recognise its URL, which actions to run in order, and
 * what to wait for. It is pure data — reading, validating and matching a target
 * never touches a browser — which is what lets the rules be tested directly and
 * the failure messages name the exact place in the file that is wrong.
 *
 * Two decisions worth knowing while reading:
 *
 * - **Selection is by URL alone.** The fetch seam carries one URL and nothing
 *   else, so a target cannot be requested per call; the file is consulted, the
 *   URL picks the target. No match is the ordinary case and is not an error.
 * - **Specificity is length.** When several targets match, the longest match
 *   wins, and two equally long matches are a configuration error rather than a
 *   coin toss — an ambiguous file is a mistake the author wants to hear about.
 *
 * @module dsh-web-fetch-playwright/targets
 */

/** How a target's URL is compared with the URL being fetched. */
export type MatchKind = 'exact' | 'prefix'

/** How one target recognises the URLs it applies to. */
export interface TargetMatch {
  readonly kind: MatchKind
  readonly url: string
}

/**
 * One condition a `waitFor` step waits on.
 *
 * - `text` — the page's visible text contains it (or, with `absent`, no longer
 *   does).
 * - `url` — the browser is on this URL, or on one below it in the same tree (or,
 *   with `absent`, no longer is). This is how a target waits to be back on the
 *   page a gate interrupted, or to have left the one it clicked through.
 * - `time` — a fixed wait, still bounded by the step's ceiling.
 */
export type WaitCondition =
  | { readonly kind: 'text'; readonly text: string; readonly absent?: boolean }
  | { readonly kind: 'url'; readonly url: string; readonly absent?: boolean }
  | { readonly kind: 'time'; readonly ms: number }

/**
 * One way to name a control: an intent's ordered candidates, tried until one is
 * reachable (ADR-0002). Three kinds, because each covers what the others cannot
 * — a selector is exact but breaks with the markup, a text is what a person
 * reads, and a role with an accessible name is what an assistive technology
 * sees, which is also what survives a re-styled control.
 */
export type Candidate =
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'role'; readonly role: string; readonly name: string }

/** A step that waits for a condition before the fetch reads the document. */
export interface WaitStep {
  readonly verb: 'waitFor'
  readonly condition: WaitCondition
  /** When true, failing this step is skipped and recorded instead of fatal. */
  readonly optional?: boolean
}

/**
 * A step that clicks the first reachable candidate.
 *
 * The click does not assert its own effect — what a click does differs per page,
 * so a universal post-condition could only be a guess. The `waitFor` after it is
 * what turns "a click was dispatched" into "the page did what the target
 * claims"; with no such wait, the summary says the step is unverified.
 */
export interface ClickStep {
  readonly verb: 'click'
  /** Tried in order; the first reachable one is clicked, and the rest are not. */
  readonly candidates: readonly Candidate[]
  /** When true, failing this step is skipped and recorded instead of fatal. */
  readonly optional?: boolean
}

/**
 * A step that puts a control into a state, and reads it back.
 *
 * Unlike `click`, this verb asserts its own effect: a state is something the
 * page can be asked about, so the step passes only when the control *reports*
 * the wanted state afterwards. Acting twice is safe — a control already in the
 * wanted state is left alone rather than toggled back off.
 */
export interface CheckStep {
  readonly verb: 'check'
  /** Tried in order; the first reachable one is the control that is read and set. */
  readonly candidates: readonly Candidate[]
  /** The state the control has to end in; omitted means `"checked"`. */
  readonly state: 'checked' | 'unchecked'
  /** When true, failing this step is skipped and recorded instead of fatal. */
  readonly optional?: boolean
}

/** One step of a recipe. */
export type ActionStep = WaitStep | ClickStep | CheckStep

/** A named recipe for one page. */
export interface Target {
  readonly name: string
  readonly match: TargetMatch
  readonly actions: readonly ActionStep[]
}

/** The parsed file, or the reason it is unusable. */
export type TargetParseResult =
  | { readonly ok: true; readonly targets: readonly Target[] }
  | { readonly ok: false; readonly error: string }

/** What one URL's targets come to. */
export type TargetSelection =
  | { readonly ok: true; readonly target: Target | null }
  | { readonly ok: false; readonly error: string }

/** A URL reduced to what matching compares: scheme, host and path. */
export function normalizedUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return null
  }
}

/**
 * Does this URL sit at or below that one?
 *
 * The prefix rule, named on its own so a caller that simply wants "am I on this
 * page or below it" does not have to fabricate a match clause to ask. Scheme,
 * host and path are compared; the query string and hash are ignored.
 *
 * @param rawUrl - the URL to test.
 * @param base - the URL it should be at or below.
 * @returns true when it is.
 */
export function urlIsUnder(rawUrl: string, base: string): boolean {
  const candidate = normalizedUrl(rawUrl)
  const pattern = normalizedUrl(base)
  if (candidate === null || pattern === null) return false
  const candidateUrl = new URL(candidate)
  const patternUrl = new URL(pattern)
  if (candidateUrl.protocol !== patternUrl.protocol || candidateUrl.host !== patternUrl.host) return false
  const path = candidateUrl.pathname
  const prefix = patternUrl.pathname
  if (path === prefix) return true
  if (prefix.endsWith('/')) return path.startsWith(prefix)
  return path.startsWith(prefix) && path.charAt(prefix.length) === '/'
}

/**
 * Does this match apply to this URL?
 *
 * The query string and hash are ignored, so one target covers a page however it
 * is linked to. A prefix only matches at a path boundary: `.../pr` does not
 * match `.../proxy`, which is the difference between a recipe that is specific
 * and one that catches its neighbours by accident.
 *
 * @param match - the target's match clause.
 * @param rawUrl - the URL being fetched.
 * @returns true when the target applies.
 */
export function matchesTarget(match: TargetMatch, rawUrl: string): boolean {
  if (match.kind === 'exact') {
    const candidate = normalizedUrl(rawUrl)
    const pattern = normalizedUrl(match.url)
    return candidate !== null && candidate === pattern
  }
  return urlIsUnder(rawUrl, match.url)
}

/**
 * Pick the target for one URL.
 *
 * @param targets - every target in the file.
 * @param rawUrl - the URL being fetched.
 * @returns the chosen target (`null` for no match), or why the file is ambiguous.
 */
export function selectTarget(targets: readonly Target[], rawUrl: string): TargetSelection {
  const hits = targets
    .filter((target) => matchesTarget(target.match, rawUrl))
    .map((target) => ({ target, length: normalizedUrl(target.match.url)?.length ?? 0 }))
    .sort((a, b) => b.length - a.length)
  if (hits.length === 0) return { ok: true, target: null }
  const first = hits[0]
  const second = hits[1]
  if (first === undefined) return { ok: true, target: null }
  if (second !== undefined && second.length === first.length) {
    return {
      ok: false,
      error: `"${first.target.name}" and "${second.target.name}" match this URL equally specifically; make one of them more specific`,
    }
  }
  return { ok: true, target: first.target }
}

/**
 * Does this URL carry a query string or hash?
 *
 * Comparison deliberately ignores both, so a pattern that writes them would mean
 * something wider than it looks — `.../search?q=1` would match `.../search/other`.
 * That is a silent widening, so such a URL is refused rather than reinterpreted.
 */
function carriesQueryOrHash(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.search !== '' || url.hash !== ''
  } catch {
    return false
  }
}

/** Where a problem is, in the shape of the file. */
function at(path: string): string {
  return path === '' ? 'targets file' : path
}

/**
 * How a candidate reads in a summary or a failure message.
 *
 * One wording for every place that names a candidate, so a failure message and
 * the summary line above it describe the same attempt the same way.
 *
 * @param candidate - the candidate.
 * @returns e.g. `selector "#search"`, `text "查询"`, `role button "Search"`.
 */
export function describeCandidate(candidate: Candidate): string {
  if (candidate.kind === 'selector') return `selector ${JSON.stringify(candidate.selector)}`
  if (candidate.kind === 'text') return `text ${JSON.stringify(candidate.text)}`
  return `role ${candidate.role} ${JSON.stringify(candidate.name)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject keys the schema does not know, so a typo is a message rather than a shrug. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): string | null {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  return extra.length === 0 ? null : `${at(path)}: unknown key${extra.length > 1 ? 's' : ''} ${extra.map((key) => `"${key}"`).join(', ')} (allowed: ${allowed.map((key) => `"${key}"`).join(', ')})`
}

function parseMatch(value: unknown, path: string): { match: TargetMatch } | { error: string } {
  if (!isRecord(value)) return { error: `${at(path)}: expected an object` }
  const unknown = unknownKeys(value, ['kind', 'url'], path)
  if (unknown !== null) return { error: unknown }
  const kind = value['kind']
  if (kind !== 'exact' && kind !== 'prefix') return { error: `${at(path)}.kind: expected "exact" or "prefix"` }
  const url = value['url']
  if (typeof url !== 'string' || url === '' || normalizedUrl(url) === null) {
    return { error: `${at(path)}.url: expected an absolute http(s) URL` }
  }
  if (carriesQueryOrHash(url)) {
    return { error: `${at(path)}.url: comparison ignores the query string and hash, so writing them here would widen the match silently — write the URL without them` }
  }
  return { match: { kind, url } }
}

function parseCondition(value: unknown, path: string): { condition: WaitCondition } | { error: string } {
  if (!isRecord(value)) return { error: `${at(path)}: expected an object` }
  const kind = value['kind']
  if (kind === 'text') {
    const unknown = unknownKeys(value, ['kind', 'text', 'absent'], path)
    if (unknown !== null) return { error: unknown }
    const text = value['text']
    if (typeof text !== 'string' || text === '') return { error: `${at(path)}.text: expected a non-empty string` }
    const absent = value['absent']
    if (absent !== undefined && typeof absent !== 'boolean') return { error: `${at(path)}.absent: expected a boolean` }
    return { condition: absent === true ? { kind: 'text', text, absent: true } : { kind: 'text', text } }
  }
  if (kind === 'url') {
    const unknown = unknownKeys(value, ['kind', 'url', 'absent'], path)
    if (unknown !== null) return { error: unknown }
    const url = value['url']
    if (typeof url !== 'string' || url === '' || normalizedUrl(url) === null) {
      return { error: `${at(path)}.url: expected an absolute http(s) URL` }
    }
    if (carriesQueryOrHash(url)) {
      return { error: `${at(path)}.url: comparison ignores the query string and hash, so writing them here would widen the condition silently — write the URL without them` }
    }
    const absent = value['absent']
    if (absent !== undefined && typeof absent !== 'boolean') return { error: `${at(path)}.absent: expected a boolean` }
    return { condition: absent === true ? { kind: 'url', url, absent: true } : { kind: 'url', url } }
  }
  if (kind === 'time') {
    const unknown = unknownKeys(value, ['kind', 'ms'], path)
    if (unknown !== null) return { error: unknown }
    const ms = value['ms']
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return { error: `${at(path)}.ms: expected a non-negative number` }
    return { condition: { kind: 'time', ms } }
  }
  return { error: `${at(path)}.kind: expected "text", "url" or "time"` }
}

/**
 * A required non-empty string field, trimmed.
 *
 * `what` is the sentence the author reads when it is missing, so every kind
 * keeps its own advice while the shape check lives in one place.
 */
function requiredString(value: unknown, path: string, key: string, what: string): { text: string } | { error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${at(path)}.${key}: expected ${what}` }
  return { text: value.trim() }
}

/** A step's `optional` flag, absent meaning false. */
function parseOptional(value: unknown, path: string): { optional: boolean } | { error: string } {
  if (value === undefined) return { optional: false }
  if (typeof value !== 'boolean') return { error: `${at(path)}.optional: expected a boolean` }
  return { optional: value }
}

/**
 * Parse one candidate.
 *
 * A candidate is exactly one kind — `{ selector }`, `{ text }` or
 * `{ role, name }` — and a mixed one is refused rather than read as a priority
 * order, because the order between candidates is the recipe's business and
 * inside one there is none.
 */
function parseCandidate(value: unknown, path: string): { candidate: Candidate } | { error: string } {
  if (!isRecord(value)) return { error: `${at(path)}: expected an object` }
  if ('selector' in value) {
    const unknown = unknownKeys(value, ['selector'], path)
    if (unknown !== null) return { error: unknown }
    const selector = requiredString(value['selector'], path, 'selector', 'a non-empty CSS selector')
    if ('error' in selector) return { error: selector.error }
    return { candidate: { kind: 'selector', selector: selector.text } }
  }
  if ('text' in value) {
    const unknown = unknownKeys(value, ['text'], path)
    if (unknown !== null) return { error: unknown }
    const text = requiredString(value['text'], path, 'text', 'the visible text of the control, e.g. "查询"')
    if ('error' in text) return { error: text.error }
    return { candidate: { kind: 'text', text: text.text } }
  }
  if ('role' in value) {
    const unknown = unknownKeys(value, ['role', 'name'], path)
    if (unknown !== null) return { error: unknown }
    const role = requiredString(value['role'], path, 'role', 'an accessible role, e.g. "button" or "link"')
    if ('error' in role) return { error: role.error }
    const name = requiredString(value['name'], path, 'name', 'the accessible name the control must have, e.g. "查询"')
    if ('error' in name) return { error: name.error }
    return { candidate: { kind: 'role', role: role.text.toLowerCase(), name: name.text } }
  }
  if ('name' in value) return { error: `${at(path)}.name: only means something beside a "role"` }
  return {
    error: `${at(path)}: expected one of { "selector": ... }, { "text": ... } or { "role": ..., "name": ... }`,
  }
}

/**
 * The candidate list a control-naming step carries.
 *
 * One place for the rules both `click` and `check` live by: at least one
 * candidate, and every one of them well formed.
 */
function parseCandidates(value: unknown, path: string, verb: string): { parsed: Candidate[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: `${at(path)}.candidates: expected an array of candidates, most precise first` }
  }
  if (value.length === 0) {
    return { error: `${at(path)}.candidates: a ${verb} with no candidates can never match anything; give it one or remove the step` }
  }
  const parsed: Candidate[] = []
  for (const [index, raw] of value.entries()) {
    const candidate = parseCandidate(raw, `${path}.candidates[${String(index)}]`)
    if ('error' in candidate) return { error: candidate.error }
    parsed.push(candidate.candidate)
  }
  return { parsed }
}

function parseStep(value: unknown, path: string): { step: ActionStep } | { error: string } {
  if (!isRecord(value)) return { error: `${at(path)}: expected an object` }
  const verb = value['verb']
  if (verb === 'waitFor') {
    const unknown = unknownKeys(value, ['verb', 'condition', 'optional'], path)
    if (unknown !== null) return { error: unknown }
    const parsed = parseCondition(value['condition'], `${path}.condition`)
    if ('error' in parsed) return { error: parsed.error }
    const optional = parseOptional(value['optional'], path)
    if ('error' in optional) return { error: optional.error }
    return { step: optional.optional ? { verb, condition: parsed.condition, optional: true } : { verb, condition: parsed.condition } }
  }
  if (verb === 'click' || verb === 'check') {
    const allowed = verb === 'click' ? ['verb', 'candidates', 'optional'] : ['verb', 'candidates', 'state', 'optional']
    const unknown = unknownKeys(value, allowed, path)
    if (unknown !== null) return { error: unknown }
    const candidates = parseCandidates(value['candidates'], path, verb)
    if ('error' in candidates) return { error: candidates.error }
    const optional = parseOptional(value['optional'], path)
    if ('error' in optional) return { error: optional.error }
    if (verb === 'click') {
      return { step: optional.optional ? { verb, candidates: candidates.parsed, optional: true } : { verb, candidates: candidates.parsed } }
    }
    const state = value['state']
    if (state !== undefined && state !== 'checked' && state !== 'unchecked') {
      return { error: `${at(path)}.state: expected "checked" or "unchecked"` }
    }
    const wanted = state === 'unchecked' ? 'unchecked' : 'checked'
    return { step: optional.optional ? { verb, candidates: candidates.parsed, state: wanted, optional: true } : { verb, candidates: candidates.parsed, state: wanted } }
  }
  return { error: `${at(path)}.verb: expected "waitFor", "click" or "check" (the other verbs are not implemented yet)` }
}

function parseTarget(value: unknown, path: string): { target: Target } | { error: string } {
  if (!isRecord(value)) return { error: `${at(path)}: expected an object` }
  const unknown = unknownKeys(value, ['name', 'match', 'actions'], path)
  if (unknown !== null) return { error: unknown }
  const name = value['name']
  if (typeof name !== 'string' || name.trim() === '') return { error: `${at(path)}.name: expected a non-empty string` }
  const match = parseMatch(value['match'], `${path}.match`)
  if ('error' in match) return { error: match.error }
  const actions = value['actions']
  if (!Array.isArray(actions)) return { error: `${at(path)}.actions: expected an array` }
  if (actions.length === 0) return { error: `${at(path)}.actions: a target with no actions does nothing; remove it or give it one` }
  const steps: ActionStep[] = []
  for (const [index, raw] of actions.entries()) {
    const step = parseStep(raw, `${path}.actions[${String(index)}]`)
    if ('error' in step) return { error: step.error }
    steps.push(step.step)
  }
  return { target: { name: name.trim(), match: match.match, actions: steps } }
}

/**
 * Parse and validate a targets file.
 *
 * Strict on purpose: an unknown key, an unknown verb, or an empty action list is
 * a message naming its place in the file, because a recipe that silently does
 * less than it says is the failure this whole feature exists to remove.
 *
 * @param text - the file's contents.
 * @returns the targets, or the first problem found.
 */
export function parseTargets(text: string): TargetParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `targets file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'targets file: expected an object with a "targets" array' }
  const unknown = unknownKeys(parsed, ['targets'], '')
  if (unknown !== null) return { ok: false, error: unknown }
  const list = parsed['targets']
  if (!Array.isArray(list)) return { ok: false, error: 'targets file: expected a "targets" array' }
  const targets: Target[] = []
  for (const [index, raw] of list.entries()) {
    const target = parseTarget(raw, `targets[${String(index)}]`)
    if ('error' in target) return { ok: false, error: target.error }
    targets.push(target.target)
  }
  return { ok: true, targets }
}
