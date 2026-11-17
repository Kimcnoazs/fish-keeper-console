import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { ConsoleRuntime } from '../lib/runtime.js'
import { createAdapter } from '../lib/sources.js'

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
await runtime.start()

const overview = await runtime.overview()
const fish = overview.sources.find(source => source.id === 'fish')
assert.equal(fish.status, 'ok')
assert.equal(fish.preset, 'dsh-fish')
assert.equal(fish.fish.day, 11)
assert.equal(fish.fish.stage, 2)
assert.equal(fish.fish.turns, 42)
assert.equal(fish.fish.lastTurnAt, '2026-11-11T12:20:00.000Z')
assert.equal(fish.fish.lastActiveAt, '2026-11-11T12:20:00.000Z')
assert.equal(fish.fish.latestDiary.at, '2026-11-11T00:00:00.000Z')
assert.match(fish.fish.latestDiary.text, /薄薄的糖/u)
assert.equal(fish.fish.latestDiary.visibility, 'private')
assert.ok(fish.fish.dataBytes > 0)
assert.equal(fish.warnings.length, 2)

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
assert.deepEqual(diary.map(item => item.occurredAt), ['2026-11-11T00:00:00.000Z', '2026-11-10T00:00:00.000Z'])
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
await runtime.dispose()

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

const generic = await createAdapter({ id: 'generic-md', displayName: '通用 md', adapter: 'file', location: genericRoot }, {}, {})
const genericDiary = await generic.readDiary()
assert.equal(genericDiary.items.length, 1)
assert.equal(genericDiary.items[0].occurredAt, '2026-11-11T00:00:00.000Z')
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
