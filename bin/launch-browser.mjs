#!/usr/bin/env node
/**
 * `dsh-web-fetch-launch` — start a local, VISIBLE browser for the CDP/tunnel
 * topology: your real Chrome, a COPY of your real profile, an outbound proxy
 * taken from the very settings section the plugin card writes, a loopback
 * DevTools port, and (printed for you) the reverse tunnel command that carries
 * that port to the server the plugin runs on.
 *
 * The whole decision logic lives in the plugin's own `src/launcher.ts`, so the
 * card's read-only preview and this command can never disagree; this file is
 * only argv → plan → copy → spawn. It imports the BUILT plugin (`lib/index.js`),
 * which the published package ships and a checkout produces with `pnpm build`.
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

let flags
try {
  flags = api.parseLauncherArgs(process.argv.slice(2))
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
if (flags.help) {
  console.log(api.launcherUsage())
  process.exit(0)
}

const settingsFile = flags.settingsFile ?? api.resolveSettingsPath()
const { settings, found } = api.readSettingsSection(settingsFile)

let plan
try {
  plan = api.planLauncher(flags, settings)
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

console.error(`settings: ${settingsFile} ${found ? '(read)' : '(not found — running on flags and defaults)'}`)
for (const note of plan.notes) console.error(`  ${note}`)
for (const warning of plan.warnings) console.error(`warning: ${warning}`)

if (plan.copyProfile) {
  try {
    const report = api.copyProfile(plan.profileSource, plan.userDataDir, { force: flags.force === true })
    console.error(`profile copy: ${report.source} → ${report.destination} (locks, caches, and crash dumps excluded)`)
    if (report.sourceInUse) {
      console.error('warning: the source profile looks like it is in use (SingletonLock present) — the copy may be inconsistent; close that browser for a clean snapshot.')
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
} else {
  console.error(`profile: using ${plan.userDataDir} as-is`)
}

if (flags.dryRun) {
  console.log(plan.command)
  console.error(`would expose CDP on ${plan.endpoint}; from the plugin host, reach it with:`)
  console.error(`  ${api.TUNNEL_HINT}`)
  process.exit(0)
}

console.error(`launching ${plan.executable} · ${plan.headless ? 'headless' : 'headful'} · CDP ${plan.endpoint} · profile ${plan.userDataDir}`)
console.error('from the plugin host, reach this browser with:')
console.error(`  ${api.TUNNEL_HINT}`)

const child = spawn(plan.executable, plan.args, { stdio: 'inherit' })
child.on('error', (error) => {
  console.error(`error: cannot run ${plan.executable}: ${error.message}`)
  process.exitCode = 2
})
child.on('exit', (code, signal) => {
  if (signal !== null) console.error(`browser stopped by ${signal}`)
  process.exitCode = code ?? 0
})
