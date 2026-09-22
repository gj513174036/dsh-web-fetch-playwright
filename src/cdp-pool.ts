/**
 * The CDP backend's shared connection: one `connectOverCDP` session reused by
 * every fetch, each fetch leasing a page (a tab in the remote browser) that it
 * closes when done — in an isolated throwaway context (`isolated` mode), or in
 * the remote browser's default context (`profile` mode, whose cookies and
 * localStorage are the real profile's, so its persistent logins apply; that
 * context is never closed, only the tab is). The connection itself outlives
 * fetches — reconnecting per fetch would spend 100–500ms per call and open one
 * socket per concurrent tab for no benefit.
 *
 * The lease/liveness/replacement machinery lives in {@link BrowserPool}; this
 * module is the CDP instantiation of it (the endpoint URL is the key, and the
 * browser's default context is the `profile` lease's context). The DSH-managed
 * persistent backend uses the same pool with a different opener, key, and
 * `shared`-context lease.
 *
 * @module dsh-web-fetch-playwright/cdp-pool
 */

import { BrowserPool } from './browser-pool.ts'
import type { BrowserLease, LeaseContext, LeaseMode } from './browser-pool.ts'
import type { PlaywrightBrowser } from './types.ts'

/** Opens the shared connection; injected so tests can substitute a fake. */
export type CdpConnect = (endpoint: string, timeoutMs: number) => Promise<PlaywrightBrowser>

/** How a CDP lease scopes its fetch: throwaway context or the remote profile. */
export type CdpAcquireMode = Extract<LeaseMode, 'isolated' | 'profile'>

/** One CDP fetch's lease: the shared browser, a context, and the tab it owns. */
export type CdpLease = BrowserLease<string>

/**
 * The context a CDP lease opens in: `profile` rides the remote browser's
 * default context — `[0]` is it, because playwright-core's BrowserDispatcher
 * always dispatches it first and contexts created outside this connection
 * never appear here, so the pick is deterministic — while `isolated` is a
 * throwaway context the lease owns and release closes. The persistent handle
 * is taken fresh every call (never cached across connections): a reconnect
 * yields a new Browser object whose `contexts()[0]` must be re-read.
 */
async function cdpLeaseContext(browser: PlaywrightBrowser, mode: LeaseMode): Promise<LeaseContext> {
  if (mode === 'profile') {
    const context = browser.contexts?.()[0]
    if (context === undefined) {
      throw new Error('the CDP endpoint exposed no default browser context (profile mode requires a real browser profile)')
    }
    return { context, persistent: true }
  }
  const newContext = browser.newContext
  if (newContext === undefined) {
    throw new Error('the connected browser cannot create an isolated context')
  }
  return { context: await newContext.call(browser), persistent: false }
}

/** A reusable `connectOverCDP` session handing out per-fetch pages. */
export class CdpConnectionPool {
  private readonly pool: BrowserPool<string, PlaywrightBrowser>

  /**
   * @param connect - opens a connection to an endpoint (the provider's real
   * one resolves the bundled playwright-core; tests inject fakes).
   */
  constructor(connect: CdpConnect) {
    this.pool = new BrowserPool<string, PlaywrightBrowser>({
      open: (endpoint, timeoutMs) => connect(endpoint, timeoutMs),
      keyText: endpoint => endpoint,
      acquireContext: cdpLeaseContext,
    })
  }

  /**
   * Lease a fetch's page on the shared connection, connecting (or
   * reconnecting) first if needed. Concurrent first fetches share one
   * connect attempt.
   *
   * @param endpoint - normalized CDP endpoint URL.
   * @param timeoutMs - connect timeout budget.
   * @param mode - `isolated` (default): a fresh throwaway context plus a page
   *   in it; `profile`: a page in the remote browser's default context — the
   *   real profile — which is never closed, only the page is.
   * @returns the shared browser, the page's context, and the page the caller
   *   must release.
   * @throws whatever the connect function throws when no connection can be
   *   established (the provider wraps it in a structured WebError), or a
   *   diagnostic error when `profile` mode finds no default context.
   */
  async acquire(endpoint: string, timeoutMs: number, mode: CdpAcquireMode = 'isolated'): Promise<CdpLease> {
    return await this.pool.acquire(endpoint, timeoutMs, mode)
  }

  /**
   * Close a fetch-owned page, plus its context when the lease owns one. The
   * remote default context (persistent leases) and the shared connection
   * stay for the next fetch.
   * @param lease - the lease whose page (and, when isolated, context) goes away.
   */
  async release(lease: CdpLease): Promise<void> {
    await this.pool.release(lease)
  }

  /**
   * Drop the shared connection (plugin teardown or endpoint change). Fetches
   * holding leases keep their contexts until they release them.
   */
  async dispose(): Promise<void> {
    await this.pool.dispose()
  }
}
