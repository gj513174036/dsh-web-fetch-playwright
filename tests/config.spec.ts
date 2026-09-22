/**
 * Config schema defaults, the CDP endpoint normalizer, the outbound-proxy
 * normalizers, the backend-dependent concurrency resolution, and the
 * challenge-wait knobs (pure, network-free).
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  DEFAULT_MAX_CONCURRENCY_MANAGED,
  MANAGED_PROFILE_DIRECTORY,
  MAX_CHALLENGE_RETRIES,
  MAX_CHALLENGE_WAIT_MS,
  MAX_CONCURRENCY_CEILING,
  PROXY_LOOPBACK_BYPASS,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveHeadless,
  effectiveMaxConcurrency,
  effectiveUserDataDir,
  managedLaunchFor,
  managedLaunchKey,
  mergeProxyBypass,
  normalizeCdpEndpoint,
  normalizeProxyServer,
  proxyOptionFor,
  redactProxyServer,
} from '../src/config.ts'

/** The four proxy fields, all blank unless a case overrides one. */
function proxyConfig(over: Partial<Record<'proxyServer' | 'proxyBypass' | 'proxyUsername' | 'proxyPassword', string>> = {}) {
  return { proxyServer: '', proxyBypass: '', proxyUsername: '', proxyPassword: '', ...over }
}

describe('Config', () => {
  it('fills every field default it owns (maxConcurrency stays optional)', () => {
    const resolved = Config({})
    expect(resolved).toEqual({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: DEFAULT_CHALLENGE_WAIT_MS,
      challengeRetries: DEFAULT_CHALLENGE_RETRIES,
      proxyServer: '',
      proxyBypass: '',
      proxyUsername: '',
      proxyPassword: '',
      headless: true,
      userDataDir: '',
      launchArgs: '',
    })
  })

  it('accepts every backend value and rejects anything else', () => {
    expect(Config({ backend: 'local' }).backend).toBe('local')
    expect(Config({ backend: 'cdp' }).backend).toBe('cdp')
    // The DSH-managed persistent browser joins the existing two.
    expect(Config({ backend: 'managed' }).backend).toBe('managed')
    expect(() => Config({ backend: 'managed-persistent' as never })).toThrow()
  })

  it('defaults headless on, the profile directory blank, and no extra args', () => {
    const resolved = Config({})
    expect(resolved.headless).toBe(true)
    expect(resolved.userDataDir).toBe('')
    expect(resolved.launchArgs).toBe('')
  })

  it('accepts a full managed section unchanged', () => {
    const resolved = Config({
      backend: 'managed',
      headless: false,
      userDataDir: '/data/chrome-profile',
      launchArgs: '--lang=zh-CN --disable-gpu',
      proxyServer: '127.0.0.1:7890',
    })
    expect(resolved).toMatchObject({
      backend: 'managed',
      headless: false,
      userDataDir: '/data/chrome-profile',
      launchArgs: '--lang=zh-CN --disable-gpu',
      proxyServer: '127.0.0.1:7890',
    })
  })

  it('accepts a full CDP section unchanged', () => {
    const resolved = Config({
      backend: 'cdp',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '*.internal',
      proxyUsername: 'proxyuser',
      proxyPassword: 's3cret',
    })
    expect(resolved).toEqual({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '*.internal',
      proxyUsername: 'proxyuser',
      proxyPassword: 's3cret',
      headless: true,
      userDataDir: '',
      launchArgs: '',
    })
  })

  it('defaults the four proxy fields to empty strings (empty = a direct connection)', () => {
    const resolved = Config({})
    expect(resolved.proxyServer).toBe('')
    expect(resolved.proxyBypass).toBe('')
    expect(resolved.proxyUsername).toBe('')
    expect(resolved.proxyPassword).toBe('')
  })

  it('accepts maxConcurrency across its whole integer range and rejects outside it', () => {
    expect(Config({ maxConcurrency: 1 }).maxConcurrency).toBe(1)
    expect(Config({ maxConcurrency: MAX_CONCURRENCY_CEILING }).maxConcurrency).toBe(MAX_CONCURRENCY_CEILING)
    expect(() => Config({ maxConcurrency: 0 })).toThrow()
    expect(() => Config({ maxConcurrency: MAX_CONCURRENCY_CEILING + 1 })).toThrow()
    expect(() => Config({ maxConcurrency: 2.5 })).toThrow()
  })

  it('accepts the challenge knobs across their ranges, rejects outside them', () => {
    expect(Config({ challengeWaitMs: 0 }).challengeWaitMs).toBe(0)
    expect(Config({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS }).challengeWaitMs).toBe(MAX_CHALLENGE_WAIT_MS)
    expect(() => Config({ challengeWaitMs: -1 })).toThrow()
    expect(() => Config({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS + 1 })).toThrow()
    expect(Config({ challengeRetries: 0 }).challengeRetries).toBe(0)
    expect(Config({ challengeRetries: MAX_CHALLENGE_RETRIES }).challengeRetries).toBe(MAX_CHALLENGE_RETRIES)
    expect(() => Config({ challengeRetries: -1 })).toThrow()
    expect(() => Config({ challengeRetries: MAX_CHALLENGE_RETRIES + 1 })).toThrow()
  })
})

describe('effective challenge knobs', () => {
  it('an explicit wait wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 0 })).toBe(0)
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 7_500 })).toBe(7_500)
    expect(effectiveChallengeWaitMs({})).toBe(DEFAULT_CHALLENGE_WAIT_MS)
  })

  it('an explicit retry count wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeRetries({ challengeRetries: 0 })).toBe(0)
    expect(effectiveChallengeRetries({ challengeRetries: 3 })).toBe(3)
    expect(effectiveChallengeRetries({})).toBe(DEFAULT_CHALLENGE_RETRIES)
  })
})

describe('effectiveMaxConcurrency', () => {
  it('defaults per backend: local browsers are dear, CDP tabs are cheap', () => {
    expect(effectiveMaxConcurrency({ backend: 'local' })).toBe(DEFAULT_MAX_CONCURRENCY_LOCAL)
    expect(effectiveMaxConcurrency({ backend: 'cdp' })).toBe(DEFAULT_MAX_CONCURRENCY_CDP)
    // The managed backend also keeps ONE browser alive, so its budget is
    // "concurrent tabs" too.
    expect(effectiveMaxConcurrency({ backend: 'managed' })).toBe(DEFAULT_MAX_CONCURRENCY_MANAGED)
    expect(DEFAULT_MAX_CONCURRENCY_MANAGED).toBe(DEFAULT_MAX_CONCURRENCY_CDP)
    expect(DEFAULT_MAX_CONCURRENCY_CDP).toBeGreaterThan(DEFAULT_MAX_CONCURRENCY_LOCAL)
  })

  it('an explicit setting wins over both backend defaults', () => {
    expect(effectiveMaxConcurrency({ backend: 'local', maxConcurrency: 50 })).toBe(50)
    expect(effectiveMaxConcurrency({ backend: 'cdp', maxConcurrency: 2 })).toBe(2)
    expect(effectiveMaxConcurrency({ backend: 'managed', maxConcurrency: 12 })).toBe(12)
  })
})

describe('managed backend resolution', () => {
  const managed = { headless: true, userDataDir: '', launchArgs: '', playwrightPath: '', proxyServer: '', proxyBypass: '', proxyUsername: '', proxyPassword: '' }

  it('headless defaults on and an explicit false wins', () => {
    expect(effectiveHeadless({})).toBe(true)
    expect(effectiveHeadless({ headless: true })).toBe(true)
    expect(effectiveHeadless({ headless: false })).toBe(false)
  })

  it('the profile directory is the configured one, trimmed, else the DSH default', () => {
    expect(effectiveUserDataDir({ userDataDir: ' /data/chrome ' }, {})).toBe('/data/chrome')
    expect(effectiveUserDataDir({ userDataDir: '' }, { DSH_HOME: '/srv/dsh' }))
      .toBe(`/srv/dsh/${MANAGED_PROFILE_DIRECTORY}/profile`)
    expect(effectiveUserDataDir({ userDataDir: '   ' }, { HOME: '/home/u' }))
      .toBe(`/home/u/.dsh/${MANAGED_PROFILE_DIRECTORY}/profile`)
    expect(MANAGED_PROFILE_DIRECTORY).toBe('web-fetch-playwright')
  })

  it('the managed backend always runs in its own persistent profile', () => {
    expect(effectiveContextMode({ backend: 'managed' })).toBe('profile')
    expect(effectiveContextMode({ backend: 'managed', shareBrowserContext: false })).toBe('profile')
    // Unchanged for the other two.
    expect(effectiveContextMode({ backend: 'local' })).toBe('isolated')
    expect(effectiveContextMode({ backend: 'cdp' })).toBe('profile')
  })

  it('assembles the launch descriptor: profile dir, headless, argv, proxy', () => {
    const launch = managedLaunchFor(
      { ...managed, userDataDir: '/data/p', headless: false, launchArgs: '--lang=zh-CN "--user-agent=a b"', playwrightPath: ' /usr/bin/playwright ' },
      { server: 'http://127.0.0.1:7890', bypass: '127.0.0.1,localhost,::1' },
      { DSH_HOME: '/srv/dsh' },
    )
    expect(launch).toEqual({
      userDataDir: '/data/p',
      headless: false,
      args: ['--lang=zh-CN', '--user-agent=a b'],
      playwrightPath: '/usr/bin/playwright',
      proxy: { server: 'http://127.0.0.1:7890', bypass: '127.0.0.1,localhost,::1' },
    })
  })

  it('the launch descriptor is the pool key: any change is a different browser', () => {
    const base = managedLaunchFor({ ...managed, userDataDir: '/data/p' }, undefined, {})
    const same = managedLaunchFor({ ...managed, userDataDir: '/data/p' }, undefined, {})
    expect(managedLaunchKey(same)).toBe(managedLaunchKey(base))

    const changed = [
      managedLaunchFor({ ...managed, userDataDir: '/data/other' }, undefined, {}),
      managedLaunchFor({ ...managed, userDataDir: '/data/p', headless: false }, undefined, {}),
      managedLaunchFor({ ...managed, userDataDir: '/data/p', launchArgs: '--disable-gpu' }, undefined, {}),
      managedLaunchFor({ ...managed, userDataDir: '/data/p', playwrightPath: '/opt/pw' }, undefined, {}),
      managedLaunchFor({ ...managed, userDataDir: '/data/p' }, { server: 'http://127.0.0.1:7890' }, {}),
    ]
    for (const launch of changed) {
      expect(managedLaunchKey(launch)).not.toBe(managedLaunchKey(base))
    }
    // A proxy edit inside the same server changes the key too (bypass).
    const bypassEdited = managedLaunchFor({ ...managed, userDataDir: '/data/p' }, { server: 'http://127.0.0.1:7890', bypass: '*.corp' }, {})
    expect(managedLaunchKey(bypassEdited))
      .not.toBe(managedLaunchKey(managedLaunchFor({ ...managed, userDataDir: '/data/p' }, { server: 'http://127.0.0.1:7890' }, {})))
  })
})

describe('effectiveContextMode', () => {
  it('CDP shares the remote profile by default; an explicit opt-out isolates', () => {
    // Absent value reads as the schema default (true) — the checkbox's
    // "unchecked draft formats as ''" case collapses to the same thing.
    expect(effectiveContextMode({ backend: 'cdp' })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: true })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: false })).toBe('isolated')
  })

  it('the local backend has no shared profile to use — always isolated', () => {
    expect(effectiveContextMode({ backend: 'local' })).toBe('isolated')
    expect(effectiveContextMode({ backend: 'local', shareBrowserContext: true })).toBe('isolated')
  })
})

describe('normalizeCdpEndpoint', () => {
  it('defaults a blank endpoint to the loopback address', () => {
    expect(normalizeCdpEndpoint('')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
    expect(normalizeCdpEndpoint('   ')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
  })

  it('prefixes bare host:port with the http scheme', () => {
    expect(normalizeCdpEndpoint('127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('browser.internal:9222')).toBe('http://browser.internal:9222')
  })

  it('passes http(s)/ws(s) endpoints through', () => {
    expect(normalizeCdpEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('https://browser.corp:9222')).toBe('https://browser.corp:9222')
    expect(normalizeCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc')).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
  })

  it('rejects unparseable values', () => {
    expect(() => normalizeCdpEndpoint('http://')).toThrow()
    expect(() => normalizeCdpEndpoint('://missing-host')).toThrow()
  })
})

describe('normalizeProxyServer', () => {
  it('reads blank (and whitespace-only) as no proxy at all', () => {
    expect(normalizeProxyServer('')).toBeUndefined()
    expect(normalizeProxyServer('   ')).toBeUndefined()
    expect(normalizeProxyServer('\t\n')).toBeUndefined()
  })

  it('prefixes a schemeless host:port with the http scheme Chromium dials', () => {
    expect(normalizeProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyServer('proxy.internal:3128')).toBe('http://proxy.internal:3128')
    expect(normalizeProxyServer('  proxy.internal:3128  ')).toBe('http://proxy.internal:3128')
    // A bare host without a port is still a URL Chromium accepts.
    expect(normalizeProxyServer('localhost')).toBe('http://localhost')
  })

  it('passes http(s)/socks4/socks5 servers through as written', () => {
    expect(normalizeProxyServer('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyServer('https://proxy.corp:8443')).toBe('https://proxy.corp:8443')
    expect(normalizeProxyServer('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxyServer('socks4://127.0.0.1:1080')).toBe('socks4://127.0.0.1:1080')
  })

  it('rejects anything else — including other schemes and hostless values', () => {
    expect(() => normalizeProxyServer('ftp://proxy.corp:21')).toThrow()
    expect(() => normalizeProxyServer('file:///tmp/sock')).toThrow()
    expect(() => normalizeProxyServer('http://')).toThrow()
    expect(() => normalizeProxyServer('socks5://')).toThrow()
    expect(() => normalizeProxyServer('://missing-host')).toThrow()
    expect(() => normalizeProxyServer('not a url')).toThrow()
    expect(() => normalizeProxyServer('ftp://')).toThrow(/scheme/i)
  })

  it('never echoes the value in its rejection messages (the field may carry credentials)', () => {
    // The settings field accepts `http://user:pass@host:port`, so a rejection
    // message must not be able to print the password back.
    const error = (() => { try { normalizeProxyServer('ftp://user:sup3r-secret@proxy.corp:21') } catch (thrown: unknown) { return thrown as Error } return undefined })()
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).not.toContain('sup3r-secret')
    expect(error?.message).not.toContain('user')
  })
})

describe('mergeProxyBypass', () => {
  it('always merges the loopback exceptions, blank list included', () => {
    expect(mergeProxyBypass('')).toBe(PROXY_LOOPBACK_BYPASS.join(','))
    expect(PROXY_LOOPBACK_BYPASS).toContain('127.0.0.1')
    expect(PROXY_LOOPBACK_BYPASS).toContain('localhost')
    expect(PROXY_LOOPBACK_BYPASS).toContain('::1')
  })

  it('keeps the user entries first, de-duplicates them, and adds the missing loopback hosts', () => {
    expect(mergeProxyBypass('*.internal, localhost ,*.internal')).toBe('*.internal,localhost,127.0.0.1,::1')
    expect(mergeProxyBypass('10.0.0.0/8')).toBe('10.0.0.0/8,127.0.0.1,localhost,::1')
  })

  it('ignores empty entries left by trailing commas', () => {
    expect(mergeProxyBypass(' , *.corp , ')).toBe('*.corp,127.0.0.1,localhost,::1')
  })
})

describe('proxyOptionFor', () => {
  it('an all-blank section means a direct connection', () => {
    expect(proxyOptionFor(proxyConfig())).toBeUndefined()
    expect(proxyOptionFor({})).toBeUndefined()
    expect(proxyOptionFor(proxyConfig({ proxyServer: '   ' }))).toBeUndefined()
  })

  it('builds the Playwright launch proxy option, loopback bypass included', () => {
    expect(proxyOptionFor(proxyConfig({ proxyServer: '127.0.0.1:7890' }))).toEqual({
      server: 'http://127.0.0.1:7890',
      bypass: '127.0.0.1,localhost,::1',
    })
  })

  it('merges a user bypass list with the loopback exceptions', () => {
    expect(proxyOptionFor(proxyConfig({ proxyServer: 'socks5://127.0.0.1:1080', proxyBypass: '*.corp,localhost' }))).toEqual({
      server: 'socks5://127.0.0.1:1080',
      bypass: '*.corp,localhost,127.0.0.1,::1',
    })
  })

  it('carries the credentials when they are configured (and only then)', () => {
    expect(proxyOptionFor(proxyConfig({ proxyServer: 'http://127.0.0.1:7890' }))).not.toHaveProperty('username')
    expect(proxyOptionFor(proxyConfig({ proxyServer: 'http://127.0.0.1:7890', proxyUsername: ' user ', proxyPassword: 'p@ss' }))).toEqual({
      server: 'http://127.0.0.1:7890',
      bypass: '127.0.0.1,localhost,::1',
      username: 'user',
      password: 'p@ss',
    })
  })

  it('aux fields alone do not conjure a proxy: without a server there is nothing to dial', () => {
    expect(proxyOptionFor(proxyConfig({ proxyBypass: '*.corp', proxyUsername: 'user', proxyPassword: 'p' }))).toBeUndefined()
  })

  it('propagates an unusable server value instead of guessing', () => {
    expect(() => proxyOptionFor(proxyConfig({ proxyServer: 'ftp://proxy.corp:21' }))).toThrow()
  })
})

describe('redactProxyServer', () => {
  it('leaves credential-free addresses untouched', () => {
    expect(redactProxyServer('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('strips userinfo so a diagnostic cannot print the password', () => {
    expect(redactProxyServer('http://user:sup3r-secret@proxy.corp:3128')).not.toContain('sup3r-secret')
    expect(redactProxyServer('http://user:sup3r-secret@proxy.corp:3128')).toContain('proxy.corp:3128')
  })

  it('falls back to a regex strip for values URL cannot parse', () => {
    expect(redactProxyServer('not-a-url://user:pw@host')).not.toContain('pw@')
  })
})
