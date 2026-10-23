import { NextResponse, type NextRequest } from 'next/server'
import { Buckets, clientIp, RULES, ruleFor, sameOrigin } from '@/lib/limits'
import { refuse } from '@/lib/server'

const buckets = new Buckets()

export function proxy(request: NextRequest) {
  if (!sameOrigin(request.method, request.headers.get('origin'), request.headers.get('host'))) {
    return refuse(403, 'forbidden', 'requests that change something must come from this site')
  }
  const rule = ruleFor(request.method, request.nextUrl.pathname)
  if (!rule) return NextResponse.next()
  const ip = clientIp(request.headers.get('x-forwarded-for'))
  const wait = buckets.take(`${rule}:${ip}`, RULES[rule], Date.now())
  if (wait === 0) return NextResponse.next()
  return refuse(429, 'rate_limited', `slow down and try again in ${wait} s`, { 'retry-after': String(wait) })
}

export const config = {
  matcher: ['/api/:path*'],
}
