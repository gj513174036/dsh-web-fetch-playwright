/**
 * The card's read-only launcher preview. It renders the command the local
 * launcher (`bin/launch-browser.mjs`) would run for the CDP/tunnel topology —
 * from the very drafts the user is editing — by calling the SAME
 * dependency-free argument builder the host uses (`launch-args.ts`), so the
 * two can never disagree about flag names, order, or the bypass separator.
 *
 * Kept free of Node builtins (the client bundle's purity gate) and of the
 * host config module (which value-imports schemastery): everything it needs
 * is either a parameter or lives in `launch-args.ts`.
 *
 * @module dsh-web-fetch-playwright/client/command
 */

import { buildCdpLaunchArgs, LAUNCHER_CDP_PORT, normalizeProxyServer, renderCommand } from '../launch-args.ts'

/** The card fields the preview renders from (drafts, not saved values). */
export interface LauncherPreviewInput {
  /** Draft of the headless checkbox ('true'/'false'/''). */
  headless: string
  /** Draft of the managed profile directory (also the launcher's copy target). */
  userDataDir: string
  /** Draft of the extra browser arguments. */
  launchArgs: string
  /** Draft of the proxy server. */
  proxyServer: string
  /** Draft of the proxy bypass list. */
  proxyBypass: string
}

/** Placeholder shown while the profile field is still empty. */
export const PREVIEW_USER_DATA_DIR_PLACEHOLDER = '<user-data-dir>'

/**
 * The command line the launcher would print for these drafts.
 *
 * @param input - the current draft values.
 * @returns one shell-ready line, e.g.
 *   `google-chrome --remote-debugging-port=9222 … --proxy-server=http://…`.
 */
export function launcherPreview(input: LauncherPreviewInput): string {
  const trimmedDir = input.userDataDir.trim()
  // The SAME normalizer the host launcher and the provider use, so a
  // schemeless `host:port` previews as the `http://…` that will be run. A
  // draft that is not a usable address yet (the user is mid-keystroke) shows
  // as typed: the preview must never make the card throw.
  const rawProxy = input.proxyServer.trim()
  let proxyServer: string | undefined
  try {
    proxyServer = normalizeProxyServer(rawProxy)
  } catch {
    proxyServer = rawProxy === '' ? undefined : rawProxy
  }
  const args = buildCdpLaunchArgs({
    userDataDir: trimmedDir === '' ? PREVIEW_USER_DATA_DIR_PLACEHOLDER : trimmedDir,
    // Absent/blank reads as the schema default (on), like effectiveHeadless.
    headless: input.headless !== 'false',
    ...(proxyServer === undefined ? {} : { proxyServer }),
    ...(input.proxyBypass.trim() === '' ? {} : { proxyBypassList: input.proxyBypass }),
    ...(input.launchArgs.trim() === '' ? {} : { launchArgs: input.launchArgs }),
  })
  return renderCommand('google-chrome', args)
}

/** The port the preview pins, re-exported so the card can spell it in copy. */
export const PREVIEW_CDP_PORT = LAUNCHER_CDP_PORT
