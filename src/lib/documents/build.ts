import { z } from 'zod'
import type { Llm } from '../ai/llm'
import type { Db } from '../db/client'
import { KIND_LABEL, STATUS_LABEL } from '../knowledge/types'
import { verifyCitations, renderSources } from '../qa'
import { detectEntities, retrieve, type Source } from '../retrieval'
import { DOC_TYPES, type Block, type DocModel, type DocRequest, type DocSource, type Run, type Section } from './model'

type ItemSrc = Extract<Source, { type: 'item' }>

const SECTIONS_BY_TYPE: Record<DocRequest['docType'], string[]> = {
  project_report: ['overview', 'timeline', 'decisions', 'requirements', 'problems', 'tasks', 'ideas', 'changes'],
  technical: ['overview', 'decisions', 'requirements', 'problems', 'timeline', 'changes'],
  decision_record: ['overview', 'decisions', 'changes'],
  requirements: ['overview', 'requirements', 'changes'],
  pending_tasks: ['tasks'],
  timeline: ['timeline', 'changes'],
}

/**
 * Builds a document from the knowledge base. Every statement carries a numbered reference to the original
 * conversation message. Only the optional executive overview is written by the AI model (when enabled), and
 * its citations are verified; every other section is assembled directly from verified records.
 */
export async function buildDocument(db: Db, req: DocRequest, llm: Llm | null): Promise<DocModel> {
  let subject = req.query?.trim() || ''
  let entityName: string | null = null
  if (req.entityId) {
    const [e] = await db.query<{ name: string }>('SELECT name FROM entities WHERE id = $1', [req.entityId])
    if (!e) throw new Error('The selected project or topic no longer exists')
    entityName = e.name
    subject = subject || e.name
  }
  if (!subject) throw new Error('Choose a project/topic or enter a subject')
  // A typed subject that names a known project is treated like choosing that project.
  let entityIds = req.entityId ? [req.entityId] : []
  if (!entityIds.length) {
    const found = await detectEntities(db, subject)
    if (found.length) {
      entityIds = found.map((e) => e.id)
      entityName = found.map((e) => e.name).join(', ')
    }
  }

  const sources = await retrieve(db, {
    query: subject,
    entityIds,
    from: req.from ?? null,
    to: req.to ?? null,
    maxItems: 400,
    maxMessages: 25,
  })

  // Conversations in scope, for the timeline.
  const convIds = [...new Set(sources.map((s) => s.conversationId))]
  const convs = convIds.length
    ? await db.query<{ id: number; title: string; created_at: Date | null; updated_at: Date | null; summary: string | null; external_id: string }>(
        `SELECT id, title, created_at, updated_at, summary, external_id FROM conversations WHERE id = ANY($1::int[])
          ORDER BY created_at NULLS LAST, id`,
        [convIds],
      )
    : []

  // Number sources in order of appearance in the document; items reuse the number of their message.
  const docSources: DocSource[] = []
  const numberFor = new Map<number, number>() // messageId → n
  const cite = (s: { messageId: number; conversationId: number; conversationTitle: string; externalId: string; date: string | null; origin: string }) => {
    let n = numberFor.get(s.messageId)
    if (!n) {
      n = docSources.length + 1
      numberFor.set(s.messageId, n)
      docSources.push({ n, messageId: s.messageId, conversationId: s.conversationId, conversationTitle: s.conversationTitle, externalId: s.externalId, date: s.date, origin: s.origin })
    }
    return n
  }

  const items = sources.filter((s): s is ItemSrc => s.type === 'item')
  const byItemId = new Map(items.map((i) => [i.itemId, i]))
  const chrono = (a: ItemSrc, b: ItemSrc) => (a.date ?? '').localeCompare(b.date ?? '')
  const itemRun = (i: ItemSrc, showStatus = true): Run[] => {
    const notes: string[] = []
    if (i.supersededBy) {
      const later = byItemId.get(i.supersededBy)
      notes.push(later ? `Outdated: replaced by a later statement [${cite(later)}]` : 'Outdated: replaced by a later statement')
    }
    if (i.contradictedBy.length) notes.push('Conflicting statements exist (see “Changes and conflicts”)')
    if (i.possiblyChangedBy.length) notes.push('Possibly changed later (needs review)')
    return [
      { text: `${i.date ? i.date.slice(0, 10) + ' — ' : ''}${i.statement}`, cites: [cite(i)], tag: showStatus ? STATUS_LABEL[i.status] ?? i.status : undefined },
      ...(notes.length ? [{ text: ` (${notes.join('; ')})` }] : []),
    ]
  }
  const bulletList = (list: ItemSrc[], showStatus = true): Block =>
    list.length ? { type: 'bullets', items: list.sort(chrono).map((i) => itemRun(i, showStatus)) } : { type: 'note', text: 'Nothing recorded in the available conversations.' }

  const sections: Section[] = []
  for (const key of SECTIONS_BY_TYPE[req.docType]) {
    switch (key) {
      case 'overview':
        sections.push({ heading: 'Overview', blocks: await overview(subject, items, convs, sources, llm, cite) })
        break
      case 'timeline':
        sections.push({
          heading: 'Timeline of discussions',
          blocks: convs.length
            ? [
                {
                  type: 'bullets',
                  items: convs.map((c) => {
                    const first = sources.find((s) => s.conversationId === c.id)!
                    return [
                      { text: `${c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : 'undated'} — ${c.title}`, cites: [cite(first)] },
                      ...(c.summary ? [{ text: `: ${c.summary.replace(/\s+/g, ' ').slice(0, 400)}` }] : []),
                    ]
                  }),
                },
              ]
            : [{ type: 'note', text: 'No conversations found for this subject.' }],
        })
        break
      case 'decisions': {
        const confirmed = items.filter((i) => i.kind === 'decision' && i.status === 'confirmed')
        const proposed = items.filter((i) => i.kind === 'decision' && i.status !== 'confirmed')
        sections.push({
          heading: 'Decisions',
          blocks: [
            { type: 'paragraph', runs: [{ text: 'Confirmed by the director:' }] },
            bulletList(confirmed, false),
            { type: 'paragraph', runs: [{ text: 'Suggested or discussed, not confirmed:' }] },
            bulletList(proposed),
          ],
        })
        break
      }
      case 'requirements':
        sections.push({ heading: 'Requirements and specifications', blocks: [bulletList(items.filter((i) => i.kind === 'requirement' || i.kind === 'preference'))] })
        break
      case 'problems':
        sections.push({ heading: 'Problems and solutions', blocks: [bulletList(items.filter((i) => i.kind === 'problem' || i.kind === 'solution'))] })
        break
      case 'tasks': {
        const open = items.filter((i) => (i.kind === 'task' && i.status === 'open' && !i.supersededBy) || i.kind === 'deadline')
        const done = items.filter((i) => i.kind === 'task' && (i.status === 'done' || i.supersededBy))
        sections.push({
          heading: 'Pending work',
          blocks: [
            open.length
              ? {
                  type: 'table',
                  headers: ['Recorded', 'Task / deadline', 'Conversation', 'Ref'],
                  rows: open.sort(chrono).map((i) => [i.date?.slice(0, 10) ?? '—', i.statement, i.conversationTitle, `[${cite(i)}]`]),
                }
              : { type: 'note', text: 'No open tasks recorded.' },
            ...(done.length ? [{ type: 'paragraph' as const, runs: [{ text: 'Completed or replaced:' }] }, bulletList(done)] : []),
            { type: 'note', text: 'A task is shown as open until a later conversation records it as done; check recent work before relying on this list.' },
          ],
        })
        break
      }
      case 'ideas':
        sections.push({ heading: 'Ideas and suggestions', blocks: [bulletList(items.filter((i) => i.kind === 'idea'))] })
        break
      case 'changes': {
        const changed = items.filter((i) => i.supersededBy || i.contradictedBy.length || i.possiblyChangedBy.length)
        sections.push({
          heading: 'Changes and conflicts',
          blocks: changed.length
            ? [
                {
                  type: 'bullets',
                  items: changed.sort(chrono).map((i): Run[] => {
                    const later = [i.supersededBy, ...i.contradictedBy, ...i.possiblyChangedBy].map((id) => (id ? byItemId.get(id) : undefined)).filter((x): x is ItemSrc => !!x)
                    const label = i.supersededBy ? 'Replaced' : i.contradictedBy.length ? 'Conflict' : 'Possibly changed'
                    return [
                      { text: `${label}: “${i.statement}” (${i.date?.slice(0, 10) ?? 'undated'})`, cites: [cite(i)] },
                      ...later.map((l) => ({ text: ` → “${l.statement}” (${l.date?.slice(0, 10) ?? 'undated'})`, cites: [cite(l)] })),
                    ]
                  }),
                },
              ]
            : [{ type: 'note', text: 'No changed or conflicting statements were detected among the records in scope.' }],
        })
        break
      }
    }
  }

  const range = [req.from && `from ${req.from}`, req.to && `to ${req.to}`].filter(Boolean).join(' ')
  return {
    title: req.title?.trim() || `${DOC_TYPES[req.docType]}: ${entityName ?? subject}`,
    docType: req.docType,
    subtitle: `Prepared from ${convs.length} conversation${convs.length === 1 ? '' : 's'} and ${items.length} recorded statement${items.length === 1 ? '' : 's'}`,
    generatedAt: new Date().toISOString(),
    mode: llm ? 'ai' : 'local',
    scope: `Subject: ${entityName ?? subject}${range ? ` (${range})` : ''}`,
    sections,
    sources: docSources,
  }
}

const OverviewSchema = z.object({ overview: z.string() })

async function overview(
  subject: string,
  items: ItemSrc[],
  convs: { id: number; title: string; created_at: Date | null }[],
  sources: Source[],
  llm: Llm | null,
  cite: (s: Source) => number,
): Promise<Block[]> {
  if (!sources.length) return [{ type: 'note', text: `No conversations about “${subject}” were found.` }]
  const first = convs[0]?.created_at ? new Date(convs[0].created_at).toISOString().slice(0, 10) : null
  const last = convs.at(-1)?.created_at ? new Date(convs.at(-1)!.created_at!).toISOString().slice(0, 10) : null
  const count = (pred: (i: ItemSrc) => boolean) => items.filter(pred).length
  const facts: Run[] = [
    {
      text:
        `“${subject}” was discussed in ${convs.length} conversation${convs.length === 1 ? '' : 's'}` +
        (first ? ` between ${first} and ${last}` : '') +
        `. The record contains ${count((i) => i.kind === 'decision' && i.status === 'confirmed')} confirmed decision(s), ` +
        `${count((i) => i.status === 'proposed')} unconfirmed suggestion(s), ${count((i) => i.kind === 'requirement')} requirement(s), ` +
        `${count((i) => i.kind === 'task' && i.status === 'open')} open task(s) and ` +
        `${count((i) => !!i.supersededBy || i.contradictedBy.length > 0)} statement(s) that were later replaced or contradicted.`,
    },
  ]
  const blocks: Block[] = [{ type: 'paragraph', runs: facts }]
  if (!llm) {
    const latest = items.filter((i) => i.kind === 'decision' && i.status === 'confirmed' && !i.supersededBy).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 5)
    if (latest.length) {
      blocks.push({ type: 'paragraph', runs: [{ text: 'Current confirmed decisions:' }] })
      blocks.push({ type: 'bullets', items: latest.map((i) => [{ text: i.statement, cites: [cite(i)] }]) })
    }
    return blocks
  }
  const subset = sources.slice(0, 120)
  const res = await llm.json({
    purpose: 'document_overview',
    system:
      'Write a factual executive overview (2-4 short paragraphs, plain text, no headings) of the subject using ONLY the numbered sources. ' +
      'Cite each sentence with [S#]. Distinguish confirmed decisions from suggestions, present the current state before history, and mention open questions or conflicts. ' +
      'Do not add anything the sources do not support.',
    user: `Subject: ${subject}\n\nSources:\n\n${renderSources(subset)}`,
    schema: { type: 'object', additionalProperties: false, required: ['overview'], properties: { overview: { type: 'string' } } },
    validate: OverviewSchema,
    effort: 'medium',
    maxTokens: 8000,
  })
  const { text } = verifyCitations(res.overview, subset.length)
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    // Convert [S#] markers into document reference numbers.
    const runs: Run[] = []
    let last = 0
    for (const m of para.matchAll(/((?:\[S\d+\])+)/g)) {
      const nums = [...m[1].matchAll(/S(\d+)/g)].map((x) => cite(subset[Number(x[1]) - 1]))
      runs.push({ text: para.slice(last, m.index), cites: nums })
      last = m.index! + m[1].length
    }
    if (last < para.length) runs.push({ text: para.slice(last) })
    blocks.push({ type: 'paragraph', runs })
  }
  blocks.push({ type: 'note', text: 'The overview above was written by an AI model from the cited records; the sections below are taken directly from the records.' })
  return blocks
}

export { KIND_LABEL }
