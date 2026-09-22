/**
 * Browser half of `dsh-web-fetch-playwright`: registers the locale dictionary
 * and the plugin-configuration card that edits the `web-fetch-playwright`
 * settings namespace.
 *
 * SEAT SELECTION. A deployment renders plugin cards through exactly one of two
 * seats, and a card contributed to the other one renders nowhere:
 *
 * - `web-ui.plugin.item` — the list seat declared by the `dsh-web-settings`
 *   family group (its own first-level section, e.g. 「Web 插件」);
 * - `settings.plugin.item` — the official keyed seat of the harness's
 *   `ui-settings-plugins` tab, keyed by the settings namespace the card edits.
 *
 * Declaring the official seat is not a usable probe: the harness bundle always
 * declares it, so "is it declared?" answers yes even in a deployment whose whole
 * point is the family group. The distinguishing signal is whether the family
 * group is loaded — it publishes the `webUiSettings` service — so this module
 * follows that service and re-evaluates on every `slots/changed`, exactly like
 * the family's own plugins do.
 *
 * @module dsh-web-fetch-playwright/client
 */

import type { Context } from 'cordis'
// Type-only: pulls the ctx.locale / ctx.slots / ctx.settingsScope Context
// merges, and the 'settings.plugin.item' SlotMap declaration from the
// ui-settings-plugins package that owns the official slot contract.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PlaywrightCardController, WEB_FETCH_PLAYWRIGHT_NS } from './controller.ts'
import { PlaywrightCard } from './card.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'web-fetch-playwright'

/** The family group's list seat (rendered as its own "Web UI plugins" section). */
const FAMILY_CARD_SEAT = 'web-ui.plugin.item'

/** The official keyed plugin-card seat of the `ui-settings-plugins` tab. */
const OFFICIAL_CARD_SEAT = 'settings.plugin.item'

/** The service the `dsh-web-settings` family group publishes while loaded. */
const FAMILY_GROUP_SERVICE = 'webUiSettings'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/** The loose registration shape both seats accept at runtime. */
type SeatRegister = (options: Record<string, unknown>, component: unknown) => () => void

/**
 * Whether the family group is loaded in this page. Read structurally (a plain
 * service lookup) so this module needs no dependency on the family package.
 * @param ctx - the browser plugin context.
 * @returns true when the family group's service is available.
 */
function familyGroupLoaded(ctx: Context): boolean {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return false
    return get.call(ctx, FAMILY_GROUP_SERVICE) !== undefined
  } catch {
    return false
  }
}

/**
 * Mount the Playwright plugin-configuration card into whichever seat this host
 * renders, moving it when the family group loads or unloads later.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-fetch-playwright: card dictionary')

  const controller = new PlaywrightCardController(
    ctx.settingsScope.bind({ namespace: WEB_FETCH_PLAYWRIGHT_NS }),
  )
  const face = () => controller.inject()
  const register = ctx.slots.register as unknown as SeatRegister

  let dispose: (() => void) | undefined
  let current: string | undefined
  // `register` and the previous entry's disposer both run synchronously, so an
  // unguarded reconcile re-enters itself mid-move and registers the card twice
  // into the seat it is leaving ("already has an entry for key ...").
  let reconciling = false

  const reconcile = (): void => {
    if (reconciling) return
    const target = familyGroupLoaded(ctx) ? FAMILY_CARD_SEAT : OFFICIAL_CARD_SEAT
    if (current === target) return
    reconciling = true
    const previous = dispose
    dispose = undefined
    current = undefined
    previous?.()
    try {
      dispose = target === FAMILY_CARD_SEAT
        ? register({ name: FAMILY_CARD_SEAT, id: WEB_FETCH_PLAYWRIGHT_NS, locale: NS, inject: face }, PlaywrightCard)
        : register({ name: OFFICIAL_CARD_SEAT, key: WEB_FETCH_PLAYWRIGHT_NS, locale: NS, inject: face }, PlaywrightCard)
      current = target
    } catch (error: unknown) {
      // A refused seat must be reported, never swallowed: a silent failure is
      // exactly the "installed but no settings card anywhere" symptom.
      console.warn(`[dsh-web-fetch-playwright] plugin card registration into "${target}" was refused; the card will not render`, error)
    } finally {
      reconciling = false
    }
  }

  ctx.effect(() => {
    let off: (() => void) | undefined
    try {
      off = (ctx as unknown as { on?: (name: string, listener: () => void) => () => void })
        .on?.('slots/changed', () => { reconcile() })
    } catch {
      // A context without the event still gets the initial reconcile below.
    }
    reconcile()
    return () => {
      off?.()
      dispose?.()
      dispose = undefined
      current = undefined
    }
  }, 'web-fetch-playwright: plugin card seat')
}
