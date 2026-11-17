import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { CheckpointManager } from '../lib/checkpoints.js'
import { ConsoleRuntime } from '../lib/runtime.js'
import { createAdapter } from '../lib/sources.js'
import { PACKAGE_VERSION, pathIsWithin } from '../lib/util.js'

const workspace = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const temp = join(tmpdir(), `fishkeeper-dsh-fish-${randomBytes(4).toString('hex')}`)
const sourceRoot = join(temp, 'source')
const tankRoot = join(temp, 'fishtank')
const genericRoot = join(temp, 'generic')
await fsp.mkdir(temp, { recursive: true })
await fsp.cp(join(workspace, 'demo', 'dsh-fish'), sourceRoot, { recursive: true })
await fsp.cp(join(workspace, 'demo', 'fishtank'), tankRoot, { recursive: true })
await fsp.mkdir(join(genericRoot, 'diary'), { recursive: true })
await fsp.writeFile(join(genericRoot, 'diary', '2026-11-11.md'), '通用 md 日记：今天只写了一句。\n')

function localDate(y, m, d) {
  return new Date(y, m - 1, d).toISOString()
}

const beforeRead = await hashTree(sourceRoot)
const ctx = {
  logger: console,
  fiber: { entry: { id: 'test-entry' } },
  get: name => {
    if (name === 'configEditor') return { async edit() {} }
    return undefined
  },
}
const runtime = new ConsoleRuntime(ctx, {
  dataRoot: join(temp, 'data'),
  sources: [
    { id: 'fish', displayName: '大肥鱼', adapter: 'file', location: sourceRoot, enabled: true, options: { preset: 'dsh-fish' } },
  ],
})

// Guard every write primitive while the runtime starts, watches, reads,
// creates checkpoints, exports, and runs restore preflight. Writes under the
// console data root are fine; a write anywhere under the dsh-fish source is a
// violation of the read-only promise.
const originalWrites = new Map()
const sourceWrites = []
const isSource = value => typeof value === 'string' && value !== '' && pathIsWithin(sourceRoot, value)
const guard = (name, targetIndex = 0) => {
  if (typeof fsp[name] !== 'function') return
  const original = fsp[name]
  originalWrites.set(name, original)
  fsp[name] = async (...args) => {
    const target = args[targetIndex]
    if (isSource(target)) {
      sourceWrites.push(`${name}: ${target}`)
      throw new Error(`write to read-only dsh-fish source: ${name} ${target}`)
    }
    return original.apply(fsp, args)
  }
}
for (const name of ['writeFile', 'appendFile', 'rename', 'rm', 'mkdir', 'chmod', 'utimes', 'unlink', 'truncate', 'copyFile']) {
  guard(name, name === 'copyFile' ? 1 : 0)
}
if (typeof fsp.open === 'function') {
  const originalOpen = fsp.open
  originalWrites.set('open', originalOpen)
  fsp.open = async (target, flags, ...rest) => {
    const writes = typeof flags === 'string' && /[wax+]/u.test(flags)
    if (writes && isSource(target)) {
      sourceWrites.push(`open: ${target}`)
      throw new Error(`write handle opened on read-only dsh-fish source: ${target}`)
    }
    return originalOpen.call(fsp, target, flags, ...rest)
  }
}

try {
  await runtime.start()
} catch (error) {
  for (const [name, original] of originalWrites) fsp[name] = original
  throw error
}

const overview = await runtime.overview()
const fish = overview.sources.find(source => source.id === 'fish')
assert.equal(fish.status, 'ok')
assert.equal(fish.preset, 'dsh-fish')
assert.equal(fish.fish.day, 11)
assert.equal(fish.fish.stage, 2)
assert.equal(fish.fish.turns, 42)
assert.equal(fish.fish.lastTurnAt, '2026-11-11T12:20:00.000Z')
assert.equal(fish.fish.lastActiveAt, '2026-11-11T12:20:00.000Z')
assert.equal(fish.fish.latestDiary.at, localDate(2026, 11, 11))
assert.match(fish.fish.latestDiary.text, /薄薄的糖/u)
assert.equal(fish.fish.latestDiary.visibility, 'private')
assert.ok(fish.fish.dataBytes > 0)
assert.equal(fish.warnings.length, 2)
assert.deepEqual(fish.warningCodes.map(warning => warning.code), ['dshfish-readonly', 'dshfish-append-only'])

const info = runtime.sourceList().find(source => source.id === 'fish')
assert.equal(info.preset, 'dsh-fish')
assert.equal(info.capabilities.diary, true)
assert.equal(info.capabilities.externalEvents, true)
assert.equal(info.capabilities.restore, false)
assert.equal(info.capabilities.import, false)
assert.ok(info.capabilities.checkpoint)
const description = await runtime.sources.get('fish').adapter.describe()
const statusFile = description.files.find(file => file.role === 'status')
const eventsFile = description.files.find(file => file.role === 'memory')
const diaryFiles = description.files.filter(file => file.role === 'diary')
assert.equal(statusFile?.path, 'home.json')
assert.equal(eventsFile?.path, 'events.jsonl')
assert.equal(eventsFile?.appendOnly, true)
assert.deepEqual(diaryFiles.map(file => file.path), ['diary/2026-11-10.md', 'diary/2026-11-11.md'])
assert.ok(description.files.every(file => file.restorable === false))

const timeline = await runtime.timeline({ limit: 100 })
const diary = timeline.items.filter(item => item.sourceId === 'fish' && item.kind === 'diary')
assert.equal(diary.length, 2)
assert.deepEqual(diary.map(item => item.occurredAt), [localDate(2026, 11, 11), localDate(2026, 11, 10)])
assert.ok(diary.every(item => item.visibility === 'private'))
const events = timeline.items.filter(item => item.sourceId === 'fish' && item.kind === 'event')
assert.equal(events.length, 6)
assert.equal(events.some(item => item.eventType === 'meta'), false, 'system meta events are hidden by default')
const revise = events.find(item => item.eventType === 'revise')
assert.ok(revise, 'revise event is in the timeline')
assert.equal(revise.verdict, 'refined')
assert.equal(revise.day, 10)
assert.equal(revise.stage, 1)
assert.equal(revise.unknownTime, false)
assert.equal(events.find(item => item.eventType === 'utterance')?.day, 9)
const detail = await runtime.entry({ source: 'fish', id: revise.id })
assert.equal(detail.eventType, 'revise')
assert.equal(detail.verdict, 'refined')
assert.match(detail.textMasked, /安静就是不动/u)
assert.equal((await runtime.timeline({ q: '水面' })).items.length > 0, true)

const afterRead = await hashTree(sourceRoot)
assert.deepEqual(afterRead, beforeRead, 'reading a dsh-fish source does not modify it')

const checkpoints = runtime.sources.get('fish').checkpoints
const baselineSummary = checkpoints.list().find(item => item.baseline)
assert.ok(baselineSummary, 'dsh-fish gets a startup baseline checkpoint')
assert.equal(baselineSummary.pinned, true, 'baseline is pinned so retention cannot evict the protection start')
assert.equal(baselineSummary.files, 4, 'baseline records every tracked dsh-fish file')
const baselineDetail = checkpoints.get(baselineSummary.id)
assert.equal(baselineDetail.tool.version, PACKAGE_VERSION)
assert.ok(baselineDetail.files.every(file => file.restorable === false))
assert.ok(baselineDetail.files.some(file => file.path === 'events.jsonl' && file.changed === false))

const manual = await runtime.createCheckpoint('fish')
assert.ok(manual.checkpoint.id, 'manual checkpoint works even when nothing changed')
assert.equal(manual.checkpoint.files, 4, 'manual checkpoint snapshots all tracked files')

await assert.rejects(
  () => runtime.restoreDryRun(baselineSummary.id, undefined),
  error => error.code === 'fishkeeper/restore-unsupported',
  'dsh-fish checkpoints cannot be restored',
)
const sharePackage = await runtime.exportPackage({ sourceId: 'fish', mode: 'share', includeCheckpoints: false })
assert.ok(sharePackage.path)
const writePlan = await runtime.preflightImport({ path: sharePackage.path, mode: 'write', targetSourceId: 'fish' })
assert.equal(writePlan.verdict, 'blocked', 'dsh-fish cannot be a write-back target')
assert.ok(writePlan.findings.some(finding => finding.code === 'target-import-unsupported'))
await assert.rejects(
  () => runtime.importPackage({ path: sharePackage.path, mode: 'write', targetSourceId: 'fish' }),
  error => error.code === 'fishkeeper/confirm-invalid',
  'write-back to a dsh-fish source is refused before any write',
)

await runtime.dispose()
for (const [name, original] of originalWrites) fsp[name] = original
assert.deepEqual(sourceWrites, [], 'no write primitive touched the dsh-fish source directory')
assert.deepEqual(await hashTree(sourceRoot), beforeRead, 'runtime start/read/checkpoint/export did not modify the source')

const withSystem = await createAdapter({
  id: 'fish-system',
  displayName: '系统事件',
  adapter: 'file',
  location: sourceRoot,
  options: { preset: 'dsh-fish', includeSystemEvents: true },
}, {}, {})
const systemEvents = await withSystem.readExternalEvents()
assert.equal(systemEvents.items.length, 7)
const systemMeta = systemEvents.items.find(item => item.eventType === 'meta')
assert.ok(systemMeta, 'includeSystemEvents exposes meta events')
assert.equal(systemMeta.day, 0)

// dsh-fish events.jsonl changes on every turn/meta event. Auto checkpoints
// must only follow real diary writes; otherwise the console creates hundreds
// of hash-only manifests per day (observed: 200 retained / 415 indexed).
const autoManager = new CheckpointManager({ dataRoot: join(temp, 'auto-data'), source: { id: 'auto', location: sourceRoot }, describe: { files: [
  { role: 'status', path: 'home.json', restorable: false, format: 'json', appendOnly: false },
  { role: 'diary', path: 'diary/2026-11-11.md', restorable: false, format: 'text', appendOnly: false },
  { role: 'memory', path: 'events.jsonl', restorable: false, format: 'jsonl', appendOnly: true },
], autoCheckpointRoles: ['diary'] }, retention: {} })
await autoManager.init()
await autoManager.baseline()
await fsp.appendFile(join(sourceRoot, 'events.jsonl'), `${JSON.stringify({ id: 'ev_smoke_noise', v: 1, ts: '2026-11-11T13:00:00.000Z', day: 0, stage: 1, type: 'meta', source: 'system', text: 'seen:noise', refs: [], verdict: null, confidence: 0.5, flags: [] })}\n`)
assert.equal(await autoManager.create({ kind: 'auto' }), null, 'events-only change does not create an automatic checkpoint')
await fsp.appendFile(join(sourceRoot, 'diary', '2026-11-11.md'), '\n')
const diaryAuto = await autoManager.create({ kind: 'auto' })
assert.ok(diaryAuto, 'diary write creates an automatic checkpoint')
assert.equal(diaryAuto.trigger.kind, 'diary')
await autoManager.dispose()

const generic = await createAdapter({ id: 'generic-md', displayName: '通用 md', adapter: 'file', location: genericRoot }, {}, {})
const genericDiary = await generic.readDiary()
assert.equal(genericDiary.items.length, 1)
assert.equal(genericDiary.items[0].occurredAt, localDate(2026, 11, 11))
assert.equal(genericDiary.items[0].text, '通用 md 日记：今天只写了一句。')

const tank = await createAdapter({
  id: 'tank',
  displayName: '目标鱼',
  adapter: 'file',
  location: tankRoot,
  options: { preset: 'fishtank' },
}, {}, {})
const tankStatus = await tank.readStatus()
assert.equal(tankStatus.mood, '安静')
assert.equal(tankStatus.energy, 0.64)
const tankInfo = await tank.describe()
assert.equal(tankInfo.preset, 'fishtank')
assert.equal(tankInfo.capabilities.import, true)
const tankDiary = await tank.readDiary()
assert.equal(tankDiary.items.length, 4)

await fsp.rm(temp, { recursive: true, force: true })
console.log(JSON.stringify({
  status: { day: fish.fish.day, stage: fish.fish.stage, turns: fish.fish.turns, lastTurnAt: fish.fish.lastTurnAt },
  diary: diary.length,
  events: events.length,
  systemEvents: systemEvents.items.length,
  revise: { verdict: revise.verdict, day: revise.day, stage: revise.stage },
  readOnly: true,
  genericMarkdown: genericDiary.items[0].occurredAt,
  fishtank: { mood: tankStatus.mood, import: tankInfo.capabilities.import, diary: tankDiary.items.length },
}, null, 2))

async function hashTree(root) {
  const hashes = {}
  async function walk(dir, prefix = '') {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative)
      else if (entry.isFile()) hashes[relative] = createHash('sha256').update(await fsp.readFile(join(dir, entry.name))).digest('hex')
    }
  }
  await walk(root)
  return hashes
}
