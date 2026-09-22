/**
 * Emit jsdom's synchronous-XHR worker placeholder next to the host bundle.
 *
 * jsdom's `XMLHttpRequest-impl` runs `require.resolve("./xhr-sync-worker.js")`
 * while the module loads, to locate the child process it forks when synchronous
 * XHR is used. The host bundle inlines jsdom, so that file no longer sits beside
 * the bundled code and the resolve throws — which fails the whole plugin import
 * before any of our code runs.
 *
 * The denoise pipeline never issues a synchronous XHR, so a placeholder that
 * explains itself satisfies the resolve and stays honest if it is ever executed.
 *
 * @module scripts/emit-jsdom-sync-worker-stub
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MESSAGE = 'dsh-web-fetch-playwright: synchronous XHR is not supported in this bundle'

writeFileSync(
  join('lib', 'xhr-sync-worker.js'),
  `throw new Error(${JSON.stringify(MESSAGE)})\n`,
)
