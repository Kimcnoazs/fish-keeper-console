/**
 * Optional end-to-end check against a real dsh-fish data directory.
 *
 * Usage:
 *   node scripts/smoke-real-dsh-fish.mjs [path]
 *   FISHKEEPER_REAL_DSH_FISH=C:/Users/me/.dsh-fish node scripts/smoke-real-dsh-fish.mjs
 *
 * The script copies the data to a temporary directory first, so the real
 * directory is never opened for writing. It prints only counts and timestamps,
 * never diary or event text. When no real directory exists it exits 0 with a
 * "skipped" message so it is safe to run in CI.
 */
import { promises as fsp } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { ConsoleRuntime } from '../lib/runtime.js'

const real = process.argv[2] ?? process.env.FISHKEEPER_REAL_DSH_FISH ?? join(homedir(), '.dsh-fish')
try {
  await fsp.access(join(real, 'events.jsonl'))
} catch {
  console.log(JSON.stringify({ skipped: true, reason: `no dsh-fish data at ${real}` }, null, 2))
  process.exit(0)
}

const temp = join(tmpdir(), `fishkeeper-real-${randomBytes(4).toString('hex')}`)
const copy = join(temp, 'source')
try {
  await fsp.cp(real, copy, { recursive: true })
  const before = await hashTree(copy)
  const runtime = new ConsoleRuntime({ logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, {
    dataRoot: join(temp, 'data'),
    sources: [{ id: 'dsh-fish', displayName: '大肥鱼', adapter: 'file', location: copy, enabled: true, options: { preset: 'dsh-fish' } }],
  })
  await runtime.start()
  try {
    const overview = await runtime.overview()
    const source = overview.sources[0]
    assert.equal(source.status, 'ok')
    const fish = source.fish
    assert.ok(fish.day >= 1, 'growth day is read from events.jsonl')
    assert.ok(Number.isInteger(fish.turns), 'turns is read from home.json')
    assert.ok(fish.latestDiary?.text, 'latest diary is read from diary/*.md')
    // Date-only diary files have no timezone. They are intentionally parsed as
    // local midnight, so a data directory created in another timezone can show
    // a future local time; assert the date semantics, not the clock offset.
    assert.equal(new Date(fish.latestDiary.at).getHours(), 0, 'diary date is local midnight')
    assert.equal(fish.latestDiary.visibility, 'private')

    const all = []
    let cursor
    let pages = 0
    do {
      const page = await runtime.timeline({ limit: 200, cursor })
      all.push(...page.items)
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 20)
    const diary = all.filter(item => item.kind === 'diary')
    const events = all.filter(item => item.kind === 'event')
    assert.equal(diary.length, await countDiaryFiles(copy))
    assert.ok(events.length > 0, 'events.jsonl produces timeline entries')
    assert.ok(all.every(item => item.visibility === 'private'), 'dsh-fish entries are private')
    assert.ok(diary.every(item => new Date(item.occurredAt).getHours() === 0), 'every diary entry is local midnight')

    const checkpoints = runtime.checkpoints('dsh-fish')
    const baseline = checkpoints.items.find(item => item.baseline)
    assert.ok(baseline, 'baseline checkpoint exists')
    assert.equal(baseline.pinned, true)
    const manual = await runtime.createCheckpoint('dsh-fish')
    assert.ok(manual.checkpoint.id, 'manual checkpoint works')

    console.log(JSON.stringify({
      source: real,
      day: fish.day,
      stage: fish.stage,
      turns: fish.turns,
      lastTurnAt: fish.lastTurnAt,
      lastActiveAt: fish.lastActiveAt,
      latestDiaryAt: fish.latestDiary.at,
      diaryFiles: diary.length,
      timelineEntries: all.length,
      pages,
      events: events.length,
      baselineFiles: baseline.files,
      manualFiles: manual.checkpoint.files,
      readOnly: true,
    }, null, 2))
  } finally {
    await runtime.dispose()
  }
  assert.deepEqual(await hashTree(copy), before, 'reading the copied real data does not modify it')
} finally {
  await fsp.rm(temp, { recursive: true, force: true })
}

async function countDiaryFiles(root) {
  try {
    const entries = await fsp.readdir(join(root, 'diary'))
    return entries.filter(name => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name)).length
  } catch {
    return 0
  }
}

async function hashTree(root) {
  const out = {}
  async function walk(dir, prefix = '') {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative)
      else if (entry.isFile()) out[relative] = createHash('sha256').update(await fsp.readFile(join(dir, entry.name))).digest('hex')
    }
  }
  await walk(root)
  return out
}
