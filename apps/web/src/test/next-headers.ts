import { ResponseCookies } from 'next/dist/server/web/spec-extension/cookies'

export const jar = { sent: new Map<string, string>(), headers: new Headers() }

export function resetJar(): void {
  jar.sent.clear()
  jar.headers = new Headers()
}

export function cookies() {
  const response = new ResponseCookies(jar.headers)
  return Promise.resolve({
    get: (name: string) => {
      const value = jar.sent.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: response.set.bind(response),
    delete: response.delete.bind(response),
  })
}
