import { z } from 'zod'
import { getLlm, type Llm } from './ai/llm'
import type { Db } from './db/client'
import { KIND_LABEL, STATUS_LABEL } from './knowledge/types'
import { detectEntities, itemNumberMap, parseTimeWindow, retrieve, type Source } from './retrieval'

export interface Answer {
  question: string
  mode: 'ai' | 'local'
  answer: string
  confidence: 'high' | 'medium' | 'low' | 'insufficient' | 'not_assessed'
  conflicts: { description: string; sources: number[] }[]
  sources: Source[]
  entities: { id: number; name: string }[]
  removedCitations: number
  provider: string | null
  timeWindowFrom: string | null
}

const AnswerSchema = z.object({
  answer: z.string(),
  confidence: z.enum(['high', 'medium', 'low', 'insufficient']),
  conflicts: z.array(z.object({ description: z.string(), sources: z.array(z.number().int()) })),
})
const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'confidence', 'conflicts'],
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'insufficient'] },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'sources'],
        properties: { description: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } } },
      },
    },
  },
}

const SYSTEM = `You answer a company director's questions using ONLY the numbered sources from their own past ChatGPT conversations.

Rules:
- Cite every factual sentence with source numbers like [S3] or [S2][S5]. Never cite a number that is not listed.
- Use only what the sources say. If they do not answer the question, say so plainly and set confidence to "insufficient". Never fill gaps with general knowledge.
- Keep the status of each statement: say "decided" only for sources marked CONFIRMED; describe PROPOSED items as suggestions that were not confirmed; mark assumptions as assumptions.
- Sources marked OUTDATED were replaced by a later statement: present the current one and mention the earlier one only as history.
- If sources disagree (CONFLICT, or different statements on the same point), say so and list the disagreement in "conflicts".
- When the question is about change over time, answer chronologically with dates.
- Write concise Markdown (short paragraphs or bullets). No preamble.`

export async function answerQuestion(db: Db, question: string, llm: Llm | null = getLlm(db)): Promise<Answer> {
  const q = question.trim().slice(0, 2000)
  const entities = await detectEntities(db, q)
  const { from } = parseTimeWindow(q)
  const sources = await retrieve(db, { query: q, entityIds: entities.map((e) => e.id), from, maxItems: 45, maxMessages: 15 })
  const base = {
    question: q,
    sources,
    entities: entities.map((e) => ({ id: e.id, name: e.name })),
    timeWindowFrom: from,
  }

  if (sources.length === 0) {
    return {
      ...base,
      mode: llm ? 'ai' : 'local',
      answer: 'I could not find anything about this in your conversation history. Try different words, or check that the relevant conversations have been imported or captured.',
      confidence: 'insufficient',
      conflicts: [],
      removedCitations: 0,
      provider: null,
    }
  }

  if (!llm) return { ...base, ...localAnswer(sources, q), mode: 'local', removedCitations: 0, provider: null }

  const res = await llm.json({
    purpose: 'question_answering',
    system: SYSTEM,
    user: `Question: ${q}\n\nSources:\n\n${renderSources(sources)}`,
    schema: ANSWER_JSON_SCHEMA,
    validate: AnswerSchema,
    effort: 'medium',
    maxTokens: 16000,
  })
  const { text, removed, cited } = verifyCitations(res.answer, sources.length)
  let confidence: Answer['confidence'] = res.confidence
  let answer = text
  if (confidence !== 'insufficient' && cited.size === 0) {
    confidence = 'low'
    answer += '\n\n_Note: this answer cites no sources, so treat it as unverified._'
  }
  return {
    ...base,
    mode: 'ai',
    answer,
    confidence,
    conflicts: res.conflicts
      .map((c) => ({ description: c.description, sources: c.sources.filter((n) => n >= 1 && n <= sources.length) }))
      .filter((c) => c.description.trim()),
    removedCitations: removed,
    provider: `${llm.provider}:${llm.model}`,
  }
}

/** Removes citations to sources that do not exist; reports which ones remain. */
export function verifyCitations(text: string, sourceCount: number): { text: string; removed: number; cited: Set<number> } {
  let removed = 0
  const cited = new Set<number>()
  // Models sometimes group references as [S1, S3] or [S1; S3]: split them into [S1][S3] first.
  const normalized = text.replace(/\[(S\d+(?:\s*[,;]\s*S?\d+)+)\]/g, (_m, inner: string) =>
    inner
      .split(/\s*[,;]\s*/)
      .map((p) => `[S${p.replace(/^S/, '')}]`)
      .join(''),
  )
  const out = normalized.replace(/\[S(\d+)\]/g, (m, d: string) => {
    const n = Number(d)
    if (n >= 1 && n <= sourceCount) {
      cited.add(n)
      return m
    }
    removed++
    return ''
  })
  return { text: out, removed, cited }
}

export function renderSources(sources: Source[]): string {
  const num = itemNumberMap(sources)
  return sources
    .map((s) => {
      const date = s.date ? s.date.slice(0, 10) : 'date unknown'
      const where = `"${s.conversationTitle}", ${date}${s.origin === 'live_capture' ? ', live capture (not yet confirmed by export)' : ''}`
      if (s.type === 'item') {
        const flags = [
          `${s.kind.toUpperCase()}`,
          s.status.toUpperCase(),
          s.supersededBy ? `OUTDATED (replaced by ${num.has(s.supersededBy) ? `S${num.get(s.supersededBy)}` : 'a later statement'})` : null,
          s.contradictedBy.length ? `CONFLICT with ${s.contradictedBy.map((id) => (num.has(id) ? `S${num.get(id)}` : 'another statement')).join(', ')}` : null,
        ].filter(Boolean)
        return `[S${s.n}] (${flags.join(' · ')}) ${where}\nStatement: ${s.statement}\nQuote: "${s.quote}"`
      }
      return `[S${s.n}] (MESSAGE by ${s.role === 'user' ? 'the director' : s.role === 'assistant' ? 'ChatGPT' : s.role}) ${where}\n${s.text}${s.truncated ? '\n[…message continues]' : ''}`
    })
    .join('\n\n')
}

/**
 * Answer without any AI model: the verified record, grouped by status, plus the most relevant passages.
 * Nothing is paraphrased, so nothing can be invented.
 */
function localAnswer(sources: Source[], question = ''): Pick<Answer, 'answer' | 'confidence' | 'conflicts'> {
  const num = itemNumberMap(sources)
  const items = sources.filter((s): s is Extract<Source, { type: 'item' }> => s.type === 'item')
  const allGroups: [string, (s: (typeof items)[number]) => boolean][] = [
    ['Confirmed decisions', (s) => s.kind === 'decision' && s.status === 'confirmed'],
    ['Requirements', (s) => s.kind === 'requirement'],
    ['Suggestions (not confirmed)', (s) => s.status === 'proposed'],
    ['Open tasks and deadlines', (s) => (s.kind === 'task' && s.status === 'open') || s.kind === 'deadline'],
    ['Problems and solutions', (s) => s.kind === 'problem' || s.kind === 'solution'],
    ['Ideas', (s) => s.kind === 'idea'],
    ['Preferences and instructions', (s) => s.kind === 'preference'],
    ['Other', () => true],
  ]
  // Put what the question asks about first.
  const intents: [RegExp, string][] = [
    [/\b(task|pending|todo|to-do|next step|deadline|due|outstanding)/i, 'Open tasks and deadlines'],
    [/\b(requirement|spec|must|need)/i, 'Requirements'],
    [/\b(problem|issue|bug|error|fail|solution|fix)/i, 'Problems and solutions'],
    [/\b(idea|brainstorm)/i, 'Ideas'],
    [/\b(prefer|preference|instruction)/i, 'Preferences and instructions'],
    [/\b(suggest|recommend|option)/i, 'Suggestions (not confirmed)'],
    [/\b(decid|decision|chose|choice)/i, 'Confirmed decisions'],
  ]
  const wanted = new Set(intents.filter(([re]) => re.test(question)).map(([, g]) => g))
  const groups = [...allGroups.filter(([h]) => wanted.has(h)), ...allGroups.filter(([h]) => !wanted.has(h))]
  const used = new Set<number>()
  const parts: string[] = [
    '_AI answering is turned off, so this is the verified record from your history, grouped by status. Newest first; open a source to read the original._',
  ]
  for (const [heading, test] of groups) {
    const list = items.filter((s) => !used.has(s.n) && test(s)).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    if (!list.length) continue
    parts.push(`**${heading}**`)
    for (const s of list.slice(0, 12)) {
      used.add(s.n)
      const notes = [
        s.supersededBy ? `outdated — replaced${num.has(s.supersededBy) ? ` by [S${num.get(s.supersededBy)}]` : ''}` : null,
        s.possiblyChangedBy.length ? `possibly changed later${num.has(s.possiblyChangedBy[0]) ? ` (see [S${num.get(s.possiblyChangedBy[0])}])` : ''}` : null,
        s.contradictedBy.length ? 'conflicting statements exist' : null,
        heading === 'Other' ? `${KIND_LABEL[s.kind] ?? s.kind}, ${STATUS_LABEL[s.status] ?? s.status}` : null,
      ].filter(Boolean)
      parts.push(`- ${s.statement} — ${s.date ? s.date.slice(0, 10) : 'undated'} [S${s.n}]${notes.length ? ` _(${notes.join('; ')})_` : ''}`)
    }
  }
  const passages = sources.filter((s) => s.type === 'message').slice(0, 6)
  if (passages.length) {
    parts.push('**Most relevant passages**')
    for (const p of passages) {
      if (p.type !== 'message') continue
      const who = p.role === 'user' ? 'You' : p.role === 'assistant' ? 'ChatGPT' : p.role
      const excerpt = p.text.replace(/\s+/g, ' ').slice(0, 220)
      parts.push(`- ${who}, “${p.conversationTitle}” (${p.date ? p.date.slice(0, 10) : 'undated'}): “${excerpt}${p.text.length > 220 ? '…' : ''}” [S${p.n}]`)
    }
  }
  const conflicts = items
    .filter((s) => s.contradictedBy.length)
    .map((s) => ({
      description: `“${s.statement}” conflicts with a statement in another conversation.`,
      sources: [s.n, ...s.contradictedBy.map((id) => num.get(id)).filter((n): n is number => !!n)],
    }))
  return { answer: parts.join('\n\n'), confidence: 'not_assessed', conflicts }
}

export async function saveAnswer(db: Db, a: Answer): Promise<number> {
  const [row] = await db.query<{ id: number }>('INSERT INTO qa_turns(question, answer, mode) VALUES ($1, $2::jsonb, $3) RETURNING id', [
    a.question,
    JSON.stringify(a),
    a.mode,
  ])
  return row.id
}
