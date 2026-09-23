/**
 * Observe mode: hand the caller the page's *actionable state* instead of its
 * prose.
 *
 * Why this exists as its own mode rather than a step: the fetch seam takes a
 * URL and nothing else, so a per-call "show me the controls" argument cannot
 * reach the provider. What this mode buys is the thing a fixed recipe cannot
 * have — the ability to look at an unfamiliar page and work out what it wants.
 *
 * The shape is deliberately about *acting*, not about markup, and it encodes the
 * lessons of a real gate (booking.com's /pipl_consent.zh-cn.html):
 *
 * - **State, not just labels.** That gate listed five consents, had a select-all,
 *   and refused to continue until every one was ticked. Nothing in the button
 *   labels says so; `uncheckedCheckboxes: 5` does.
 * - **Where the visible control is.** Its five `<input type="checkbox">` are
 *   hidden and `locator.check()` times out on all of them — a person clicks the
 *   `<label>` around them. So each control reports whether it is visible itself,
 *   visible through its label, or hidden.
 * - **A bounded amount of it.** Counts are complete; the control list is capped,
 *   ordered so that everything reachable (itself or through its label) comes
 *   first in page order, with the unreachable tail last — a long page has
 *   hundreds of links and the planner needs the actionable ones.
 *
 * @module dsh-web-fetch-playwright/observe
 */

import type { PlaywrightPage } from './types.ts'
import { PAGE_FRAGMENTS, spliceFragments } from './page-fragments.ts'
import { raceTimeout, TIMED_OUT } from './race.ts'

/** How long the page gets to answer the observation probe. */
export const OBSERVE_TIMEOUT_MS = 5_000

/** Most controls the report will list; the counts always stay complete. */
export const OBSERVE_CONTROL_LIMIT = 150

/**
 * One control the planner could act on.
 *
 * @property kind - `button`, `link`, `checkbox`, `radio`, `select`, `textarea`,
 *   `submit`, or the element's own role.
 * @property label - its accessible-ish name: aria-label, value, associated
 *   label text, or its own text.
 * @property host - `self` (the control is laid out), `label` (it is not, but the
 *   `<label>` that controls it is — this is how a hidden checkbox is really
 *   clicked), or `hidden` (neither, so a plain click cannot reach it).
 * @property state - comma-separated flags: `checked`, `unchecked`, `disabled`,
 *   `aria-disabled`, `required`, `expanded=true|false`, and `covered` when the
 *   control is laid out but something else is on top of it (so a click aimed at
 *   it would land elsewhere).
 */
export interface ObservedControl {
  kind: string
  label: string
  host: string
  state: string
}

/** What one observation found. */
export interface Observation {
  url: string
  title: string
  textHead: string
  counts: Record<string, number>
  controlsTotal: number
  controls: ObservedControl[]
}

/**
 * The in-page collector. Exported so tests can run the real script against real
 * markup rather than assert against a copy of it.
 */
export const OBSERVE_SCRIPT = `(() => {
  ${spliceFragments(PAGE_FRAGMENTS)}
  const kindOf = (el) => {
    // Deliberately NOT the shared roleOf: this field reports the markup a planner
    // is looking at (submit, search, link), while roleOf answers the ARIA role a
    // candidate is matched against (button, searchbox). Merging them would rename
    // every control in this report.
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'input') return type === '' ? 'input' : type;
    if (tag === 'a') return 'link';
    if (role !== '') return role;
    return tag;
  };
  const stateOf = (el) => {
    const out = [];
    if (el.disabled === true) out.push('disabled');
    if (el.getAttribute('aria-disabled') === 'true') out.push('aria-disabled');
    if (el.required === true) out.push('required');
    // The one state read this plugin has (check verifies with the same one), so a
    // custom control that announces itself with aria-checked is not reported as
    // unchecked — which is what reading the DOM property alone used to say.
    const checked = checkedStateOf(el);
    if (checked !== '') out.push(checked);
    const expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) out.push('expanded=' + expanded);
    return out.join(', ');
  };
  const SELECTOR = 'input, select, textarea, button, [role="button"], [role="checkbox"], [role="radio"], [role="tab"], a[href]';
  let nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR)) } catch (error) { nodes = [] }
  const seen = nodes.map((el) => {
    const state = [stateOf(el), coverageOf(el)].filter((part) => part !== '').join(', ');
    // Where a person's click has to land, not merely whether the control itself
    // is laid out: the two answers differ exactly where it matters (a 1x1 input
    // under the styled box its own label draws over it).
    const host = hitTargetOf(el).host;
    return { kind: kindOf(el), label: accessibleNameOf(el).slice(0, 60), host: host === null ? 'hidden' : host, state: state };
  });
  const named = seen.filter((entry) => entry.label !== '');
  const reachable = named.filter((entry) => entry.host !== 'hidden');
  const ordered = reachable.concat(named.filter((entry) => entry.host === 'hidden'));
  const text = visibleTextOf();
  const count = (predicate) => seen.filter(predicate).length;
  return {
    url: location.href,
    title: document.title,
    textHead: text.replace(/\\s+/g, ' ').trim().slice(0, 600),
    counts: {
      controls: seen.length,
      reachable: reachable.length,
      buttons: count((entry) => entry.kind === 'button' || entry.kind === 'submit'),
      links: count((entry) => entry.kind === 'link'),
      checkboxes: count((entry) => entry.kind === 'checkbox'),
      uncheckedCheckboxes: count((entry) => entry.kind === 'checkbox' && entry.state.indexOf('unchecked') >= 0),
      selects: count((entry) => entry.kind === 'select'),
      forms: document.querySelectorAll('form').length,
      iframes: document.querySelectorAll('iframe').length,
    },
    controlsTotal: ordered.length,
    controls: ordered.slice(0, ${String(OBSERVE_CONTROL_LIMIT)}),
  };
})()`

/**
 * Read the page's actionable state.
 *
 * @param page - the page the fetch just settled.
 * @param timeoutMs - budget for the probe.
 * @returns the observation, or null when the page cannot be asked or did not
 *   answer (observe mode is the whole point of the fetch, so the caller treats
 *   null as a failure rather than as an empty page).
 */
export async function observePage(
  page: PlaywrightPage,
  timeoutMs: number = OBSERVE_TIMEOUT_MS,
): Promise<Observation | null> {
  const evaluate = page.evaluate?.bind(page)
  if (evaluate === undefined) return null
  let answer: unknown
  try {
    answer = await raceTimeout(evaluate(OBSERVE_SCRIPT), Math.max(0, timeoutMs))
  } catch {
    return null
  }
  if (answer === TIMED_OUT || typeof answer !== 'object' || answer === null) return null
  const shape = answer as Partial<Observation>
  if (typeof shape.url !== 'string' || !Array.isArray(shape.controls)) return null
  return {
    url: shape.url,
    title: typeof shape.title === 'string' ? shape.title : '',
    textHead: typeof shape.textHead === 'string' ? shape.textHead : '',
    counts: typeof shape.counts === 'object' && shape.counts !== null ? shape.counts : {},
    controlsTotal: typeof shape.controlsTotal === 'number' ? shape.controlsTotal : shape.controls.length,
    controls: shape.controls as ObservedControl[],
  }
}

/** One `key value` pair, skipped when the count is missing. */
function countOf(counts: Record<string, number>, key: string): number {
  const value = counts[key]
  return typeof value === 'number' ? value : 0
}

/**
 * Render an observation as the text the caller receives.
 *
 * Plain lines rather than a table: the control list runs to a hundred entries on
 * a busy page, and column alignment would cost more than it explains.
 *
 * @param observation - what {@link observePage} read.
 * @returns the report, counts first because they are what a precondition hides in.
 */
export function renderObservation(observation: Observation): string {
  const lines: string[] = []
  lines.push(`# Page state: ${observation.title === '' ? '(untitled)' : observation.title}`)
  lines.push('')
  lines.push(`URL: ${observation.url}`)
  const counts = observation.counts
  const unchecked = countOf(counts, 'uncheckedCheckboxes')
  lines.push(
    `Counts: controls ${String(countOf(counts, 'controls'))} (reachable ${String(countOf(counts, 'reachable'))})` +
      `, buttons ${String(countOf(counts, 'buttons'))}, links ${String(countOf(counts, 'links'))}` +
      `, checkboxes ${String(countOf(counts, 'checkboxes'))} (unchecked ${String(unchecked)})` +
      `, selects ${String(countOf(counts, 'selects'))}, forms ${String(countOf(counts, 'forms'))}` +
      `, iframes ${String(countOf(counts, 'iframes'))}`,
  )
  if (observation.textHead !== '') {
    lines.push('')
    lines.push('Visible text (head):')
    lines.push(`> ${observation.textHead}`)
  }
  lines.push('')
  lines.push(`## Controls (${String(observation.controls.length)} of ${String(observation.controlsTotal)}; reachable first)`)
  observation.controls.forEach((control, index) => {
    const where = control.host === 'label' ? ' (visible as its label)' : control.host === 'hidden' ? ' (not visible)' : ''
    const state = control.state === '' ? '' : ` - ${control.state}`
    lines.push(`${String(index + 1)}. [${control.kind}] "${control.label}"${state}${where}`)
  })
  return lines.join('\n')
}
