/**
 * Reading the targets file.
 *
 * It is read on every fetch that needs it, with no cache: the file is tiny, a
 * fetch takes seconds, and "edit the recipe, fetch again" is the iteration loop
 * this feature is built around — a cache keyed on the file's timestamps would
 * eventually serve the previous recipe, which is exactly the sort of quiet
 * mistake the rest of this plugin refuses to make.
 *
 * @module dsh-web-fetch-playwright/target-store
 */

import { readFile } from 'node:fs/promises'
import { parseTargets, type Target } from './targets.ts'

/** What loading produced: the targets, or why the file is unusable. */
export type TargetLoad =
  | { readonly ok: true; readonly targets: readonly Target[] }
  | { readonly ok: false; readonly error: string }

/**
 * Load and validate the targets file.
 *
 * @param path - the configured path to the file.
 * @returns the targets, or a message naming what is wrong.
 */
export async function loadTargets(path: string): Promise<TargetLoad> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = parseTargets(text)
    return parsed.ok ? { ok: true, targets: parsed.targets } : { ok: false, error: parsed.error }
  } catch (error) {
    return { ok: false, error: `targets file could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}
