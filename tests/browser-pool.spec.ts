/**
 * The generic shared-browser pool over fake handles: one open under
 * concurrent acquires, reuse while the key text is unchanged, replacement when
 * it changes, the lease modes (isolated closes its context, shared closes ONLY
 * the page), liveness/reconnect, abandonment races, and teardown.
 *
 * The CDP instantiation is covered in `cdp-pool.spec.ts` (its behavior is
 * unchanged by the generalization); this file proves the machinery both
 * shared backends ride.
 */
import { describe, expect, it } from 'vitest'
import { BrowserPool } from '../src/browser-pool.ts'
import type { BrowserPoolOptions, LeaseMode } from '../src/browser-pool.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from '../src/types.ts'

/** A fake page tracking its own close (all members the pool may touch). */
class FakePage {
  private closedFlag = false
  readonly page: PlaywrightPage = {
    goto: async () => null,
    waitForLoadState: async () => {},
    url: () => 'about:blank',
    content: async () => '',
    route: async () => {},
    close: async () => { this.closedFlag = true },
  }
  get closed(): boolean { return this.closedFlag }
}

/** A fake context tracking its pages and its own close. */
class FakeContext {
  private closedFlag = false
  readonly pages: FakePage[] = []
  readonly context: PlaywrightContext = {
    newPage: async () => {
      const page = new FakePage()
      this.pages.push(page)
      return page.page
    },
    route: async () => {},
    close: async () => { this.closedFlag = true },
  }
  get closed(): boolean { return this.closedFlag }
}

/** A fake shared handle: a browser-like object with liveness and listeners. */
class FakeHandle {
  readonly contexts: FakeContext[] = []
  readonly defaultContext = new FakeContext()
  closed = false
  live = true
  private readonly listeners: Array<() => void> = []

  readonly browser: PlaywrightBrowser = {
    newContext: async () => {
      if (!this.live) throw new Error('Target closed')
      const context = new FakeContext()
      this.contexts.push(context)
      return context.context
    },
    contexts: () => [this.defaultContext.context],
    close: async () => { this.closed = true },
    isConnected: () => this.live,
    on: (_event: 'disconnected' | 'close', listener: () => void) => { this.listeners.push(listener) },
  }

  /** Simulate the handle going away (fires the disconnect listener). */
  drop(): void {
    this.live = false
    for (const listener of this.listeners) listener()
  }
}

/** A pool over fake handles with the CDP-shaped lease rules. */
function cdpShapedPool(open: (key: string, timeoutMs: number) => Promise<PlaywrightBrowser>) {
  return new BrowserPool<string, PlaywrightBrowser>({
    open,
    keyText: key => key,
    acquireContext: async (handle, mode) => {
      if (mode === 'profile') {
        const context = handle.contexts?.()[0]
        if (context === undefined) throw new Error('no default context')
        return { context, persistent: true }
      }
      const newContext = handle.newContext
      if (newContext === undefined) throw new Error('cannot create a context')
      return { context: await newContext.call(handle), persistent: false }
    },
  })
}

/** Open function recording calls, returning scripted handles. */
function scriptedOpen(...handles: FakeHandle[]): { open: (key: string, timeoutMs: number) => Promise<PlaywrightBrowser>; calls: string[] } {
  if (handles.length === 0) throw new Error('scriptedOpen needs at least one handle')
  const calls: string[] = []
  let index = 0
  return {
    calls,
    open: async (key, timeoutMs) => {
      calls.push(`${key}@${String(timeoutMs)}`)
      const handle = handles[Math.min(index, handles.length - 1)] as FakeHandle
      index++
      return handle.browser
    },
  }
}

describe('BrowserPool', () => {
  it('opens once and shares the handle across concurrent acquires', async () => {
    const handle = new FakeHandle()
    const { open, calls } = scriptedOpen(handle)
    const pool = cdpShapedPool(open)

    const leases = await Promise.all(Array.from({ length: 4 }, () => pool.acquire('a', 1000)))
    expect(calls).toEqual(['a@1000'])
    expect(handle.contexts).toHaveLength(4)
    for (const lease of leases) {
      expect(lease.browser).toBe(handle.browser)
      expect(lease.key).toBe('a')
    }
  })

  it('reuses the handle while the key text is unchanged, replacing it otherwise', async () => {
    const first = new FakeHandle()
    const second = new FakeHandle()
    const { open, calls } = scriptedOpen(first, second)
    const pool = cdpShapedPool(open)

    await pool.acquire('a', 1000)
    const again = await pool.acquire('a', 1000)
    expect(again.browser).toBe(first.browser)
    expect(calls).toHaveLength(1)

    const replaced = await pool.acquire('b', 1000)
    expect(replaced.browser).toBe(second.browser)
    expect(first.closed).toBe(true) // the superseded handle is closed
    expect(calls).toHaveLength(2)
  })

  it('compares keys by their keyText, not by identity', async () => {
    const handle = new FakeHandle()
    const { open, calls } = scriptedOpen(handle)
    // A descriptor-shaped key: equal content must reuse the handle even
    // though the object identity differs (the managed backend's case).
    const pool = new BrowserPool<{ dir: string }, PlaywrightBrowser>({
      open: (key) => open(JSON.stringify(key), 1000),
      keyText: key => `dir=${key.dir}`,
      acquireContext: () => ({ context: new FakeContext().context, persistent: false }),
    })
    await pool.acquire({ dir: '/data/p' }, 1000)
    await pool.acquire({ dir: '/data/p' }, 1000)
    expect(calls).toHaveLength(1)
    await pool.acquire({ dir: '/data/other' }, 1000)
    expect(calls).toHaveLength(2)
  })

  it('release closes only the page for a persistent lease, never the context or handle', async () => {
    const handle = new FakeHandle()
    const { open } = scriptedOpen(handle)
    const pool = cdpShapedPool(open)

    const lease = await pool.acquire('a', 1000, 'profile')
    expect(lease.persistent).toBe(true)
    expect(lease.context).toBe(handle.defaultContext.context)
    await pool.release(lease)

    expect(handle.defaultContext.pages[0]?.closed).toBe(true)
    // The whole point of the shared model: the shared context (the profile,
    // or the managed persistent context) outlives the fetch.
    expect(handle.defaultContext.closed).toBe(false)
    expect(handle.closed).toBe(false)
    expect(handle.contexts).toHaveLength(0)
  })

  it('release closes a fetch-owned context in isolated mode', async () => {
    const handle = new FakeHandle()
    const { open } = scriptedOpen(handle)
    const pool = cdpShapedPool(open)

    const lease = await pool.acquire('a', 1000, 'isolated')
    expect(lease.persistent).toBe(false)
    await pool.release(lease)
    expect(handle.contexts[0]?.pages[0]?.closed).toBe(true)
    expect(handle.contexts[0]?.closed).toBe(true)
    expect(handle.defaultContext.pages).toHaveLength(0)
    expect(handle.closed).toBe(false)
  })

  it('closes a fetch-owned context whose newPage failed, keeping the handle', async () => {
    const handle = new FakeHandle()
    const broken = new FakeContext()
    const failingContext: PlaywrightContext = {
      newPage: async () => { throw new Error('Target closed') },
      route: async () => {},
      close: async () => { broken.context.close().catch(() => {}) },
    }
    const pool = new BrowserPool<string, PlaywrightBrowser>({
      open: async () => handle.browser,
      keyText: key => key,
      acquireContext: (_handle, mode: LeaseMode) => mode === 'isolated'
        ? { context: failingContext, persistent: false }
        : { context: handle.defaultContext.context, persistent: true },
    })
    await expect(pool.acquire('a', 1000, 'isolated')).rejects.toThrow('Target closed')
    expect(broken.closed).toBe(true) // the stranded context was cleaned up
  })

  it('reconnects once when the handle died between ensure and the lease', async () => {
    const first = new FakeHandle()
    const second = new FakeHandle()
    let calls = 0
    const pool = new BrowserPool<string, PlaywrightBrowser>({
      open: async () => {
        calls++
        const handle = calls === 1 ? first : second
        return handle.browser
      },
      keyText: key => key,
      acquireContext: (browser) => {
        // The first attempt hits a handle that just died.
        if (browser === first.browser) {
          first.drop()
          throw new Error('Target closed')
        }
        return { context: second.defaultContext.context, persistent: true }
      },
    })

    const lease = await pool.acquire('a', 1000, 'profile')
    expect(lease.browser).toBe(second.browser)
    expect(calls).toBe(2)
    // The dead handle is forgotten, not "closed": a handle that failed its
    // liveness probe is already gone (a dropped CDP socket, a closed
    // persistent context), and closing it would be a no-op at best.
    expect(first.closed).toBe(false)
    const reused = await pool.acquire('a', 1000, 'profile')
    expect(reused.browser).toBe(second.browser)
    expect(calls).toBe(2)
  })

  it('propagates a lease failure on a live handle without reopening', async () => {
    const handle = new FakeHandle()
    let calls = 0
    const pool = new BrowserPool<string, PlaywrightBrowser>({
      open: async () => { calls++; return handle.browser },
      keyText: key => key,
      acquireContext: () => { throw new Error('cannot open a tab') },
    })
    await expect(pool.acquire('a', 1000)).rejects.toThrow('cannot open a tab')
    expect(calls).toBe(1) // the handle is healthy — no reconnect
  })

  it('dispose closes the handle, and the next acquire opens a fresh one', async () => {
    const first = new FakeHandle()
    const second = new FakeHandle()
    const { open, calls } = scriptedOpen(first, second)
    const pool = cdpShapedPool(open)

    await pool.acquire('a', 1000)
    await pool.dispose()
    expect(first.closed).toBe(true)

    const lease = await pool.acquire('a', 1000)
    expect(lease.browser).toBe(second.browser)
    expect(calls).toHaveLength(2)
  })

  it('abandons an open that settles after dispose, leaving no stale handle', async () => {
    const handle = new FakeHandle()
    let releaseOpen: (() => void) | undefined
    let opens = 0
    const pool = cdpShapedPool(async () => {
      opens++
      if (opens === 2) await new Promise<void>(resolve => { releaseOpen = resolve })
      return handle.browser
    })

    await pool.acquire('a', 1000)
    await pool.dispose()
    const pending = pool.acquire('a', 1000).then(
      lease => lease.browser,
      () => undefined as unknown as PlaywrightBrowser,
    )
    await new Promise(resolve => { setImmediate(resolve) })
    await pool.dispose() // abandons the in-flight open
    releaseOpen?.()
    expect(await pending).toBeUndefined()

    const lease = await pool.acquire('a', 1000)
    expect(lease.browser).toBe(handle.browser)
    expect(opens).toBe(3)
  })

  it('honours backend-supplied liveness, watch, and close hooks', async () => {
    const lost: Array<() => void> = []
    const handle = new FakeHandle()
    let closed = 0
    let opens = 0
    const options: BrowserPoolOptions<string, FakeHandleAsBrowser> = {
      open: async () => {
        opens++
        return handle.browser as unknown as FakeHandleAsBrowser
      },
      keyText: key => key,
      acquireContext: () => ({ context: handle.defaultContext.context, persistent: true }),
      isLive: h => h.live,
      watch: (_h, onLost) => { lost.push(onLost) },
      close: async () => { closed++ },
    }
    const pool = new BrowserPool(options)
    await pool.acquire('a', 1000, 'profile')
    expect(lost).toHaveLength(1) // the backend's own watcher was used
    expect(closed).toBe(0)

    // The handle reports loss (the managed backend's `close` event): the next
    // acquire must open a fresh handle rather than reuse the dead one.
    lost[0]?.()
    await pool.acquire('a', 1000, 'profile')
    expect(opens).toBe(2)

    await pool.dispose()
    expect(closed).toBe(1) // the custom closer ran instead of handle.close()
    expect(handle.closed).toBe(false)
  })
})

/** A handle typed as the pool's browser (its structural surface). */
type FakeHandleAsBrowser = PlaywrightBrowser & { live: boolean }
