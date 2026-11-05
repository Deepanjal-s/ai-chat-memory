import type { RawConversation, RawNode } from '../../src/lib/importer/normalize'

/** Seconds since epoch for a UTC date string. */
export const t = (s: string) => Date.parse(s) / 1000

interface Msg {
  id: string
  parent: string | null
  role?: 'system' | 'user' | 'assistant' | 'tool'
  text?: string
  content?: Record<string, unknown>
  time?: number
  hidden?: boolean
  model?: string
}

/** Builds a conversation in the exact shape of ChatGPT's conversations.json. */
export function conversation(opts: {
  id: string
  title: string
  create: number
  update: number
  current: string
  messages: Msg[]
}): RawConversation {
  const mapping: Record<string, RawNode> = {}
  for (const m of opts.messages) {
    mapping[m.id] = {
      id: m.id,
      parent: m.parent,
      children: [],
      message: m.role
        ? {
            id: m.id,
            author: { role: m.role, name: null, metadata: {} },
            create_time: m.time ?? null,
            content: m.content ?? { content_type: 'text', parts: [m.text ?? ''] },
            metadata: {
              ...(m.hidden ? { is_visually_hidden_from_conversation: true } : {}),
              ...(m.model ? { model_slug: m.model } : {}),
            },
            recipient: 'all',
          }
        : null,
    }
  }
  for (const m of opts.messages) if (m.parent) mapping[m.parent].children!.push(m.id)
  return {
    title: opts.title,
    create_time: opts.create,
    update_time: opts.update,
    mapping,
    current_node: opts.current,
    conversation_id: opts.id,
    id: opts.id,
    is_archived: false,
    moderation_results: [],
  }
}

/** The VK7SPORTS planning conversation: includes an edited user message (branch) and a regenerated reply. */
export function vk7Conversation(extra: Msg[] = [], current = 'a2b') {
  return conversation({
    id: 'conv-vk7',
    title: 'VK7SPORTS backend planning',
    create: t('2026-03-01T10:00:00Z'),
    update: t('2026-03-01T11:00:00Z'),
    current,
    messages: [
      { id: 'root', parent: null },
      { id: 'sys', parent: 'root', role: 'system', text: '', hidden: true },
      {
        id: 'ctx',
        parent: 'sys',
        role: 'user',
        hidden: true,
        content: {
          content_type: 'user_editable_context',
          user_profile: 'Director of a sports technology company.',
          user_instructions: 'Prefer PostgreSQL. Always include a cost section.',
        },
      },
      // Original question, later edited → branch.
      { id: 'u1', parent: 'ctx', role: 'user', text: 'What database for VK7SPORTS?', time: t('2026-03-01T10:00:00Z') },
      { id: 'a1', parent: 'u1', role: 'assistant', text: 'MongoDB could work.', time: t('2026-03-01T10:00:10Z'), model: 'gpt-4o' },
      {
        id: 'u1e',
        parent: 'ctx',
        role: 'user',
        text: 'What database should the VK7SPORTS backend use for match statistics?',
        time: t('2026-03-01T10:05:00Z'),
      },
      {
        id: 'a2',
        parent: 'u1e',
        role: 'assistant',
        text: 'I suggest PostgreSQL for relational match data.',
        time: t('2026-03-01T10:05:10Z'),
        model: 'gpt-4o',
      },
      { id: 'u2', parent: 'a2', role: 'user', text: 'Decision: we go with PostgreSQL. Show me a schema.', time: t('2026-03-01T10:10:00Z') },
      {
        id: 'a2b',
        parent: 'u2',
        role: 'assistant',
        content: { content_type: 'code', language: 'sql', text: 'CREATE TABLE matches (id serial primary key);' },
        time: t('2026-03-01T10:10:30Z'),
        model: 'gpt-4o',
      },
      { id: 'a2c', parent: 'u2', role: 'assistant', text: 'Regenerated: here is an alternative schema.', time: t('2026-03-01T10:11:00Z') },
      ...extra,
    ],
  })
}

export function marketingConversation() {
  return conversation({
    id: 'conv-mkt',
    title: 'Q2 marketing ideas',
    create: t('2026-04-10T09:00:00Z'),
    update: t('2026-04-10T09:30:00Z'),
    current: 'ma1',
    messages: [
      { id: 'mroot', parent: null },
      {
        id: 'mu1',
        parent: 'mroot',
        role: 'user',
        content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' }, 'Ideas for a cricket academy launch campaign?'] },
        time: t('2026-04-10T09:00:00Z'),
      },
      { id: 'ma1', parent: 'mu1', role: 'assistant', text: 'Run a free coaching weekend and partner with schools.', time: t('2026-04-10T09:00:20Z') },
    ],
  })
}
