import { describe, expect, it } from 'vitest'
import { normalizeConversation, conversationHash } from '../src/lib/importer/normalize'
import { vk7Conversation, marketingConversation } from './fixtures/build-export'

describe('normalizeConversation', () => {
  const n = normalizeConversation(vk7Conversation())
  const byId = new Map(n.nodes.map((x) => [x.nodeId, x]))

  it('keeps every node of the tree, including abandoned branches', () => {
    expect(n.nodes).toHaveLength(10)
    expect(byId.get('u1')!.isCanonical).toBe(false)
    expect(byId.get('a2c')!.isCanonical).toBe(false)
  })

  it('follows current_node back to the root for the canonical thread', () => {
    const canonical = n.nodes.filter((x) => x.isCanonical).sort((a, b) => a.canonicalPosition! - b.canonicalPosition!)
    expect(canonical.map((x) => x.nodeId)).toEqual(['root', 'sys', 'ctx', 'u1e', 'a2', 'u2', 'a2b'])
  })

  it('records edit/regeneration siblings and fork count', () => {
    expect(byId.get('u1e')).toMatchObject({ siblingIndex: 1, siblingCount: 2 })
    expect(byId.get('a2b')).toMatchObject({ siblingIndex: 0, siblingCount: 2 })
    expect(n.branchCount).toBe(2)
  })

  it('counts only visible canonical user/assistant messages', () => {
    expect(n.messageCount).toBe(4)
  })

  it('extracts text from code, custom instructions and multimodal parts', () => {
    expect(byId.get('a2b')!.text).toBe('```sql\nCREATE TABLE matches (id serial primary key);\n```')
    expect(byId.get('ctx')!.text).toContain('Prefer PostgreSQL')
    expect(byId.get('ctx')!.isHidden).toBe(true)
    const m = normalizeConversation(marketingConversation())
    expect(m.nodes.find((x) => x.nodeId === 'mu1')!.text).toBe('[Image]\n\nIdeas for a cricket academy launch campaign?')
  })

  it('converts timestamps and model slugs', () => {
    expect(byId.get('u1e')!.createdAt!.toISOString()).toBe('2026-03-01T10:05:00.000Z')
    expect(n.modelSlugs).toEqual(['gpt-4o'])
  })

  it('hashes content independently of key order and update_time', () => {
    const a = vk7Conversation()
    const b = Object.fromEntries(Object.entries(structuredClone(a)).reverse()) as typeof a
    b.update_time = 1
    expect(conversationHash(b)).toBe(conversationHash(a))
  })

  it('falls back to the latest branch when current_node is missing', () => {
    const raw = vk7Conversation([], 'does-not-exist')
    const x = normalizeConversation(raw)
    expect(x.warnings[0]).toMatch(/current_node/)
    expect(x.nodes.find((y) => y.nodeId === 'a2c')!.isCanonical).toBe(true)
  })

  it('rejects conversations without an id or mapping', () => {
    expect(() => normalizeConversation({ title: 'x', mapping: {} })).toThrow(/id/)
    expect(() => normalizeConversation({ id: 'x' })).toThrow(/mapping/)
  })
})
