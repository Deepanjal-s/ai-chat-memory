export interface ChunkInputMessage {
  id: number
  role: string | null
  text: string
}

export interface Chunk {
  messageIds: number[]
  ordinal: number
  contextHeader: string
  text: string
}

/** ~1,000 tokens. Character budget keeps the chunker model-agnostic. */
const MAX_CHARS = 4000
const OVERLAP_CHARS = 400

const ROLE_LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' }

/**
 * Splits a conversation's canonical thread into retrieval units. A unit is one "turn": a user message plus
 * the replies that follow it, so a question and its answer stay together. Oversized turns fall back to one
 * unit per message, and oversized messages are split on paragraph boundaries without breaking code blocks.
 */
export function chunkConversation(
  title: string,
  date: Date | null,
  messages: ChunkInputMessage[],
): Chunk[] {
  const header = `Conversation: "${title}"${date ? ` · ${date.toISOString().slice(0, 10)}` : ''}`
  const turns: ChunkInputMessage[][] = []
  for (const m of messages) {
    if (!m.text.trim()) continue
    if (m.role === 'user' || turns.length === 0) turns.push([m])
    else turns[turns.length - 1].push(m)
  }

  const out: Chunk[] = []
  const push = (messageIds: number[], text: string) =>
    out.push({ messageIds, ordinal: out.length, contextHeader: header, text })

  for (const turn of turns) {
    const rendered = turn.map((m) => `${ROLE_LABEL[m.role ?? ''] ?? m.role ?? 'Message'}: ${m.text.trim()}`)
    const whole = rendered.join('\n\n')
    if (whole.length <= MAX_CHARS) {
      push(turn.map((m) => m.id), whole)
      continue
    }
    turn.forEach((m, i) => {
      if (rendered[i].length <= MAX_CHARS) push([m.id], rendered[i])
      else for (const piece of splitLongText(rendered[i])) push([m.id], piece)
    })
  }
  return out
}

export function splitLongText(text: string, max = MAX_CHARS, overlap = OVERLAP_CHARS): string[] {
  // Paragraphs, with fenced code blocks kept whole.
  const blocks: string[] = []
  let inFence = false
  let buf: string[] = []
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '' && buf.length) {
      blocks.push(buf.join('\n'))
      buf = []
    } else buf.push(line)
  }
  if (buf.length) blocks.push(buf.join('\n'))

  const pieces: string[] = []
  let cur = ''
  for (const b of blocks.flatMap((b) => (b.length > max ? hardSplit(b, max) : [b]))) {
    if (cur && cur.length + b.length + 2 > max) {
      pieces.push(cur)
      cur = cur.slice(-overlap) + '\n\n' + b
    } else cur = cur ? cur + '\n\n' + b : b
  }
  if (cur) pieces.push(cur)
  return pieces
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max))
  return out
}
