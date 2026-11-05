import { guardApi } from '@/lib/auth'
import { getDb } from '@/lib/db/client'
import { search } from '@/lib/search'

export async function GET(request: Request) {
  const denied = await guardApi(request)
  if (denied) return denied
  const u = new URL(request.url).searchParams
  const role = u.get('role')
  const result = await search(await getDb(), {
    q: u.get('q') ?? '',
    from: u.get('from'),
    to: u.get('to'),
    role: role === 'user' || role === 'assistant' ? role : null,
    includeHidden: u.get('hidden') === '1',
    includeBranches: u.get('branches') === '1',
    limit: Number(u.get('limit') ?? 50),
  })
  return Response.json(result)
}
