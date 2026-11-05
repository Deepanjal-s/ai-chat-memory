import type { Llm } from '../ai/llm'
import { EXTRACTION_JSON_SCHEMA, ExtractionSchema, type Extraction, type SourceMessage } from './types'

const SYSTEM = `You extract an accurate, verifiable record from one ChatGPT conversation of a company director.

Return:
- summary: 2-4 sentences on what the conversation was about and where it ended up.
- entities: the projects, organisations, people, products, technologies and topics that the conversation is substantively about and NAMES explicitly. If a name in "Known entities" is written in the conversation (even with different spacing or case), use that exact known spelling. Never attach a known entity to a conversation that does not name it, even if the subject seems similar; entities not named in the text are discarded automatically.
- items: the decisions, requirements, tasks, problems, solutions, ideas, preferences/standing instructions and deadlines.

Rules — accuracy matters more than coverage:
1. Every item's "quote" must be copied EXACTLY (verbatim, 8-300 characters) from the message whose id is given in "message_id". Items whose quote cannot be found in that message are discarded automatically.
2. status:
   - "confirmed" only when the USER states or explicitly accepts it ("we'll go with X", "decision: X", "yes, do that").
   - "proposed" when ChatGPT suggests or recommends something the user did not explicitly accept.
   - "assumption" when something is assumed rather than decided; "discussed" for problems, ideas or facts that were only discussed.
   - tasks: "open" or "done"; anything explicitly abandoned: "rejected".
   When unsure, choose the weaker status.
3. statement: one self-contained sentence a reader can understand without the conversation (name the project).
4. due: the deadline as written ("end of March", "2026-04-01"), or null.
5. entities on an item: canonical names from the entities list that the item is about.
6. Do not invent anything. Skip small talk and generic explanations. Do not treat ChatGPT's general advice as the director's decision.`

/** Long conversations are split into windows so nothing is silently truncated. */
const WINDOW_CHARS = 120_000

export async function llmExtract(
  llm: Llm,
  title: string,
  messages: SourceMessage[],
  knownEntities: string[],
): Promise<Extraction> {
  const rendered = messages.map(
    (m) => `[message_id=${m.id}] ${m.role.toUpperCase()}${m.createdAt ? ` (${m.createdAt.toISOString().slice(0, 16)})` : ''}:\n${m.text}`,
  )
  const windows: string[][] = [[]]
  let size = 0
  for (const r of rendered) {
    if (size + r.length > WINDOW_CHARS && windows[windows.length - 1].length) {
      windows.push([])
      size = 0
    }
    windows[windows.length - 1].push(r)
    size += r.length
  }

  const parts: Extraction[] = []
  for (let i = 0; i < windows.length; i++) {
    const user =
      `Conversation title: ${title}\n` +
      (windows.length > 1 ? `Part ${i + 1} of ${windows.length}.\n` : '') +
      `Known entities: ${knownEntities.length ? knownEntities.join(', ') : '(none yet)'}\n\n` +
      `<conversation>\n${windows[i].join('\n\n')}\n</conversation>`
    parts.push(
      await llm.json({
        purpose: 'knowledge_extraction',
        system: SYSTEM,
        user,
        schema: EXTRACTION_JSON_SCHEMA,
        validate: ExtractionSchema,
        effort: 'medium',
      }),
    )
  }
  return {
    summary: parts.map((p) => p.summary).join(' '),
    entities: parts.flatMap((p) => p.entities),
    items: parts.flatMap((p) => p.items),
  }
}
