/*
 * Reads the conversation currently displayed on chatgpt.com from the page itself (the DOM).
 * It does not call ChatGPT's internal APIs, and does not read cookies, storage or credentials.
 * Kept free of extension APIs so it can be tested against a simulated page.
 */
;(function () {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HR'])
  const ROLES = new Set(['user', 'assistant', 'tool', 'system'])

  function conversationIdFromPath(pathname) {
    const m = String(pathname || '').match(/\/c\/([A-Za-z0-9-]{8,100})(?:[/?#]|$)/)
    return m ? m[1] : null
  }

  /** Text of an element with sensible line breaks; code blocks become fenced blocks; buttons are ignored. */
  function textOf(root) {
    let out = ''
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue
        return
      }
      if (node.nodeType !== 1) return
      const el = node
      const tag = el.tagName
      if (tag === 'BUTTON' || tag === 'SVG' || tag === 'svg' || el.getAttribute('aria-hidden') === 'true' || tag === 'STYLE' || tag === 'SCRIPT') return
      if (tag === 'PRE') {
        const code = el.querySelector('code') || el
        const lang = ((code.className || '').match(/language-([\w+#-]+)/) || [])[1] || ''
        out += '\n```' + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n```\n'
        return
      }
      if (tag === 'BR') {
        out += '\n'
        return
      }
      const block = BLOCK.has(tag)
      if (block) out += '\n'
      if (tag === 'LI') out += '- '
      if (tag === 'TD' || tag === 'TH') out += ' | '
      for (const child of el.childNodes) walk(child)
      if (block) out += '\n'
    }
    walk(root)
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  /** "2/3" switcher shown next to an edited or regenerated message. */
  function variantOf(turn) {
    if (!turn) return null
    for (const el of turn.querySelectorAll('div, span')) {
      if (el.children.length > 0) continue
      const m = (el.textContent || '').match(/^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/)
      if (m && Number(m[2]) > 1 && Number(m[1]) <= Number(m[2])) return { index: Number(m[1]), count: Number(m[2]) }
    }
    return null
  }

  function cleanTitle(t) {
    const s = String(t || '').replace(/\s*[|\-–]\s*ChatGPT\s*$/i, '').trim()
    return s && s.toLowerCase() !== 'chatgpt' ? s : null
  }

  function extractConversation(doc, loc) {
    const conversationId = conversationIdFromPath(loc.pathname)
    if (!conversationId) return null
    const messages = []
    for (const el of doc.querySelectorAll('[data-message-author-role]')) {
      // Skip elements nested inside another message element (avoid double counting).
      if (el.parentElement && el.parentElement.closest('[data-message-author-role]')) continue
      const role = el.getAttribute('data-message-author-role')
      if (!ROLES.has(role)) continue
      const content = el.querySelector('.markdown') || el.querySelector('.whitespace-pre-wrap') || el
      const text = textOf(content)
      if (!text) continue
      const turn = el.closest('[data-testid^="conversation-turn"]') || el.closest('article') || el.parentElement
      messages.push({
        id: el.getAttribute('data-message-id') || null,
        role,
        text,
        model: el.getAttribute('data-message-model-slug') || null,
        variant: variantOf(turn),
      })
    }
    const navLink = doc.querySelector('nav a[href$="/c/' + conversationId + '"]')
    const title = (navLink && navLink.textContent && navLink.textContent.trim()) || cleanTitle(doc.title)
    const streaming = !!doc.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]')
    return { conversationId, title: title || null, url: loc.href, messages, streaming }
  }

  globalThis.AIMExtract = { extractConversation, conversationIdFromPath, textOf, variantOf }
})()
