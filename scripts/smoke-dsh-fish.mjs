import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { CheckpointManager } from '../lib/checkpoints.js'
import { ConsoleRuntime } from '../lib/runtime.js'
import { createAdapter } from '../lib/sources.js'
import { PACKAGE_VERSION, pathIsWithin, sha256File } from '../lib/util.js'

const workspace = fileURLToPath(new URL('..', import.meta.url))
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

// dsh-fish creates a new diary file every day. A console that started before
// midnight must pick it up without a plugin reload.
const dynamicRuntime = new ConsoleRuntime(ctx, {
  dataRoot: join(temp, 'data-dynamic'),
  sources: [
    { id: 'fish', displayName: '大肥鱼', adapter: 'file', location: sourceRoot, enabled: true, options: { preset: 'dsh-fish' } },
  ],
})
await dynamicRuntime.start()
await fsp.writeFile(join(sourceRoot, 'diary', '2026-11-12.md'), '新的一天，今天也写了一句。\n')
const dynamicOverview = await dynamicRuntime.overview()
assert.equal(dynamicOverview.sources[0].fish.latestDiary.text, '新的一天，今天也写了一句。')
const dynamicTimeline = await dynamicRuntime.timeline({ limit: 100 })
assert.equal(dynamicTimeline.items.filter(item => item.sourceId === 'fish' && item.kind === 'diary').length, 3)
const dynamicCheckpoint = await dynamicRuntime.createCheckpoint('fish')
assert.equal(dynamicCheckpoint.checkpoint.files, 5, 'new diary file is included in a checkpoint without a reload')
await dynamicRuntime.dispose()

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

const withRoles = await createAdapter({
  id: 'fish-roles',
  displayName: '自定义触发',
  adapter: 'file',
  location: sourceRoot,
  options: { preset: 'dsh-fish', autoCheckpointRoles: ['memory', 'bogus'] },
}, {}, {})
assert.deepEqual((await withRoles.describe()).autoCheckpointRoles, ['memory'], 'explicit trigger roles are honored and filtered')

// Opt-in restore: the preset stays read-only by default, and only
// options.allowRestore turns the tracked files restorable. Restores are guarded
// by an explicit plugin-stopped confirmation plus a 30-second quiet-window
// fallback, and events.jsonl is truncated (never silently rewritten).
const restoreRoot = join(temp, 'restore-source')
await fsp.cp(join(workspace, 'demo', 'dsh-fish'), restoreRoot, { recursive: true })
const restoreAdapter = await createAdapter({
  id: 'fish-restore',
  displayName: '可回滚鱼',
  adapter: 'file',
  location: restoreRoot,
  options: { preset: 'dsh-fish', allowRestore: true },
}, {}, {})
const restoreDescription = await restoreAdapter.describe()
assert.equal(restoreDescription.capabilities.restore, true)
assert.equal(restoreDescription.capabilities.import, false, 'restore does not enable write-back import')
assert.ok(restoreDescription.files.every(file => file.restorable === true))
assert.equal(restoreDescription.files.find(file => file.role === 'memory')?.appendOnly, true)
assert.deepEqual(
  restoreDescription.warningCodes.map(warning => warning.code),
  ['dshfish-restore-enabled', 'dshfish-append-only-restore'],
)

const restoreManager = new CheckpointManager({
  dataRoot: join(temp, 'restore-data'),
  source: { id: 'fish-restore', location: restoreRoot },
  describe: restoreDescription,
  retention: {},
})
await restoreManager.init()
await restoreManager.baseline()
const restoreBaseline = await restoreManager.ensureBaselineCheckpoint()
assert.ok(restoreBaseline, 'restorable dsh-fish source gets a snapshot baseline')
const restoreEventsEntry = restoreManager.get(restoreBaseline.id).files.find(file => file.path === 'events.jsonl')
const restoreHomeEntry = restoreManager.get(restoreBaseline.id).files.find(file => file.path === 'home.json')
assert.ok(restoreEventsEntry?.before?.blob, 'events.jsonl content is snapshotted when restore is enabled')
assert.ok(restoreHomeEntry?.before?.blob)
assert.equal(restoreEventsEntry.appendOnly, true)

const restoreEventsPath = join(restoreRoot, 'events.jsonl')
const restoreHomePath = join(restoreRoot, 'home.json')
await fsp.appendFile(restoreEventsPath, `${JSON.stringify({
  id: 'ev_restore_window',
  v: 1,
  ts: '2026-11-11T13:30:00.000Z',
  day: 11,
  stage: 2,
  type: 'utterance',
  source: 'user',
  text: '回滚前刚写的一条事件',
  refs: [],
  verdict: null,
  confidence: 0.5,
  flags: [],
})}\n`)
const restoreHomeData = JSON.parse((await fsp.readFile(restoreHomePath, 'utf8')).replace(/^\uFEFF/u, ''))
assert.equal(restoreHomeData.turns, 42)

const busyNow = new Date()
await fsp.utimes(restoreEventsPath, busyNow, busyNow)
await fsp.utimes(restoreHomePath, busyNow, busyNow)
await assert.rejects(
  () => restoreManager.preflightRestore(restoreBaseline.id, ['events.jsonl', 'home.json']),
  error => error.code === 'fishkeeper/restore-busy' && /鱼正在活动/u.test(error.message),
  'a write inside the 30-second quiet window is refused',
)

const quiet = new Date(Date.now() - 31_000)
await fsp.utimes(restoreEventsPath, quiet, quiet)
await fsp.utimes(restoreHomePath, quiet, quiet)
const restorePlan = await restoreManager.preflightRestore(restoreBaseline.id, ['events.jsonl', 'home.json'])
const eventsPlan = restorePlan.files.find(file => file.path === 'events.jsonl')
assert.equal(eventsPlan.mode, 'truncate', 'an appended events.jsonl rolls back by truncation')
assert.equal(eventsPlan.stale, false, 'appends after the checkpoint do not count as stale')
assert.equal(eventsPlan.truncateBytes, restoreEventsEntry.before.bytes)
assert.equal(restorePlan.files.find(file => file.path === 'home.json')?.action, 'restore')

const restored = await restoreManager.restore(restoreBaseline.id, ['events.jsonl', 'home.json'])
assert.equal(restored.ok, true)
assert.ok(restored.safetyCheckpointId, 'a pre-restore safety checkpoint is created')
assert.equal(await sha256File(restoreEventsPath), restoreEventsEntry.before.sha256)
assert.equal(await sha256File(restoreHomePath), restoreHomeEntry.before.sha256)
const safetyManifest = restoreManager.get(restored.safetyCheckpointId)
assert.equal(safetyManifest.files.length, restoreManager.get(restoreBaseline.id).files.length, 'the safety checkpoint covers the whole dsh-fish state')
assert.ok(safetyManifest.files.every(file => file.mode === 'snapshot'))

// A file whose content no longer extends the checkpoint can only be replaced
// as a whole, and that replacement must be confirmed explicitly.
await fsp.writeFile(restoreEventsPath, `rewritten\n${await fsp.readFile(restoreEventsPath, 'utf8')}`)
await fsp.utimes(restoreEventsPath, quiet, quiet)
await fsp.utimes(restoreHomePath, quiet, quiet)
const replacePlan = await restoreManager.preflightRestore(restoreBaseline.id, ['events.jsonl'])
const replaceEvents = replacePlan.files.find(file => file.path === 'events.jsonl')
assert.equal(replaceEvents.mode, 'replace')
assert.equal(replaceEvents.stale, true)
await assert.rejects(
  () => restoreManager.restore(restoreBaseline.id, ['events.jsonl']),
  error => error.code === 'fishkeeper/restore-stale',
  'whole-file replacement is refused without explicit confirmation',
)
const replaced = await restoreManager.restore(restoreBaseline.id, ['events.jsonl'], { overrideStale: true })
assert.equal(replaced.ok, true)
assert.equal(await sha256File(restoreEventsPath), restoreEventsEntry.before.sha256)
await restoreManager.dispose()

// Runtime-level gate: an explicit "plugin is disabled" confirmation is the
// primary guard; the mtime check runs again at execute time as a fallback.
const runtimeRestoreRoot = join(temp, 'restore-runtime-source')
await fsp.cp(join(workspace, 'demo', 'dsh-fish'), runtimeRestoreRoot, { recursive: true })
const restoreRuntime = new ConsoleRuntime(ctx, {
  dataRoot: join(temp, 'restore-runtime-data'),
  sources: [
    { id: 'fish', displayName: '回滚鱼', adapter: 'file', location: runtimeRestoreRoot, enabled: true, options: { preset: 'dsh-fish', allowRestore: true } },
  ],
})
await restoreRuntime.start()
try {
  const restoreSourceInfo = restoreRuntime.sourceList().find(source => source.id === 'fish')
  assert.equal(restoreSourceInfo.capabilities.restore, true)
  const restoreList = restoreRuntime.checkpoints('fish')
  assert.equal(restoreList.restoreSupported, true)
  const runtimeBaseline = restoreList.items.find(item => item.baseline)
  assert.ok(runtimeBaseline)
  const runtimeManifest = restoreRuntime.checkpointDetail(runtimeBaseline.id).manifest
  const runtimeEventsEntry = runtimeManifest.files.find(file => file.path === 'events.jsonl')
  const runtimeHomeEntry = runtimeManifest.files.find(file => file.path === 'home.json')
  const runtimeEventsPath = join(runtimeRestoreRoot, 'events.jsonl')
  const runtimeHomePath = join(runtimeRestoreRoot, 'home.json')
  await fsp.appendFile(runtimeEventsPath, `${JSON.stringify({
    id: 'ev_restore_runtime',
    v: 1,
    ts: '2026-11-11T13:40:00.000Z',
    day: 11,
    stage: 2,
    type: 'utterance',
    source: 'user',
    text: '运行时回滚测试事件',
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
  })}\n`)
  const runtimeHomeData = JSON.parse((await fsp.readFile(runtimeHomePath, 'utf8')).replace(/^\uFEFF/u, ''))
  assert.equal(runtimeHomeData.turns, 42)
  const runtimeBusy = new Date()
  await fsp.utimes(runtimeEventsPath, runtimeBusy, runtimeBusy)
  await fsp.utimes(runtimeHomePath, runtimeBusy, runtimeBusy)
  await assert.rejects(
    () => restoreRuntime.restoreDryRun(runtimeBaseline.id, ['events.jsonl', 'home.json']),
    error => error.code === 'fishkeeper/restore-busy',
  )
  await fsp.utimes(runtimeEventsPath, quiet, quiet)
  await fsp.utimes(runtimeHomePath, quiet, quiet)
  const runtimePlan = await restoreRuntime.restoreDryRun(runtimeBaseline.id, ['events.jsonl', 'home.json'])
  assert.equal(runtimePlan.requiresPluginStopped, true)
  assert.equal(runtimePlan.reenablePluginAfterRestore, true)
  await assert.rejects(
    () => restoreRuntime.restoreExecute({
      id: runtimeBaseline.id,
      paths: ['events.jsonl', 'home.json'],
      confirmToken: runtimePlan.confirmToken,
    }),
    error => error.code === 'fishkeeper/restore-plugin-active',
    'restore is refused until the user confirms the plugin is disabled',
  )
  const confirmedPlan = await restoreRuntime.restoreDryRun(runtimeBaseline.id, ['events.jsonl', 'home.json'])
  const runtimeRestored = await restoreRuntime.restoreExecute({
    id: runtimeBaseline.id,
    paths: ['events.jsonl', 'home.json'],
    confirmToken: confirmedPlan.confirmToken,
    pluginStopped: true,
  })
  assert.equal(runtimeRestored.ok, true)
  assert.equal(runtimeRestored.reenablePlugin, true)
  assert.equal(await sha256File(runtimeEventsPath), runtimeEventsEntry.before.sha256)
  assert.equal(await sha256File(runtimeHomePath), runtimeHomeEntry.before.sha256)
} finally {
  await restoreRuntime.dispose()
}

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
