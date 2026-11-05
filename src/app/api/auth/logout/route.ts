import { SESSION_COOKIE, sameOrigin } from '@/lib/auth'

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  })
}
