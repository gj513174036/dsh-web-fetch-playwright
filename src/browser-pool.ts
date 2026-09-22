/**
 * The shared-browser pool: ONE live browser handle, reused by every fetch,
 * each fetch leasing only the tab it owns and closing only that tab. The
 * machinery — one connect/launch under concurrent acquires, liveness checks,
 * one reconnect-and-retry against a handle that died mid-lease, replacement
 * when the settings that produced the handle change, generation-guarded
 * teardown — is backend-agnostic; what varies is injected:
 *
 * | Backend | `open` | key | lease context |
 * | --- | --- | --- | --- |
 * | CDP | `chromium.connectOverCDP(endpoint)` | the normalized endpoint URL | `isolated`: a fresh throwaway context per fetch; `profile`: the remote browser's default context |
 * | DSH-managed | `chromium.launchPersistentContext(userDataDir, options)` | the launch descriptor (profile dir, headless, args, proxy, playwright path) | `shared`: the persistent context itself |
 *
 * The invariant every backend shares, and the reason this is one pool rather
 * than three: `release` NEVER closes the shared handle or a shared context —
 * only the fetch's page. Closing the CDP default context would take the whole
 * connection down; closing the managed persistent context would kill the
 * browser and the logins the backend exists to keep.
 *
 * @module dsh-web-fetch-playwright/browser-pool
 */

import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from './types.ts'

/**
 * How a lease scopes its fetch:
 *
 * - `isolated` — a fresh throwaway context per fetch, closed on release;
 * - `profile` — a tab in a browser-owned default context (the CDP browser's
 *   real profile), never closed by this plugin;
 * - `shared` — the shared handle IS the context (the managed persistent
 *   profile), so tabs live directly in it and nothing but the tab closes.
 */
export type LeaseMode = 'isolated' | 'profile' | 'shared'

/** One fetch's lease on the pool's shared handle. */
export interface BrowserLease<K = string> {
  /**
   * The shared handle — close only what the lease owns, never this. For the
   * managed backend this IS the persistent context (see {@link BrowserPool}).
   */
  browser: PlaywrightBrowser
  /**
   * The context the page lives in: fetch-owned (`isolated`), the browser's
   * default context (`profile`), or the shared handle itself (`shared`).
   * Never close it when `persistent`.
   */
  context: PlaywrightContext
  /** The fetch-owned tab; {@link BrowserPool.release} always closes it. */
  page: PlaywrightPage
  /** True when `context` is shared: release must not close it. */
  persistent: boolean
  /** The key this lease was acquired under (the pool's identity for it). */
  key: K
}

/** How a lease takes its tab from the shared handle. */
export interface LeaseContext {
  /** The context the tab is opened in. */
  context: PlaywrightContext
  /** True when that context outlives the fetch (never closed on release). */
  persistent: boolean
}

/** Establishes (or re-establishes) the shared handle for one key. */
export type BrowserOpener<K, H> = (key: K, timeoutMs: number) => Promise<H>

/** What a backend must tell the pool about its handle. */
export interface BrowserPoolOptions<K, H extends PlaywrightBrowser> {
  /** Connect/launch the shared handle for `key`. */
  open: BrowserOpener<K, H>
  /** Stable text identity of a key: same text ⇒ the same shared browser. */
  keyText: (key: K) => string
  /** Where a lease's tab is born, per mode. */
  acquireContext: (handle: H, mode: LeaseMode) => Promise<LeaseContext> | LeaseContext
  /** Liveness probe; defaults to Playwright's `isConnected()`. */
  isLive?: (handle: H) => boolean
  /** Watch for the handle going away; defaults to the `disconnected` event. */
  watch?: (handle: H, lost: () => void) => void
  /** Close the handle on teardown; defaults to `handle.close()`. */
  close?: (handle: H) => Promise<void>
}

/**
 * A reusable shared browser: connect/launch once, hand every fetch its own
 * tab, and never let a release touch the shared handle.
 */
export class BrowserPool<K = string, H extends PlaywrightBrowser = PlaywrightBrowser> {
  private handle: H | undefined
  private handleKey = ''
  private connecting: Promise<H> | undefined
  private connectingKey = ''
  /** Bumped by dispose/replace so a settling open knows it was abandoned. */
  private generation = 0

  /** @param options - the backend-specific half of the pool. */
  constructor(private readonly options: BrowserPoolOptions<K, H>) {}

  /**
   * Lease a fetch's page on the shared handle, opening (or re-opening) first
   * if needed. Concurrent first acquires share one open attempt.
   *
   * @param key - the backend's identity for the shared browser.
   * @param timeoutMs - connect/launch timeout budget.
   * @param mode - how the lease scopes its tab (see {@link LeaseMode}).
   * @returns the shared handle, the page's context, and the page to release.
   * @throws whatever `open` throws when no handle can be established (the
   *   provider wraps it in a structured WebError), or a diagnostic error when
   *   `profile` mode finds no default context.
   */
  async acquire(key: K, timeoutMs: number, mode: LeaseMode = 'isolated'): Promise<BrowserLease<K>> {
    const handle = await this.ensure(key, timeoutMs)
    try {
      return await this.openLease(handle, key, mode)
    } catch (error: unknown) {
      // The handle may have died between ensure() and opening the lease; one
      // fresh attempt, then the error propagates as-is.
      if (this.isLive(handle)) throw error
      this.drop(handle)
      const fresh = await this.ensure(key, timeoutMs)
      return await this.openLease(fresh, key, mode)
    }
  }

  /** Open one lease's tab on a live handle. */
  private async openLease(handle: H, key: K, mode: LeaseMode): Promise<BrowserLease<K>> {
    const { context, persistent } = await this.options.acquireContext(handle, mode)
    try {
      return { browser: handle, context, page: await context.newPage(), persistent, key }
    } catch (error: unknown) {
      // A fetch-owned context whose page failed must not strand the context
      // until the whole handle goes away; a persistent one is not ours to
      // clean (the acquire-level retry simply tries again).
      if (!persistent) await context.close().catch(() => {})
      throw error
    }
  }

  /**
   * Close a fetch-owned page, plus its context when the lease owns one. The
   * shared handle and any persistent context stay for the next fetch.
   * @param lease - the lease whose page (and, when isolated, context) goes away.
   */
  async release(lease: BrowserLease<K>): Promise<void> {
    await lease.page.close().catch(() => {})
    if (!lease.persistent) await lease.context.close().catch(() => {})
  }

  /**
   * Drop the shared handle (plugin teardown or a settings change). Fetches
   * holding leases keep their pages until they release them. An open still in
   * flight is abandoned — its own continuation closes the stray handle
   * (nothing here waits on it, so teardown cannot deadlock).
   */
  async dispose(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.handleKey = ''
    this.connecting = undefined
    this.connectingKey = ''
    this.generation++
    if (handle !== undefined) await this.closeHandle(handle)
  }

  /** The shared handle for `key`, opening or replacing as needed. */
  private async ensure(key: K, timeoutMs: number): Promise<H> {
    const text = this.options.keyText(key)
    if (this.handle !== undefined && this.handleKey === text && this.isLive(this.handle)) return this.handle
    if (this.connecting !== undefined && this.connectingKey === text) return await this.connecting
    // Dead handle or a different key: (re)open. An in-flight open for another
    // key is abandoned by the generation bump below — its own continuation
    // closes the stray handle and rejects to its waiter.
    return await this.openFresh(key, text, timeoutMs)
  }

  /** Start an open for `key`, superseding whatever was there. */
  private openFresh(key: K, text: string, timeoutMs: number): Promise<H> {
    const stale = this.handle
    this.handle = undefined
    this.handleKey = ''
    const generation = ++this.generation
    const attempt = (async () => {
      const handle = await this.options.open(key, timeoutMs)
      // A dispose/replace won the race while we were opening: this handle is
      // unwanted — close it and surface the abandonment.
      if (generation !== this.generation) {
        await this.closeHandle(handle)
        throw new Error('shared browser abandoned before it attached')
      }
      this.handle = handle
      this.handleKey = text
      this.watch(handle)
      return handle
    })()
    this.connecting = attempt
    this.connectingKey = text
    void attempt.then(
      () => { if (this.connecting === attempt) this.connecting = undefined },
      () => { if (this.connecting === attempt) this.connecting = undefined },
    )
    if (stale !== undefined) void this.closeHandle(stale)
    return attempt
  }

  /** Clear the reference when this exact handle reports it went away. */
  private watch(handle: H): void {
    const onLost = () => {
      if (this.handle === handle) {
        this.handle = undefined
        this.handleKey = ''
      }
    }
    try {
      if (this.options.watch !== undefined) this.options.watch(handle, onLost)
      else handle.on?.('disconnected', onLost)
    } catch {
      // a backend that refuses listeners just loses proactive detection
    }
  }

  /** Forget a handle known to be dead (absent probe = assume dead here). */
  private drop(handle: H): void {
    if (this.handle === handle) {
      this.handle = undefined
      this.handleKey = ''
    }
  }

  private isLive(handle: H): boolean {
    if (this.options.isLive !== undefined) return this.options.isLive(handle)
    return handle.isConnected?.() !== false
  }

  private async closeHandle(handle: H): Promise<void> {
    if (this.options.close !== undefined) {
      await this.options.close(handle).catch(() => {})
      return
    }
    await handle.close().catch(() => {})
  }
}
