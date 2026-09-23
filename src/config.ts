/**
 * Settings/config surface for the Playwright fetch provider: the schemastery
 * schema the loader validates the row against, the settings namespace's
 * resolved shape, and the small pure normalizers the provider applies per
 * fetch (CDP endpoint shaping, outbound-proxy shaping, the DSH-managed
 * backend's launch plan, the network recorder's dump location) — kept
 * network-free for unit tests.
 *
 * @module dsh-web-fetch-playwright/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { mergeProxyBypass, normalizeProxyServer, parseLaunchArgs } from './launch-args.ts'
import type { PlaywrightProxyOption } from './types.ts'

// Re-exported: the proxy-bypass rules and the proxy-server normalizer live in
// the dependency-free `launch-args` module (the card's preview and the local
// launcher share them verbatim) but stay part of this module's published
// config surface.
export { mergeProxyBypass, normalizeProxyServer, PROXY_LOOPBACK_BYPASS } from './launch-args.ts'

/** Default CDP endpoint when the settings section leaves it blank. */
export const DEFAULT_CDP_ENDPOINT = '127.0.0.1:9222'

/**
 * Default concurrency for the local backend: each slot launches a whole
 * Chromium, so the default stays frugal; parallel `web_fetch` bursts stop
 * queueing without a browser farm per fetch.
 */
export const DEFAULT_MAX_CONCURRENCY_LOCAL = 4

/**
 * Default concurrency for the CDP backend: the browser already exists, each
 * fetch only opens a tab (isolated context) inside it over one shared
 * connection — so the budget behaves like "max concurrent tabs" and defaults
 * high.
 */
export const DEFAULT_MAX_CONCURRENCY_CDP = 50

/**
 * Default concurrency for the DSH-managed backend. Same shape as CDP — one
 * browser for the provider's lifetime, each in-flight fetch a tab in its
 * persistent context — so the budget is again "max concurrent tabs", not
 * "max browsers", and defaults high.
 */
export const DEFAULT_MAX_CONCURRENCY_MANAGED = 50

/** Ceiling the schema accepts for `maxConcurrency` (local slots are browsers). */
export const MAX_CONCURRENCY_CEILING = 200

/**
 * Default bounded wait (ms) for a Cloudflare challenge to clear naturally —
 * the user's real browser passes the verification on its own while the fetch
 * holds the same page and context. Sized to fit the 45s per-fetch deadline
 * with the settle/decode tail (and one retry) still inside it.
 */
export const DEFAULT_CHALLENGE_WAIT_MS = 15_000

/** Ceiling the schema accepts for `challengeWaitMs`. */
export const MAX_CHALLENGE_WAIT_MS = 60_000

/** Default same-page re-navigation attempts after a challenge wait runs out. */
export const DEFAULT_CHALLENGE_RETRIES = 1

/** Ceiling the schema accepts for `challengeRetries`. */
export const MAX_CHALLENGE_RETRIES = 3

/**
 * Directory name the capture dumps live under when `recordDir` is blank:
 * `<working directory>/net-dumps/<sessionId>`. `net-dumps/` is in this
 * repository's `.gitignore` — the dumps carry plaintext credentials — so the
 * basename is fixed here and must not be renamed.
 */
export const DEFAULT_RECORD_DIRECTORY = 'net-dumps'

/** Default per-body byte cap for a capture: big enough for an API payload, small enough to bound a dump. */
export const DEFAULT_MAX_BODY_BYTES = 262_144

/** Ceiling the schema accepts for `maxBodyBytes` (16 MiB). */
export const MAX_BODY_BYTES_CEILING = 16 * 1024 * 1024

/**
 * Which browser backend serves a fetch:
 *
 * - `local` — a throwaway browser per fetch (nothing outlives the call);
 * - `cdp` — a browser someone else already started, driven over DevTools;
 * - `managed` — a browser THIS plugin starts once and keeps: one persistent
 *   context over `userDataDir`, reused by every fetch as tabs, so logins
 *   survive across fetches and restarts (headless by configuration).
 */
export type PlaywrightBackend = 'local' | 'cdp' | 'managed'

/**
 * How a fetch is scoped: a throwaway isolated context, or a tab in a real
 * profile (the CDP browser's default context, or the managed backend's own
 * persistent context).
 */
export type CdpContextMode = 'isolated' | 'profile'

/** Plugin config: everything optional — the schema fills the defaults. */
export interface Config {
  /** Backend selector: local Playwright launch or a remote CDP endpoint. */
  backend?: PlaywrightBackend
  /**
   * Local backend: path to a `playwright` executable (Node CLI) or to a
   * Chromium-family browser executable. Empty = discover `playwright` on
   * `$PATH`, then fall back to the plugin's bundled `playwright-core`.
   */
  playwrightPath?: string
  /** CDP backend: `host:port`, `http(s)://…`, or `ws(s)://…`. Empty = default. */
  cdpEndpoint?: string
  /**
   * CDP backend only. `true` (default): each fetch is a tab in the remote
   * browser's default context — the real profile — so cookies/localStorage
   * come from (and are written back to) it and its persistent logins apply.
   * `false`: a fresh incognito-like isolated context per fetch, no shared
   * state. Meaningless for the local backend (collapses to isolated).
   */
  shareBrowserContext?: boolean
  /** Whether the Readability + DOMPurify denoise pipeline runs before markdown. */
  denoise?: boolean
  /**
   * Whether a known consent-management banner is dismissed before the
   * document is read (see `CONSENT_SELECTORS` in `./consent.ts`).
   *
   * Off by default, because the click is not a neutral act: it records the
   * user's consent in whichever profile the fetch runs in — the real one on
   * the CDP and DSH-managed backends. Best-effort either way; it can never
   * fail a fetch.
   */
  dismissConsent?: boolean
  /**
   * Whether the fetch returns the page's *actionable state* (reachable controls
   * with their labels and states, counts, the head of the visible text) instead
   * of denoised prose.
   *
   * A mode rather than a per-call argument because the fetch seam carries only a
   * URL. Its purpose is meeting an unfamiliar page: it is how a precondition
   * that no label mentions (five unchecked consents, a disabled submit) becomes
   * visible before anything is clicked.
   */
  observe?: boolean
  /**
   * Path to the JSON targets file: named recipes that tell a URL which actions to
   * run before its document is read.
   *
   * An explicit path rather than something workspace-relative, because the
   * provider only knows the process working directory — not the session's
   * workspace — and a recipe that silently fails to load would be worse than one
   * that names its file.
   */
  targetsFile?: string
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally inside
   * the same page/context. `0` (or any config leaving this at 0) restores the
   * legacy behavior: the first response is final, no waiting — the A/B
   * baseline. Schema default: {@link DEFAULT_CHALLENGE_WAIT_MS}.
   */
  challengeWaitMs?: number
  /**
   * Same-page re-navigation attempts after a challenge wait window runs out
   * (any partial clearance cookies stay in the context for the retry).
   * Schema default: {@link DEFAULT_CHALLENGE_RETRIES}.
   */
  challengeRetries?: number
  /**
   * How many fetches may render at once. Blank = backend default (4 for
   * local — each slot launches a browser; 50 for CDP — each slot is a tab in
   * the already-running remote browser).
   */
  maxConcurrency?: number
  /**
   * Outbound proxy for the browser this plugin launches, as `host:port` or an
   * `http(s)://` / `socks4://` / `socks5://` URL. Blank = direct connection.
   * Injected through Playwright's `launch({ proxy })` /
   * `launchPersistentContext({ proxy })`, so it is a launch-time property of
   * the browser PROCESS: the CDP backend, which only connects to a browser
   * someone else started, cannot take one (see the README and
   * {@link proxyOptionFor}).
   */
  proxyServer?: string
  /**
   * Comma-separated hosts that skip the proxy (Playwright's `proxy.bypass`).
   * {@link PROXY_LOOPBACK_BYPASS} is always merged in. Blank = loopback only.
   */
  proxyBypass?: string
  /** Proxy username (`proxy.username`); blank = an open proxy. */
  proxyUsername?: string
  /**
   * Proxy password (`proxy.password`). Stored like every other setting and
   * never echoed back in an error message.
   */
  proxyPassword?: string
  /**
   * Whether the browsers THIS plugin launches run without a window: the
   * per-fetch `local` browser and the `managed` persistent one. The local
   * launcher (`bin/launch-browser.mjs`) applies the same flag to the browser
   * it spawns for the CDP/tunnel topology, so one setting flips both.
   */
  headless?: boolean
  /**
   * Managed backend: the persistent profile directory the browser runs with.
   * Blank = `$DSH_HOME/web-fetch-playwright/profile` (or `~/.dsh/...` when
   * `DSH_HOME` is unset). The profile is what makes logins survive across
   * fetches and plugin restarts — treat that directory as credential-bearing.
   */
  userDataDir?: string
  /**
   * Extra Chromium arguments appended to every plugin-launched browser (and to
   * the launcher's command), e.g. `--lang=zh-CN --disable-gpu`. Split on
   * whitespace with shell-style quoting.
   */
  launchArgs?: string
  /**
   * Record the XHR/Fetch/WebSocket traffic of each fetch to disk (one CDP
   * session on the fetch's own tab, one session directory). Off by default:
   * the dumps carry plaintext credentials.
   */
  recordNetwork?: boolean
  /**
   * Base directory for the dumps; each capture gets a `<sessionId>`
   * subdirectory under it. Blank = `<working directory>/net-dumps` — the
   * gitignored default, whose basename is fixed.
   */
  recordDir?: string
  /**
   * Fetch response bodies through `Network.getResponseBody` (bounded by
   * {@link Config.maxBodyBytes}). Off = metadata only.
   */
  captureBodies?: boolean
  /**
   * Byte cap for a stored response body / WebSocket frame payload.
   * **`0` means NO CAP** (the whole body is stored) — the recorder treats a
   * non-positive cap as "no limit"; negative/absent fall back to the default
   * ({@link DEFAULT_MAX_BODY_BYTES}). A body that IS cut is flagged
   * `bodyTruncated` with its original `bodyBytes`.
   */
  maxBodyBytes?: number
  /**
   * Keep image/font/media/stylesheet records too. Off (the default) drops
   * them: they are noise for the API extraction this dump exists for.
   */
  recordAllResources?: boolean
}

export const Config: z<Config> = z.object({
  // union-of-consts rather than z.enum: the profile's published schemastery
  // build does not expose `.enum`, and this schema executes at runtime
  // against that copy.
  backend: z.union([z.const('local'), z.const('cdp'), z.const('managed')]).default('local'),
  playwrightPath: z.string().default(''),
  cdpEndpoint: z.string().default(''),
  shareBrowserContext: z.boolean().default(true),
  denoise: z.boolean().default(true),
  dismissConsent: z.boolean().default(false),
  observe: z.boolean().default(false),
  targetsFile: z.string().default(''),
  // Optional on purpose: the effective default depends on `backend`, which a
  // static schema default cannot express.
  maxConcurrency: z.number().step(1).min(1).max(MAX_CONCURRENCY_CEILING),
  // The bounded natural-wait knobs; 0 disables the whole challenge path.
  challengeWaitMs: z.number().step(100).min(0).max(MAX_CHALLENGE_WAIT_MS).default(DEFAULT_CHALLENGE_WAIT_MS),
  challengeRetries: z.number().step(1).min(0).max(MAX_CHALLENGE_RETRIES).default(DEFAULT_CHALLENGE_RETRIES),
  // The outbound proxy for the browser this plugin launches. Every field
  // defaults to '' = a direct connection, so an untouched section adds no
  // proxy key to the launch options at all.
  proxyServer: z.string().default(''),
  proxyBypass: z.string().default(''),
  proxyUsername: z.string().default(''),
  proxyPassword: z.string().default(''),
  // The DSH-managed persistent browser: headless by default (a server has no
  // display), the profile directory resolved per fetch, extra args free-form.
  headless: z.boolean().default(true),
  userDataDir: z.string().default(''),
  launchArgs: z.string().default(''),
  // The P2 capture knobs: opt-in (dumps hold plaintext credentials), with the
  // default directory's basename pinned to the gitignored `net-dumps`.
  recordNetwork: z.boolean().default(false),
  recordDir: z.string().default(''),
  captureBodies: z.boolean().default(true),
  // 0 = no cap (the recorder stores whole bodies); the ceiling keeps a dump
  // from growing without bound when bodies are captured.
  maxBodyBytes: z.number().step(1024).min(0).max(MAX_BODY_BYTES_CEILING).default(DEFAULT_MAX_BODY_BYTES),
  recordAllResources: z.boolean().default(false),
})

/** The four proxy fields, as the settings section carries them. */
export type ProxySettings = Pick<Config, 'proxyServer' | 'proxyBypass' | 'proxyUsername' | 'proxyPassword'>

/** The managed-backend fields, as the settings section carries them. */
export type ManagedSettings = Pick<Config, 'headless' | 'userDataDir' | 'launchArgs' | 'playwrightPath' | 'proxyServer' | 'proxyBypass' | 'proxyUsername' | 'proxyPassword'>

/** The capture fields, as the settings section carries them. */
export type CaptureSettings = Pick<Config, 'recordNetwork' | 'recordDir' | 'captureBodies' | 'maxBodyBytes' | 'recordAllResources'>

/** Field names whose effective value is resolved by a helper, not the schema. */
type ResolvedLaterFieldName = 'maxConcurrency' | 'proxyServer' | 'proxyBypass' | 'proxyUsername' | 'proxyPassword' | 'headless' | 'userDataDir' | 'launchArgs' | 'recordNetwork' | 'recordDir' | 'captureBodies' | 'maxBodyBytes' | 'recordAllResources'

/**
 * Complete config after schemastery applies the field defaults it owns.
 *
 * Eight fields stay optional in the TYPE while the schema still gives each a
 * concrete default: `maxConcurrency` is resolved against the backend by
 * {@link effectiveMaxConcurrency}; the four proxy fields default to `''` and
 * every reader treats a missing or blank value as "no proxy"; `headless`
 * defaults to `true` ({@link effectiveHeadless}); `userDataDir` defaults to
 * `$DSH_HOME/web-fetch-playwright/profile` ({@link effectiveUserDataDir});
 * `launchArgs` defaults to `''`; the five capture fields default to "off,
 * `<cwd>/net-dumps`, bodies on, {@link DEFAULT_MAX_BODY_BYTES}, static
 * resources dropped" ({@link effectiveRecordDir}, {@link captureOptionsFor}).
 * Keeping them optional here leaves hand-built configs written before these
 * features (composition rows restored from an older profile, test fixtures)
 * assignable without inventing values.
 */
export type ResolvedConfig = Omit<Required<Config>, ResolvedLaterFieldName> & {
  maxConcurrency?: number
} & ProxySettings & Pick<ManagedSettings, 'headless' | 'userDataDir' | 'launchArgs'> & CaptureSettings

/**
 * The concurrency limit a fetch actually runs with: an explicit setting
 * wins; otherwise the backend default. Local slots are whole browsers (4);
 * the CDP and managed backends each keep ONE browser alive and spend the
 * budget on concurrent tabs, so both default high (50) and `maxConcurrency`
 * means "how many tabs may be open at once".
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the effective limit for the semaphore.
 */
export function effectiveMaxConcurrency(config: Pick<Config, 'backend' | 'maxConcurrency'>): number {
  if (typeof config.maxConcurrency === 'number') return config.maxConcurrency
  if (config.backend === 'cdp') return DEFAULT_MAX_CONCURRENCY_CDP
  if (config.backend === 'managed') return DEFAULT_MAX_CONCURRENCY_MANAGED
  return DEFAULT_MAX_CONCURRENCY_LOCAL
}

/**
 * The challenge wait budget a fetch actually runs with: an explicit setting
 * wins, else the schema default. `0` means the challenge path is off.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the bounded wait in milliseconds.
 */
export function effectiveChallengeWaitMs(config: Pick<Config, 'challengeWaitMs'>): number {
  if (typeof config.challengeWaitMs === 'number') return config.challengeWaitMs
  return DEFAULT_CHALLENGE_WAIT_MS
}

/**
 * The same-page retry count a challenge fetch actually runs with: an explicit
 * setting wins, else the schema default.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns retries after a wait window runs out.
 */
export function effectiveChallengeRetries(config: Pick<Config, 'challengeRetries'>): number {
  if (typeof config.challengeRetries === 'number') return config.challengeRetries
  return DEFAULT_CHALLENGE_RETRIES
}

/**
 * The context mode a fetch actually runs with: the managed backend always
 * runs in its own persistent profile (that is the point of the backend); the
 * CDP backend runs in the remote browser's default context when the checkbox
 * is on (it defaults on, so an absent value reads as `true`, mirroring the
 * schema default); everything else — the local backend, whose browser dies
 * with the fetch, and an explicit CDP opt-out — collapses to isolated.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the mode the pool acquires its lease with.
 */
export function effectiveContextMode(config: Pick<Config, 'backend' | 'shareBrowserContext'>): CdpContextMode {
  if (config.backend === 'managed') return 'profile'
  if (config.backend === 'cdp' && config.shareBrowserContext !== false) return 'profile'
  return 'isolated'
}

/**
 * Whether a browser this plugin launches runs headless: an explicit setting
 * wins, else the schema default (`true` — a fetch needs no window, and the
 * launcher's `--headless=new` follows the same value).
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns true when the browser should run without a window.
 */
export function effectiveHeadless(config: Pick<Config, 'headless'>): boolean {
  return config.headless !== false
}

/** Directory name the managed backend's default profile lives under. */
export const MANAGED_PROFILE_DIRECTORY = 'web-fetch-playwright'

/**
 * The persistent profile directory the managed backend runs with: the
 * configured `userDataDir` when set, else a plugin-owned directory under
 * `$DSH_HOME` (falling back to `~/.dsh`). Never blank —
 * `launchPersistentContext` needs a real directory, and a stable one is what
 * makes logins persist.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @param env - environment to read `DSH_HOME`/`HOME` from (tests pass theirs).
 * @returns the absolute profile directory.
 */
export function effectiveUserDataDir(
  config: Pick<Config, 'userDataDir'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (config.userDataDir ?? '').trim()
  if (configured !== '') return configured
  const dshHome = (env.DSH_HOME ?? '').trim()
  const base = dshHome !== '' ? dshHome : join(env.HOME ?? homedir(), '.dsh')
  return join(base, MANAGED_PROFILE_DIRECTORY, 'profile')
}

/**
 * The launch inputs the managed backend runs with, and its shared-browser
 * pool key: a browser is reused for as long as this descriptor is unchanged,
 * and replaced (with the old one closed) the moment any of it changes — a new
 * profile directory, a headless flip, another proxy, more arguments, or a
 * different Playwright installation.
 */
export interface ManagedLaunch {
  /** The persistent profile directory (`launchPersistentContext` first arg). */
  userDataDir: string
  /** Headless switch for the browser process. */
  headless: boolean
  /** Extra Chromium arguments, already split into argv entries. */
  args: string[]
  /** Which Playwright installation serves the launch. */
  playwrightPath: string
  /** The outbound proxy, when one is configured (absent = direct). */
  proxy?: PlaywrightProxyOption
}

/**
 * Resolve the managed backend's launch plan.
 *
 * @param config - the resolved settings section.
 * @param proxy - the already-normalized proxy option (from {@link proxyOptionFor}).
 * @param env - environment for the default profile directory.
 * @returns the descriptor the pool keys its shared browser on.
 */
export function managedLaunchFor(
  config: ManagedSettings,
  proxy: PlaywrightProxyOption | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ManagedLaunch {
  return {
    userDataDir: effectiveUserDataDir(config, env),
    headless: effectiveHeadless(config),
    args: parseLaunchArgs(config.launchArgs ?? ''),
    playwrightPath: (config.playwrightPath ?? '').trim(),
    ...(proxy === undefined ? {} : { proxy }),
  }
}

/**
 * The stable text identity of a {@link ManagedLaunch} — the pool's "same
 * browser?" comparison. Field order is fixed here, so two equal plans always
 * serialize identically.
 *
 * @param launch - the resolved managed launch plan.
 * @returns the key text.
 */
export function managedLaunchKey(launch: ManagedLaunch): string {
  return JSON.stringify([
    launch.userDataDir,
    launch.headless,
    launch.args,
    launch.playwrightPath,
    launch.proxy?.server ?? '',
    launch.proxy?.bypass ?? '',
    launch.proxy?.username ?? '',
    launch.proxy?.password ?? '',
  ])
}

/**
 * The BASE directory the capture dumps live under: the configured `recordDir`
 * (resolved against the working directory when relative), else
 * `<working directory>/{@link DEFAULT_RECORD_DIRECTORY}` — so a default path
 * always ends in `net-dumps`. The recorder appends and claims the per-session
 * segment itself ({@link effectiveRecordDir} composes the full path for tests
 * and callers that just want the shape).
 *
 * @param config - the resolved settings section (or any partial of it).
 * @param cwd - the working directory the default and relative paths resolve against.
 * @returns the absolute base dump directory.
 */
export function effectiveRecordBase(
  config: Pick<Config, 'recordDir'>,
  cwd: string = process.cwd(),
): string {
  const configured = (config.recordDir ?? '').trim()
  if (configured === '') return join(cwd, DEFAULT_RECORD_DIRECTORY)
  return isAbsolute(configured) ? configured : resolve(cwd, configured)
}

/**
 * The full session directory path for a given id: `<base>/<sessionId>`. Useful
 * for tests and diagnostics; the RECORDER allocates the real directory (and may
 * pick a different id) so a collision can never merge two captures.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @param sessionId - the capture's id (see `newCaptureSessionId`).
 * @param cwd - the working directory the default and relative paths resolve against.
 * @returns the absolute session dump directory.
 */
export function effectiveRecordDir(
  config: Pick<Config, 'recordDir'>,
  sessionId: string,
  cwd: string = process.cwd(),
): string {
  return join(effectiveRecordBase(config, cwd), sessionId)
}

/** Everything one capture session needs, resolved from the settings section. */
export interface CapturePlan {
  /**
   * The BASE directory the capture allocates its session directory under
   * (`<baseDir>/<sessionId>`, 0700, files 0600). The recorder claims the
   * session directory itself, so two captures can never share one dump.
   */
  baseDir: string
  /** Fetch response bodies through `Network.getResponseBody`. */
  captureBodies: boolean
  /** Byte cap for a stored body / frame payload. */
  maxBodyBytes: number
  /** Keep image/font/media/stylesheet records instead of dropping them. */
  recordAllResources: boolean
  /** Whether recording is on at all. */
  enabled: boolean
}

/**
 * Resolve the capture plan for one fetch. Recording is opt-in
 * (`recordNetwork`), bodies are captured by default, and the byte cap falls
 * back to {@link DEFAULT_MAX_BODY_BYTES} when the setting is absent.
 *
 * @param config - the resolved settings section.
 * @param sessionId - this capture's id.
 * @param cwd - the working directory the default dump path resolves against.
 * @returns the plan the recorder runs with.
 */
export function captureOptionsFor(
  config: CaptureSettings,
  cwd: string = process.cwd(),
): CapturePlan {
  return {
    enabled: config.recordNetwork === true,
    baseDir: effectiveRecordBase(config, cwd),
    captureBodies: config.captureBodies !== false,
    maxBodyBytes: typeof config.maxBodyBytes === 'number' && Number.isFinite(config.maxBodyBytes)
      ? config.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES,
    recordAllResources: config.recordAllResources === true,
  }
}

/**
 * Normalize a configured CDP endpoint for `chromium.connectOverCDP`:
 * blank becomes the default loopback endpoint; `wss?://` and `https?://`
 * pass through; a bare `host:port` gains the `http://` scheme Playwright's
 * CDP discovery (`GET /json/version`) expects.
 *
 * @param input - the raw configured endpoint.
 * @returns the endpoint string to hand to Playwright.
 * @throws {Error} when the normalized value is not a parseable URL.
 */
export function normalizeCdpEndpoint(input: string): string {
  const trimmed = input.trim()
  const value = trimmed === '' ? DEFAULT_CDP_ENDPOINT : trimmed
  const candidate = /^wss?:\/\//i.test(value) || /^https?:\/\//i.test(value)
    ? value
    : `http://${value}`
  // Surface garbage early with a plain Error; the provider wraps it in a
  // structured WebError with the configured value for context.
  new URL(candidate)
  return candidate
}

/**
 * The Playwright launch `proxy` option for a settings section, or
 * `undefined` when the browser should launch unproxied.
 *
 * The switch is the SERVER: bypass, username, and password only refine a
 * proxy that exists (Playwright's option requires `server`), so an all-blank
 * section — and equally one holding only auxiliary values — yields a direct
 * connection instead of an unusable proxy object.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the launch proxy option, or undefined for a direct connection.
 * @throws {Error} when `proxyServer` is not a usable proxy address.
 */
export function proxyOptionFor(config: ProxySettings): PlaywrightProxyOption | undefined {
  const server = normalizeProxyServer(config.proxyServer ?? '')
  if (server === undefined) return undefined
  const bypass = mergeProxyBypass(config.proxyBypass ?? '')
  const username = (config.proxyUsername ?? '').trim()
  const password = config.proxyPassword ?? ''
  return {
    server,
    ...(bypass === '' ? {} : { bypass }),
    ...(username === '' ? {} : { username }),
    ...(password === '' ? {} : { password }),
  }
}

/**
 * Strip credentials out of a proxy address so diagnostics can name it. Only
 * the reachability of the value matters in a message; the password must not
 * appear (see {@link proxyOptionFor} consumers in the provider).
 *
 * @param server - a normalized (or raw) proxy address.
 * @returns the address with any `user:pass@` userinfo removed.
 */
export function redactProxyServer(server: string): string {
  try {
    const url = new URL(server)
    if (url.username === '' && url.password === '') return server
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    // Unparseable input still must not echo userinfo into a diagnostic.
    return server.replace(/\/\/[^/@]*@/, '//')
  }
}
