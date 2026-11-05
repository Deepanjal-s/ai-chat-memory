import { z } from 'zod'

export const DOC_TYPES = {
  project_report: 'Project report',
  technical: 'Technical documentation',
  decision_record: 'Decision record',
  requirements: 'Requirements document',
  pending_tasks: 'Pending-task report',
  timeline: 'Project timeline',
} as const
export type DocType = keyof typeof DOC_TYPES

export const DocRequestSchema = z.object({
  title: z.string().trim().max(200).optional(),
  entityId: z.number().int().positive().nullable().optional(),
  query: z.string().trim().max(300).optional(),
  docType: z.enum(Object.keys(DOC_TYPES) as [DocType, ...DocType[]]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  formats: z.array(z.enum(['pdf', 'docx', 'md'])).min(1),
})
export type DocRequest = z.infer<typeof DocRequestSchema>

/** Inline run: plain text with citation numbers appended. */
export interface Run {
  text: string
  cites?: number[]
  tag?: string
}

export type Block =
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'bullets'; items: Run[][] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'note'; text: string }

export interface Section {
  heading: string
  blocks: Block[]
}

export interface DocSource {
  n: number
  conversationId: number
  conversationTitle: string
  externalId: string
  messageId: number
  date: string | null
  origin: string
}

export interface DocModel {
  title: string
  docType: DocType
  subtitle: string
  generatedAt: string
  mode: 'ai' | 'local'
  scope: string
  sections: Section[]
  sources: DocSource[]
}

export function citeText(cites?: number[]): string {
  return cites?.length ? ' ' + cites.map((c) => `[${c}]`).join('') : ''
}
