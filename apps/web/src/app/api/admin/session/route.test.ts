import { afterEach, describe, expect, it, vi } from 'vitest'
import { jar, resetJar } from '@/test/next-headers'
import { upstream } from '@/test/upstream'

vi.mock('next/headers', () => import('@/test/next-headers'))

afterEach(() => {
  resetJar()
  vi.unstubAllEnvs()
})

async function logOut(apiStatus: number) {
  const api = await upstream(apiStatus, {}, apiStatus === 200 ? { revoked: true } : { error: { code: 'unavailable', message: 'the API is restarting' } })
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('API_URL', api.url)
  jar.sent.set('__Host-cw_admin', 'cw_session_token')
  try {
    const { DELETE } = await import('./route')
    return await DELETE()
  } finally {
    api.close()
  }
}

describe('logging out', () => {
  it('keeps the cookie and says why when the API could not end the session, so it can be tried again', async () => {
    const response = await logOut(503)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'unavailable', message: 'the API is restarting' } })
    expect(jar.headers.get('set-cookie')).toBeNull()
  })

  it.each([200, 401])('clears the cookie when the API answers %i, because the session is over either way', async (status) => {
    const response = await logOut(status)
    expect(await response.json()).toEqual({ admin: false })
    expect(jar.headers.get('set-cookie')).toContain('__Host-cw_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure')
  })
})
