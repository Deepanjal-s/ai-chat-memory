import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { config } from '../config'
import type { Queryable } from '../db/client'
import { log } from '../logger'

/**
 * The one place conversation content can leave this server for an AI model. Every call is recorded in
 * external_calls (provider, purpose, size; never the content itself) so the director can see what was sent.
 */
export interface Llm {
  provider: string
  model: string
  json<T>(args: {
    purpose: string
    system: string
    user: string
    schema: Record<string, unknown>
    validate: z.ZodType<T>
    effort?: 'low' | 'medium' | 'high'
    maxTokens?: number
  }): Promise<T>
}

export class LlmError extends Error {}

export function getLlm(db: Queryable): Llm | null {
  if (config.aiProvider === 'anthropic') return anthropicLlm(db, config.aiModel, config.anthropicApiKey || undefined)
  if (config.aiProvider === 'gemini') {
    if (!config.geminiApiKey) throw new LlmError('AI_PROVIDER=gemini requires GEMINI_API_KEY')
    return geminiLlm(db, config.aiModel, config.geminiApiKey)
  }
  return null
}

export function aiDescription(): { enabled: boolean; provider: string; model: string | null } {
  if (config.aiProvider === 'anthropic') return { enabled: true, provider: 'Anthropic (Claude API)', model: config.aiModel }
  if (config.aiProvider === 'gemini') return { enabled: true, provider: 'Google (Gemini API)', model: config.aiModel }
  return { enabled: false, provider: 'None — all processing stays on this server', model: null }
}

/**
 * Google Gemini over its REST API (generateContent with a JSON schema). The key travels in a header, never in the URL.
 * Busy (503) and rate-limit (429) responses are retried with backoff; the free tier hits these often.
 */
function geminiLlm(db: Queryable, model: string, apiKey: string): Llm {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const DELAYS = [5_000, 20_000, 60_000]
  const TIMEOUT_MS = 120_000
  return {
    provider: 'gemini',
    model,
    async json({ purpose, system, user, schema, validate, effort = 'medium', maxTokens = 32000 }) {
      const chars = system.length + user.length
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingLevel: effort },
        },
      })
      try {
        for (let attempt = 0; ; attempt++) {
          let res: Response
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
              body,
              signal: AbortSignal.timeout(TIMEOUT_MS),
            })
          } catch (e) {
            // A hung request (common when the service is overloaded) is retried like a 503.
            if ((e as Error).name === 'TimeoutError' && attempt < DELAYS.length) {
              log('warn', 'llm_retry', { provider: 'gemini', purpose, status: 'timeout', attempt: attempt + 1 })
              continue
            }
            throw e
          }
          const json = (await res.json().catch(() => ({}))) as GeminiResponse
          if ((res.status === 429 || res.status >= 500) && attempt < DELAYS.length) {
            log('warn', 'llm_retry', { provider: 'gemini', purpose, status: res.status, attempt: attempt + 1 })
            await new Promise((r) => setTimeout(r, DELAYS[attempt]))
            continue
          }
          if (!res.ok) throw new LlmError(`Gemini API error ${res.status}: ${json.error?.message?.slice(0, 300) ?? res.statusText}`)
          if (json.promptFeedback?.blockReason) throw new LlmError(`The AI model declined this request (${json.promptFeedback.blockReason}).`)
          const cand = json.candidates?.[0]
          if (cand?.finishReason === 'MAX_TOKENS') throw new LlmError('The AI response was cut off (output limit reached).')
          if (cand?.finishReason && cand.finishReason !== 'STOP') throw new LlmError(`The AI model stopped early (${cand.finishReason}).`)
          const text = (cand?.content?.parts ?? []).map((p) => (p.thought ? '' : p.text ?? '')).join('')
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            throw new LlmError('The AI response was not valid JSON.')
          }
          const parsed = validate.safeParse(data)
          if (!parsed.success) throw new LlmError(`AI response did not match the expected format: ${parsed.error.message.slice(0, 300)}`)
          await record(db, { provider: 'gemini', model, purpose, chars, ok: true })
          return parsed.data
        }
      } catch (e) {
        const msg = (e as Error).name === 'TimeoutError' ? 'Gemini did not respond (timed out on every attempt)' : (e as Error).message
        await record(db, { provider: 'gemini', model, purpose, chars, ok: false, error: msg })
        log('error', 'llm_call_failed', { provider: 'gemini', purpose, error: msg })
        throw e instanceof LlmError ? e : new LlmError(msg)
      }
    },
  }
}

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

function anthropicLlm(db: Queryable, model: string, apiKey?: string): Llm {
  const client = new Anthropic(apiKey ? { apiKey } : {})
  return {
    provider: 'anthropic',
    model,
    async json({ purpose, system, user, schema, validate, effort = 'medium', maxTokens = 32000 }) {
      const chars = system.length + user.length
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort, format: { type: 'json_schema', schema } },
          system,
          messages: [{ role: 'user', content: user }],
        })
        const message = await stream.finalMessage()
        if (message.stop_reason === 'refusal') throw new LlmError('The AI model declined this request.')
        if (message.stop_reason === 'max_tokens') throw new LlmError('The AI response was cut off (output limit reached).')
        const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        const parsed = validate.safeParse(JSON.parse(text))
        if (!parsed.success) throw new LlmError(`AI response did not match the expected format: ${parsed.error.message.slice(0, 300)}`)
        await record(db, { provider: 'anthropic', model, purpose, chars, ok: true })
        return parsed.data
      } catch (e) {
        const msg = e instanceof Anthropic.APIError ? `Anthropic API error ${e.status}: ${e.message}` : (e as Error).message
        await record(db, { provider: 'anthropic', model, purpose, chars, ok: false, error: msg })
        log('error', 'llm_call_failed', { purpose, error: msg })
        throw e instanceof LlmError ? e : new LlmError(msg)
      }
    },
  }
}

export async function record(
  db: Queryable,
  c: { provider: string; model: string | null; purpose: string; chars: number; ok: boolean; error?: string },
) {
  try {
    await db.query('INSERT INTO external_calls(provider, model, purpose, chars_sent, ok, error) VALUES ($1,$2,$3,$4,$5,$6)', [
      c.provider,
      c.model,
      c.purpose,
      c.chars,
      c.ok,
      c.error ?? null,
    ])
  } catch {}
}
