import { afterEach, describe, expect, it, vi } from 'vitest'
import { jar, resetJar, setCookieHeader } from '@/test/next-headers'
import { upstream } from '@/test/upstream'

vi.mock('next/headers', () => import('@/test/next-headers'))

const CLEARED = '__Host-cw_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure'

afterEach(() => {
  resetJar()
  vi.unstubAllEnvs()
})

async function logOut(apiUrl: string) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('API_URL', apiUrl)
  const { DELETE } = await import('./route')
  return DELETE()
}

async function logOutAgainst(status: number, body: unknown) {
  const api = await upstream(status, {}, body)
  jar.sent.set('__Host-cw_admin', 'cw_session_token')
  try {
    return { response: await logOut(api.url), seen: api.seen }
  } finally {
    api.close()
  }
}

describe('logging out', () => {
  it('ends the session with its own token and clears the cookie', async () => {
    const { response, seen } = await logOutAgainst(200, { revoked: true })
    expect(seen.map(({ method, url, headers }) => ({ method, url, authorization: headers.authorization }))).toEqual([
      { method: 'DELETE', url: '/v1/admin/sessions/current', authorization: 'Bearer cw_session_token' },
    ])
    expect(await response.json()).toEqual({ admin: false, revoked: true })
    expect(setCookieHeader()).toContain(CLEARED)
  })

  it('counts a session that had already ended as ended', async () => {
    const { response } = await logOutAgainst(401, { error: { code: 'unauthorized', message: 'the session has ended' } })
    expect(await response.json()).toEqual({ admin: false, revoked: true })
    expect(setCookieHeader()).toContain(CLEARED)
  })

  it('still clears the cookie when the API could not end the session, which then ends at its expiry with no browser holding it', async () => {
    const { response } = await logOutAgainst(503, { error: { code: 'unavailable', message: 'the API is restarting' } })
    expect(await response.json()).toEqual({ admin: false, revoked: false })
    expect(setCookieHeader()).toContain(CLEARED)
  })

  it('does the same when the API does not answer at all', async () => {
    jar.sent.set('__Host-cw_admin', 'cw_session_token')
    const response = await logOut('http://127.0.0.1:9')
    expect(await response.json()).toEqual({ admin: false, revoked: false })
    expect(setCookieHeader()).toContain(CLEARED)
  })

  it('asks the API nothing when there is no session cookie', async () => {
    const response = await logOut('http://127.0.0.1:9')
    expect(await response.json()).toEqual({ admin: false, revoked: false })
  })
})
