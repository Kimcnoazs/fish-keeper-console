import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { ConsoleRuntime } from '../lib/runtime.js'

const workspace = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const temp = join(tmpdir(), `fishkeeper-runtime-${randomBytes(4).toString('hex')}`)
await fsp.mkdir(temp, { recursive: true })
const a = join(temp, 'fish-a')
const b = join(temp, 'fish-b')
await fsp.cp(join(workspace, 'demo', 'fish-a'), a, { recursive: true })
await fsp.cp(join(workspace, 'demo', 'fish-b'), b, { recursive: true })
await fsp.appendFile(join(a, 'diary', '2026-11-11.jsonl'), '{bad line\n')
await fsp.appendFile(join(b, 'diary.jsonl'), `${JSON.stringify({ id: 'b-custom', time: '2026-11-11T13:00:00Z', text: '这里出现 SMOKE-RULE 词', private: true })}\n`)
const dataRoot = join(temp, 'data')
const ctx = { logger: console, get: () => undefined }
const runtime = new ConsoleRuntime(ctx, {
  dataRoot,
  sources: [
    { id: 'a', displayName: 'Aurora', adapter: 'file', location: a, enabled: true, options: {} },
    { id: 'b', displayName: 'Mira', adapter: 'file', location: b, enabled: true, options: {} },
  ],
})
await runtime.start()
const overview = await runtime.overview()
assert.equal(overview.sources.length, 2)
assert.equal(overview.sources[0].status, 'ok')
assert.equal(overview.sources[0].capabilities?.checkpoint, true)
const timeline = await runtime.timeline({ limit: 50 })
assert.ok(timeline.items.length >= 8)
assert.ok(timeline.items.some(item => item.hits.length > 0))
assert.equal(timeline.parseErrors, 1, 'timeline reports unparseable JSONL lines')
const checkpoints = runtime.checkpoints('a')
assert.ok(checkpoints.items.length >= 1)
const manual = await runtime.createCheckpoint('a')
assert.ok(manual.checkpoint.id)
const detail = runtime.checkpointDetail(manual.checkpoint.id)
assert.ok(detail.manifest)
const exported = await runtime.exportPackage({ sourceId: 'a', mode: 'full', includeCheckpoints: true })
assert.ok(exported.path.endsWith('.fishkeeper'))
const preflight = await runtime.preflightImport(exported.path)
assert.equal(preflight.verdict, 'ok')
const imported = await runtime.importPackage(exported.path)
assert.equal(imported.ok, true)
const overwritePreflight = await runtime.preflightImport(exported.path)
assert.equal(overwritePreflight.overwrite, true)
await assert.rejects(
  () => runtime.importPackage(exported.path),
  error => error.code === 'fishkeeper/import-overwrite-required',
)
const importedAgain = await runtime.importPackage({ path: exported.path, overwrite: true })
assert.equal(importedAgain.ok, true)
const recoveryBackup = `${importedAgain.importedPath}.previous-123`
await fsp.rename(importedAgain.importedPath, recoveryBackup)
await runtime.migration.recover()
assert.ok((await fsp.stat(importedAgain.importedPath)).isDirectory(), 'interrupted import backup is recovered on startup')
const doctor = await runtime.doctor()
assert.ok(doctor.checks.length > 3)
assert.ok(doctor.checks.some(check => check.id === 'source.a.writable'), 'doctor checks source writability')
assert.ok(doctor.checks.every(check => typeof check.titleKey === 'string'), 'doctor checks carry i18n keys')
await runtime.dispose()

const rulesRuntime = new ConsoleRuntime(ctx, {
  dataRoot: join(temp, 'data-rules'),
  rules: [{ id: 'custom.smoke', category: 'custom', severity: 'high', enabled: true, kind: 'keyword', keywords: ['SMOKE-RULE'], mask: 'partial' }],
  sources: [
    { id: 'b', displayName: 'Mira', adapter: 'file', location: b, enabled: true, options: {} },
  ],
})
await rulesRuntime.start()
const customTimeline = await rulesRuntime.timeline({ q: 'SMOKE-RULE' })
assert.equal(customTimeline.items.length, 1)
assert.equal(customTimeline.items[0].hits[0]?.ruleId, 'custom.smoke')
await rulesRuntime.dispose()
await fsp.rm(temp, { recursive: true, force: true })
console.log(JSON.stringify({
  overview: overview.sources.map(source => ({ id: source.id, status: source.status, diary: source.fish?.latestDiary?.text?.slice(0, 12) })),
  timeline: timeline.items.length,
  risky: timeline.items.filter(item => item.hits.length > 0).length,
  checkpoint: manual.checkpoint.id,
  exportBytes: exported.bytes,
  preflight: preflight.verdict,
  importPath: imported.importedPath,
  doctor: doctor.overall,
  customRuleHits: customTimeline.items[0].hits.map(hit => hit.ruleId),
}, null, 2))
