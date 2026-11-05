import { audit } from '@/lib/audit'
import { clientIp, guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { errorMessage, log } from '@/lib/logger'
import { answerQuestion, saveAnswer } from '@/lib/qa'
import { allow } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  if (!allow('ask', 30, 60_000)) return Response.json({ error: 'Too many questions in a minute; please wait.' }, { status: 429 })
  const body = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (question.length < 3) return Response.json({ error: 'Please type a question.' }, { status: 400 })
  if (question.length > 2000) return Response.json({ error: 'Question is too long (2,000 characters max).' }, { status: 400 })
  const db = await getDb()
  try {
    const answer = await answerQuestion(db, question)
    const id = await saveAnswer(db, answer)
    await audit('ask', `qa:${id}`, await clientIp(), { mode: answer.mode, sources: answer.sources.length })
    return Response.json({ id, ...answer })
  } catch (e) {
    log('error', 'ask_failed', { error: errorMessage(e) })
    return Response.json({ error: `Could not answer: ${errorMessage(e)}` }, { status: 502 })
  }
}
