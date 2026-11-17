const SEVERITY_RANK = { high: 3, medium: 2, low: 1 }

export const DEFAULT_RULES = [
  {
    id: 'pii.email',
    category: 'pii',
    severity: 'medium',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
    mask: 'email',
  },
  {
    id: 'pii.phone_cn',
    category: 'pii',
    severity: 'medium',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
    mask: 'phone',
  },
  {
    id: 'pii.id_cn',
    category: 'pii',
    severity: 'high',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
    validator: 'cn-id',
    mask: 'id',
  },
  {
    id: 'pii.bank_card',
    category: 'pii',
    severity: 'high',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`(?<!\d)\d{13,19}(?!\d)`,
    validator: 'luhn',
    mask: 'card',
  },
  {
    id: 'pii.address_cn',
    category: 'pii',
    severity: 'low',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`[\u4e00-\u9fa5]{2,}(?:省|自治区|市)[\u4e00-\u9fa5]{1,12}(?:市|区|县)[\u4e00-\u9fa5]{0,24}(?:街道|路|街|巷|号)`,
    mask: 'partial',
  },
  {
    id: 'secret.api_key',
    category: 'secret',
    severity: 'high',
    enabled: true,
    kind: 'regex',
    pattern: String.raw`\b(?:sk|ghp|gho|glpat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b`,
    mask: 'secret',
  },
  {
    id: 'topic.sensitive',
    category: 'topic',
    severity: 'medium',
    enabled: false,
    kind: 'keyword',
    keywords: ['示例敏感词'],
    mask: 'partial',
  },
  {
    id: 'topic.controversy',
    category: 'topic',
    severity: 'low',
    enabled: false,
    kind: 'keyword',
    keywords: ['示例争议话题'],
    mask: 'partial',
  },
]

const MAX_SCAN_CHARS = 200_000
const RULE_SEVERITIES = new Set(['high', 'medium', 'low'])
const RULE_MASKS = new Set(['email', 'phone', 'id', 'card', 'secret', 'partial'])
const RULE_VALIDATORS = new Set(['cn-id', 'luhn'])
const RULE_FLAGS = new Set(['i', 'm', 's'])

/**
 * Validate and normalize a user-configured rule list. `undefined` means "use
 * the built-in defaults"; an explicit array is the complete effective list, so
 * the settings panel can add, remove, enable/disable, and change severity.
 */
export function normalizeRules(value) {
  if (value === undefined || value === null) return DEFAULT_RULES.map(rule => normalizeRule(rule))
  if (!Array.isArray(value)) throw rulesError('rules must be an array.', { field: 'rules' })
  const seen = new Set()
  return value.map((rule, index) => {
    const normalized = normalizeRule(rule, `rules.${index}`)
    if (seen.has(normalized.id)) throw rulesError(`Duplicate rule id: ${normalized.id}.`, { field: `rules.${index}.id` })
    seen.add(normalized.id)
    return normalized
  })
}

function normalizeRule(rule, field = 'rules') {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw rulesError(`${field} must be an object.`, { field })
  }
  const id = typeof rule.id === 'string' ? rule.id.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) {
    throw rulesError(`${field}.id must be 1-64 characters: letters, digits, dots, underscores or dashes.`, { field: `${field}.id` })
  }
  const category = typeof rule.category === 'string' && rule.category.trim() !== ''
    ? rule.category.trim().slice(0, 32)
    : 'custom'
  const severity = RULE_SEVERITIES.has(rule.severity) ? rule.severity : 'low'
  const kind = rule.kind === 'keyword' ? 'keyword' : 'regex'
  const normalized = {
    id,
    category,
    severity,
    enabled: rule.enabled !== false,
    kind,
  }
  if (rule.mask !== undefined) {
    if (!RULE_MASKS.has(rule.mask)) throw rulesError(`${field}.mask is not supported.`, { field: `${field}.mask` })
    normalized.mask = rule.mask
  }
  if (kind === 'keyword') {
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : []
    if (keywords.length === 0) throw rulesError(`${field}.keywords must contain at least one keyword.`, { field: `${field}.keywords` })
    normalized.keywords = keywords.map(keyword => {
      if (typeof keyword !== 'string' || keyword.trim() === '') {
        throw rulesError(`${field}.keywords must contain non-empty strings.`, { field: `${field}.keywords` })
      }
      return keyword.slice(0, 200)
    }).slice(0, 200)
    return normalized
  }
  const pattern = typeof rule.pattern === 'string' ? rule.pattern : ''
  if (pattern === '' || pattern.length > 2000) {
    throw rulesError(`${field}.pattern must be 1-2000 characters.`, { field: `${field}.pattern` })
  }
  const flags = typeof rule.flags === 'string'
    ? [...new Set(rule.flags.split(''))].filter(flag => RULE_FLAGS.has(flag)).join('')
    : ''
  try {
    // `scanText` adds the global and unicode flags itself.
    new RegExp(pattern, `${flags}gu`)
  } catch {
    throw rulesError(`${field}.pattern is not a valid regular expression.`, { field: `${field}.pattern` })
  }
  normalized.pattern = pattern
  if (flags) normalized.flags = flags
  if (rule.validator !== undefined) {
    if (!RULE_VALIDATORS.has(rule.validator)) throw rulesError(`${field}.validator is not supported.`, { field: `${field}.validator` })
    normalized.validator = rule.validator
  }
  return normalized
}

function rulesError(message, details) {
  const error = new Error(message)
  error.code = 'fishkeeper/config-invalid'
  error.details = details
  return error
}

export function scanText(text, rules = DEFAULT_RULES) {
  const scanned = String(text ?? '')
  const bounded = scanned.slice(0, MAX_SCAN_CHARS)
  const hits = []
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    if (rule.kind === 'keyword' && Array.isArray(rule.keywords)) {
      for (const keyword of rule.keywords) {
        if (!keyword) continue
        let from = 0
        while (from < bounded.length) {
          const index = bounded.indexOf(keyword, from)
          if (index === -1) break
          hits.push(makeHit(rule, bounded, index, index + keyword.length))
          from = index + keyword.length
        }
      }
      continue
    }
    if (!rule.pattern) continue
    let regex
    try {
      const flags = `${(rule.flags ?? '').replace(/g/gu, '')}gu`
      regex = new RegExp(rule.pattern, flags)
    } catch {
      continue
    }
    let match
    let guard = 0
    while ((match = regex.exec(bounded)) !== null) {
      guard += 1
      if (guard > 2000) break
      if (match[0].length === 0) {
        regex.lastIndex += 1
        continue
      }
      const value = match[0]
      if (rule.validator === 'cn-id' && !isValidCnId(value)) continue
      if (rule.validator === 'luhn' && !isValidLuhn(value)) continue
      hits.push(makeHit(rule, bounded, match.index, match.index + value.length))
    }
  }
  const ordered = hits
    .sort((left, right) => left.start - right.start || right.rank - left.rank)
    .slice(0, 50)
  const deduped = []
  let cursor = -1
  for (const hit of ordered) {
    if (hit.start < cursor) continue
    deduped.push(hit)
    cursor = hit.end
  }
  return {
    hits: deduped,
    scannedChars: bounded.length,
    truncated: scanned.length > bounded.length,
  }
}

function makeHit(rule, text, start, end) {
  const value = text.slice(start, end)
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.severity,
    start,
    end,
    rank: SEVERITY_RANK[rule.severity] ?? 0,
    masked: maskValue(rule.mask, value),
  }
}

export function maskText(text, hits) {
  const source = String(text ?? '')
  if (!Array.isArray(hits) || hits.length === 0) return source
  let output = ''
  let cursor = 0
  for (const hit of [...hits].sort((left, right) => left.start - right.start)) {
    if (hit.start < cursor || hit.start >= source.length) continue
    output += source.slice(cursor, hit.start)
    output += hit.masked || '***'
    cursor = Math.min(source.length, hit.end)
  }
  output += source.slice(cursor)
  return output
}

export function maskValue(kind, value) {
  const text = String(value ?? '')
  if (kind === 'email') {
    const at = text.indexOf('@')
    if (at <= 0) return `${text.slice(0, 1)}***`
    const local = text.slice(0, at)
    const domain = text.slice(at + 1)
    const dot = domain.lastIndexOf('.')
    const host = dot > 0 ? domain.slice(0, dot) : domain
    const tld = dot > 0 ? domain.slice(dot) : ''
    return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`
  }
  if (kind === 'phone') return text.replace(/^(\d{3})\d{4}(\d{4})$/u, '$1****$2')
  if (kind === 'id') return `${text.slice(0, 6)}********${text.slice(-4)}`
  if (kind === 'card') return `**** **** **** ${text.slice(-4)}`
  if (kind === 'secret') return `${text.slice(0, 5)}…${text.slice(-4)}`
  if (kind === 'partial') return `${text.slice(0, 6)}***`
  return '***'
}

export function isValidCnId(value) {
  const id = String(value).toUpperCase()
  if (!/^\d{17}[\dX]$/u.test(id)) return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let index = 0; index < 17; index += 1) {
    sum += Number(id[index]) * weights[index]
  }
  return checks[sum % 11] === id[17]
}

export function isValidLuhn(value) {
  const digits = String(value).replace(/\D/gu, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

export function ruleLabelKey(ruleId) {
  return `rule.${ruleId}`
}
