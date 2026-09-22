/**
 * The client card form model against a fake settings scope: staging, dirty
 * tracking, save writes (set/clear), failed-save retention, discard, and the
 * radio/checkbox field kinds — no browser, no DOM.
 */
import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { launcherPreview } from '../src/client/command.ts'
import { PlaywrightCardController } from '../src/client/controller.ts'
import type { PlaywrightSettings } from '../src/client/controller.ts'
import { CardForm, checkboxField, numberField, radioField, textField } from '../src/client/form.ts'

/** Minimal reactive scope double: a snapshot, a publish path, and a write log. */
class FakeScope implements SettingsScope<Record<string, unknown>> {
  snapshot: SettingsScopeSnapshot<Record<string, unknown>>
  readonly writes: Array<{ field: string; op: 'set' | 'unset'; value?: unknown }> = []
  /** When true, writes settle WITHOUT applying (a rejected Host write). */
  dropWrites = false
  private readonly listeners = new Set<() => void>()

  constructor(
    value: Record<string, unknown> = {},
    user: Record<string, unknown> = {},
    base: Record<string, unknown> = {},
  ) {
    this.snapshot = { status: 'ready', value, base, user, revision: 1, writable: true, mode: 'host' }
  }

  getSnapshot(): SettingsScopeSnapshot<Record<string, unknown>> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'set', value })
    const user = { ...(this.snapshot.user as Record<string, unknown>), [field]: value }
    this.publish({ value: { ...(this.snapshot.value as Record<string, unknown>), [field]: value }, user })
  }

  async unset(field: string): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'unset' })
    const user = { ...(this.snapshot.user as Record<string, unknown>) }
    const value = { ...(this.snapshot.value as Record<string, unknown>) }
    delete user[field]
    delete value[field]
    this.publish({ value, user })
  }

  private publish(partial: Partial<SettingsScopeSnapshot<Record<string, unknown>>>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

/** The card's field set: backend radio, eleven text inputs, six checkboxes, three numbers. */
function makeForm(scope: SettingsScope<Record<string, unknown>>) {
  return new CardForm(scope, [
    radioField('backend', ['local', 'cdp', 'managed']),
    textField('playwrightPath'),
    checkboxField('shareBrowserContext'),
    checkboxField('denoise'),
    numberField('maxConcurrency', 1, 8),
    numberField('challengeWaitMs', 0, 60_000),
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
  ])
}

describe('CardForm', () => {
  it('seeds field state from the scope snapshot', () => {
    const scope = new FakeScope({ backend: 'cdp', playwrightPath: '/usr/bin/chrome', denoise: false })
    const form = makeForm(scope)
    expect(form.field('backend').text).toBe('cdp')
    expect(form.field('playwrightPath').text).toBe('/usr/bin/chrome')
    expect(form.field('denoise').text).toBe('false')
    expect(form.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('stages an edit and marks the form dirty without touching the scope', () => {
    const scope = new FakeScope({ playwrightPath: '' })
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/opt/chrome')
    expect(form.field('playwrightPath').text).toBe('/opt/chrome')
    expect(form.shell().dirty).toBe(true)
    expect(scope.writes).toHaveLength(0)
  })

  it('save writes staged edits through scope.set and clears the drafts on success', async () => {
    const scope = new FakeScope({ backend: 'local', playwrightPath: '' })
    const form = makeForm(scope)
    form.actions().edit('backend', 'cdp')
    form.actions().edit('playwrightPath', '/usr/bin/chrome')
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'backend', op: 'set', value: 'cdp' },
      { field: 'playwrightPath', op: 'set', value: '/usr/bin/chrome' },
    ])
    expect(form.shell().dirty).toBe(false)
    expect(form.shell().failed).toBe(false)
  })

  it('keeps drafts and flags the save when the write does not land', async () => {
    const scope = new FakeScope({ playwrightPath: '' })
    scope.dropWrites = true
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/opt/chrome')
    await form.save()
    expect(form.shell().failed).toBe(true)
    expect(form.field('playwrightPath').text).toBe('/opt/chrome')
    expect(form.shell().dirty).toBe(true)
  })

  it('resetField stages a clear that lets the field re-inherit the composition layer', async () => {
    const scope = new FakeScope({ playwrightPath: '/old/path' }, { playwrightPath: '/old/path' }, { playwrightPath: '/default' })
    const form = makeForm(scope)
    form.actions().resetField('playwrightPath')
    expect(form.field('playwrightPath').overridden).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'playwrightPath', op: 'unset' }])
    expect(form.shell().dirty).toBe(false)
  })

  it('discard drops every staged edit', () => {
    const scope = new FakeScope({ playwrightPath: '/a' })
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/b')
    form.actions().discard()
    expect(form.field('playwrightPath').text).toBe('/a')
    expect(form.shell().dirty).toBe(false)
  })

  it('radioField rejects values outside the option set and blocks the save', () => {
    const form = makeForm(new FakeScope({ backend: 'local' }))
    form.actions().edit('backend', 'whatever')
    expect(form.field('backend').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
  })

  it('checkboxField round-trips booleans through the draft strings', async () => {
    const scope = new FakeScope({ denoise: true })
    const form = makeForm(scope)
    form.actions().edit('denoise', 'false')
    expect(form.field('denoise').text).toBe('false')
    expect(form.field('denoise').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'denoise', op: 'set', value: false }])
    expect(form.field('denoise').text).toBe('false')
  })

  it('the shared-context checkbox seeds absent as empty (card renders the on default)', async () => {
    const scope = new FakeScope({ backend: 'cdp' })
    const form = makeForm(scope)
    // Absent stored value formats as '': the checkbox control falls back to
    // its schema default (checked) while nothing is staged.
    expect(form.field('shareBrowserContext').text).toBe('')
    expect(form.field('shareBrowserContext').overridden).toBe(false)
    expect(form.shell().dirty).toBe(false)

    form.actions().edit('shareBrowserContext', 'false') // the user unchecks
    await form.save()
    expect(scope.writes).toEqual([{ field: 'shareBrowserContext', op: 'set', value: false }])
    expect(form.field('shareBrowserContext').text).toBe('false')
    expect(form.field('shareBrowserContext').overridden).toBe(true)

    form.actions().resetField('shareBrowserContext') // back to the default
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'shareBrowserContext', op: 'unset' })
    expect(form.field('shareBrowserContext').text).toBe('')
  })

  it('numberField round-trips in-range integers and clears on empty', async () => {
    const scope = new FakeScope({ maxConcurrency: 4 })
    const form = makeForm(scope)
    expect(form.field('maxConcurrency').text).toBe('4')
    form.actions().edit('maxConcurrency', '6')
    expect(form.field('maxConcurrency').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'maxConcurrency', op: 'set', value: 6 }])
    form.actions().edit('maxConcurrency', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'maxConcurrency', op: 'unset' })
  })

  it('numberField rejects out-of-range and non-integer drafts, blocking the save', () => {
    const form = makeForm(new FakeScope({ maxConcurrency: 4 }))
    for (const bad of ['0', '9', '2.5', '-1', 'four', '1 2']) {
      form.actions().edit('maxConcurrency', bad)
      expect(form.field('maxConcurrency').invalid, bad).toBe(true)
      expect(form.shell().invalid, bad).toBe(true)
    }
    form.actions().discard()
  })

  it('the challenge-wait field round-trips its millisecond range, 0 included', async () => {
    const scope = new FakeScope({ challengeWaitMs: 15_000 })
    const form = makeForm(scope)
    expect(form.field('challengeWaitMs').text).toBe('15000')
    form.actions().edit('challengeWaitMs', '20000')
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    form.actions().edit('challengeWaitMs', '0') // 0 is the feature-off value, not invalid
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'challengeWaitMs', op: 'set', value: 0 }])
    form.actions().edit('challengeWaitMs', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'challengeWaitMs', op: 'unset' })
    // Out of range blocks the save like any number field.
    form.actions().edit('challengeWaitMs', '60001')
    expect(form.field('challengeWaitMs').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
    form.actions().discard()
  })

  it('an external scope change republishes through the bound snapshot store', () => {
    const scope = new FakeScope({ playwrightPath: '/a' })
    const form = makeForm(scope)
    const store = form.bind(() => form.shell())
    expect(store.getSnapshot().dirty).toBe(false)
    scope.set('playwrightPath', '/b')
    expect(store.getSnapshot().dirty).toBe(false)
  })
})

/** The outbound-proxy fields added for P0, against the same staged model. */
describe('CardForm proxy fields', () => {
  const proxyFields = ['proxyServer', 'proxyBypass', 'proxyUsername', 'proxyPassword'] as const

  it('seeds every proxy field from the section and treats blanks as unstaged', () => {
    const scope = new FakeScope({
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypass: '',
      proxyUsername: 'proxyuser',
      proxyPassword: '',
    })
    const form = makeForm(scope)
    expect(form.field('proxyServer').text).toBe('http://127.0.0.1:7890')
    expect(form.field('proxyBypass').text).toBe('')
    expect(form.field('proxyUsername').text).toBe('proxyuser')
    expect(form.field('proxyPassword').text).toBe('')
    expect(form.shell().dirty).toBe(false)
    expect(form.shell().invalid).toBe(false)
  })

  it('stages all four through the same text-field semantics and saves them as strings', async () => {
    const scope = new FakeScope({})
    const form = makeForm(scope)
    form.actions().edit('proxyServer', 'socks5://127.0.0.1:1080')
    form.actions().edit('proxyBypass', '*.corp,10.0.0.0/8')
    form.actions().edit('proxyUsername', 'proxyuser')
    form.actions().edit('proxyPassword', 'p@ss word')
    expect(scope.writes).toHaveLength(0) // still staged, nothing written yet
    expect(form.shell()).toMatchObject({ dirty: true, invalid: false })
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'proxyServer', op: 'set', value: 'socks5://127.0.0.1:1080' },
      { field: 'proxyBypass', op: 'set', value: '*.corp,10.0.0.0/8' },
      { field: 'proxyUsername', op: 'set', value: 'proxyuser' },
      { field: 'proxyPassword', op: 'set', value: 'p@ss word' },
    ])
    expect(form.shell().dirty).toBe(false)
    for (const field of proxyFields) expect(form.field(field).overridden).toBe(true)
  })

  it('marks each proxy field overridden only once the user layer holds it', () => {
    const scope = new FakeScope(
      { proxyServer: 'http://127.0.0.1:7890' },
      { proxyServer: 'http://127.0.0.1:7890' },
      {},
    )
    const form = makeForm(scope)
    expect(form.field('proxyServer').overridden).toBe(true)
    expect(form.field('proxyBypass').overridden).toBe(false)
    expect(form.field('proxyUsername').overridden).toBe(false)
    expect(form.field('proxyPassword').overridden).toBe(false)
  })

  it('resetField stages a clear for a saved proxy value (the same gesture as the other fields)', async () => {
    const scope = new FakeScope(
      { proxyServer: 'http://127.0.0.1:7890', proxyPassword: 'p@ss' },
      { proxyServer: 'http://127.0.0.1:7890', proxyPassword: 'p@ss' },
      {},
    )
    const form = makeForm(scope)
    form.actions().resetField('proxyServer')
    form.actions().resetField('proxyPassword')
    expect(form.field('proxyServer').overridden).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'proxyServer', op: 'unset' },
      { field: 'proxyPassword', op: 'unset' },
    ])
  })

  it('an emptied draft clears the field, exactly like the other text fields', async () => {
    const scope = new FakeScope(
      { proxyServer: 'http://127.0.0.1:7890' },
      { proxyServer: 'http://127.0.0.1:7890' },
      {},
    )
    const form = makeForm(scope)
    form.actions().edit('proxyServer', '   ')
    expect(form.field('proxyServer').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'proxyServer', op: 'unset' }])
    expect(form.field('proxyServer').text).toBe('')
  })

  it('proxy text fields accept any draft (no local validation), like playwrightPath/cdpEndpoint', () => {
    const form = makeForm(new FakeScope({}))
    // The Host/provider diagnoses a bad address per fetch; the card only
    // stages text, so `invalid` stays false for every draft — the same
    // semantics the path and CDP-endpoint inputs have.
    for (const draft of ['ftp://proxy:21', 'not a url', 'http://127.0.0.1:7890']) {
      form.actions().edit('proxyServer', draft)
      expect(form.field('proxyServer').invalid, draft).toBe(false)
      expect(form.shell().invalid, draft).toBe(false)
    }
    form.actions().edit('proxyPassword', 'p@ss word, with spaces')
    expect(form.field('proxyPassword').invalid).toBe(false)
    form.actions().discard()
  })
})

/** The managed-backend fields added for P1, against the same staged model. */
describe('CardForm managed-backend fields', () => {
  it('seeds headless, the profile directory, and the launch arguments', () => {
    const scope = new FakeScope({ headless: false, userDataDir: '/data/p', launchArgs: '--lang=zh-CN' })
    const form = makeForm(scope)
    expect(form.field('headless').text).toBe('false')
    expect(form.field('userDataDir').text).toBe('/data/p')
    expect(form.field('launchArgs').text).toBe('--lang=zh-CN')
    expect(form.shell().dirty).toBe(false)
  })

  it('stages and saves all three through the shared text/checkbox semantics', async () => {
    const scope = new FakeScope({})
    const form = makeForm(scope)
    form.actions().edit('backend', 'managed')
    form.actions().edit('headless', 'false')
    form.actions().edit('userDataDir', '/srv/chrome-profile')
    form.actions().edit('launchArgs', '--lang=zh-CN --disable-gpu')
    expect(form.shell()).toMatchObject({ dirty: true, invalid: false })
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'backend', op: 'set', value: 'managed' },
      { field: 'headless', op: 'set', value: false },
      { field: 'userDataDir', op: 'set', value: '/srv/chrome-profile' },
      { field: 'launchArgs', op: 'set', value: '--lang=zh-CN --disable-gpu' },
    ])
    expect(form.field('headless').overridden).toBe(true)
  })

  it('resetField clears the profile directory and the headless override', async () => {
    const scope = new FakeScope(
      { headless: false, userDataDir: '/data/p' },
      { headless: false, userDataDir: '/data/p' },
      {},
    )
    const form = makeForm(scope)
    form.actions().resetField('userDataDir')
    form.actions().resetField('headless')
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'userDataDir', op: 'unset' },
      { field: 'headless', op: 'unset' },
    ])
    // The headless checkbox falls back to the schema default (on) when the
    // user layer no longer holds it.
    expect(form.field('headless').text).toBe('')
    expect(form.field('headless').overridden).toBe(false)
  })

  it('accepts the managed backend as a radio value and rejects a typo', () => {
    const form = makeForm(new FakeScope({ backend: 'local' }))
    form.actions().edit('backend', 'managed')
    expect(form.field('backend').invalid).toBe(false)
    form.actions().edit('backend', 'managedpersistent')
    expect(form.field('backend').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
  })
})

/** The controller's projection: the managed fields plus the derived preview. */
describe('PlaywrightCardController projection', () => {
  function controllerFor(value: Record<string, unknown>): PlaywrightCardController {
    return new PlaywrightCardController(new FakeScope(value) as unknown as SettingsScope<PlaywrightSettings>)
  }

  it('projects the managed/proxy drafts and a read-only launcher command', () => {
    const state = controllerFor({
      headless: false,
      userDataDir: '/data/p',
      launchArgs: '--lang=zh-CN',
      proxyServer: '127.0.0.1:7890',
      proxyBypass: '*.corp',
    }).inject().hooks.playwrightCard.getSnapshot()

    expect(state.headless.text).toBe('false')
    expect(state.userDataDir.text).toBe('/data/p')
    expect(state.launchArgs.text).toBe('--lang=zh-CN')
    // The preview is derived, not staged: it is exactly what the shared
    // argument builder produces for these drafts.
    expect(state.launcherCommand).toBe(launcherPreview({
      headless: 'false',
      userDataDir: '/data/p',
      launchArgs: '--lang=zh-CN',
      proxyServer: '127.0.0.1:7890',
      proxyBypass: '*.corp',
    }))
    expect(state.launcherCommand).toContain('--user-data-dir=/data/p')
    expect(state.launcherCommand).toContain('--proxy-server=http://127.0.0.1:7890')
    expect(state.launcherCommand).toContain('--proxy-bypass-list=*.corp;127.0.0.1;localhost;::1')
    expect(state.launcherCommand).not.toContain('--headless=new')
  })

  it('projects the capture fields and keeps the recording switch independent of the launcher preview', () => {
    const face = controllerFor({ recordNetwork: true, recordDir: '/data/dumps', maxBodyBytes: 4096 }).inject()
    const state = face.hooks.playwrightCard.getSnapshot()
    expect(state.recordNetwork.text).toBe('true')
    expect(state.recordDir.text).toBe('/data/dumps')
    expect(state.maxBodyBytes.text).toBe('4096')
    expect(state.captureBodies.text).toBe('') // absent = the schema default (bodies on)
    // Capture settings never leak into the launcher command preview.
    expect(state.launcherCommand).not.toContain('/data/dumps')
  })

  it('re-derives and republishes the preview as the user types', () => {
    const face = controllerFor({}).inject()
    const store = face.hooks.playwrightCard
    const before = store.getSnapshot().launcherCommand
    expect(before).toContain('--headless=new') // headless defaults on

    face.edit('userDataDir', '/tmp/copy')
    const after = store.getSnapshot().launcherCommand
    expect(after).not.toBe(before)
    expect(after).toContain('--user-data-dir=/tmp/copy')

    face.edit('headless', 'false')
    expect(store.getSnapshot().launcherCommand).not.toContain('--headless=new')
    expect(store.getSnapshot().dirty).toBe(true)
  })
})

/** The P2 capture fields: opt-in switch, path, body capture, byte cap. */
describe('CardForm capture fields', () => {
  it('seeds the capture fields, with recording off and bodies on by default', () => {
    const form = makeForm(new FakeScope({}))
    expect(form.field('recordNetwork').text).toBe('') // absent = schema default (off)
    expect(form.field('recordDir').text).toBe('')
    expect(form.field('captureBodies').text).toBe('')
    expect(form.field('maxBodyBytes').text).toBe('')
    expect(form.field('recordAllResources').text).toBe('')
    expect(form.shell().dirty).toBe(false)
  })

  it('stages and saves every capture field', async () => {
    const scope = new FakeScope({})
    const form = makeForm(scope)
    form.actions().edit('recordNetwork', 'true')
    form.actions().edit('recordDir', '/data/dumps')
    form.actions().edit('captureBodies', 'false')
    form.actions().edit('maxBodyBytes', '65536')
    form.actions().edit('recordAllResources', 'true')
    form.actions().edit('proxyServer', '127.0.0.1:7890')
    expect(form.shell()).toMatchObject({ dirty: true, invalid: false })
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'recordNetwork', op: 'set', value: true },
      { field: 'recordDir', op: 'set', value: '/data/dumps' },
      { field: 'captureBodies', op: 'set', value: false },
      { field: 'maxBodyBytes', op: 'set', value: 65536 },
      { field: 'recordAllResources', op: 'set', value: true },
      { field: 'proxyServer', op: 'set', value: '127.0.0.1:7890' },
    ])
    expect(form.field('recordNetwork').overridden).toBe(true)
  })

  it('accepts 0 as the body cap (metadata only) and blocks out-of-range drafts', () => {
    const form = makeForm(new FakeScope({}))
    form.actions().edit('maxBodyBytes', '0')
    expect(form.field('maxBodyBytes').invalid).toBe(false)
    form.actions().edit('maxBodyBytes', String(16 * 1024 * 1024 + 1))
    expect(form.field('maxBodyBytes').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
    form.actions().edit('maxBodyBytes', 'lots')
    expect(form.field('maxBodyBytes').invalid).toBe(true)
    form.actions().discard()
  })

  it('resetField clears a saved capture switch and path', async () => {
    const scope = new FakeScope(
      { recordNetwork: true, recordDir: '/data/dumps' },
      { recordNetwork: true, recordDir: '/data/dumps' },
      {},
    )
    const form = makeForm(scope)
    form.actions().resetField('recordNetwork')
    form.actions().resetField('recordDir')
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'recordNetwork', op: 'unset' },
      { field: 'recordDir', op: 'unset' },
    ])
    expect(form.field('recordNetwork').overridden).toBe(false)
  })
})
