/**
 * `dsh-web-fetch-playwright`: registers the Playwright/CDP
 * {@link PlaywrightFetchProvider} with `ctx.web` and exposes its settings
 * section ('web-fetch-playwright') so the web client's plugin-configuration
 * card can edit it live.
 *
 * A function plugin (NOT a default-export service): like the shipped search
 * providers, it registers INTO the seam's fetch registry.
 *
 * @module dsh-web-fetch-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { Config } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { PlaywrightFetchProvider } from './provider.ts'

export { Config, DEFAULT_CDP_ENDPOINT, DEFAULT_CHALLENGE_RETRIES, DEFAULT_CHALLENGE_WAIT_MS, DEFAULT_MAX_CONCURRENCY_CDP, DEFAULT_MAX_CONCURRENCY_LOCAL, DEFAULT_MAX_CONCURRENCY_MANAGED, MANAGED_PROFILE_DIRECTORY, PROXY_LOOPBACK_BYPASS, effectiveChallengeRetries, effectiveChallengeWaitMs, effectiveContextMode, effectiveHeadless, effectiveMaxConcurrency, effectiveUserDataDir, managedLaunchFor, managedLaunchKey, mergeProxyBypass, normalizeCdpEndpoint, normalizeProxyServer, proxyOptionFor, redactProxyServer } from './config.ts'
export type { CdpContextMode, Config as PlaywrightFetchConfig, ManagedLaunch, ManagedSettings, PlaywrightBackend, ProxySettings, ResolvedConfig } from './config.ts'
export { BrowserPool } from './browser-pool.ts'
export type { BrowserLease, BrowserOpener, BrowserPoolOptions, LeaseContext, LeaseMode } from './browser-pool.ts'
export { CdpConnectionPool } from './cdp-pool.ts'
export type { CdpAcquireMode, CdpConnect, CdpLease } from './cdp-pool.ts'
export { CHALLENGE_DOM_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, CHALLENGE_TITLE_RE, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
export type { ChallengeVerdict } from './challenge.ts'
export { buildCdpLaunchArgs, LAUNCHER_CDP_ADDRESS, LAUNCHER_CDP_PORT, parseLaunchArgs, renderCommand } from './launch-args.ts'
export type { CdpLaunchInput } from './launch-args.ts'
export { BROWSER_CANDIDATES, copyProfile, defaultProfileCandidates, findBrowserExecutable, isProfileInUse, LAUNCHER_SETTINGS_NAMESPACE, launcherUsage, parseLauncherArgs, parseSettingsSection, planLauncher, PROFILE_COPY_EXCLUDES, profileCopyExcluded, readSettingsSection, resolveSettingsPath, TUNNEL_HINT } from './launcher.ts'
export type { LauncherFlags, LauncherPlan, ProfileCopyReport } from './launcher.ts'
export { CDP_PROXY_POLICY, PLAYWRIGHT_FETCH_PROVIDER_ID, PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE, WEB_FETCH_PROXY_CODE } from './provider.ts'
export { htmlToMarkdown } from './markdown.ts'
export type { DenoiseMode, DenoiseResult } from './markdown.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-web-fetch-playwright'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying this provider's configuration card. */
export const WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE = 'web-fetch-playwright'

/** Register the Playwright fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // `current` is REASSIGNED by setSource when the settings scope attaches
  // (possibly after this function returns), so the provider must receive an
  // indirection — `() => current()` — never the thunk's value at this moment.
  // Passing `current` directly would pin the composition entry forever (the
  // web-search-deepseek provider uses the same wrapper idiom).
  let current: () => ResolvedConfig = () => config as ResolvedConfig
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source as () => ResolvedConfig
      },
      // The provider projects the section per fetch, so a committed change
      // needs no re-registration.
      onChange: () => {},
    })
  })
  // The CDP backend holds one shared connection for the provider's lifetime;
  // drop it when this plugin unloads so restarts don't strand sockets.
  const provider = new PlaywrightFetchProvider(() => current())
  ctx.effect(() => () => { void provider.dispose() }, 'dsh-web-fetch-playwright: shared CDP connection')
  ctx.web.registerFetchProvider(provider)
}
