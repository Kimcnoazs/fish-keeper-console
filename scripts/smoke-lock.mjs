import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { ConsoleRuntime } from '../lib/runtime.js'

const workspace = fileURLToPath(new URL('..', import.meta.url))
const temp = join(tmpdir(), `fishkeeper-lock-${randomBytes(4).toString('hex')}`)
await fsp.mkdir(temp, { recursive: true })
const sourceRoot = join(temp, 'fish-a')
await fsp.cp(join(workspace, 'demo', 'fish-a'), sourceRoot, { recursive: true })
const dataRoot = join(temp, 'data')
const config = {
  dataRoot,
  sources: [{ id: 'a', displayName: 'Aurora', adapter: 'file', location: sourceRoot, enabled: true, options: {} }],
}
const ctx = { logger: console, get: () => undefined }
const first = new ConsoleRuntime(ctx, config)
await first.start()

// A stale staging directory is normally cleaned on writer startup. A
// read-only second instance must not touch it (FR-CP-10 / AC-CP-04).
const staleStaging = join(dataRoot, 'checkpoints', 'a', '.staging', 'sentinel.txt')
await fsp.mkdir(dirname(staleStaging), { recursive: true })
await fsp.writeFile(staleStaging, 'stale')
const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
await fsp.utimes(staleStaging, old, old)

const second = new ConsoleRuntime(ctx, config)
await second.start()
const overview = await second.overview()
assert.equal(overview.sources[0].readOnly, true)
await assert.rejects(() => second.createCheckpoint('a'), error => error.code === 'fishkeeper/lock-held')
assert.equal(first.checkpoints('a').readOnly, false)
await fsp.access(staleStaging)
assert.equal(second.sources.get('a').checkpoints.list().length, first.sources.get('a').checkpoints.list().length)
await first.dispose()
await second.dispose()
await fsp.rm(temp, { recursive: true, force: true })
console.log(JSON.stringify({ firstMode: 'writer', secondReadOnly: true, secondWriteDenied: true }, null, 2))
