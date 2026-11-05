import { sha256, stableStringify } from '../hash'

/** Shape of one conversation in ChatGPT's conversations.json (only the fields we rely on). */
export interface RawConversation {
  id?: string
  conversation_id?: string
  title?: string | null
  create_time?: number | null
  update_time?: number | null
  current_node?: string | null
  is_archived?: boolean
  mapping?: Record<string, RawNode>
  [key: string]: unknown
}

export interface RawNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: RawMessage | null
}

export interface RawMessage {
  id?: string
  author?: { role?: string; name?: string | null; metadata?: unknown }
  create_time?: number | null
  content?: Record<string, unknown> & { content_type?: string }
  metadata?: Record<string, unknown>
  recipient?: string
  [key: string]: unknown
}

export interface NormalizedNode {
  nodeId: string
  parentId: string | null
  role: string | null
  authorName: string | null
  contentType: string | null
  text: string
  createdAt: Date | null
  modelSlug: string | null
  isHidden: boolean
  isCanonical: boolean
  canonicalPosition: number | null
  depth: number
  siblingIndex: number
  siblingCount: number
  contentHash: string
  metadata: Record<string, unknown>
}

export interface NormalizedConversation {
  externalId: string
  title: string
  createdAt: Date | null
  updatedAt: Date | null
  currentNodeId: string | null
  isArchived: boolean
  contentHash: string
  nodes: NormalizedNode[]
  /** Visible user/assistant/tool messages on the canonical path. */
  messageCount: number
  /** Number of fork points (edits / regenerations). */
  branchCount: number
  modelSlugs: string[]
  warnings: string[]
}

export class ConversationFormatError extends Error {}

export function normalizeConversation(raw: RawConversation): NormalizedConversation {
  const externalId = raw.conversation_id ?? raw.id
  if (!externalId || typeof externalId !== 'string') {
    throw new ConversationFormatError('Conversation has no id/conversation_id')
  }
  const mapping = raw.mapping
  if (!mapping || typeof mapping !== 'object') {
    throw new ConversationFormatError(`Conversation ${externalId} has no message mapping`)
  }
  const warnings: string[] = []

  // Mapping keys are authoritative node ids; node.id should match but is not trusted.
  const ids = Object.keys(mapping)
  const parentOf = new Map<string, string | null>()
  for (const id of ids) {
    const p: string | null = mapping[id]?.parent ?? null
    if (p !== null && !(p in mapping)) {
      warnings.push(`Node ${id} references missing parent ${p}; treated as a root`)
      parentOf.set(id, null)
    } else {
      parentOf.set(id, p)
    }
  }
  const roots = ids.filter((id) => parentOf.get(id) === null)
  if (roots.length === 0 && ids.length > 0) warnings.push('Message tree has no root node')
  if (roots.length > 1) warnings.push(`Message tree has ${roots.length} root nodes`)

  // Canonical path: what the user last saw = current_node back to the root.
  let leaf = raw.current_node ?? null
  if (!leaf || !(leaf in mapping)) {
    if (leaf) warnings.push(`current_node ${leaf} not found; using the latest branch instead`)
    leaf = latestLeaf(mapping, roots[0])
  }
  const canonical: string[] = []
  const seen = new Set<string>()
  for (let cur: string | null = leaf; cur && !seen.has(cur); cur = parentOf.get(cur) ?? null) {
    seen.add(cur)
    canonical.push(cur)
  }
  canonical.reverse()
  const canonicalPos = new Map(canonical.map((id, i) => [id, i]))

  const depthMemo = new Map<string, number>()
  const depth = (id: string): number => {
    const path: string[] = []
    let cur: string | null = id
    const guard = new Set<string>()
    while (cur !== null && !depthMemo.has(cur)) {
      if (guard.has(cur)) {
        warnings.push(`Cycle detected in message tree at ${cur}`)
        depthMemo.set(cur, 0)
        break
      }
      guard.add(cur)
      path.push(cur)
      cur = parentOf.get(cur) ?? null
    }
    let d = cur === null ? -1 : depthMemo.get(cur)!
    for (let i = path.length - 1; i >= 0; i--) depthMemo.set(path[i], ++d)
    return depthMemo.get(id)!
  }

  const modelSlugs = new Set<string>()
  let messageCount = 0
  let branchCount = 0
  const nodes: NormalizedNode[] = ids.map((id) => {
    const node = mapping[id] ?? {}
    if ((node.children?.length ?? 0) > 1) branchCount++
    const parentId = parentOf.get(id) ?? null
    const siblings = parentId ? (mapping[parentId]?.children ?? []) : roots
    const msg = node.message ?? null
    const role = msg?.author?.role ?? null
    const text = msg ? extractText(msg) : ''
    const md = (msg?.metadata ?? {}) as Record<string, unknown>
    const modelSlug = typeof md.model_slug === 'string' ? md.model_slug : null
    if (modelSlug) modelSlugs.add(modelSlug)
    const isHidden =
      !msg ||
      md.is_visually_hidden_from_conversation === true ||
      (role === 'system' && text.trim() === '') ||
      (text.trim() === '' && !hasAttachments(msg))
    const isCanonical = canonicalPos.has(id)
    if (isCanonical && !isHidden && (role === 'user' || role === 'assistant' || role === 'tool')) messageCount++
    return {
      nodeId: id,
      parentId,
      role,
      authorName: msg?.author?.name ?? null,
      contentType: (msg?.content?.content_type as string | undefined) ?? null,
      text,
      createdAt: toDate(msg?.create_time),
      modelSlug,
      isHidden,
      isCanonical,
      canonicalPosition: canonicalPos.get(id) ?? null,
      depth: depth(id),
      siblingIndex: Math.max(0, siblings.indexOf(id)),
      siblingCount: Math.max(1, siblings.length),
      contentHash: sha256(stableStringify({ parent: parentId, message: msg })),
      metadata: messageMetadata(msg),
    }
  })

  return {
    externalId,
    title: (raw.title ?? '').toString().trim() || 'Untitled conversation',
    createdAt: toDate(raw.create_time),
    updatedAt: toDate(raw.update_time),
    currentNodeId: leaf,
    isArchived: raw.is_archived === true,
    contentHash: conversationHash(raw),
    nodes,
    messageCount,
    branchCount,
    modelSlugs: [...modelSlugs].sort(),
    warnings,
  }
}

/**
 * Identity of a conversation's content. Ignores update_time and other volatile export fields so that
 * re-exporting an unchanged conversation is recognised as unchanged.
 */
export function conversationHash(raw: RawConversation): string {
  return sha256(stableStringify({ title: raw.title ?? '', current_node: raw.current_node ?? null, mapping: raw.mapping }))
}

function latestLeaf(mapping: Record<string, RawNode>, root: string | undefined): string | null {
  let cur = root ?? null
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const kids = (mapping[cur]?.children ?? []).filter((k) => k in mapping)
    if (kids.length === 0) return cur
    cur = kids[kids.length - 1]
  }
  return cur
}

function toDate(t: unknown): Date | null {
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return new Date(t * 1000)
  if (typeof t === 'string' && t) {
    const n = Number(t)
    const d = Number.isFinite(n) ? new Date(n * 1000) : new Date(t)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function hasAttachments(msg: RawMessage): boolean {
  const a = msg.metadata?.attachments
  return Array.isArray(a) && a.length > 0
}

function messageMetadata(msg: RawMessage | null): Record<string, unknown> {
  if (!msg) return {}
  const out: Record<string, unknown> = {}
  const md = msg.metadata ?? {}
  if (Array.isArray(md.attachments)) {
    out.attachments = md.attachments.map((a: Record<string, unknown>) => ({
      name: a.name ?? null,
      mime_type: a.mime_type ?? a.mimeType ?? null,
      size: a.size ?? null,
    }))
  }
  if (msg.recipient && msg.recipient !== 'all') out.recipient = msg.recipient
  if (md.is_user_system_message) out.custom_instructions = true
  return out
}

/** Flatten every known ChatGPT content type into readable text. Unknown types fall back to their string fields. */
export function extractText(msg: RawMessage): string {
  const c = msg.content
  if (!c) return ''
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (c.content_type) {
    case 'text':
    case 'multimodal_text':
      return partsToText(c.parts)
    case 'code': {
      const lang = s(c.language) && c.language !== 'unknown' ? s(c.language) : ''
      return s(c.text) ? '```' + lang + '\n' + s(c.text) + '\n```' : ''
    }
    case 'execution_output':
      return s(c.text)
    case 'tether_browsing_display':
      return [s(c.summary), s(c.result)].filter(Boolean).join('\n\n')
    case 'tether_quote':
      return [s(c.title), s(c.url), s(c.text)].filter(Boolean).join('\n')
    case 'user_editable_context':
      return [
        s(c.user_profile) && `About the user:\n${s(c.user_profile)}`,
        s(c.user_instructions) && `Instructions for ChatGPT:\n${s(c.user_instructions)}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'model_editable_context':
      return s(c.model_set_context)
    case 'thoughts':
      return Array.isArray(c.thoughts)
        ? c.thoughts
            .map((t: Record<string, unknown>) => [s(t.summary), s(t.content)].filter(Boolean).join('\n'))
            .filter(Boolean)
            .join('\n\n')
        : ''
    case 'reasoning_recap':
      return s(c.content)
    case 'system_error':
      return [s(c.name), s(c.text)].filter(Boolean).join(': ')
    default: {
      if (Array.isArray(c.parts)) return partsToText(c.parts)
      return [s(c.text), s(c.result), s(c.content)].filter(Boolean).join('\n\n')
    }
  }
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p) => {
      if (typeof p === 'string') return p
      if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
        if (o.content_type === 'image_asset_pointer') return '[Image]'
        if (o.content_type === 'audio_asset_pointer') return '[Audio]'
        if (typeof o.content_type === 'string') return `[${o.content_type}]`
      }
      return ''
    })
    .filter((t) => t !== '')
    .join('\n\n')
}
