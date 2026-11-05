import { z } from 'zod'

export const ITEM_KINDS = ['decision', 'requirement', 'task', 'problem', 'solution', 'idea', 'preference', 'deadline'] as const
export const ITEM_STATUSES = ['confirmed', 'proposed', 'assumption', 'discussed', 'open', 'done', 'rejected'] as const
export const ENTITY_KINDS = ['project', 'organization', 'person', 'product', 'technology', 'topic'] as const

export type ItemKind = (typeof ITEM_KINDS)[number]
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export type EntityKind = (typeof ENTITY_KINDS)[number]

export const ExtractionSchema = z.object({
  summary: z.string(),
  entities: z.array(z.object({ name: z.string().min(1), kind: z.enum(ENTITY_KINDS) })),
  items: z.array(
    z.object({
      kind: z.enum(ITEM_KINDS),
      status: z.enum(ITEM_STATUSES),
      statement: z.string().min(3),
      quote: z.string(),
      message_id: z.number().int(),
      due: z.string().nullable(),
      entities: z.array(z.string()),
    }),
  ),
})
export type Extraction = z.infer<typeof ExtractionSchema>
export type ExtractedItem = Extraction['items'][number]

/** JSON Schema given to the model (structured outputs); mirrors ExtractionSchema. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'entities', 'items'],
  properties: {
    summary: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: { name: { type: 'string' }, kind: { type: 'string', enum: [...ENTITY_KINDS] } },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'status', 'statement', 'quote', 'message_id', 'due', 'entities'],
        properties: {
          kind: { type: 'string', enum: [...ITEM_KINDS] },
          status: { type: 'string', enum: [...ITEM_STATUSES] },
          statement: { type: 'string' },
          quote: { type: 'string' },
          message_id: { type: 'integer' },
          due: { type: ['string', 'null'] },
          entities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

export interface SourceMessage {
  id: number
  role: string
  text: string
  createdAt: Date | null
}

export const KIND_LABEL: Record<string, string> = {
  decision: 'Decision',
  requirement: 'Requirement',
  task: 'Task',
  problem: 'Problem',
  solution: 'Solution',
  idea: 'Idea',
  preference: 'Preference / instruction',
  deadline: 'Deadline',
}

export const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  proposed: 'Suggested (not confirmed)',
  assumption: 'Assumption',
  discussed: 'Discussed',
  open: 'Open',
  done: 'Done',
  rejected: 'Rejected',
}

/** Lower-case, whitespace-collapsed, markdown-stripped form used to verify quotes against messages. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`#>|~]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Canonical key for an entity name: "VK7 Sports", "vk7-sports" and "VK7SPORTS" are the same entity. */
export function normalizeEntityName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** An extracted item is kept only if its quote really appears in the message it cites. */
export function verifyQuote(item: { quote: string; message_id: number }, messages: Map<number, SourceMessage>): boolean {
  const msg = messages.get(item.message_id)
  if (!msg) return false
  const q = normalizeForMatch(item.quote)
  if (q.length < 8) return false
  return normalizeForMatch(msg.text).includes(q)
}
