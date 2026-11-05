import { MARK_END, MARK_START } from '@/lib/search'

/** Renders a search snippet whose matches are delimited by control characters, without ever using raw HTML. */
export function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let rest = text.replace(/\s+/g, ' ')
  let key = 0
  while (rest) {
    const s = rest.indexOf(MARK_START)
    if (s === -1) {
      parts.push(rest)
      break
    }
    const e = rest.indexOf(MARK_END, s)
    parts.push(rest.slice(0, s))
    parts.push(<mark key={key++}>{rest.slice(s + 1, e === -1 ? undefined : e)}</mark>)
    rest = e === -1 ? '' : rest.slice(e + 1)
  }
  return <>{parts}</>
}
