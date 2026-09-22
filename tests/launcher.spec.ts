/**
 * The local launcher: argument shaping (the same builder the card preview
 * uses), the settings-section reader, browser/profile discovery, the profile
 * copy with its exclusion and in-use rules, and the plan precedence
 * (flag > settings card > default).
 *
 * Filesystem-touching cases run in a throwaway temp directory; nothing here
 * launches a browser.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCdpLaunchArgs, LAUNCHER_CDP_ADDRESS, LAUNCHER_CDP_PORT, mergeProxyBypass, parseLaunchArgs, renderCommand } from '../src/launch-args.ts'
import type { LauncherFlags } from '../src/launcher.ts'
import {
  copyProfile,
  defaultProfileCandidates,
  findBrowserExecutable,
  isProfileInUse,
  launcherUsage,
  parseLauncherArgs,
  parseSettingsSection,
  planLauncher,
  PROFILE_COPY_EXCLUDES,
  profileCopyExcluded,
  isLoopbackAddress,
  readSettingsSection,
  resolveSettingsPath,
  scrubCredentials,
} from '../src/launcher.ts'
import { launcherPreview } from '../src/client/command.ts'

describe('parseLaunchArgs', () => {
  it('reads a blank setting as no arguments', () => {
    expect(parseLaunchArgs('')).toEqual([])
    expect(parseLaunchArgs('   ')).toEqual([])
  })

  it('splits on whitespace', () => {
    expect(parseLaunchArgs('--lang=zh-CN --disable-gpu')).toEqual(['--lang=zh-CN', '--disable-gpu'])
    expect(parseLaunchArgs('  --a=1\t--b=2\n--c=3 ')).toEqual(['--a=1', '--b=2', '--c=3'])
  })

  it('keeps quoted values (including spaces) as one argument', () => {
    expect(parseLaunchArgs('--user-agent="a b" --flag'))
      .toEqual(['--user-agent=a b', '--flag'])
    expect(parseLaunchArgs("--name='a b' --flag")).toEqual(['--name=a b', '--flag'])
    expect(parseLaunchArgs('--empty="" --after')).toEqual(['--empty=', '--after'])
  })

  it('honours backslash escapes outside quotes and inside double quotes', () => {
    expect(parseLaunchArgs('--path=/a\\ b')).toEqual(['--path=/a b'])
    expect(parseLaunchArgs('--q="a\\"b"')).toEqual(['--q=a"b'])
  })
})

describe('buildCdpLaunchArgs', () => {
  it('always pins the loopback debugging endpoint and the profile', () => {
    expect(buildCdpLaunchArgs({ userDataDir: '/data/copy', headless: true })).toEqual([
      `--remote-debugging-port=${String(LAUNCHER_CDP_PORT)}`,
      `--remote-debugging-address=${LAUNCHER_CDP_ADDRESS}`,
      '--user-data-dir=/data/copy',
      '--headless=new',
    ])
    expect(LAUNCHER_CDP_PORT).toBe(9222)
    expect(LAUNCHER_CDP_ADDRESS).toBe('127.0.0.1')
  })

  it('omits --headless=new when the browser should show a window', () => {
    expect(buildCdpLaunchArgs({ userDataDir: '/p', headless: false }))
      .not.toContain('--headless=new')
  })

  it('carries the proxy and re-joins the bypass list with semicolons', () => {
    const args = buildCdpLaunchArgs({
      userDataDir: '/p',
      headless: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassList: '*.corp',
    })
    expect(args).toContain('--proxy-server=http://127.0.0.1:7890')
    // Chromium splits --proxy-bypass-list on semicolons; the settings field
    // (and Playwright's proxy.bypass) uses commas, and loopback is merged in.
    expect(args).toContain('--proxy-bypass-list=*.corp;127.0.0.1;localhost;::1')
    expect(args.join(' ')).not.toContain('proxy-bypass-list=*.corp,')
  })

  it('adds no proxy flags at all when no proxy is configured', () => {
    const args = buildCdpLaunchArgs({ userDataDir: '/p', headless: false })
    expect(args.some(arg => arg.startsWith('--proxy-'))).toBe(false)
  })

  it('appends the extra arguments last, and honours port/address overrides', () => {
    const args = buildCdpLaunchArgs({
      userDataDir: '/p',
      headless: false,
      launchArgs: '--lang=zh-CN --disable-gpu',
      port: 9333,
      address: '0.0.0.0',
    })
    expect(args.slice(-2)).toEqual(['--lang=zh-CN', '--disable-gpu'])
    expect(args).toContain('--remote-debugging-port=9333')
    expect(args).toContain('--remote-debugging-address=0.0.0.0')
  })
})

describe('renderCommand', () => {
  it('leaves shell-safe tokens bare and quotes the rest', () => {
    expect(renderCommand('google-chrome', ['--headless=new', '--user-data-dir=/data/p']))
      .toBe('google-chrome --headless=new --user-data-dir=/data/p')
    expect(renderCommand('/opt/My Browser/chrome', ['--user-data-dir=/a b']))
      .toBe("'/opt/My Browser/chrome' '--user-data-dir=/a b'")
  })

  it('escapes embedded single quotes', () => {
    expect(renderCommand('chrome', ["--name=a'b"])).toBe("chrome '--name=a'\\''b'")
  })
})

describe('profileCopyExcluded', () => {
  it('excludes the live-browser locks by prefix', () => {
    expect(profileCopyExcluded('SingletonLock')).toBe(true)
    expect(profileCopyExcluded('SingletonCookie')).toBe(true)
    expect(profileCopyExcluded('SingletonSocket')).toBe(true)
    expect(profileCopyExcluded('SingletonXYZ')).toBe(true)
  })

  it('excludes the heavy caches and crash droppings', () => {
    for (const name of ['Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'Crashpad']) {
      expect(profileCopyExcluded(name), name).toBe(true)
    }
    expect(PROFILE_COPY_EXCLUDES).toContain('Service Worker')
    expect(PROFILE_COPY_EXCLUDES).toContain('Cache')
    expect(PROFILE_COPY_EXCLUDES).toContain('Code Cache')
  })

  it('keeps what makes the copy useful', () => {
    for (const name of ['Default', 'Cookies', 'Login Data', 'Local Storage', 'Preferences', 'Extensions']) {
      expect(profileCopyExcluded(name), name).toBe(false)
    }
  })
})

describe('parseSettingsSection', () => {
  const SETTINGS = `# DSH settings
web:
  fetchProvider: playwright
web-fetch-playwright:
  backend: managed
  headless: false
  userDataDir: "/data/chrome profile"
  launchArgs: '--lang=zh-CN'
  proxyServer: http://127.0.0.1:7890   # the local hop
  proxyBypass: ""
  unknownKey: ignored
other-section:
  backend: cdp
`

  it('reads only the requested section, as plain strings', () => {
    expect(parseSettingsSection(SETTINGS)).toEqual({
      backend: 'managed',
      headless: 'false',
      userDataDir: '/data/chrome profile',
      launchArgs: '--lang=zh-CN',
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '',
      unknownKey: 'ignored',
    })
  })

  it('stops at the next top-level section', () => {
    expect(parseSettingsSection(SETTINGS).backend).toBe('managed')
    expect(parseSettingsSection(SETTINGS, 'other-section')).toEqual({ backend: 'cdp' })
  })

  it('returns nothing for a section that is absent or misnamed', () => {
    expect(parseSettingsSection('web:\n  x: 1\n', 'web-fetch-playwright')).toEqual({})
    expect(parseSettingsSection('', 'web-fetch-playwright')).toEqual({})
  })

  it('ignores comments and blank lines inside the section', () => {
    const text = 'web-fetch-playwright:\n  # a comment\n\n  headless: true\n'
    expect(parseSettingsSection(text)).toEqual({ headless: 'true' })
  })
})

describe('resolveSettingsPath / readSettingsSection', () => {
  it('prefers $DSH_HOME, else ~/.dsh', () => {
    expect(resolveSettingsPath({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh/settings.yaml')
    expect(resolveSettingsPath({ HOME: '/home/u' })).toBe('/home/u/.dsh/settings.yaml')
  })

  it('reports a missing file instead of failing the launcher', () => {
    const report = readSettingsSection(join(tmpdir(), 'definitely-not-here-settings.yaml'))
    expect(report.found).toBe(false)
    expect(report.settings).toEqual({})
  })

  it('reads a real file and labels its provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-settings-'))
    try {
      const file = join(dir, 'settings.yaml')
      writeFileSync(file, 'web-fetch-playwright:\n  headless: false\n')
      const report = readSettingsSection(file)
      expect(report).toMatchObject({ found: true, path: file })
      expect(report.settings.headless).toBe('false')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('findBrowserExecutable', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-path-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('finds the first candidate on $PATH', () => {
    const second = join(dir, 'second')
    mkdirSync(second)
    writeFileSync(join(second, 'chromium'), '#!/bin/sh\n')
    expect(findBrowserExecutable({ PATH: `${join(dir, 'missing')}:${second}` }, ['google-chrome', 'chromium'], 'linux'))
      .toBe(join(second, 'chromium'))
  })

  it('returns undefined when nothing matches', () => {
    expect(findBrowserExecutable({ PATH: dir }, ['google-chrome'], 'linux')).toBeUndefined()
    expect(findBrowserExecutable({ PATH: '' }, ['google-chrome'], 'linux')).toBeUndefined()
  })
})

describe('defaultProfileCandidates', () => {
  it('lists the OS-native profile locations, most likely first', () => {
    expect(defaultProfileCandidates({ HOME: '/home/u' }, 'linux')[0]).toBe('/home/u/.config/google-chrome')
    expect(defaultProfileCandidates({ HOME: '/Users/u' }, 'darwin')[0])
      .toBe('/Users/u/Library/Application Support/Google/Chrome')
    expect(defaultProfileCandidates({ HOME: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32')[0])
      .toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data')
  })
})

/** The launcher flags a test starts from (everything off/default). */
function flags(over: Partial<LauncherFlags> = {}): LauncherFlags {
  return { help: false, dryRun: false, copyProfile: true, force: false, ...over }
}

describe('planLauncher', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-plan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** A temp environment with a fake browser and a fake source profile. */
  function envWithBrowser(): { env: NodeJS.ProcessEnv; browser: string; profile: string } {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const browser = join(bin, 'google-chrome')
    writeFileSync(browser, '#!/bin/sh\n')
    const profile = join(dir, 'real-profile')
    mkdirSync(profile)
    return { env: { PATH: bin, DSH_HOME: join(dir, 'dsh') }, browser, profile }
  }

  it('turns the settings card into the launcher command', () => {
    const { env, browser, profile } = envWithBrowser()
    const plan = planLauncher(
      flags({ dryRun: true, profile }),
      {
        headless: 'false',
        userDataDir: join(dir, 'copy'),
        launchArgs: '--lang=zh-CN',
        proxyServer: '127.0.0.1:7890',
        proxyBypass: '*.corp',
      },
      env,
    )
    expect(plan.executable).toBe(browser)
    expect(plan.userDataDir).toBe(join(dir, 'copy'))
    expect(plan.headless).toBe(false)
    expect(plan.profileSource).toBe(profile)
    expect(plan.copyProfile).toBe(true)
    expect(plan.endpoint).toBe('127.0.0.1:9222')
    expect(plan.args).toEqual([
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${join(dir, 'copy')}`,
      '--proxy-server=http://127.0.0.1:7890',
      `--proxy-bypass-list=*.corp;${mergeProxyBypass('').split(',').join(';')}`,
      '--lang=zh-CN',
    ])
    expect(plan.command).toBe(renderCommand(browser, plan.args))
    expect(plan.notes.join('\n')).toContain('settings card')
  })

  it('lets a flag win over the settings card', () => {
    const { env, profile } = envWithBrowser()
    const plan = planLauncher(
      flags({ dryRun: true, profile, proxyServer: 'socks5://127.0.0.1:1080', headless: true, userDataDir: join(dir, 'flag-copy') }),
      { headless: 'false', userDataDir: join(dir, 'setting-copy'), proxyServer: 'http://127.0.0.1:7890' },
      env,
    )
    expect(plan.userDataDir).toBe(join(dir, 'flag-copy'))
    expect(plan.headless).toBe(true)
    expect(plan.args).toContain('--proxy-server=socks5://127.0.0.1:1080')
    expect(plan.notes).toContain('proxy-server: command-line flag')
  })

  it('defaults the copy target under $DSH_HOME and skips the copy without a source profile', () => {
    const { env } = envWithBrowser()
    const plan = planLauncher(flags({ dryRun: true }), { headless: 'true' }, env)
    expect(plan.userDataDir).toBe(join(dir, 'dsh', 'chrome-dsh-profile'))
    expect(plan.copyProfile).toBe(false)
    expect(plan.args).toContain('--headless=new')
    expect(plan.notes.join('\n')).toContain('SKIPPED')
  })

  it('honours --no-copy: the profile directory is used as-is', () => {
    const { env } = envWithBrowser()
    const plan = planLauncher(flags({ dryRun: true, copyProfile: false, userDataDir: join(dir, 'keep') }), {}, env)
    expect(plan.copyProfile).toBe(false)
    expect(plan.profileSource).toBeUndefined()
    expect(plan.userDataDir).toBe(join(dir, 'keep'))
    expect(plan.notes.join('\n')).toContain('--no-copy')
  })

  it('fails readably when no browser exists and when the proxy value is unusable', () => {
    const empty = { PATH: join(dir, 'nothing'), DSH_HOME: dir }
    expect(() => planLauncher(flags({ dryRun: true, copyProfile: false }), {}, empty))
      .toThrow(/no Chromium-family browser found/)

    const { env } = envWithBrowser()
    expect(() => planLauncher(flags({ dryRun: true, copyProfile: false, proxyServer: 'ftp://proxy:21' }), {}, env))
      .toThrow(/scheme/i)
  })
})

describe('parseLauncherArgs', () => {
  it('parses the documented flags, with and without =', () => {
    const flags = parseLauncherArgs([
      '--dry-run', '--headless', '--browser=/usr/bin/chromium', '--profile', '/real',
      '--user-data-dir=/copy', '--proxy', 'http://127.0.0.1:7890', '--proxy-bypass', '*.corp',
      '--launch-args=--lang=zh-CN', '--port', '9333', '--address', '0.0.0.0', '--settings', '/tmp/s.yaml',
    ])
    expect(flags).toEqual({
      help: false,
      dryRun: true,
      copyProfile: true,
      force: false,
      headless: true,
      browser: '/usr/bin/chromium',
      profile: '/real',
      userDataDir: '/copy',
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '*.corp',
      launchArgs: '--lang=zh-CN',
      port: 9333,
      address: '0.0.0.0',
      settingsFile: '/tmp/s.yaml',
    })
  })

  it('supports --headful, --no-headless, --no-copy, and --help', () => {
    expect(parseLauncherArgs(['--headful']).headless).toBe(false)
    expect(parseLauncherArgs(['--no-headless']).headless).toBe(false)
    expect(parseLauncherArgs(['--no-copy']).copyProfile).toBe(false)
    expect(parseLauncherArgs(['--help']).help).toBe(true)
    expect(launcherUsage()).toContain('--dry-run')
  })

  it('rejects unknown flags, missing values, and bad ports with the usage text', () => {
    expect(() => parseLauncherArgs(['--nope'])).toThrow(/unknown option --nope/)
    expect(() => parseLauncherArgs(['--proxy'])).toThrow(/needs a value/)
    expect(() => parseLauncherArgs(['--port', 'eighty'])).toThrow(/port number/)
  })
})

describe('profile copy', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-launcher-copy-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A miniature Chrome profile with the entries the rules care about. */
  function makeProfile(dir: string): void {
    mkdirSync(join(dir, 'Default', 'Local Storage'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Cookies'), 'cookie-db')
    writeFileSync(join(dir, 'Default', 'Preferences'), '{}')
    writeFileSync(join(dir, 'Local State'), '{}')
    mkdirSync(join(dir, 'Default', 'Cache'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Cache', 'data_0'), 'cache-blob')
    mkdirSync(join(dir, 'Default', 'Code Cache'), { recursive: true })
    mkdirSync(join(dir, 'Default', 'Service Worker'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Service Worker', 'sw'), 'x')
    mkdirSync(join(dir, 'Crashpad'), { recursive: true })
    mkdirSync(join(dir, 'SingletonLock'), { recursive: true })
    writeFileSync(join(dir, 'SingletonCookie'), '1')
  }

  it('copies the login-bearing entries and skips locks, caches, and crash data', () => {
    const source = join(root, 'src')
    const dest = join(root, 'copy')
    makeProfile(source)
    const report = copyProfile(source, dest)
    expect(report).toMatchObject({ source, destination: dest, sourceInUse: true })

    expect(existsSync(join(dest, 'Default', 'Cookies'))).toBe(true)
    expect(existsSync(join(dest, 'Default', 'Preferences'))).toBe(true)
    expect(existsSync(join(dest, 'Default', 'Local Storage'))).toBe(true)
    expect(existsSync(join(dest, 'Local State'))).toBe(true)

    expect(existsSync(join(dest, 'Default', 'Cache'))).toBe(false)
    expect(existsSync(join(dest, 'Default', 'Code Cache'))).toBe(false)
    expect(existsSync(join(dest, 'Default', 'Service Worker'))).toBe(false)
    expect(existsSync(join(dest, 'Crashpad'))).toBe(false)
    expect(existsSync(join(dest, 'SingletonLock'))).toBe(false)
    expect(existsSync(join(dest, 'SingletonCookie'))).toBe(false)
  })

  it('refuses a destination a browser is running on (SingletonLock present)', () => {
    const source = join(root, 'src')
    const dest = join(root, 'busy')
    makeProfile(source)
    mkdirSync(dest)
    symlinkSync('host-1234', join(dest, 'SingletonLock'))
    expect(isProfileInUse(dest)).toBe(true)
    expect(() => copyProfile(source, dest)).toThrow(/is in use/)
    expect(() => copyProfile(join(root, 'missing'), join(root, 'copy'))).toThrow(/cannot copy the profile/)
  })

  it('refuses to overwrite an existing destination unless force is set', () => {
    const source = join(root, 'src')
    const dest = join(root, 'existing')
    makeProfile(source)
    mkdirSync(dest)
    // Refusing is the DEFAULT: a copy target is a snapshot of real profile
    // data, and silently merging into it is never what was meant.
    expect(() => copyProfile(source, dest)).toThrow(/already exists; pass --force/)
    expect(() => copyProfile(source, dest, { force: false })).toThrow(/already exists; pass --force/)
    expect(() => copyProfile(source, dest, { force: true })).not.toThrow()
    expect(existsSync(join(dest, 'Default', 'Cookies'))).toBe(true)
  })

  it('reports a source that is not a directory', () => {
    const notDir = join(root, 'file')
    writeFileSync(notDir, 'x')
    expect(() => copyProfile(notDir, join(root, 'copy'))).toThrow(/not a directory/)
  })
})

describe('the card preview and the launcher agree', () => {
  it('renders exactly the launcher arguments the host would build', () => {
    const input = {
      userDataDir: '/data/copy',
      headless: false,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassList: '*.corp',
      launchArgs: '--lang=zh-CN',
    }
    // The host builder (which bin/launch-browser.mjs runs) …
    const hostCommand = renderCommand('google-chrome', buildCdpLaunchArgs(input))
    // … and the card's read-only preview (same drafts, same function).
    const preview = launcherPreview({
      headless: 'false',
      userDataDir: '/data/copy',
      launchArgs: '--lang=zh-CN',
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '*.corp',
    })
    expect(preview).toBe(hostCommand)
    expect(preview).toContain('--proxy-server=http://127.0.0.1:7890')
    expect(preview).toContain('--proxy-bypass-list=*.corp;127.0.0.1;localhost;::1')
    expect(preview).not.toContain('--headless=new')
  })

  it('marks an unset profile directory and defaults headless on', () => {
    const preview = launcherPreview({ headless: '', userDataDir: '  ', launchArgs: '', proxyServer: '', proxyBypass: '' })
    expect(preview).toContain('--user-data-dir=<user-data-dir>')
    expect(preview).toContain('--headless=new')
    expect(preview).not.toContain('--proxy-server')
  })
})

/** The launcher's CLI contract: argv → planLauncher → copyProfile → spawn. */
describe('launcher CLI contract', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-launcher-cli-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A miniature real profile plus the fake browser the CLI would run. */
  function makeEnv(): { settingsFile: string; profile: string; browser: string; userDataDir: string } {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const browser = join(bin, 'google-chrome')
    writeFileSync(browser, '#!/bin/sh\n')
    const profile = join(root, 'real-profile')
    mkdirSync(join(profile, 'Default'), { recursive: true })
    writeFileSync(join(profile, 'Default', 'Cookies'), 'cookie-db')
    writeFileSync(join(profile, 'Default', 'Preferences'), '{}')
    mkdirSync(join(profile, 'Default', 'Cache'), { recursive: true })
    const settingsFile = join(root, 'settings.yaml')
    writeFileSync(settingsFile, 'web-fetch-playwright:\n  backend: cdp\n  headless: false\n')
    return { settingsFile, profile, browser, userDataDir: join(root, 'copy') }
  }

  /**
   * The exact path `bin/launch-browser.mjs` takes (it is argv → parse → read
   * settings → planLauncher → copyProfile), so the CLI's wiring is what is
   * under test — not just the functions it calls.
   */
  function runCli(argv: string[], env: NodeJS.ProcessEnv): { plan: ReturnType<typeof planLauncher>; report?: ReturnType<typeof copyProfile> } {
    const parsed = parseLauncherArgs(argv)
    const { settings } = readSettingsSection(parsed.settingsFile ?? join(root, 'settings.yaml'))
    const plan = planLauncher(parsed, settings, env)
    const source = plan.profileSource
    const report = plan.copyProfile && source !== undefined
      ? copyProfile(source, plan.userDataDir, { force: parsed.force === true })
      : undefined
    return { plan, report }
  }

  it('(a) refuses an existing target without --force and leaves it untouched', () => {
    const { settingsFile, profile, browser, userDataDir } = makeEnv()
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'bin') }
    // First run populates the copy target.
    const first = runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile], env)
    expect(first.report?.destination).toBe(userDataDir)
    const marker = join(userDataDir, 'Default', 'Cookies')
    expect(readFileSync(marker, 'utf8')).toBe('cookie-db')

    // A second run must refuse, and must not touch what is already there.
    writeFileSync(marker, 'edited-by-hand')
    expect(() => runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile], env))
      .toThrow(/already exists; pass --force/)
    expect(readFileSync(marker, 'utf8')).toBe('edited-by-hand')
  })

  it('(b) overwrites the existing target with --force', () => {
    const { settingsFile, profile, browser, userDataDir } = makeEnv()
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'bin') }
    runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile], env)
    const marker = join(userDataDir, 'Default', 'Cookies')
    writeFileSync(marker, 'edited-by-hand')

    const forced = runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile, '--force'], env)
    expect(forced.report?.destination).toBe(userDataDir)
    expect(readFileSync(marker, 'utf8')).toBe('cookie-db') // re-copied
    expect(parseLauncherArgs(['--force']).force).toBe(true)
    expect(launcherUsage()).toContain('--force')
  })

  it('passes the settings section through the same path the CLI uses', () => {
    const { settingsFile, profile, browser, userDataDir } = makeEnv()
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'bin') }
    const { plan } = runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile], env)
    expect(plan.headless).toBe(false) // from the settings section
    expect(plan.args).toContain('--user-data-dir=' + userDataDir)
    expect(plan.args).not.toContain('--headless=new')
    expect(plan.warnings).toEqual([])
  })

  it('warns that proxy credentials cannot ride the command line', () => {
    const { settingsFile, profile, browser, userDataDir } = makeEnv()
    writeFileSync(settingsFile, [
      'web-fetch-playwright:',
      '  proxyServer: http://127.0.0.1:7890',
      '  proxyUsername: proxyuser',
      '  proxyPassword: "p@ss word"',
      '',
    ].join('\n'))
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'bin') }
    const { plan } = runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile], env)
    expect(plan.args).toContain('--proxy-server=http://127.0.0.1:7890')
    expect(plan.warnings.join('\n')).toContain('proxyUsername/proxyPassword are set')
    expect(plan.warnings.join('\n')).toContain('NOT sent to the browser')
    // The credentials never reach the command line.
    expect(plan.command).not.toContain('proxyuser')
    expect(plan.command).not.toContain('p@ss word')

    // No credentials configured → no warning.
    writeFileSync(settingsFile, 'web-fetch-playwright:\n  proxyServer: http://127.0.0.1:7890\n')
    // --force: the target already exists from the run above.
    expect(runCli(['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile, '--force'], env).plan.warnings).toEqual([])
  })

  it('refuses a non-loopback --address and accepts the loopback spellings', () => {
    const { settingsFile, profile, browser, userDataDir } = makeEnv()
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'bin') }
    const base = ['--browser', browser, '--profile', profile, '--user-data-dir', userDataDir, '--settings', settingsFile]
    expect(() => runCli([...base, '--address', '0.0.0.0'], env)).toThrow(/not a loopback address/)
    expect(() => runCli([...base, '--address', '192.168.1.10'], env)).toThrow(/full control of this browser/)
    for (const address of ['127.0.0.1', '127.0.0.5', '::1', 'localhost']) {
      // --no-copy: these cases only assert the generated flags.
      expect(runCli([...base, '--address', address, '--no-copy'], env).plan.args, address)
        .toContain(`--remote-debugging-address=${address}`)
    }
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.9.9.9')).toBe(true)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
  })

  it('never echoes credentials from argv in an error message', () => {
    // A typo'd flag that carries a credentialed proxy URL is the realistic leak.
    const argv = ['--proxyy=http://user:sup3r-secret@proxy.corp:1080']
    let message = ''
    try {
      parseLauncherArgs(argv)
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('unknown option')
    expect(message).not.toContain('sup3r-secret')
    expect(message).not.toContain('user:')
    expect(scrubCredentials('--x=http://u:p@h:1 trailing')).toBe('--x=http://h:1 trailing')

    let portMessage = ''
    try {
      parseLauncherArgs(['--port', 'http://u:p@h:1'])
    } catch (error: unknown) {
      portMessage = error instanceof Error ? error.message : String(error)
    }
    expect(portMessage).toContain('--port needs a port number')
    expect(portMessage).not.toContain('p@h')
  })

  it('decodes a double-quoted settings value (escapes), leaving single quotes literal', () => {
    // String.raw keeps the settings text byte-for-byte: the `\\`, `\"` and
    // `\t` below are the two-character escapes a YAML writer emits.
    const settings = parseSettingsSection(String.raw`
web-fetch-playwright:
  proxyPassword: "a\\b \"quoted\" tab\tend"
  proxyUsername: 'raw\nnot-decoded'
`)
    // Double-quoted: `\\` → `\`, `\"` → `"`, `\t` → TAB.
    expect(settings.proxyPassword).toBe(String.raw`a\b "quoted" tab` + '\t' + 'end')
    // Single-quoted: taken literally (YAML semantics) — no decoding at all.
    expect(settings.proxyUsername).toBe(String.raw`raw\nnot-decoded`)
  })
})
