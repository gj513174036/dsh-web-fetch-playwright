/**
 * The local GUI/tunnel launcher's host half — `dsh-web-fetch-launch`, shipped
 * as `bin/launch-browser.mjs`.
 *
 * It exists for the topology where the VISIBLE browser runs on the user's own
 * machine (their real Chrome, their real profile, their own eyes) while the
 * plugin runs somewhere else and attaches over CDP: the launcher reads the
 * SAME settings section the card writes, copies the real profile to a
 * throwaway directory (Chromium locks a profile it is using, and copying keeps
 * the original safe), builds the browser command — `--remote-debugging-port`,
 * `--remote-debugging-address=127.0.0.1`, `--user-data-dir=<copy>`,
 * `--proxy-server`, `--proxy-bypass-list`, `--headless=new` — prints it
 * (`--dry-run`) or runs it, then prints the reverse-tunnel reminder
 * (`autossh -R 9222:127.0.0.1:9222 …`).
 *
 * The pure argument shaping lives in `launch-args.ts` so the card's read-only
 * preview cannot drift from what this actually runs; this module owns the I/O:
 * the settings file, the browser/PATH discovery, the profile copy, and the
 * spawn (the CLI half).
 *
 * @module dsh-web-fetch-playwright/launcher
 */

import { cpSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, posix, win32 } from 'node:path'
import { normalizeProxyServer } from './config.ts'
import { buildCdpLaunchArgs, LAUNCHER_CDP_ADDRESS, LAUNCHER_CDP_PORT, renderCommand } from './launch-args.ts'

/** Settings namespace whose section this launcher mirrors from the card. */
export const LAUNCHER_SETTINGS_NAMESPACE = 'web-fetch-playwright'

/** How long the remote tunnel command is worth a copy-paste line (docs mirror it). */
export const TUNNEL_HINT = `autossh -M 0 -N -R ${String(LAUNCHER_CDP_PORT)}:${LAUNCHER_CDP_ADDRESS}:${String(LAUNCHER_CDP_PORT)} <user@server>`

/**
 * Chromium-family executables probed on `$PATH` when `--browser` is not given.
 * Ordered from the most common to the least; the first hit wins.
 */
export const BROWSER_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'brave-browser',
  'microsoft-edge',
  'msedge',
] as const

/**
 * Profile entries the copy NEVER carries over:
 *
 * - `Singleton*` (matched by prefix: `SingletonLock`, `SingletonCookie`,
 *   `SingletonSocket`) — the lock belongs to the LIVE browser; copying it
 *   either makes the copy refuse to start or lets two browsers share a
 *   profile, which corrupts it. The launcher also refuses to copy ONTO a
 *   directory that has one (that browser is still running).
 * - the caches and short-lived state that can be gigabytes and carry no login
 *   value (`Cache`, `Code Cache`, `GPUCache`, `Service Worker`, …);
 * - crash/telemetry droppings.
 * Everything that makes the copy useful — `Default/Cookies`, `Login Data`,
 * `Local Storage`, `Extensions`, `Preferences`, the macOS `Keychain`-adjacent
 * files — is kept.
 */
export const PROFILE_COPY_EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
  'Service Worker',
  'Application Cache',
  'Media Cache',
  'Crashpad',
  'Crash Reports',
  'BrowserMetrics',
  'BrowserMetrics-spare',
  'component_crx_cache',
  'extensions_crx_cache',
  'OptimizationGuidePredictionModels',
] as const

/** Undo YAML's double-quoted escapes (the ones a settings writer emits). */
function unescapeDoubleQuoted(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index)
    if (char !== '\\') {
      out += char
      continue
    }
    const next = value.charAt(index + 1)
    if (next === '') {
      out += char
      continue
    }
    index++
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else out += next // \\, \", and anything else stands for itself
  }
  return out
}

/**
 * Strip `user:pass@` userinfo out of a string before it is echoed back to the
 * user (an argv token, an error message). Anything without that shape is
 * returned unchanged.
 *
 * @param text - the text about to be printed.
 * @returns the same text with any `//user:pass@` reduced to `//`.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^\s/@]*@/g, '//')
}

/**
 * Whether an address is a loopback one. The launcher refuses anything else for
 * `--address`: the DevTools port is full control of the browser AND the
 * credentials in its profile, so it is only ever safe on the machine itself
 * (the intended remote path is a loopback-bound reverse tunnel).
 *
 * @param address - the candidate bind address.
 * @returns true for `127.0.0.1`, the rest of `127.0.0.0/8`, `::1`, `localhost`.
 */
export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  return Number(match[1]) === 127
}

/** Prefixes excluded regardless of suffix (`SingletonLock`, `SingletonCookie`, …). */
const PROFILE_COPY_EXCLUDED_PREFIXES = ['Singleton'] as const

/**
 * Whether a profile entry (a file or directory NAME, not a path) is skipped
 * by {@link copyProfile}.
 *
 * @param name - the directory entry's basename.
 * @returns true when the entry is never copied.
 */
export function profileCopyExcluded(name: string): boolean {
  if (PROFILE_COPY_EXCLUDED_PREFIXES.some(prefix => name.startsWith(prefix))) return true
  return (PROFILE_COPY_EXCLUDES as readonly string[]).includes(name)
}

/** Where the DSH settings file lives (`$DSH_HOME/settings.yaml`). */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = (env.DSH_HOME ?? '').trim()
  const base = dshHome !== '' ? dshHome : join(env.HOME ?? homedir(), '.dsh')
  return join(base, 'settings.yaml')
}

/**
 * Extract the plugin's settings section from a settings YAML text.
 *
 * Deliberately minimal: DSH settings sections are flat key/value maps, so this
 * reads the top-level `<namespace>:` line and the indented `key: value` pairs
 * under it, strips comments and one layer of quotes, and stops at the next
 * top-level key. Nested maps inside the section are not modeled (this plugin
 * has none) and are skipped.
 *
 * A DOUBLE-quoted value is unescaped the way YAML spells the handful of
 * characters that must be escaped (`\\`, `\"`, `\n`, `\t`, `\r`); a
 * single-quoted value is taken literally (YAML semantics). That matters for a
 * proxy password containing a backslash or a quote: without it the launcher
 * would dial a different password than the plugin does.
 *
 * @param text - the settings file contents.
 * @param namespace - the section to read (defaults to this plugin's).
 * @returns the section's key/value pairs, all as strings.
 */
export function parseSettingsSection(text: string, namespace: string = LAUNCHER_SETTINGS_NAMESPACE): Record<string, string> {
  const settings: Record<string, string> = {}
  let inSection = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    if (indent === 0) {
      inSection = line === `${namespace}:` || line.startsWith(`${namespace}: `)
      continue
    }
    if (!inSection) continue
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    const raw = (match[2] ?? '').trim()
    let value = raw
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      // Double-quoted: undo the escapes a YAML writer emits, so a password
      // with a quote/backslash/tab survives the round trip.
      value = unescapeDoubleQuoted(raw.slice(1, -1))
    } else if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1)
    } else {
      value = raw.replace(/\s+#.*$/, '').trim()
    }
    if (key !== '') settings[key] = value
  }
  return settings
}

/**
 * Read this plugin's settings section from disk. A missing or unreadable file
 * is NOT an error — the launcher then runs on flags and defaults alone — but
 * it is reported so `--dry-run` can say where nothing was found.
 *
 * @param file - the settings file path.
 * @param namespace - the section to read.
 * @returns the section's settings plus the provenance the CLI prints.
 */
export function readSettingsSection(file: string, namespace: string = LAUNCHER_SETTINGS_NAMESPACE): { settings: Record<string, string>; path: string; found: boolean } {
  try {
    const text = readFileSync(file, 'utf8')
    return { settings: parseSettingsSection(text, namespace), path: file, found: true }
  } catch {
    // The launcher stays usable without a settings file (flags + defaults);
    // an unreadable one is reported as "not found" so nothing pretends to
    // have read values that were never there.
    return { settings: {}, path: file, found: false }
  }
}

/** Flags the launcher accepts on the command line. */
export interface LauncherFlags {
  /** `--help`: print usage and exit. */
  help: boolean
  /** `--dry-run`: print the command instead of running it. */
  dryRun: boolean
  /** `--no-copy`: use `--user-data-dir` as-is, without copying a profile. */
  copyProfile: boolean
  /**
   * `--force`: overwrite an EXISTING copy target. Without it, a re-run into a
   * directory that already exists is refused — the target is a snapshot of
   * real profile data, and silently merging into it is never what was meant.
   */
  force: boolean
  /** `--browser <path>`: the Chromium-family executable to run. */
  browser?: string
  /** `--profile <dir>`: the REAL profile to copy from. */
  profile?: string
  /** `--user-data-dir <dir>`: the (copy) profile the browser opens. */
  userDataDir?: string
  /** `--proxy <server>`: overrides the settings' `proxyServer`. */
  proxyServer?: string
  /** `--proxy-bypass <list>`: overrides the settings' `proxyBypass`. */
  proxyBypass?: string
  /** `--launch-args <string>`: overrides the settings' `launchArgs`. */
  launchArgs?: string
  /** `--headless` / `--headful`: overrides the settings' `headless`. */
  headless?: boolean
  /** `--port <n>`: the DevTools port (default 9222). */
  port?: number
  /** `--address <ip>`: the DevTools bind address (default 127.0.0.1). */
  address?: string
  /** `--settings <file>`: an alternative settings.yaml. */
  settingsFile?: string
}

/** The `--help` text (kept next to the flags it documents). */
export function launcherUsage(): string {
  return [
    'dsh-web-fetch-launch — start a local browser for the CDP/tunnel topology',
    '',
    'Usage: dsh-web-fetch-launch [options]',
    '',
    'Options:',
    '  --dry-run                 print the command instead of running it',
    '  --browser <path>          Chromium-family executable to launch',
    '  --profile <dir>           real profile to copy (default: the OS Chrome profile)',
    '  --user-data-dir <dir>     profile the browser opens (the copy target)',
    '  --no-copy                 do not copy a profile; use --user-data-dir as-is',
    '  --force                   overwrite an existing copy target (refused by default)',
    '  --proxy <server>          proxy server (default: the settings card value)',
    '  --proxy-bypass <list>     comma-separated bypass list',
    '  --launch-args <string>    extra browser arguments (shell-style quoting)',
    '  --headless | --headful    run without / with a window',
    `  --port <n>                DevTools port (default ${String(LAUNCHER_CDP_PORT)})`,
    `  --address <ip>            DevTools bind address (default ${LAUNCHER_CDP_ADDRESS})`,
    '  --settings <file>         alternative settings.yaml',
    '  --help                    this text',
    '',
    'Notes:',
    `  --address only accepts a loopback value (${LAUNCHER_CDP_ADDRESS}, ::1, localhost):`,
    '  the DevTools port is full control of the browser AND the credentials in its',
    '  profile, so it is never bound anywhere else.',
    '  Proxy credentials from the settings card are NOT sent: a Chromium command',
    '  line cannot carry them. Use an auth-free local proxy instead (e.g.',
    '  `ssh -D 1080 user@host` with --proxy socks5://127.0.0.1:1080), or answer the',
    '  authentication once in a headful browser.',
    '',
    'The plugin then attaches over the tunnel endpoint (see the README):',
    `  ${TUNNEL_HINT}`,
  ].join('\n')
}

/**
 * Parse the launcher's argv. Unknown flags and missing values throw with the
 * usage text, so a typo is a message rather than a silently ignored argument.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed flags.
 * @throws {Error} on an unknown flag, a missing value, or a bad number.
 */
export function parseLauncherArgs(argv: readonly string[]): LauncherFlags {
  const flags: LauncherFlags = { help: false, dryRun: false, copyProfile: true, force: false }
  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n\n${launcherUsage()}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] ?? ''
    const inline = /^--([A-Za-z-]+)=(.*)$/.exec(flag)
    const name = inline !== null ? `--${inline[1] ?? ''}` : flag
    const take = (): string => inline !== null ? (inline[2] ?? '') : nextValue(index, name)
    switch (name) {
      case '--help': case '-h': flags.help = true; break
      case '--dry-run': flags.dryRun = true; break
      case '--no-copy': flags.copyProfile = false; break
      case '--force': flags.force = true; break
      case '--headless': flags.headless = true; break
      case '--headful': case '--no-headless': flags.headless = false; break
      case '--browser': flags.browser = take(); break
      case '--profile': flags.profile = take(); break
      case '--user-data-dir': flags.userDataDir = take(); break
      case '--proxy': flags.proxyServer = take(); break
      case '--proxy-bypass': flags.proxyBypass = take(); break
      case '--launch-args': flags.launchArgs = take(); break
      case '--settings': flags.settingsFile = take(); break
      case '--address': flags.address = take(); break
      case '--port': {
        const value = take()
        if (!/^\d+$/.test(value)) throw new Error(`--port needs a port number, got "${scrubCredentials(value)}"\n\n${launcherUsage()}`)
        flags.port = Number(value)
        break
      }
      default:
        // The flag itself may carry a proxy address WITH credentials (a
        // typo'd `--proxyy=http://user:pass@host:1080` is the obvious case):
        // never echo them back into a terminal or a log.
        throw new Error(`unknown option ${scrubCredentials(flag)}\n\n${launcherUsage()}`)
    }
    if (inline === null && /^--(browser|profile|user-data-dir|proxy|proxy-bypass|launch-args|settings|address|port)$/.test(name)) index++
  }
  return flags
}

/**
 * The first Chromium-family executable on `$PATH` (or, on macOS, the app-bundle
 * binary). The filesystem probe is local and dependency-free so the search is
 * unit-testable through the returned path string.
 *
 * @param env - environment supplying `PATH`.
 * @param candidates - bare names probed on `$PATH`.
 * @param platform - the platform to probe for.
 * @returns the executable path, or undefined when nothing was found.
 */
export function findBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = BROWSER_CANDIDATES,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const probe = (path: string): boolean => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  if (platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    if (probe(macPath)) return macPath
    const macChromium = '/Applications/Chromium.app/Contents/MacOS/Chromium'
    if (probe(macChromium)) return macChromium
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of candidates) {
      const candidate = join(dir, name)
      if (probe(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Where the user's REAL Chrome profile probably lives on this platform, most
 * likely first. Nothing is assumed to exist: the caller probes.
 *
 * @param env - environment supplying `HOME`/`LOCALAPPDATA`.
 * @param platform - the platform to compute for (`process.platform` by default).
 * @returns absolute candidate directories.
 */
export function defaultProfileCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME ?? homedir()
  // Platform-specific joins: a Windows candidate must come out with Windows
  // separators even when the computation happens on a POSIX host (and vice
  // versa), so the list can be asserted anywhere.
  const path = platform === 'win32' ? win32 : posix
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome'),
      path.join(home, 'Library/Application Support/Chromium'),
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
    ]
  }
  return [
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/chromium-browser'),
  ]
}

/** The resolved launcher plan: everything the command needs, and its provenance. */
export interface LauncherPlan {
  /** Browser executable to run. */
  executable: string
  /** Full argv (see {@link buildCdpLaunchArgs}). */
  args: string[]
  /** The profile directory the browser opens (the copy target by default). */
  userDataDir: string
  /** Whether the launched browser runs without a window. */
  headless: boolean
  /** The real profile to copy from, when a copy runs. */
  profileSource?: string
  /** Whether the profile copy runs before the spawn. */
  copyProfile: boolean
  /** The CDP endpoint this browser will expose (for the tunnel example). */
  endpoint: string
  /** The copy-pasteable command line. */
  command: string
  /** One line per resolved decision, for `--dry-run` output. */
  notes: string[]
  /**
   * Things the user must know BEFORE trusting this launch — printed by the
   * CLI as `warning:` lines. Currently: settings that silently cannot reach
   * the launched browser.
   */
  warnings: string[]
}

/**
 * Compose the plan from flags, the settings section, and the environment.
 * Precedence: explicit flag > settings section > built-in default.
 *
 * @param flags - parsed command-line flags.
 * @param settings - this plugin's settings section (strings; may be empty).
 * @param env - environment for defaults and discovery.
 * @returns the launcher plan.
 * @throws {Error} with a readable message when a value is unusable (no browser
 *   found, an invalid proxy, a bad profile directory).
 */
export function planLauncher(
  flags: LauncherFlags,
  settings: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): LauncherPlan {
  const notes: string[] = []
  const warnings: string[] = []
  /** Flag wins over the settings section; both absent = undefined (default). */
  const pick = (flagValue: string | undefined, settingKey: string, label: string): string | undefined => {
    if (flagValue !== undefined && flagValue !== '') {
      notes.push(`${label}: command-line flag`)
      return flagValue
    }
    const raw = settings[settingKey]
    if (raw !== undefined && raw !== '') {
      notes.push(`${label}: settings card (${settingKey})`)
      return raw
    }
    notes.push(`${label}: built-in default`)
    return undefined
  }

  const executable = pick(flags.browser, 'browser', 'browser') ?? findBrowserExecutable(env)
  if (executable === undefined) {
    throw new Error('no Chromium-family browser found on $PATH; pass --browser <path> (e.g. /usr/bin/google-chrome)')
  }

  // Absent/blank settings read as the schema default (true), exactly like the
  // provider's effectiveHeadless.
  const headless = flags.headless
    ?? (settings.headless === undefined || settings.headless === '' ? true : settings.headless !== 'false')

  const proxyRaw = pick(flags.proxyServer, 'proxyServer', 'proxy-server')
  // Same normalizer as the provider: `host:port` gains `http://`, and an
  // unusable value fails here with the same reasoning the fetch would use.
  const proxyServer = proxyRaw === undefined ? undefined : normalizeProxyServer(proxyRaw)
  const proxyBypass = pick(flags.proxyBypass, 'proxyBypass', 'proxy-bypass')
  const launchArgs = pick(flags.launchArgs, 'launchArgs', 'launch-args')

  // The DevTools port is full control of the browser AND the credentials in
  // its profile: never bind it off-loopback. The supported remote path is a
  // loopback-bound reverse tunnel (see the README), so this is a hard refusal
  // rather than a warning.
  if (flags.address !== undefined && !isLoopbackAddress(flags.address)) {
    throw new Error(
      `--address ${flags.address} is not a loopback address: the DevTools port grants full control of this browser and access to the logins in its profile, so binding it to a network interface would expose both. `
      + `Use the default ${LAUNCHER_CDP_ADDRESS} and reach it over a reverse tunnel (${TUNNEL_HINT}).`,
    )
  }

  // A Chromium command line has no place to put proxy credentials, so the
  // settings' username/password cannot reach the launched browser — say so
  // instead of letting the user believe authentication is configured.
  const proxyUsername = (settings.proxyUsername ?? '').trim()
  const proxyPassword = settings.proxyPassword ?? ''
  if (proxyServer !== undefined && (proxyUsername !== '' || proxyPassword !== '')) {
    warnings.push(
      'proxyUsername/proxyPassword are set in the settings card but are NOT sent to the browser: a Chromium command line cannot carry proxy credentials. '
      + 'If the proxy requires authentication, use an auth-free local hop instead (e.g. `ssh -D 1080 user@host` with --proxy socks5://127.0.0.1:1080, or an IP allowlist on the proxy), '
      + 'or answer the authentication once in a headful browser.',
    )
  }

  const copyProfile = flags.copyProfile
  const configuredDir = settings.userDataDir
  const userDataDir = flags.userDataDir
    ?? (configuredDir !== undefined && configuredDir !== '' ? configuredDir : join(dshHome(env), 'chrome-dsh-profile'))
  notes.push(flags.userDataDir !== undefined
    ? 'user-data-dir: command-line flag'
    : configuredDir !== undefined && configuredDir !== ''
      ? 'user-data-dir: settings card (userDataDir)'
      : `user-data-dir: built-in default (${join(dshHome(env), 'chrome-dsh-profile')})`)

  let profileSource = flags.profile
  if (copyProfile && profileSource === undefined) {
    profileSource = defaultProfileCandidates(env).find(candidate => {
      try {
        return statSync(candidate).isDirectory()
      } catch {
        return false
      }
    })
  }
  if (!copyProfile) notes.push('profile copy: disabled (--no-copy)')
  else if (profileSource === undefined) notes.push('profile copy: SKIPPED (no live profile found; pass --profile <dir> to copy one)')
  else notes.push(flags.profile !== undefined ? 'profile source: command-line flag' : 'profile source: detected OS profile')

  const args = buildCdpLaunchArgs({
    userDataDir,
    headless,
    ...(proxyServer === undefined ? {} : { proxyServer }),
    ...(proxyBypass === undefined ? {} : { proxyBypassList: proxyBypass }),
    ...(launchArgs === undefined ? {} : { launchArgs }),
    ...(flags.port === undefined ? {} : { port: flags.port }),
    ...(flags.address === undefined ? {} : { address: flags.address }),
  })
  const port = flags.port ?? LAUNCHER_CDP_PORT
  const address = flags.address ?? LAUNCHER_CDP_ADDRESS
  return {
    executable,
    args,
    userDataDir,
    headless,
    warnings,
    ...(profileSource === undefined ? {} : { profileSource }),
    copyProfile: copyProfile && profileSource !== undefined,
    endpoint: `${address}:${String(port)}`,
    command: renderCommand(executable, args),
    notes,
  }
}

/** `$DSH_HOME`, or `~/.dsh` when it is not set. */
function dshHome(env: NodeJS.ProcessEnv): string {
  const configured = (env.DSH_HOME ?? '').trim()
  return configured !== '' ? configured : join(env.HOME ?? homedir(), '.dsh')
}

/**
 * Whether a profile directory is currently held by a running browser: Chromium
 * puts a `SingletonLock` symlink there and removes it on exit. Probed with
 * `lstatSync`, not `statSync`: the link points at `<hostname>-<pid>`, which
 * does not exist as a file, so following it would always miss a real lock.
 *
 * @param dir - the profile directory to probe.
 * @returns true when a live browser appears to own that directory.
 */
export function isProfileInUse(dir: string): boolean {
  try {
    lstatSync(join(dir, 'SingletonLock'))
    return true
  } catch {
    return false
  }
}

/** What a profile copy did, for the launcher's output. */
export interface ProfileCopyReport {
  /** The copied-from directory. */
  source: string
  /** The copied-to directory. */
  destination: string
  /** True when the SOURCE looked like a live browser's profile (inconsistent snapshot). */
  sourceInUse: boolean
}

/**
 * Copy a real Chrome profile into a throwaway directory the launched browser
 * can own: skip {@link profileCopyExcluded} entries, refuse a destination that
 * is currently in use, and translate filesystem failures into a readable
 * message.
 *
 * @param source - the live profile directory to copy from.
 * @param destination - the directory to create/populate.
 * @param options - the copy must be asked for: an existing destination is
 *   refused unless `force: true` (the destination is a snapshot of real profile
 *   data, and silently merging into it is never what was meant).
 * @returns the copy report.
 * @throws {Error} when the destination is in use, when it already exists and
 *   `force` is not true, or when any filesystem step fails.
 */
export function copyProfile(source: string, destination: string, options: { force?: boolean } = {}): ProfileCopyReport {
  try {
    if (!statSync(source).isDirectory()) throw new Error(`${source} is not a directory`)
  } catch (error: unknown) {
    throw new Error(`cannot copy the profile: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (isProfileInUse(destination)) {
    throw new Error(`the target profile ${destination} is in use: a browser is running on it (SingletonLock is present). Close that browser, pick another --user-data-dir, or delete the directory.`)
  }
  if (options.force !== true && existsSync(destination)) {
    throw new Error(`the target profile ${destination} already exists; pass --force to overwrite it (or --user-data-dir to copy somewhere else)`)
  }
  const sourceInUse = isProfileInUse(source)
  try {
    cpSync(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      filter: (from) => {
        const name = from.split(/[\\/]/).pop() ?? ''
        return !profileCopyExcluded(name)
      },
    })
  } catch (error: unknown) {
    throw new Error(`copying the profile from ${source} to ${destination} failed: ${error instanceof Error ? error.message : String(error)}. Check the permissions of both directories, and close the source browser (a live profile copies inconsistently).`)
  }
  return { source, destination, sourceInUse }
}
