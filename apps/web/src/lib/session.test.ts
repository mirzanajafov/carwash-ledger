import { afterEach, describe, expect, it, vi } from 'vitest'
import { jar, resetJar } from '@/test/next-headers'

vi.mock('next/headers', () => import('@/test/next-headers'))

afterEach(() => {
  resetJar()
  vi.unstubAllEnvs()
})

describe('the admin session cookie', () => {
  it('lasts as long as the session, and is cleared with the attributes it was set with, which a browser needs for a __Host- cookie', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { forgetSession, rememberSession } = await import('./session')
    await rememberSession('cw_session_token', new Date(Date.now() + 3_600_000).toISOString())
    expect(jar.headers.get('set-cookie')).toMatch(
      /^__Host-cw_admin=cw_session_token; Path=\/; Expires=[^;]+; Max-Age=3(599|600); Secure; HttpOnly; SameSite=strict$/,
    )
    await forgetSession()
    expect(jar.headers.get('set-cookie')).toBe('__Host-cw_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=strict')
  })
})
