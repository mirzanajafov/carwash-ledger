import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Car Wash Ledger',
  description: 'A payments ledger for a chain of car washes, where every cent moves exactly once and the books always balance.',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0a1317' },
  ],
}

function Drop() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-accent" aria-hidden>
      <path d="M12 3c3.5 4.3 6 7.6 6 10.5A6 6 0 0 1 6 13.5C6 10.6 8.5 7.3 12 3z" fill="currentColor" />
    </svg>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans">
        <header className="border-b border-line bg-surface/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <Drop />
              Car Wash Ledger
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/" className="text-ink">
                Live
              </Link>
              <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">sandbox money</span>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
          The bank and the payment provider are simulated. The ledger, its invariants and its audit log are not.
        </footer>
      </body>
    </html>
  )
}
