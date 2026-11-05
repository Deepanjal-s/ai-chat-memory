import type { EntityKind, Extraction, ExtractedItem, ItemKind, ItemStatus, SourceMessage } from './types'

/**
 * Rule-based extractor used when no AI provider is configured (everything stays local).
 * It is deliberately conservative: it only records sentences that state a decision, task, requirement,
 * problem or idea explicitly, and it treats anything ChatGPT proposes as a suggestion, never a decision.
 */

interface Rule {
  kind: ItemKind
  status: ItemStatus
  roles: string[]
  re: RegExp
}

const RULES: Rule[] = [
  // Explicit decisions by the user.
  {
    kind: 'decision',
    status: 'confirmed',
    roles: ['user'],
    re: /\b(decision:|decided|we(?:'| wi)ll go with|let'?s go with|we(?: are|'re) going with|go ahead with|final(?: decision)?:|we will use|we'll use|i(?:'ve| have) chosen|approved)(?!\w)/i,
  },
  { kind: 'decision', status: 'rejected', roles: ['user'], re: /\b(we won'?t use|not going with|rejected?|drop(?:ped)? the idea)(?!\w)/i },
  // Suggestions by ChatGPT are never decisions.
  {
    kind: 'decision',
    status: 'proposed',
    roles: ['assistant'],
    re: /\b(i (?:would )?(?:suggest|recommend)|my recommendation|you (?:should|could) (?:use|go with|choose|consider)|consider using|the best option)(?!\w)/i,
  },
  { kind: 'requirement', status: 'confirmed', roles: ['user'], re: /\b(must|requirement|required to|needs? to support|it should support|has to|mandatory)(?!\w)/i },
  { kind: 'task', status: 'open', roles: ['user'], re: /\b(pending:?|to-?do:?|action item|next step|remember to|follow up|we need to|i need to)(?!\w)/i },
  { kind: 'task', status: 'done', roles: ['user'], re: /\b(done:|completed|finished|has been deployed|is now live)(?!\w)/i },
  { kind: 'problem', status: 'discussed', roles: ['user'], re: /\b(error|issue|problem|bug|fails?|failing|not working|broken|crash(?:es|ed)?)(?!\w)/i },
  { kind: 'idea', status: 'discussed', roles: ['user'], re: /\b(idea:|what if we|maybe we could|we could also|brainstorm)(?!\w)/i },
  { kind: 'preference', status: 'confirmed', roles: ['user'], re: /\b(i prefer|always (?:use|include|write)|never (?:use|include)|please always|my preference)(?!\w)/i },
]

const DUE_RE =
  /\b(?:by|before|until|due(?: on)?|deadline(?: is)?:?)\s+((?:end of |the end of )?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|next week|tomorrow|monday|tuesday|wednesday|thursday|friday)[\w ,]*?\d{0,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)/i

const KNOWN_TECH = [
  'PostgreSQL', 'Postgres', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'Elasticsearch', 'Kafka', 'RabbitMQ',
  'FastAPI', 'Django', 'Flask', 'Express', 'Node', 'Node.js', 'NestJS', 'Next.js', 'React', 'Vue', 'Angular', 'Svelte',
  'Python', 'TypeScript', 'JavaScript', 'Java', 'Go', 'Rust', 'Kotlin', 'Swift', 'Flutter', 'PHP', 'Laravel',
  'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Firebase', 'Supabase', 'Vercel', 'Stripe', 'Razorpay',
  'GraphQL', 'REST', 'OpenAI', 'Claude', 'ChatGPT', 'Terraform', 'Nginx', 'WordPress', 'Shopify', 'Tailwind',
]
const TECH_NORM = new Map(KNOWN_TECH.map((t) => [t.toLowerCase().replace(/[^a-z0-9]/g, ''), t]))

const STOP_CAPS = new Set([
  'I', 'A', 'AI', 'OK', 'API', 'UI', 'UX', 'URL', 'ID', 'PDF', 'CSV', 'JSON', 'HTML', 'CSS', 'SQL', 'HTTP', 'HTTPS',
  'FAQ', 'TODO', 'NOTE', 'PS', 'USA', 'UK', 'CEO', 'CTO', 'MVP', 'Q1', 'Q2', 'Q3', 'Q4', 'ETA', 'EOD', 'N/A',
])

export function heuristicExtract(title: string, messages: SourceMessage[]): Extraction {
  const items: ExtractedItem[] = []
  const entityCounts = new Map<string, { name: string; kind: EntityKind; n: number }>()
  const addEntity = (name: string, kind: EntityKind) => {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (key.length < 2) return
    const e = entityCounts.get(key) ?? { name, kind, n: 0 }
    e.n++
    entityCounts.set(key, e)
  }

  const scan = (text: string) => {
    // Brand/project-style names: VK7SPORTS, ACME-CRM (all caps with letters, ≥4 chars, or caps+digits).
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*[0-9A-Z](?:[-_][A-Z0-9]+)*\b/g)) {
      const w = m[0]
      if (w.length >= 4 && !STOP_CAPS.has(w) && /[A-Z]/.test(w) && (/\d/.test(w) || w.length >= 5)) addEntity(w, 'project')
    }
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9.+#]*/g)) {
      const tech = TECH_NORM.get(m[0].toLowerCase().replace(/[^a-z0-9]/g, ''))
      if (tech) addEntity(tech === 'Postgres' ? 'PostgreSQL' : tech, 'technology')
    }
  }
  scan(title)
  scan(title) // titles name the subject; weight them.

  for (const msg of messages) {
    scan(msg.text)
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    for (const sentence of sentences(msg.text)) {
      for (const rule of RULES) {
        if (!rule.roles.includes(msg.role) || !rule.re.test(sentence)) continue
        const due = sentence.match(DUE_RE)?.[1]?.trim() ?? null
        items.push({
          kind: rule.kind === 'task' && due ? 'task' : rule.kind,
          status: rule.status,
          statement: sentence.length > 300 ? sentence.slice(0, 297) + '…' : sentence,
          quote: sentence,
          message_id: msg.id,
          due,
          entities: [],
        })
        break // one classification per sentence
      }
    }
  }

  // Projects must recur (or appear in the title) to count; this avoids random capitalised words.
  const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  const entities = [...entityCounts.entries()]
    .filter(([key, e]) => e.kind === 'technology' || e.n >= 3 || titleNorm.includes(key))
    .map(([, e]) => ({ name: e.name, kind: e.kind }))

  // Link every item to the entities named in its sentence, or to the conversation's projects.
  const projects = entities.filter((e) => e.kind === 'project').map((e) => e.name)
  for (const item of items) {
    const s = item.quote.toLowerCase()
    const named = entities.filter((e) => s.includes(e.name.toLowerCase())).map((e) => e.name)
    item.entities = [...new Set([...named, ...projects])]
  }

  const firstUser = messages.find((m) => m.role === 'user')?.text.trim().replace(/\s+/g, ' ') ?? ''
  const summary =
    (firstUser ? `Started with: “${firstUser.slice(0, 220)}${firstUser.length > 220 ? '…' : ''}”. ` : '') +
    `${messages.length} messages` +
    (items.length ? `; ${items.length} notable statements found by rule-based extraction.` : '.')

  return { summary, entities, items }
}

/** Sentence-ish units; keeps list items and lines separate, skips code blocks. */
export function sentences(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ')
  return withoutCode
    .split(/\n+/)
    .flatMap((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 600)
}
