import { afterEach, describe, expect, it, vi } from 'vitest'

const jar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }))

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the admin session cookie', () => {
  it('is cleared with the attributes it was set with, because a browser ignores clearing a __Host- cookie without Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { forgetSession, rememberSession } = await import('./session')
    await rememberSession('cw_session_token', '2026-10-24T00:00:00.000Z')
    await forgetSession()
    const attributes = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' }
    expect(jar.set).toHaveBeenCalledWith('__Host-cw_admin', 'cw_session_token', { ...attributes, expires: new Date('2026-10-24T00:00:00.000Z') })
    expect(jar.delete).toHaveBeenCalledWith({ name: '__Host-cw_admin', ...attributes })
  })
})
