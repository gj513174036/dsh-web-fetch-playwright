/**
 * Launch-argument shaping, shared verbatim by the three callers that need the
 * same flags spelled the same way: the hosted backends (Playwright's launch
 * options), the local GUI launcher (`bin/launch-browser.mjs`, which spawns a
 * Chromium with those options written as command-line arguments), and the
 * settings card's read-only command preview.
 *
 * Deliberately dependency-free — not one import, not even a Node builtin —
 * because the card's browser bundle value-imports this module (the client
 * purity gate rejects Node builtins and `@deepseek-ai/*` values) while the
 * host half does the real spawning. Keep it pure: no `process`, no `fs`.
 *
 * @module dsh-web-fetch-playwright/launch-args
 */

/**
 * Default DevTools port the launcher exposes. Pinned into the printed command
 * and the reverse-tunnel example (`autossh -R 9222:127.0.0.1:9222 …`), so the
 * two topologies agree without further configuration.
 */
export const LAUNCHER_CDP_PORT = 9222

/**
 * The debug endpoint is bound to loopback on purpose: only the reverse tunnel
 * (or a local CDP connection) may reach it, never the local network.
 */
export const LAUNCHER_CDP_ADDRESS = '127.0.0.1'

/**
 * Destinations every configured proxy bypasses. A proxy setting means "reach
 * the outside world through this hop"; silently re-routing the plugin's own
 * loopback traffic (the CDP endpoint, a local smoke server) through a remote
 * proxy is never what the field means, so loopback is merged into whatever
 * bypass list the user keeps — and stays there even when that list is blank.
 */
export const PROXY_LOOPBACK_BYPASS = ['127.0.0.1', 'localhost', '::1'] as const

/**
 * The bypass list a launch actually runs with: the user's comma-separated
 * entries plus {@link PROXY_LOOPBACK_BYPASS}, de-duplicated
 * case-insensitively and kept in that order.
 *
 * @param input - the raw configured `proxyBypass` value.
 * @returns the comma-separated bypass list (never empty).
 */
export function mergeProxyBypass(input: string): string {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const raw of [...input.split(','), ...PROXY_LOOPBACK_BYPASS]) {
    const entry = raw.trim()
    if (entry === '') continue
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries.join(',')
}

/**
 * Split a settings `launchArgs` string into argv entries: whitespace-separated,
 * with `'…'`/`"…"` quoting (so a value containing spaces survives) and
 * backslash escapes inside double quotes. Empty quoted entries (`""`) are
 * kept — a deliberately empty argument is a legitimate flag value.
 *
 * @param input - the raw configured `launchArgs` value.
 * @returns the argument list (empty for a blank setting).
 */
export function parseLaunchArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = ''
  /** True once anything (even just an opening quote) was seen for `current`. */
  let started = false
  for (let index = 0; index < input.length; index++) {
    const char = input.charAt(index)
    if (quoted !== '') {
      if (char === quoted) {
        quoted = ''
        continue
      }
      if (char === '\\' && quoted === '"') {
        const next = input.charAt(index + 1)
        if (next === '"' || next === '\\') {
          current += next
          index++
          continue
        }
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quoted = char
      started = true
      continue
    }
    if (char === '\\') {
      const next = input.charAt(index + 1)
      if (next !== '') {
        current += next
        index++
        started = true
        continue
      }
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) args.push(current)
  return args
}

/** Proxy schemes handed to Chromium as written (Chromium dials all four). */
const PROXY_SERVER_SCHEMES = /^(?:https?|socks4a?|socks5h?):\/\//i

/**
 * Any other `scheme://` prefix. Detected separately from the allow-list so a
 * value like `ftp://host:21` is rejected instead of being mangled into the
 * host `http://ftp://host:21` — the check requires the `//` because a bare
 * `localhost:8080` also reads as `scheme:`-shaped, and that IS a valid
 * `host:port`.
 */
const ANY_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Normalize a configured proxy server for Playwright's `proxy.server` AND for
 * Chromium's `--proxy-server` flag — the same string in both topologies:
 * blank becomes `undefined` (a direct connection); `http(s)://`, `socks4://`,
 * `socks5://` pass through as written; a bare `host:port` gains the `http://`
 * scheme Chromium dials it with.
 *
 * It lives in this dependency-free module, not in the host config module,
 * because the card's preview must normalize exactly like the launcher does
 * while the client bundle cannot value-import the config module (which pulls
 * schemastery in). `config.ts` re-exports it, so the host API is unchanged.
 *
 * Rejection messages deliberately do NOT echo the input: this field accepts
 * `http://user:pass@host:port`, and a diagnostic must never be able to print
 * the password (the host's `redactProxyServer` strips userinfo wherever a
 * value is quoted).
 *
 * @param input - the raw configured `proxyServer` value.
 * @returns the server string for Playwright/Chromium, or undefined when blank.
 * @throws {Error} when the value is not a usable proxy address.
 */
export function normalizeProxyServer(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  if (ANY_SCHEME_PREFIX.test(trimmed) && !PROXY_SERVER_SCHEMES.test(trimmed)) {
    throw new Error('unsupported proxy server scheme (expected http, https, socks4, or socks5)')
  }
  const candidate = PROXY_SERVER_SCHEMES.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch (error: unknown) {
    throw new Error('the proxy server must be host:port or an http(s)/socks4/socks5 URL', { cause: error })
  }
  // A non-special scheme parses `socks5://` into an empty host rather than
  // failing, so the hostless shape needs an explicit rejection.
  if (parsed.hostname === '') throw new Error('the proxy server must name a host')
  return candidate
}

/** Everything the launcher command needs, from wherever it was resolved. */
export interface CdpLaunchInput {
  /**
   * The profile the browser opens. For the launcher this is the COPY of the
   * real profile, never the live one (Chromium locks a profile it is using).
   */
  userDataDir: string
  /** Run without a window (`--headless=new`). */
  headless: boolean
  /** The normalized proxy server, when one is configured. */
  proxyServer?: string
  /** The comma-separated bypass list (settings spelling), when a proxy is set. */
  proxyBypassList?: string
  /** Extra arguments from the settings `launchArgs` field, appended last. */
  launchArgs?: string
  /** Overridden only by tests/tools; the docs and tunnel example pin 9222. */
  port?: number
  /** Overridden only by tests/tools; loopback is the shipped default. */
  address?: string
}

/**
 * Build the browser argv for the local GUI/tunnel topology — the exact flags
 * the launcher prints (and runs), and the ones the card's preview shows.
 *
 * @param input - the resolved launch inputs.
 * @returns the argument list without the executable.
 */
export function buildCdpLaunchArgs(input: CdpLaunchInput): string[] {
  const args = [
    `--remote-debugging-port=${String(input.port ?? LAUNCHER_CDP_PORT)}`,
    `--remote-debugging-address=${input.address ?? LAUNCHER_CDP_ADDRESS}`,
    `--user-data-dir=${input.userDataDir}`,
  ]
  if (input.headless) args.push('--headless=new')
  const proxyServer = (input.proxyServer ?? '').trim()
  if (proxyServer !== '') {
    args.push(`--proxy-server=${proxyServer}`)
    // Chromium splits --proxy-bypass-list on SEMICOLONS while Playwright's
    // `proxy.bypass` (and this plugin's setting) uses commas: re-join for the
    // CLI so the same list means the same thing in both topologies.
    args.push(`--proxy-bypass-list=${mergeProxyBypass(input.proxyBypassList ?? '').split(',').join(';')}`)
  }
  args.push(...parseLaunchArgs(input.launchArgs ?? ''))
  return args
}

/**
 * Format an executable plus argv as a copy-pasteable command line, quoting
 * only the arguments a shell would otherwise split (paths with spaces,
 * proxied URLs, quoted flag values).
 *
 * @param executable - the browser binary to run.
 * @param args - the argument list.
 * @returns one shell-safe line.
 */
export function renderCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(shellQuote).join(' ')
}

/** POSIX single-quote one token (bare when it cannot need quoting). */
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.split("'").join(`'\\''`)}'`
}
