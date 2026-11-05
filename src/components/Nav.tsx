'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'

const items = [
  { href: '/', label: 'Dashboard', icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { href: '/ask', label: 'Ask memory', icon: 'M8 10h8M8 14h5M21 12a9 9 0 11-4-7.5L21 3v5h-5' },
  { href: '/search', label: 'Search', icon: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3' },
  { href: '/projects', label: 'Projects & topics', icon: 'M3 7h7l2 2h9v10H3z' },
  { href: '/knowledge', label: 'Decisions & tasks', icon: 'M9 11l3 3 8-8M20 12v7H4V5h11' },
  { href: '/conversations', label: 'Conversations', icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z' },
  { href: '/documents', label: 'Documents', icon: 'M7 3h7l5 5v13H7zM14 3v5h5' },
  { href: '/import', label: 'Import & sync', icon: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2' },
  { href: '/status', label: 'Status', icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' },
]

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const active = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(href + '/') || (href === '/import' && pathname.startsWith('/imports'))

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.replace('/login')
    router.refresh()
  }

  const links = (
    <nav className="flex flex-col gap-0.5">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          onClick={() => setOpen(false)}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
            active(it.href) ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-panel-2 hover:text-ink'
          }`}
        >
          <Icon d={it.icon} />
          {it.label}
        </Link>
      ))}
    </nav>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-panel px-3 py-4 md:flex">
        <Brand />
        <div className="mt-6 flex-1">{links}</div>
        <button onClick={logout} className="rounded-lg px-3 py-2 text-left text-sm text-ink-3 hover:bg-panel-2 hover:text-ink">
          Sign out
        </button>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-panel px-4 py-3 md:hidden">
        <Brand />
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menu" className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink-2">
          Menu
        </button>
      </header>
      {open && (
        <div className="sticky top-[53px] z-10 border-b border-line bg-panel px-3 py-2 md:hidden">
          {links}
          <button onClick={logout} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-ink-3 hover:bg-panel-2">
            Sign out
          </button>
        </div>
      )}
    </>
  )
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-2">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-xs font-bold text-accent-ink">CM</span>
      <span className="text-sm font-semibold text-ink">Conversation Memory</span>
    </Link>
  )
}
