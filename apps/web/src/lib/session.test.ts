import { afterEach, describe, expect, it, vi } from 'vitest'
import { jar, resetJar, setCookieHeader } from '@/test/next-headers'
import { upstream } from '@/test/upstream'

vi.mock('next/headers', () => import('@/test/next-headers'))

const SESSION_ENDED = { error: { code: 'unauthorized', message: 'the session has ended' } }

afterEach(() => {
  resetJar()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function inProduction() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DASHBOARD_ADMIN_KEY', 'cw_admin_dashboard_key')
  return import('./session')
}

describe('the admin session cookie', () => {
  it('lasts as long as the session, and is cleared with the attributes it was set with, which a browser needs for a __Host- cookie', async () => {
    const { forgetSession, rememberSession } = await inProduction()
    vi.useFakeTimers({ now: Date.parse('2026-10-23T12:00:00.000Z') })
    await rememberSession('cw_session_token', '2026-10-23T13:00:00.000Z')
    expect(setCookieHeader()).toBe(
      '__Host-cw_admin=cw_session_token; Path=/; Expires=Fri, 23 Oct 2026 13:00:00 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=strict',
    )
    await forgetSession()
    expect(setCookieHeader()).toBe('__Host-cw_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=strict')
  })
})

describe('the key an admin action is sent with', () => {
  it('is the session token while the API still knows the session, even when it cannot say so right now', async () => {
    const { credential } = await inProduction()
    for (const status of [200, 503]) {
      const api = await upstream(status, {}, {})
      vi.stubEnv('API_URL', api.url)
      jar.sent.set('__Host-cw_admin', 'cw_session_token')
      try {
        expect(await credential()).toBe('cw_session_token')
        expect(setCookieHeader()).toBeNull()
      } finally {
        api.close()
      }
    }
  })

  it("is the dashboard's own key once the session has ended, and the dead cookie goes", async () => {
    const { credential } = await inProduction()
    const api = await upstream(401, {}, SESSION_ENDED)
    vi.stubEnv('API_URL', api.url)
    jar.sent.set('__Host-cw_admin', 'cw_session_token')
    try {
      expect(await credential()).toBe('cw_admin_dashboard_key')
      expect(api.seen[0]?.headers.authorization).toBe('Bearer cw_session_token')
      expect(setCookieHeader()).toContain('__Host-cw_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure')
    } finally {
      api.close()
    }
  })
})
