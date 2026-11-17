import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  POSIX,
  fileSizeSum,
  firstDefined,
  isLoopbackUrl,
  listMatchingFiles,
  modeString,
  nowIso,
  parseTime,
  readJsonSafe,
  readJsonStrict,
  resolveWithin,
  statSafe,
  toPosixPath,
  withTimeout,
} from './util.js'

const MAX_DIARY_FILE_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 5000
const DEFAULT_INACTIVITY_HOURS = 24
const DSH_FISH_PRESET = 'dsh-fish'
const MARKDOWN_DIARY_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/u

export async function createAdapter(source, options = {}, deps = {}) {
  if (source.adapter === 'http') return createHttpAdapter(source, deps)
  if (source.adapter === 'file') return createFileAdapter(source)
  throw adapterError('fishkeeper/source-invalid', `Unknown adapter "${source.adapter}".`, { sourceId: source.id })
}

function adapterError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

function isMetadataHost(host) {
  const value = host.replace(/^\[|\]$/gu, '').toLowerCase()
  return value === '169.254.169.254'
    || value === 'metadata.google.internal'
    || value === 'fd00:ec2::254'
    || value.startsWith('169.254.')
    || value.startsWith('fe80:')
    || value.startsWith('fd00:ec2:')
}

async function createFileAdapter(source) {
  const root = source.location
  const rootStat = await statSafe(root)
  if (!rootStat || !rootStat.isDirectory()) {
    throw adapterError('fishkeeper/source-unreadable', `Data directory does not exist: ${root}`, { sourceId: source.id, path: root })
  }
  const preset = source.options?.preset === 'fishtank'
    ? 'fishtank'
    : source.options?.preset === DSH_FISH_PRESET
      ? DSH_FISH_PRESET
      : undefined
  const layout = preset === 'fishtank'
    ? fishtankLayout(source.options ?? {})
    : preset === DSH_FISH_PRESET
      ? await dshFishLayout(root, source.options ?? {})
      : await detectLayout(root, source.options ?? {})
  for (const relative of presetTrackedPaths(preset, layout)) {
    try {
      await resolveWithin(root, relative)
    } catch {
      throw adapterError('fishkeeper/source-invalid', `Preset ${preset} path must stay inside the data directory: ${relative}`, {
        sourceId: source.id,
        path: relative,
      })
    }
  }
  const files = preset === 'fishtank'
    ? [{ role: 'status', path: layout.status, restorable: true, format: 'json', appendOnly: false }]
    : preset === DSH_FISH_PRESET
      ? dshFishFiles(layout)
      : describeFiles(layout)
  const absolute = file => {
    const relativePath = typeof file === 'string' ? file : file.path
    return join(root, ...relativePath.split('/'))
  }
  async function readStatusJson(relative) {
    try {
      return await readJsonStrict(absolute(relative))
    } catch (error) {
      if (error && error.code === 'fishkeeper/source-invalid') {
        throw adapterError('fishkeeper/source-invalid', `Cannot parse ${relative}: ${error.message}`, {
          sourceId: source.id,
          path: relative,
        })
      }
      throw adapterError('fishkeeper/source-unreadable', `Cannot read ${relative}: ${error.message}`, {
        sourceId: source.id,
        path: relative,
      })
    }
  }
  const embeddedStatus = preset ? await readJsonSafe(absolute(layout.status)) : undefined
  const embeddedCreatedAt = embeddedStatus?.createdAt
  const identityHash = preset && (typeof embeddedCreatedAt === 'number' || typeof embeddedCreatedAt === 'string')
    ? createHash('sha256').update(`${preset}\0${embeddedCreatedAt}`).digest('hex')
    : undefined

  async function currentDshFishDiaryFiles() {
    if (preset !== DSH_FISH_PRESET) return layout.diary
    return await listDshFishDiary(root, source.options ?? {}, layout.diaryPattern)
  }

  async function readDiary() {
    if (preset === 'fishtank') return readEmbeddedDiary()
    const entries = []
    let truncated = false
    let skipped = 0
    const diaryFiles = await currentDshFishDiaryFiles()
    for (const file of diaryFiles) {
      if (file.includes('*')) continue
      const result = await readDiaryFile(join(root, ...file.split('/')), file, MAX_DIARY_FILE_BYTES)
      truncated ||= result.truncated
      skipped += result.skipped ?? 0
      for (const record of result.items) {
        const normalized = normalizeDiary(record, source, file)
        if (normalized) entries.push(normalized)
      }
    }
    const deduped = dedupe(entries)
    deduped.sort((left, right) => compareEntries(left, right))
    return { items: deduped.slice(0, MAX_ENTRIES), truncated: truncated || deduped.length > MAX_ENTRIES, skipped }
  }

  async function readEmbeddedDiary() {
    const data = await readStatusJson(layout.status)
    const records = getPath(data, layout.diaryField)
    const entries = []
    if (Array.isArray(records)) {
      records.forEach((record, index) => {
        const normalized = normalizeEmbeddedDiary(record, source, layout, index)
        if (normalized) entries.push(normalized)
      })
    }
    const deduped = dedupe(entries)
    deduped.sort((left, right) => compareEntries(left, right))
    return { items: deduped.slice(0, MAX_ENTRIES), truncated: deduped.length > MAX_ENTRIES, skipped: 0 }
  }

  async function readExternalEvents() {
    if (preset === 'fishtank') return { items: [], truncated: false, skipped: 0 }
    if (preset === DSH_FISH_PRESET) return readDshFishEvents()
    const entries = []
    let truncated = false
    let skipped = 0
    for (const file of layout.external) {
      const result = await readRecords(join(root, ...file.split('/')), MAX_DIARY_FILE_BYTES)
      truncated ||= result.truncated
      skipped += result.skipped ?? 0
      for (const record of result.items) {
        const normalized = normalizeExternal(record, source, file)
        if (normalized) entries.push(normalized)
      }
    }
    const deduped = dedupe(entries)
    deduped.sort((left, right) => compareEntries(left, right))
    return { items: deduped.slice(0, MAX_ENTRIES), truncated: truncated || deduped.length > MAX_ENTRIES, skipped }
  }

  async function readDshFishEvents() {
    if (!layout.events) return { items: [], truncated: false, skipped: 0 }
    const result = await readRecords(join(root, ...layout.events.split('/')), MAX_DIARY_FILE_BYTES)
    const includeSystemEvents = source.options?.includeSystemEvents === true
    const entries = []
    result.items.forEach((record, index) => {
      const normalized = normalizeDshFishEvent(record, source, layout.events, index, includeSystemEvents)
      if (normalized) entries.push(normalized)
    })
    const deduped = dedupe(entries)
    deduped.sort((left, right) => compareEntries(left, right))
    return { items: deduped.slice(0, MAX_ENTRIES), truncated: result.truncated || deduped.length > MAX_ENTRIES, skipped: result.skipped ?? 0 }
  }

  async function readStatus() {
    if (preset === 'fishtank') return readFishtankStatus()
    if (preset === DSH_FISH_PRESET) return readDshFishStatus()
    const status = layout.status ? await readStatusJson(layout.status) : undefined
    const fish = status && typeof status === 'object'
      ? (status.fish && typeof status.fish === 'object' ? status.fish : status)
      : {}
    const diary = await readDiary()
    const latestDiary = diary.items[0]
    const external = await readExternalEvents()
    const lastActiveAt = parseTime(firstDefined(fish, [
      'updatedAt', 'lastActiveAt', 'last_active_at', 'lastActive', 'updated_at',
    ])) ?? latestDiary?.occurredAt ?? external.items[0]?.occurredAt
    const mood = firstDefined(fish, ['mood', 'emotion', 'feeling', 'state'])
    const rawEnergy = firstDefined(fish, ['energy', 'stamina', 'vitality'])
    const energy = normalizeEnergy(rawEnergy)
    const whisperRaw = firstDefined(fish, ['lastWhisper', 'last_whisper', 'whisper'])
    const latestWhisper = normalizeWhisper(whisperRaw)
    const channels = await buildChannels(source, external.items)
    let dataBytes = 0
    try {
      dataBytes = await fileSizeSum(files.map(file => absolute(file)))
    } catch {
      dataBytes = undefined
    }
    return {
      observedAt: nowIso(),
      lastActiveAt,
      mood: typeof mood === 'string' ? mood : undefined,
      energy,
      latestDiary: latestDiary
        ? { at: latestDiary.occurredAt, text: latestDiary.text, visibility: latestDiary.visibility }
        : undefined,
      latestWhisper,
      channels,
      dataPath: root,
      dataBytes,
      name: typeof fish.name === 'string' ? fish.name : source.displayName,
    }
  }

  async function readFishtankStatus() {
    const data = (await readStatusJson(layout.status)) ?? {}
    const diary = await readEmbeddedDiary()
    const latestDiary = diary.items[0]
    const whispers = getPath(data, layout.whisperField)
    const whisperList = Array.isArray(whispers) ? whispers : []
    const history = Array.isArray(data.history) ? data.history : []
    const reflections = Array.isArray(data.reflections) ? data.reflections : []
    const lastActiveAt = [
      ...history.map(item => item?.at),
      ...whisperList.map(item => item?.at),
      ...reflections.map(item => item?.at),
    ]
      .map(parseTime)
      .filter(Boolean)
      .sort()
      .at(-1)
    const statusStat = await statSafe(absolute(layout.status))
    return {
      observedAt: nowIso(),
      lastActiveAt: lastActiveAt ?? latestDiary?.occurredAt,
      mood: stringValue(getPath(data, layout.mood)),
      energy: normalizeEnergy(getPath(data, layout.energy)),
      latestDiary: latestDiary
        ? { at: latestDiary.occurredAt, text: latestDiary.text, visibility: latestDiary.visibility }
        : undefined,
      latestWhisper: normalizeWhisper(whisperList.at(-1)),
      channels: [],
      dataPath: root,
      dataBytes: statusStat?.size ?? 0,
      name: typeof data.self?.name === 'string' ? data.self.name : source.displayName,
    }
  }

  async function readDshFishStatus() {
    const home = layout.status ? await readStatusJson(layout.status) : undefined
    const diary = await readDiary()
    const latestDiary = diary.items[0]
    const external = await readExternalEvents()
    const latestEvent = external.items[0]
    const growth = latestGrowthEvent(external.items)
    const rawLastTurnAt = Number(home?.lastTurnAt)
    const lastTurnAt = Number.isFinite(rawLastTurnAt) && rawLastTurnAt > 0 ? parseTime(rawLastTurnAt) : undefined
    const lastActiveAt = [
      lastTurnAt,
      latestEvent?.occurredAt,
      latestDiary?.occurredAt,
    ].filter(Boolean).sort().at(-1)
    let dataBytes = 0
    try {
      const diaryFiles = await currentDshFishDiaryFiles()
      const tracked = [
        ...(layout.status ? [{ path: layout.status }] : []),
        ...diaryFiles.map(path => ({ path })),
        ...(layout.events ? [{ path: layout.events }] : []),
      ]
      dataBytes = await fileSizeSum(tracked.map(file => absolute(file)))
    } catch {
      dataBytes = undefined
    }
    return {
      observedAt: nowIso(),
      lastActiveAt,
      day: growth?.day,
      stage: growth?.stage,
      turns: Number.isFinite(Number(home?.turns)) ? Math.max(0, Math.trunc(Number(home.turns))) : undefined,
      lastTurnAt,
      latestDiary: latestDiary
        ? { at: latestDiary.occurredAt, text: latestDiary.text, visibility: latestDiary.visibility }
        : undefined,
      latestWhisper: undefined,
      channels: [],
      dataPath: root,
      dataBytes,
      name: source.displayName,
    }
  }

  const defaultAutoCheckpointRoles = preset === 'fishtank'
    ? []
    : preset === DSH_FISH_PRESET
      ? ['diary']
      : ['diary', 'persona', 'memory']
  const configuredAutoCheckpointRoles = Array.isArray(source.options?.autoCheckpointRoles)
    ? source.options.autoCheckpointRoles.filter(role => ['diary', 'persona', 'memory'].includes(role))
    : undefined

  const warnings = []
  const warningCodes = []
  if (preset === 'fishtank') {
    warnings.push('dsh-fishtank keeps every field in fish.json; automatic checkpoints (diary/persona/memory files) are therefore disabled for this preset.')
    warnings.push('While dsh-fishtank is running it holds state in memory and saves with a debounce, so an external write to fish.json can be overwritten. Reload the fish plugin after import or restore.')
    warningCodes.push({ code: 'fishtank-embedded' }, { code: 'fishtank-running' })
  }
  if (preset === DSH_FISH_PRESET) {
    warnings.push('dsh-fish sources are read-only here: diary/*.md, events.jsonl and home.json are never written, imported, or restored.')
    warnings.push('events.jsonl is the append-only source of truth; checkpoints record its hash only, because this preset declares no restorable files.')
    warningCodes.push({ code: 'dshfish-readonly' }, { code: 'dshfish-append-only' })
  }

  return {
    kind: 'file',
    source,
    root,
    preset,
    async describe() {
      // dsh-fish creates a new diary/YYYY-MM-DD.md every day. Re-expand the
      // pattern so a long-running console sees today's file without a reload.
      const currentFiles = preset === DSH_FISH_PRESET
        ? dshFishFiles({ ...layout, diary: await currentDshFishDiaryFiles() })
        : files
      return {
        id: source.id,
        adapter: 'file',
        displayName: source.displayName,
        root,
        preset,
        identityHash,
        capabilities: {
          status: true,
          diary: preset === 'fishtank' || preset === DSH_FISH_PRESET
            ? true
            : currentFiles.some(file => file.role === 'diary'),
          externalEvents: preset === 'fishtank'
            ? false
            : preset === DSH_FISH_PRESET
              ? Boolean(layout.events)
              : layout.external.length > 0,
          checkpoint: true,
          restore: currentFiles.some(file => file.restorable),
          import: preset === DSH_FISH_PRESET
            ? false
            : preset === 'fishtank' || source.options?.allowImport === true,
        },
        files: currentFiles,
        watchPatterns: preset === DSH_FISH_PRESET && layout.diaryPattern
          ? [{ pattern: layout.diaryPattern, role: 'diary' }]
          : [],
        warnings,
        warningCodes,
        // Only restorable, meaningful changes deserve an automatic checkpoint.
        // dsh-fish's events.jsonl is an append-only, non-restorable source of
        // truth that changes on every turn/meta event; checkpointing each append
        // produced hundreds of hash-only manifests and pushed the baseline out.
        autoCheckpointRoles: configuredAutoCheckpointRoles ?? defaultAutoCheckpointRoles,
      }
    },
    readStatus,
    readDiary,
    readExternalEvents,
    async findEntry(id) {
      const diary = await readDiary()
      const foundDiary = diary.items.find(entry => entry.id === id)
      if (foundDiary) return foundDiary
      const external = await readExternalEvents()
      return external.items.find(entry => entry.id === id)
    },
  }
}

function createHttpAdapter(source, deps = {}) {
  const baseUrl = String(source.location ?? '')
  const allowRemote = Boolean(source.options?.allowRemote)
  if (!allowRemote && !isLoopbackUrl(baseUrl)) {
    throw adapterError('fishkeeper/source-invalid', 'HTTP sources must target loopback unless allowRemote is true.', {
      sourceId: source.id,
      location: baseUrl,
    })
  }
  if (allowRemote) {
    let host
    try {
      host = new URL(baseUrl).hostname.toLowerCase()
    } catch {
      throw adapterError('fishkeeper/source-invalid', `Invalid HTTP source URL: ${baseUrl}`, { sourceId: source.id })
    }
    if (isMetadataHost(host)) {
      throw adapterError('fishkeeper/source-invalid', 'HTTP sources may not target cloud metadata or link-local addresses.', {
        sourceId: source.id,
        location: baseUrl,
      })
    }
  }
  const options = source.options ?? {}
  const preset = options.preset === 'fishtank' ? 'fishtank' : undefined
  const statusPath = options.statusPath ?? (preset === 'fishtank' ? '/fishtank/state' : '/dsh-fish/state')
  const diaryPath = options.diaryPath ?? (preset === 'fishtank' ? '/fishtank/state' : '/dsh-fish/diary')
  const eventsPath = preset === 'fishtank' ? undefined : (options.eventsPath ?? '/dsh-fish/events')
  const credentialKey = typeof options.credentialKey === 'string' && options.credentialKey.trim() !== ''
    ? options.credentialKey.trim()
    : undefined
  const requireCredentials = options.requireCredentials === true
  const credentials = deps.credentials
  const timeoutMs = positiveNumber(options.timeoutMs, deps.http?.timeoutMs ?? 3000)
  const maxBytes = positiveNumber(options.maxResponseBytes, deps.http?.maxResponseBytes ?? 4 * 1024 * 1024)

  async function credentialToken() {
    if (!credentialKey) return undefined
    if (!credentials || typeof credentials.readRecord !== 'function') {
      if (requireCredentials) {
        throw adapterError('fishkeeper/source-unauthorized', 'The credentials service is unavailable for this HTTP source.', {
          sourceId: source.id,
          credentialKey,
        })
      }
      return undefined
    }
    const record = await credentials.readRecord(credentialKey)
    if (record && record.kind === 'api-key' && typeof record.key === 'string') return record.key
    if (requireCredentials) {
      throw adapterError('fishkeeper/source-unauthorized', `No api-key credential is stored for "${credentialKey}".`, {
        sourceId: source.id,
        credentialKey,
      })
    }
    return undefined
  }

  async function request(path) {
    let url
    try {
      url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    } catch {
      throw adapterError('fishkeeper/source-invalid', `Invalid HTTP source URL: ${baseUrl}`, { sourceId: source.id })
    }
    const token = await credentialToken()
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await withTimeout(fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs + 500, 'HTTP source read')
    if (response.status >= 300 && response.status < 400) {
      throw adapterError('fishkeeper/source-unreadable', 'HTTP source returned a redirect; redirects are not followed.', { sourceId: source.id, status: response.status })
    }
    if (response.status === 401 || response.status === 403) {
      throw adapterError('fishkeeper/source-unauthorized', `HTTP source rejected the credential (${response.status}).`, {
        sourceId: source.id,
        status: response.status,
        credentialKey,
      })
    }
    if (!response.ok) {
      throw adapterError('fishkeeper/source-unreadable', `HTTP source returned ${response.status}.`, { sourceId: source.id, status: response.status })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw adapterError('fishkeeper/source-unreadable', 'HTTP source response exceeded the size limit.', { sourceId: source.id, bytes: buffer.byteLength })
    }
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      throw adapterError('fishkeeper/source-unreadable', 'HTTP source did not return JSON.', { sourceId: source.id })
    }
  }

  async function readDiary() {
    const data = await request(diaryPath)
    const records = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.diary)
          ? data.diary
          : []
    const entries = records.map((record, index) => normalizeDiary(record, source, diaryPath, index)).filter(Boolean)
    if (preset === 'fishtank') {
      for (const entry of entries) entry.visibility = 'private'
    }
    entries.sort(compareEntries)
    return { items: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
  }

  async function readExternalEvents() {
    if (!eventsPath) return { items: [], truncated: false, skipped: 0 }
    const data = await request(eventsPath)
    const records = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
    const entries = records.map((record, index) => normalizeExternal(record, source, eventsPath, index)).filter(Boolean)
    entries.sort(compareEntries)
    return { items: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
  }

  async function readStatus() {
    const data = await request(statusPath)
    const fish = data?.fish && typeof data.fish === 'object' ? data.fish : data
    const diary = await readDiary().catch(() => ({ items: [] }))
    const external = await readExternalEvents().catch(() => ({ items: [] }))
    const latestDiary = diary.items[0]
    const whisperFallback = preset === 'fishtank' && Array.isArray(fish?.whispers)
      ? fish.whispers.at(-1)
      : undefined
    return {
      observedAt: nowIso(),
      lastActiveAt: parseTime(firstDefined(fish, ['updatedAt', 'lastActiveAt', 'last_active_at', 'createdAt'])) ?? latestDiary?.occurredAt,
      mood: firstDefined(fish, ['mood', 'emotion', 'feeling']),
      energy: normalizeEnergy(firstDefined(fish, ['energy', 'stamina', 'vitality'])),
      latestDiary: latestDiary
        ? { at: latestDiary.occurredAt, text: latestDiary.text, visibility: latestDiary.visibility }
        : undefined,
      latestWhisper: normalizeWhisper(firstDefined(fish, ['lastWhisper', 'last_whisper', 'whisper']) ?? whisperFallback),
      channels: await buildChannels(source, external.items),
      dataPath: baseUrl,
      dataBytes: undefined,
      name: typeof fish.name === 'string' ? fish.name : source.displayName,
    }
  }

  const warnings = []
  const warningCodes = []
  if (allowRemote) {
    warnings.push('Remote HTTP sources are enabled explicitly.')
    warningCodes.push({ code: 'http-remote' })
  }
  if (preset === 'fishtank') {
    warnings.push('dsh-fishtank exposes only /fishtank/state and /fishtank/talk; there is no diary or external-event route, so HTTP mode reads the last 3 diary entries from /fishtank/state.')
    warningCodes.push({ code: 'fishtank-http' })
    warnings.push(credentialKey
      ? `A credential reference is configured (${credentialKey}); it must resolve to an api-key record.`
      : 'dsh-fishtank routes are unauthenticated today; configure options.credentialKey if a gateway adds auth.')
    warningCodes.push(credentialKey
      ? { code: 'fishtank-credential', params: { key: credentialKey } }
      : { code: 'fishtank-unauthenticated' })
  }

  return {
    kind: 'http',
    source,
    root: baseUrl,
    preset,
    async describe() {
      return {
        id: source.id,
        adapter: 'http',
        displayName: source.displayName,
        root: baseUrl,
        preset,
        capabilities: {
          status: true,
          diary: true,
          externalEvents: Boolean(eventsPath),
          checkpoint: false,
          restore: false,
          import: false,
        },
        files: [],
        warnings,
        warningCodes,
        autoCheckpointRoles: [],
      }
    },
    readStatus,
    readDiary,
    readExternalEvents,
    async findEntry(id) {
      const diary = await readDiary()
      const foundDiary = diary.items.find(entry => entry.id === id)
      if (foundDiary) return foundDiary
      const external = await readExternalEvents()
      return external.items.find(entry => entry.id === id)
    },
  }
}

async function detectLayout(root, options) {
  const status = await pickFile(root, [
    options.statusFile,
    ...(Array.isArray(options.statusFiles) ? options.statusFiles : []),
    'fish.json',
    'state.json',
    'status.json',
  ])
  const diary = await pickMany(root, [
    options.diaryFile,
    ...(Array.isArray(options.diaryFiles) ? options.diaryFiles : []),
  ], ['diary/*.jsonl', 'diary/*.json', 'diary/*.md', 'diary.jsonl', 'diary.json'])
  const external = await pickMany(root, [
    options.externalFile,
    ...(Array.isArray(options.externalFiles) ? options.externalFiles : []),
  ], ['river/events.jsonl', 'river/*.jsonl', 'external/events.jsonl', 'external/*.jsonl'])
  const persona = await pickFile(root, [options.personaFile, 'self.json', 'persona.json'])
  const memory = await pickFile(root, [options.memoryFile, 'events.jsonl', 'facts.jsonl'])
  return {
    status,
    diary,
    external,
    persona,
    memory,
    credentialDir: options.credentialDir ?? 'credentials',
  }
}

function fishtankLayout(options) {
  const map = options.fieldMap && typeof options.fieldMap === 'object' ? options.fieldMap : {}
  return {
    preset: 'fishtank',
    status: stringValue(map.statusPath) ?? 'fish.json',
    diaryField: stringValue(map.diaryList) ?? 'diary',
    diaryText: stringValue(map.diaryText) ?? 'text',
    diaryTime: stringValue(map.diaryTime) ?? 'date',
    whisperField: stringValue(map.whisperList) ?? 'whispers',
    mood: stringValue(map.mood) ?? 'mood',
    energy: stringValue(map.energy) ?? 'energy',
  }
}

async function listDshFishDiary(root, options, pattern) {
  const diary = await pickMany(root, [
    options.diaryFile,
    ...(Array.isArray(options.diaryFiles) ? options.diaryFiles : []),
  ], [stringValue(pattern) ?? 'diary/*.md'])
  return diary.filter(file => MARKDOWN_DIARY_NAME.test(file.slice(file.lastIndexOf('/') + 1)))
}

async function dshFishLayout(root, options) {
  const map = options.fieldMap && typeof options.fieldMap === 'object' ? options.fieldMap : {}
  const diaryPattern = stringValue(map.diaryPattern) ?? 'diary/*.md'
  return {
    preset: DSH_FISH_PRESET,
    status: stringValue(map.statusPath) ?? stringValue(options.statusFile) ?? 'home.json',
    events: stringValue(map.eventsPath) ?? stringValue(options.eventsFile) ?? stringValue(options.externalFile) ?? 'events.jsonl',
    diaryPattern,
    diary: await listDshFishDiary(root, options, diaryPattern),
  }
}

function presetTrackedPaths(preset, layout) {
  if (preset === 'fishtank') return [layout.status]
  if (preset === DSH_FISH_PRESET) return [layout.status, layout.events, ...layout.diary].filter(Boolean)
  return []
}

function dshFishFiles(layout) {
  const files = []
  if (layout.status) {
    files.push({ role: 'status', path: layout.status, restorable: false, format: 'json', appendOnly: false })
  }
  for (const path of layout.diary) {
    files.push({ role: 'diary', path, restorable: false, format: 'text', appendOnly: false })
  }
  if (layout.events) {
    files.push({ role: 'memory', path: layout.events, restorable: false, format: 'jsonl', appendOnly: true })
  }
  return files
}

function getPath(object, path) {
  if (!object || typeof object !== 'object' || typeof path !== 'string' || path === '') return undefined
  let current = object
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

async function pickFile(root, candidates) {
  for (const candidate of candidates) {
    if (!candidate || String(candidate).includes('*')) continue
    const stat = await statSafe(await resolveWithin(root, candidate))
    if (stat && stat.isFile()) return toPosixPath(candidate)
  }
  return undefined
}

async function pickMany(root, explicit, defaults) {
  const found = new Set()
  for (const candidate of explicit) {
    if (!candidate) continue
    if (String(candidate).includes('*')) {
      for (const file of await listMatchingFiles(root, candidate)) found.add(file)
    } else {
      const stat = await statSafe(await resolveWithin(root, candidate))
      if (stat && stat.isFile()) found.add(toPosixPath(candidate))
    }
  }
  if (found.size === 0) {
    for (const candidate of defaults) {
      for (const file of await listMatchingFiles(root, candidate)) found.add(file)
    }
  }
  return [...found].sort()
}

function describeFiles(layout) {
  const files = []
  const add = (role, path, restorable, format, appendOnly = false) => {
    if (!path) return
    if (!files.some(file => file.path === path)) {
      files.push({ role, path, restorable, format, appendOnly })
    }
  }
  add('status', layout.status, false, 'json')
  for (const path of layout.diary) add('diary', path, true, path.endsWith('.json') ? 'json' : path.endsWith('.md') ? 'text' : 'jsonl')
  for (const path of layout.external) add('external', path, false, 'jsonl')
  add('persona', layout.persona, true, 'json')
  add('memory', layout.memory, false, 'jsonl', true)
  return files
}

async function readRecords(path, maxBytes) {
  let stat
  try {
    stat = await fsp.stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { items: [], truncated: false, skipped: 0 }
    throw error
  }
  if (stat.size > maxBytes) return { items: [], truncated: true, skipped: 0 }
  const text = (await fsp.readFile(path, 'utf8')).replace(/^\uFEFF/u, '')
  if (path.endsWith('.jsonl')) {
    const items = []
    let skipped = 0
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        items.push(JSON.parse(trimmed))
      } catch {
        // A damaged line is skipped; the timeline reports the count so it is
        // visible instead of silently disappearing (requirements §4.2).
        skipped += 1
      }
    }
    return { items, truncated: false, skipped }
  }
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data)) return { items: data, truncated: false, skipped: 0 }
    if (Array.isArray(data?.items)) return { items: data.items, truncated: false, skipped: 0 }
    if (Array.isArray(data?.entries)) return { items: data.entries, truncated: false, skipped: 0 }
    if (Array.isArray(data?.diary)) return { items: data.diary, truncated: false, skipped: 0 }
    return { items: [data], truncated: false, skipped: 0 }
  } catch {
    return { items: [], truncated: false, skipped: 1 }
  }
}

async function readDiaryFile(path, relative, maxBytes) {
  if (relative.toLowerCase().endsWith('.md')) return readMarkdownDiary(path, relative, maxBytes)
  return readRecords(path, maxBytes)
}

/**
 * Markdown diaries (dsh-fish: diary/YYYY-MM-DD.md) have no per-entry timestamp:
 * the filename is the date and the file body is the entry. Same-day appends join
 * segments with a `---` rule, but they stay one entry because the plugin's own
 * reader also treats the file as one day.
 */
async function readMarkdownDiary(path, relative, maxBytes) {
  const date = diaryDateFromName(relative)
  if (!date) return { items: [], truncated: false, skipped: 0 }
  let stat
  try {
    stat = await fsp.stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { items: [], truncated: false, skipped: 0 }
    throw error
  }
  if (stat.size > maxBytes) return { items: [], truncated: true, skipped: 0 }
  const text = (await fsp.readFile(path, 'utf8')).replace(/^\uFEFF/u, '').trim()
  if (text === '') return { items: [], truncated: false, skipped: 0 }
  return { items: [{ date, text, visibility: 'private' }], truncated: false, skipped: 0 }
}

function diaryDateFromName(relative) {
  const name = relative.slice(relative.lastIndexOf('/') + 1)
  const match = MARKDOWN_DIARY_NAME.exec(name)
  return match ? match[1] : undefined
}

function latestGrowthEvent(events) {
  let best
  for (const event of events) {
    if (!Number.isInteger(event?.day) || event.day < 1) continue
    const stage = Number.isInteger(event.stage) && event.stage >= 1 ? event.stage : 1
    if (!best || event.day > best.day || (event.day === best.day && stage > best.stage)) {
      best = { day: event.day, stage }
    }
  }
  return best
}

function normalizeDiary(record, source, file, line) {
  if (!record || typeof record !== 'object') return undefined
  const text = firstDefined(record, ['content', 'text', 'message', 'body', 'diary', 'entry'])
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const rawTime = firstDefined(record, ['ts', 'time', 'timestamp', 'createdAt', 'created_at', 'at', 'date'])
  const occurredAt = parseTime(rawTime)
  const visibility = normalizeVisibility(record)
  const nativeId = firstDefined(record, ['id', 'entryId', 'entry_id', 'uuid'])
  return {
    id: entryId(source.id, nativeId, occurredAt, text),
    sourceId: source.id,
    kind: 'diary',
    occurredAt: occurredAt ?? '',
    unknownTime: occurredAt === undefined,
    visibility,
    text,
    channel: undefined,
    sourceRef: { path: file, line },
    nativeId: typeof nativeId === 'string' ? nativeId : undefined,
  }
}

function normalizeEmbeddedDiary(record, source, layout, line) {
  if (!record || typeof record !== 'object') return undefined
  const text = getPath(record, layout.diaryText)
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const occurredAt = parseTime(getPath(record, layout.diaryTime))
  return {
    id: entryId(source.id, undefined, occurredAt, text),
    sourceId: source.id,
    kind: 'diary',
    occurredAt: occurredAt ?? '',
    unknownTime: occurredAt === undefined,
    visibility: 'private',
    text,
    channel: undefined,
    sourceRef: { path: layout.status, field: layout.diaryField, line },
  }
}

function normalizeExternal(record, source, file, line) {
  if (!record || typeof record !== 'object') return undefined
  const text = firstDefined(record, ['text', 'content', 'message', 'body'])
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const rawTime = firstDefined(record, ['ts', 'time', 'timestamp', 'createdAt', 'created_at', 'at', 'date'])
  const occurredAt = parseTime(rawTime)
  const nativeId = firstDefined(record, ['id', 'eventId', 'event_id', 'uuid'])
  const rawKind = String(firstDefined(record, ['kind', 'type', 'action']) ?? 'comment').toLowerCase()
  const kind = rawKind === 'reply' || rawKind === 'post' || rawKind === 'comment' ? rawKind : 'comment'
  const channel = String(firstDefined(record, ['channel', 'platform', 'site', 'source', 'app']) ?? 'unknown')
  return {
    id: entryId(source.id, nativeId, occurredAt, text),
    sourceId: source.id,
    kind,
    occurredAt: occurredAt ?? '',
    unknownTime: occurredAt === undefined,
    visibility: 'public',
    text,
    channel,
    url: typeof record.url === 'string' ? record.url : undefined,
    sourceRef: { path: file, line },
    nativeId: typeof nativeId === 'string' ? nativeId : undefined,
  }
}

function normalizeDshFishEvent(record, source, file, line, includeSystemEvents = false) {
  if (!record || typeof record !== 'object') return undefined
  const text = firstDefined(record, ['text', 'content', 'message', 'body'])
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const eventType = stringValue(record.type)
  // `meta` is the plugin's own bookkeeping (seen/browsed/quiet/...), and `test`
  // is fixture noise. Neither is a memory the owner wants to audit, so the
  // timeline skips them unless the source opts in.
  if (!includeSystemEvents && (eventType === 'meta' || eventType === 'test')) return undefined
  const occurredAt = parseTime(firstDefined(record, ['ts', 'time', 'timestamp', 'createdAt', 'created_at', 'at']))
  const nativeId = firstDefined(record, ['id', 'eventId', 'event_id', 'uuid'])
  const verdict = stringValue(record.verdict)
  return {
    id: entryId(source.id, nativeId, occurredAt, text),
    sourceId: source.id,
    kind: 'event',
    occurredAt: occurredAt ?? '',
    unknownTime: occurredAt === undefined,
    // dsh-fish stores memories, not public posts; its diary and event stream are
    // the fish's private record even when the plugin's UI hides the diary.
    visibility: 'private',
    text,
    channel: undefined,
    eventType,
    day: Number.isInteger(record.day) ? record.day : undefined,
    stage: Number.isInteger(record.stage) ? record.stage : undefined,
    verdict,
    sourceRef: { path: file, line },
    nativeId: typeof nativeId === 'string' ? nativeId : undefined,
  }
}

function entryId(sourceId, nativeId, occurredAt, text) {
  if (typeof nativeId === 'string' && nativeId !== '') return `e_${sourceId}_${nativeId}`.replace(/\s/gu, '_')
  const hash = createHash('sha256').update(`${sourceId}\0${occurredAt ?? ''}\0${text}`).digest('hex')
  return `e_${hash.slice(0, 18)}`
}

function normalizeVisibility(record) {
  const raw = record.visibility ?? record.visiblity
  if (typeof raw === 'string') {
    const value = raw.toLowerCase()
    if (value === 'public' || value === 'private') return value
  }
  if (record.private === true) return 'private'
  if (record.public === true) return 'public'
  return 'unknown'
}

function normalizeEnergy(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  if (number > 1 && number <= 100) return number / 100
  return Math.min(1, Math.max(0, number))
}

function normalizeWhisper(value) {
  if (typeof value === 'string') return { at: undefined, text: value }
  if (value && typeof value === 'object') {
    const text = firstDefined(value, ['text', 'content', 'message'])
    if (typeof text !== 'string') return undefined
    return { at: parseTime(firstDefined(value, ['at', 'ts', 'time', 'createdAt'])), text }
  }
  return undefined
}

function dedupe(entries) {
  const map = new Map()
  for (const entry of entries) {
    if (!map.has(entry.id)) map.set(entry.id, entry)
  }
  return [...map.values()]
}

function compareEntries(left, right) {
  if (left.unknownTime !== right.unknownTime) return left.unknownTime ? 1 : -1
  const byTime = String(right.occurredAt).localeCompare(String(left.occurredAt))
  if (byTime !== 0) return byTime
  return String(right.id).localeCompare(String(left.id))
}

const HEALTH_TTL_MS = 60_000
const HEALTH_CACHE = new Map()

async function checkChannelHealth(source, config) {
  const raw = typeof config.healthUrl === 'string' ? config.healthUrl.trim() : ''
  if (raw === '') return undefined
  let url
  try {
    url = new URL(raw, source.adapter === 'http' ? source.location : undefined)
  } catch {
    return { state: 'unknown', detail: 'Health URL is invalid.' }
  }
  if (!source.options?.allowRemote && !isLoopbackUrl(url.href)) {
    return { state: 'unknown', detail: 'Health URL must be loopback unless options.allowRemote is true.' }
  }
  const key = `${source.id}\0${url.href}`
  const cached = HEALTH_CACHE.get(key)
  if (cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) return cached
  const timeoutMs = positiveNumber(config.healthTimeoutMs, 2000)
  let state = 'unknown'
  let status
  let detail
  let lastSuccessAt = cached?.lastSuccessAt
  try {
    const response = await withTimeout(fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs + 300, 'channel health')
    status = response.status
    if (response.ok) {
      state = 'ok'
      lastSuccessAt = nowIso()
      detail = `Health endpoint returned ${status}.`
    } else {
      state = 'error'
      detail = `Health endpoint returned ${status}${lastSuccessAt ? `; last success ${lastSuccessAt}` : ''}.`
    }
  } catch (error) {
    state = 'unknown'
    detail = `Health check failed: ${error.message}${lastSuccessAt ? `; last success ${lastSuccessAt}` : ''}.`
  }
  const result = { state, status, detail, checkedAt: Date.now(), lastSuccessAt }
  HEALTH_CACHE.set(key, result)
  return result
}

async function buildChannels(source, events) {
  const configured = Array.isArray(source.options?.channels) ? source.options.channels : []
  const remote = source.adapter === 'http'
  const names = new Set(configured.map(channel => channel.name ?? channel.channel).filter(Boolean))
  for (const event of events) {
    if (event.channel && event.channel !== 'unknown') names.add(event.channel)
  }
  const credentialDir = source.options?.credentialDir ?? 'credentials'
  const inactivityHours = Number(source.options?.inactivityHours ?? DEFAULT_INACTIVITY_HOURS)
  const channels = []
  for (const name of names) {
    const config = configured.find(channel => (channel.name ?? channel.channel) === name) ?? {}
    const health = await checkChannelHealth(source, config)
    const credentialFile = config.credentialFile ?? `${credentialDir}/${name}.json`
    let credential
    if (!remote) {
      try {
        const absolute = await resolveWithin(source.location, credentialFile)
        const stat = await statSafe(absolute)
        if (stat && stat.isFile()) {
          const mode = modeString(stat.mode)
          credential = {
            path: credentialFile,
            exists: true,
            mode,
            modeOk: POSIX ? mode === '0600' : null,
          }
        } else {
          credential = { path: credentialFile, exists: false, modeOk: POSIX ? false : null }
        }
      } catch {
        credential = { path: credentialFile, exists: false, modeOk: POSIX ? false : null }
      }
    }
    const lastActivityAt = events
      .filter(event => event.channel === name)
      .map(event => event.occurredAt)
      .filter(Boolean)
      .sort()
      .at(-1)
    const ageHours = lastActivityAt ? (Date.now() - Date.parse(lastActivityAt)) / 3_600_000 : undefined
    let state = 'unknown'
    if (remote) {
      state = lastActivityAt ? (ageHours > inactivityHours ? 'warn' : 'ok') : 'unknown'
    } else if (!credential.exists) state = config.optional ? 'unknown' : 'warn'
    else if (ageHours !== undefined && ageHours > inactivityHours) state = 'warn'
    else if (lastActivityAt) state = 'ok'
    const credentialLabel = POSIX ? (credential.mode ?? 'present') : 'present (Windows ACL not interpreted)'
    let detail = remote
      ? lastActivityAt ? `Last activity ${Math.round(ageHours ?? 0)}h ago` : 'No recent activity'
      : !credential.exists
        ? `Credential not found at ${credentialFile}`
        : lastActivityAt
          ? `Credential ${credentialLabel}; last activity ${Math.round(ageHours ?? 0)}h ago`
          : `Credential ${credentialLabel}; no recent activity`
    if (health) {
      state = health.state
      detail = health.detail
    }
    channels.push({ channel: name, state, detail, lastActivityAt, credential, health })
  }
  return channels
}

