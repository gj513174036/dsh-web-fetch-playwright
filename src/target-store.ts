/**
 * Reading the targets file.
 *
 * The file is hand-edited, so it is re-read whenever it changes rather than
 * cached for the process: editing a recipe and fetching again is the whole
 * iteration loop, and a stale cache would make it a lie. The cache key is the
 * file's mtime and size, which is cheap to stat and enough to notice an edit.
 *
 * @module dsh-web-fetch-playwright/target-store
 */

import { readFile, stat } from 'node:fs/promises'
import { parseTargets, type Target } from './targets.ts'

/** What loading produced: the targets, or why the file is unusable. */
export type TargetLoad =
  | { readonly ok: true; readonly targets: readonly Target[] }
  | { readonly ok: false; readonly error: string }

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly load: TargetLoad
}

const cache = new Map<string, CacheEntry>()

/**
 * Load and validate the targets file.
 *
 * @param path - the configured path to the file.
 * @returns the targets, or a message naming what is wrong.
 */
export async function loadTargets(path: string): Promise<TargetLoad> {
  try {
    const info = await stat(path)
    const cached = cache.get(path)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.load
    const text = await readFile(path, 'utf8')
    const parsed = parseTargets(text)
    const load: TargetLoad = parsed.ok ? { ok: true, targets: parsed.targets } : { ok: false, error: parsed.error }
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, load })
    return load
  } catch (error) {
    return { ok: false, error: `targets file could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Forget every cached file (for tests, and for a settings change that repoints the path). */
export function clearTargetCache(): void {
  cache.clear()
}
