/**
 * The Playwright card's controller: the staged form over the
 * `web-fetch-playwright` settings namespace, projected into one snapshot the
 * card's slot entry injects.
 *
 * @module dsh-web-fetch-playwright/client/controller
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { launcherPreview } from './command.ts'
import { CardForm, checkboxField, numberField, radioField, textField } from './form.ts'
import type { CardShell, CardFieldState, CardActions, SnapshotStore } from './form.ts'

/**
 * Settings namespace this card edits. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const WEB_FETCH_PLAYWRIGHT_NS = 'web-fetch-playwright'

/** The section fields this card edits. */
export interface PlaywrightSettings {
  /** Backend selector: local Playwright launch or a remote CDP endpoint. */
  backend?: string
  /** Local backend: playwright/browser executable path. */
  playwrightPath?: string
  /** CDP backend: endpoint (host:port / http(s) / ws). */
  cdpEndpoint?: string
  /**
   * CDP backend: whether fetches share the remote browser's context (its
   * real profile — cookies, localStorage, persistent logins) as tabs, or
   * each use a fresh isolated context. Absent = schema default (true).
   */
  shareBrowserContext?: boolean
  /** Whether the Readability + DOMPurify pipeline runs. */
  denoise?: boolean
  /** Whether a known consent banner is clicked away before reading. */
  dismissConsent?: boolean
  /** Whether the fetch returns the page's actionable state instead of its text. */
  observe?: boolean
  /** Path to the JSON targets file (blank = no targets). */
  targetsFile?: string
  /** How many fetches may render at once (1–200); blank = backend default. */
  maxConcurrency?: number
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally in the
   * same tab (0–60000); 0 = off (return the first response as-is).
   */
  challengeWaitMs?: number
  /**
   * Per-fetch budget (ms): everything one fetch does — including a `waitFor`
   * chain — has to fit inside it (5000–600000).
   */
  fetchBudgetMs?: number
  /**
   * Outbound proxy for the browser this plugin launches: `host:port` or an
   * `http(s)/socks4/socks5` URL. Blank = direct connection. In CDP mode it
   * does not apply to the fetch (that browser is started elsewhere) — it
   * shapes the launcher command instead, see the card's hint.
   */
  proxyServer?: string
  /** Comma-separated hosts that skip the proxy; loopback is always bypassed. */
  proxyBypass?: string
  /** Proxy username; blank = an open proxy. */
  proxyUsername?: string
  /**
   * Proxy password; never echoed back in an error message. In CDP mode it
   * only feeds the launcher command below (the browser that gets attached to
   * must have been started with `--proxy-server`).
   */
  proxyPassword?: string
  /**
   * Managed backend: run the browser this plugin launches without a window.
   * Also drives the launcher's `--headless=new`.
   */
  headless?: boolean
  /** Managed backend: the persistent profile directory (blank = DSH default). */
  userDataDir?: string
  /** Extra browser arguments for plugin-launched browsers and the launcher. */
  launchArgs?: string
  /**
   * Record each fetch's XHR/Fetch/WebSocket traffic to disk. Off by default:
   * the dump holds plaintext credentials.
   */
  recordNetwork?: boolean
  /** Base directory for the dumps; blank = `<working directory>/net-dumps`. */
  recordDir?: string
  /** Capture response bodies through CDP (bounded by `maxBodyBytes`). */
  captureBodies?: boolean
  /** Byte cap for a stored body / WebSocket frame payload. */
  maxBodyBytes?: number
  /** Keep image/font/media/stylesheet records too (default: dropped). */
  recordAllResources?: boolean
}

/** What the Playwright card renders. */
export interface PlaywrightCardState extends CardShell {
  /** Backend radio group. */
  backend: CardFieldState
  /** Local-backend path input. */
  playwrightPath: CardFieldState
  /** CDP endpoint input. */
  cdpEndpoint: CardFieldState
  /** CDP shared-context checkbox (draft 'true'/'false'). */
  shareBrowserContext: CardFieldState
  /** Denoise checkbox (draft 'true'/'false'). */
  denoise: CardFieldState
  /** Consent-banner checkbox (draft 'true'/'false'). */
  dismissConsent: CardFieldState
  /** Observe-mode checkbox (draft 'true'/'false'). */
  observe: CardFieldState
  /** Targets-file path input. */
  targetsFile: CardFieldState
  /** Concurrency input (draft decimal integer). */
  maxConcurrency: CardFieldState
  /** Challenge wait input (draft decimal integer of milliseconds). */
  challengeWaitMs: CardFieldState
  /** Per-fetch budget (ms) as the card holds it (5000–600000). */
  fetchBudgetMs: CardFieldState
  /** Proxy server input (host:port or scheme URL). */
  proxyServer: CardFieldState
  /** Proxy bypass-list input (comma-separated hosts). */
  proxyBypass: CardFieldState
  /** Proxy username input. */
  proxyUsername: CardFieldState
  /** Proxy password input (rendered masked, never as plain text). */
  proxyPassword: CardFieldState
  /** Managed-backend headless checkbox (draft 'true'/'false'). */
  headless: CardFieldState
  /** Managed-backend profile directory input. */
  userDataDir: CardFieldState
  /** Extra browser arguments input (shell-style quoted). */
  launchArgs: CardFieldState
  /** Capture master switch (draft 'true'/'false'). */
  recordNetwork: CardFieldState
  /** Capture base directory input. */
  recordDir: CardFieldState
  /** Response-body capture checkbox (draft 'true'/'false'). */
  captureBodies: CardFieldState
  /** Body byte-cap input (draft decimal integer). */
  maxBodyBytes: CardFieldState
  /** Keep-static-resources checkbox (draft 'true'/'false'). */
  recordAllResources: CardFieldState
  /**
   * Read-only preview of the local launcher's command, derived from the
   * drafts above (never staged, never saved).
   */
  launcherCommand: string
}

/** The registration-side face the card's slot entry injects. */
export interface PlaywrightCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as usePlaywrightCard. */
    playwrightCard: SnapshotStore<PlaywrightCardState>
  }
}

/** Bridges the `web-fetch-playwright` settings scope onto the card. */
export class PlaywrightCardController {
  private readonly form: CardForm<PlaywrightSettings>
  private readonly store: SnapshotStore<PlaywrightCardState>

  /**
   * @param scope - the bound settings scope for the `web-fetch-playwright` namespace.
   */
  constructor(scope: SettingsScope<PlaywrightSettings>) {
    this.form = new CardForm(
      scope,
      [
        radioField('backend', ['local', 'cdp', 'managed']),
        textField('playwrightPath'),
        textField('cdpEndpoint'),
        checkboxField('shareBrowserContext'),
        checkboxField('denoise'),
        checkboxField('dismissConsent'),
        checkboxField('observe'),
        textField('targetsFile'),
        numberField('maxConcurrency', 1, 200),
        numberField('challengeWaitMs', 0, 60_000),
        numberField('fetchBudgetMs', 5_000, 600_000),
        textField('proxyServer'),
        textField('proxyBypass'),
        textField('proxyUsername'),
        textField('proxyPassword'),
        checkboxField('headless'),
        textField('userDataDir'),
        textField('launchArgs'),
        checkboxField('recordNetwork'),
        textField('recordDir'),
        checkboxField('captureBodies'),
        numberField('maxBodyBytes', 0, 16 * 1024 * 1024),
        checkboxField('recordAllResources'),
      ],
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): PlaywrightCardState {
    return {
      ...this.form.shell(),
      backend: this.form.field('backend'),
      playwrightPath: this.form.field('playwrightPath'),
      cdpEndpoint: this.form.field('cdpEndpoint'),
      shareBrowserContext: this.form.field('shareBrowserContext'),
      denoise: this.form.field('denoise'),
      dismissConsent: this.form.field('dismissConsent'),
      observe: this.form.field('observe'),
      targetsFile: this.form.field('targetsFile'),
      maxConcurrency: this.form.field('maxConcurrency'),
      challengeWaitMs: this.form.field('challengeWaitMs'),
      fetchBudgetMs: this.form.field('fetchBudgetMs'),
      proxyServer: this.form.field('proxyServer'),
      proxyBypass: this.form.field('proxyBypass'),
      proxyUsername: this.form.field('proxyUsername'),
      proxyPassword: this.form.field('proxyPassword'),
      headless: this.form.field('headless'),
      userDataDir: this.form.field('userDataDir'),
      launchArgs: this.form.field('launchArgs'),
      recordNetwork: this.form.field('recordNetwork'),
      recordDir: this.form.field('recordDir'),
      captureBodies: this.form.field('captureBodies'),
      maxBodyBytes: this.form.field('maxBodyBytes'),
      recordAllResources: this.form.field('recordAllResources'),
      launcherCommand: this.preview(),
    }
  }

  /** The launcher line for the CURRENT drafts (staged edits included). */
  private preview(): string {
    return launcherPreview({
      headless: this.form.field('headless').text,
      userDataDir: this.form.field('userDataDir').text,
      launchArgs: this.form.field('launchArgs').text,
      proxyServer: this.form.field('proxyServer').text,
      proxyBypass: this.form.field('proxyBypass').text,
    })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): PlaywrightCardFace {
    return { hooks: { playwrightCard: this.store }, ...this.form.actions() }
  }
}
