import { z } from 'zod'
import type { Db, Queryable } from '../db/client'
import { sha256 } from '../hash'
import { getOrCreateSource, rebuildChunks, recountMessages } from '../importer/import'
import { enqueueJob } from '../jobs'

/** What the browser extension sends after a ChatGPT reply finishes (validated strictly). */
export const CapturePayloadSchema = z.object({
  conversationId: z.string().regex(/^[A-Za-z0-9-]{8,100}$/, 'invalid conversation id'),
  title: z.string().max(500).nullable(),
  url: z.string().max(2000),
  capturedAt: z.iso.datetime(),
  extensionVersion: z.string().max(40),
  messages: z
    .array(
      z.object({
        id: z.string().max(200).nullable(),
        role: z.enum(['user', 'assistant', 'tool', 'system']),
        text: z.string().max(500_000),
        model: z.string().max(100).nullable().optional(),
        variant: z.object({ index: z.number().int().min(1), count: z.number().int().min(1) }).nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
})
export type CapturePayload = z.infer<typeof CapturePayloadSchema>

export interface IngestResult {
  conversationId: number
  created: boolean
  added: number
  updated: number
  unchanged: number
  movedToEarlierVersions: number
  exportTextKept: number
}

interface Existing {
  id: number
  node_external_id: string
  role: string
  content_text: string
  origin: string
  canonical_position: number | null
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Merges one live capture into the archive. The capture shows the thread exactly as ChatGPT currently displays it,
 * so it is aligned with the stored canonical thread:
 *  - messages are matched by ChatGPT's message id, or by identical role + text when the id is unknown;
 *  - stored messages the new thread no longer shows (edited/regenerated away) become "earlier versions";
 *  - text from an official export is authoritative and is never overwritten by a live capture.
 * The raw payload is kept in capture_events.
 */
export async function ingestCapture(db: Db, payload: CapturePayload, sourceLabel = 'ChatGPT'): Promise<IngestResult> {
  const capturedAt = new Date(payload.capturedAt)
  const visible = payload.messages.filter((m) => m.role !== 'system' && m.text.trim() !== '')

  const result = await db.tx(async (q) => {
    const sourceId = await getOrCreateSource(q, 'chatgpt', sourceLabel)
    let [conv] = await q.query<{ id: number; title: string; created_at: Date | string | null }>(
      'SELECT id, title, created_at FROM conversations WHERE source_id = $1 AND external_id = $2',
      [sourceId, payload.conversationId],
    )
    let created = false
    if (!conv) {
      ;[conv] = await q.query<{ id: number; title: string; created_at: Date | string | null }>(
        `INSERT INTO conversations(source_id, external_id, title, created_at, updated_at, content_hash, origin, last_captured_at)
         VALUES ($1, $2, $3, $4, $4, $5, 'live_capture', now()) RETURNING id, title, created_at`,
        [sourceId, payload.conversationId, payload.title?.trim() || 'Untitled conversation', capturedAt.toISOString(), `live:${sha256(JSON.stringify(payload))}`],
      )
      created = true
    }

    const existing = await q.query<Existing>(
      `SELECT id, node_external_id, role, content_text, origin, canonical_position FROM messages
        WHERE conversation_id = $1 AND is_canonical AND present_in_latest AND NOT is_hidden AND role IN ('user','assistant','tool')
        ORDER BY canonical_position, id`,
      [conv.id],
    )
    const allNodes = await q.query<{ node_external_id: string; role: string; content_text: string }>(
      'SELECT node_external_id, role, content_text FROM messages WHERE conversation_id = $1',
      [conv.id],
    )

    // Resolve a stable node id for every captured message.
    const byText = new Map<string, string[]>()
    for (const n of allNodes) {
      const key = `${n.role}\n${norm(n.content_text)}`
      byText.set(key, [...(byText.get(key) ?? []), n.node_external_id])
    }
    const knownIds = new Set(allNodes.map((n) => n.node_external_id))
    const used = new Set<string>()
    const occurrences = new Map<string, number>()
    const captured = visible.map((m) => {
      const key = `${m.role}\n${norm(m.text)}`
      let nodeId = m.id && knownIds.has(m.id) ? m.id : null
      if (!nodeId) nodeId = (byText.get(key) ?? []).find((id) => !used.has(id)) ?? null
      if (!nodeId && m.id) nodeId = m.id
      if (!nodeId) {
        const k = (occurrences.get(key) ?? 0) + 1
        occurrences.set(key, k)
        nodeId = `cap:${sha256(`${key}\n${k}`).slice(0, 32)}`
      }
      used.add(nodeId)
      return { ...m, nodeId }
    })

    // Decide the canonical visible thread after this capture.
    const exIds = existing.map((e) => e.node_external_id)
    const exIndex = new Map(exIds.map((id, i) => [id, i]))
    const anchor = captured.findIndex((c) => exIndex.has(c.nodeId))
    let final: string[]
    if (existing.length === 0) {
      final = captured.map((c) => c.nodeId)
    } else if (anchor === -1) {
      // No overlap: a full thread (starts with the user and is not tiny) replaces; otherwise it continues the thread.
      const looksComplete = captured[0]?.role === 'user' && captured.length >= Math.ceil(existing.length / 2)
      final = looksComplete ? captured.map((c) => c.nodeId) : [...exIds, ...captured.map((c) => c.nodeId)]
    } else {
      const j0 = exIndex.get(captured[anchor].nodeId)!
      let i = anchor
      let j = j0
      while (i < captured.length && j < exIds.length && captured[i].nodeId === exIds[j]) {
        i++
        j++
      }
      const before = [...exIds.slice(0, j0), ...captured.slice(0, anchor).map((c) => c.nodeId)]
      if (i < captured.length) {
        // Divergence: the displayed thread continues differently from what was stored (edit or regeneration).
        final = [...before, ...exIds.slice(j0, j), ...captured.slice(i).map((c) => c.nodeId)]
      } else {
        // Capture ended inside the stored thread (partially rendered page): keep the stored tail.
        final = [...before, ...exIds.slice(j0)]
      }
    }
    const finalSet = new Set(final)

    // Positions: visible thread starts after any hidden preamble (system prompt, custom instructions).
    const [{ base }] = await q.query<{ base: number }>(
      `SELECT coalesce(max(canonical_position), -1)::int + 1 AS base FROM messages
        WHERE conversation_id = $1 AND is_canonical AND (is_hidden OR role NOT IN ('user','assistant','tool'))
          AND canonical_position < coalesce((SELECT min(canonical_position) FROM messages
               WHERE conversation_id = $1 AND is_canonical AND NOT is_hidden AND role IN ('user','assistant','tool')), 1000000)`,
      [conv.id],
    )

    const demote = existing.filter((e) => !finalSet.has(e.node_external_id))
    if (demote.length) {
      await q.query('UPDATE messages SET is_canonical = false, canonical_position = NULL WHERE id = ANY($1::int[])', [demote.map((d) => d.id)])
    }

    const capturedById = new Map(captured.map((c) => [c.nodeId, c]))
    const stored = new Map<string, { id: number; content_text: string; origin: string }>()
    for (const r of await q.query<{ id: number; node_external_id: string; content_text: string; origin: string }>(
      'SELECT id, node_external_id, content_text, origin FROM messages WHERE conversation_id = $1 AND node_external_id = ANY($2::text[])',
      [conv.id, final],
    )) {
      stored.set(r.node_external_id, r)
    }

    let added = 0
    let updated = 0
    let unchanged = 0
    let exportTextKept = 0
    for (let k = 0; k < final.length; k++) {
      const nodeId = final[k]
      const parent = k > 0 ? final[k - 1] : null
      const cap = capturedById.get(nodeId)
      const row = stored.get(nodeId)
      const position = base + k
      if (row) {
        if (cap && norm(cap.text) !== norm(row.content_text)) {
          if (row.origin === 'export') {
            exportTextKept++
          } else {
            await q.query(
              `UPDATE messages SET content_text = $2, content_hash = $3, captured_at = $4, model_slug = coalesce($5, model_slug) WHERE id = $1`,
              [row.id, cap.text, sha256(`${cap.role}\n${cap.text}`), capturedAt.toISOString(), cap.model ?? null],
            )
            updated++
          }
        } else if (cap) {
          unchanged++
        }
        await q.query(
          `UPDATE messages SET is_canonical = true, canonical_position = $2, present_in_latest = true,
             parent_node_external_id = CASE WHEN origin = 'live_capture' THEN $3 ELSE parent_node_external_id END
           WHERE id = $1`,
          [row.id, position, parent],
        )
      } else if (cap) {
        await q.query(
          `INSERT INTO messages(conversation_id, node_external_id, parent_node_external_id, role, content_type, content_text, created_at,
             captured_at, model_slug, is_hidden, is_canonical, canonical_position, depth, sibling_index, sibling_count, content_hash,
             present_in_latest, metadata, origin)
           VALUES ($1,$2,$3,$4,'text',$5,$6,$6,$7,false,true,$8,$9,$10,$11,$12,true,$13::jsonb,'live_capture')`,
          [
            conv.id,
            nodeId,
            parent,
            cap.role,
            cap.text,
            capturedAt.toISOString(),
            cap.model ?? null,
            position,
            k + 1,
            cap.variant ? cap.variant.index - 1 : 0,
            cap.variant?.count ?? 1,
            sha256(`${cap.role}\n${cap.text}`),
            JSON.stringify({ approximate_time: true, captured_from: 'browser_extension' }),
          ],
        )
        added++
      }
    }

    const changed = created || added + updated + demote.length > 0
    const title = payload.title?.trim() || conv.title
    await q.query(
      `UPDATE conversations SET title = $2, last_captured_at = now(),
         updated_at = CASE WHEN $3 THEN greatest(coalesce(updated_at, $4::timestamptz), $4::timestamptz) ELSE updated_at END
       WHERE id = $1`,
      [conv.id, title, changed, capturedAt.toISOString()],
    )
    if (changed) {
      await recountMessages(q, conv.id)
      await rebuildChunks(q, conv.id, title, conv.created_at ? new Date(conv.created_at) : capturedAt)
      // Wait a minute so an active chat is processed once, not after every reply.
      await enqueueJob(q, 'process_conversation', { conversationId: conv.id }, { dedupeKey: `process:${conv.id}`, delaySeconds: 60 })
    }
    return { conversationId: conv.id, created, added, updated, unchanged, movedToEarlierVersions: demote.length, exportTextKept }
  })

  await logCapture(db, payload, result.conversationId, 'ok', null, result)
  return result
}

export async function logCapture(
  q: Queryable,
  payload: unknown,
  conversationId: number | null,
  outcome: 'ok' | 'rejected' | 'error',
  error: string | null,
  r?: Pick<IngestResult, 'added' | 'updated'>,
) {
  const p = payload as Partial<CapturePayload>
  await q.query(
    `INSERT INTO capture_events(conversation_external_id, conversation_id, message_count, added, updated, result, error, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      typeof p?.conversationId === 'string' ? p.conversationId.slice(0, 100) : null,
      conversationId,
      Array.isArray(p?.messages) ? p.messages.length : 0,
      r?.added ?? 0,
      r?.updated ?? 0,
      outcome,
      error,
      JSON.stringify(outcome === 'ok' ? payload : { rejected: true }),
    ],
  )
}
