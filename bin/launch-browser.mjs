#!/usr/bin/env node
/**
 * `dsh-web-fetch-launch` — start a local, VISIBLE browser for the CDP/tunnel
 * topology: your real Chrome, a COPY of your real profile, an outbound proxy
 * taken from the very settings section the plugin card writes, a loopback
 * DevTools port, and (printed for you) the reverse tunnel command that carries
 * that port to the server the plugin runs on.
 *
 * This file is a SHIM and nothing else: every decision — parsing argv, reading
 * the settings section, planning, copying the profile (including the `--force`
 * intent), and running the browser — happens in `runLauncher` in the plugin's
 * `src/launcher.ts`. Keeping the entry path in the library is what makes it
 * testable: the suite drives `runLauncher`, and (when a build exists) this very
 * script, so a refactor that drifts from the tested call sequence fails a test
 * instead of hiding behind a hand-copied one.
 *
 * It imports the BUILT plugin (`lib/index.js`), which the published package
 * ships and a checkout produces with `pnpm build`.
 *
 *   node bin/launch-browser.mjs --dry-run
 *   node bin/launch-browser.mjs --profile "$HOME/.config/google-chrome"
 *   dsh-web-fetch-launch --headful --proxy http://127.0.0.1:7890
 *
 * Refusing to touch an existing copy target is the DEFAULT: pass `--force` to
 * overwrite one. Proxy credentials from the settings card cannot ride a
 * Chromium command line — the plan says so in its warnings, and the README
 * documents the auth-free alternatives.
 */
import { spawn } from 'node:child_process'

let api
try {
  api = await import('../lib/index.js')
} catch (error) {
  console.error('dsh-web-fetch-launch needs the built plugin: run `pnpm build` in this checkout first (the published package already ships lib/).')
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
}

if (typeof api.runLauncher !== 'function') {
  // A lib/ built before this shim's entry function existed: say so instead of
  // dying with a TypeError that looks like a plugin bug.
  console.error('the installed lib/ is stale (it does not export runLauncher): run `pnpm build` in this checkout, or reinstall the package.')
  process.exit(1)
}

const result = await api.runLauncher(process.argv.slice(2), process.env, {
  out: line => { console.log(line) },
  err: line => { console.error(line) },
  run: (executable, args) => new Promise(resolve => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    child.on('error', (error) => {
      console.error(`error: cannot run ${executable}: ${error.message}`)
      resolve(2)
    })
    child.on('exit', (code, signal) => {
      if (signal !== null) console.error(`browser stopped by ${signal}`)
      resolve(code ?? 0)
    })
  }),
})
process.exitCode = result.code
