'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Live' },
  { href: '/plug', label: 'Pull the plug' },
]

export function Nav() {
  const path = usePathname()
  return (
    <nav className="flex items-center gap-4 text-sm">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} className={path === link.href ? 'font-medium text-ink' : 'text-muted hover:text-ink'} aria-current={path === link.href ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
      <span className="hidden rounded-full border border-line px-2 py-0.5 text-xs text-muted sm:inline">sandbox money</span>
    </nav>
  )
}
