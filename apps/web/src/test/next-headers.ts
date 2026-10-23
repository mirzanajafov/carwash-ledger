import { NextResponse } from 'next/server'

export const jar = { sent: new Map<string, string>(), response: new NextResponse() }

export function resetJar(): void {
  jar.sent.clear()
  jar.response = new NextResponse()
}

export function setCookieHeader(): string | null {
  return jar.response.headers.get('set-cookie')
}

export function cookies() {
  return Promise.resolve({
    get: (name: string) => {
      const value = jar.sent.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: jar.response.cookies.set.bind(jar.response.cookies),
    delete: jar.response.cookies.delete.bind(jar.response.cookies),
  })
}
