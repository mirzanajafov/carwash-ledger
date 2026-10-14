'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Live' },
  { href: '/plug', label: 'Pull the plug' },
  { href: '/reconciliation', label: 'Reconciliation' },
  { href: '/audit', label: 'Audit' },
]

export function Nav() {
  const path = usePathname()
  return (
    <nav className="-mx-1 flex items-center gap-4 overflow-x-auto px-1 text-sm whitespace-nowrap">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} className={path === link.href ? 'font-medium text-ink' : 'text-muted hover:text-ink'} aria-current={path === link.href ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
      <span className="hidden rounded-full border border-line px-2 py-0.5 text-xs text-muted lg:inline">sandbox money</span>
    </nav>
  )
}
