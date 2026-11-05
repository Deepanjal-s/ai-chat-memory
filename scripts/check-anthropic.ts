/** Checks that ANTHROPIC_API_KEY in .env.local works:  npx tsx scripts/check-anthropic.ts */
import './load-env'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const model = process.env.AI_MODEL && process.env.AI_MODEL.startsWith('claude') ? process.env.AI_MODEL : 'claude-opus-5-5'
try {
  const r = await client.messages.countTokens({ model, messages: [{ role: 'user', content: 'ping' }] })
  console.log(`OK: key accepted for ${model} (${r.input_tokens} tokens counted)`)
} catch (e) {
  if (e instanceof Anthropic.AuthenticationError) console.log('REJECTED: authentication failed (401) -', e.message)
  else if (e instanceof Anthropic.PermissionDeniedError) console.log('REJECTED: permission denied (403) -', e.message)
  else if (e instanceof Anthropic.APIError) console.log(`API error ${e.status}:`, e.message)
  else console.log('Error:', (e as Error).message)
}
