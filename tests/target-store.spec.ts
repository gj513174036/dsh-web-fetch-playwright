/**
 * Reading the targets file.
 *
 * The behaviour that matters is the iteration loop: edit the file, fetch again,
 * and see the change. It is read fresh every time, and a file it cannot read is
 * reported rather than guessed at.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadTargets } from '../src/target-store.ts'

const dirs: string[] = []

function scratch(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-target-store-'))
  dirs.push(dir)
  const file = join(dir, 'targets.json')
  writeFileSync(file, contents, 'utf8')
  return file
}

const valid = (name: string): string =>
  `{ "targets": [ { "name": "${name}", "match": { "kind": "prefix", "url": "https://a.example/x" }, "actions": [ { "verb": "waitFor", "condition": { "kind": "time", "ms": 1 } } ] } ] }`

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadTargets', () => {
  it('reads a file', async () => {
    const load = await loadTargets(scratch(valid('first')))
    expect(load.ok).toBe(true)
    expect(load.ok && load.targets[0]?.name).toBe('first')
  })

  it('picks up an edit', async () => {
    const file = scratch(valid('first'))
    expect((await loadTargets(file)).ok).toBe(true)
    writeFileSync(file, valid('second'), 'utf8')
    const again = await loadTargets(file)
    expect(again.ok && again.targets[0]?.name).toBe('second')
  })

  it('reports an invalid file rather than a stale or empty result', async () => {
    const load = await loadTargets(scratch('{ not json }'))
    expect(load.ok).toBe(false)
    expect(load.ok ? '' : load.error).toContain('not valid JSON')
  })

  it('reports a file it cannot read', async () => {
    const load = await loadTargets(join(tmpdir(), 'dsh-target-store-absent', 'none.json'))
    expect(load.ok).toBe(false)
    expect(load.ok ? '' : load.error).toContain('could not be read')
  })
})
