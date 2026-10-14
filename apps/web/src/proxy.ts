import { NextResponse, type NextRequest } from 'next/server'
import { Buckets, clientIp, RULES, ruleFor } from '@/lib/limits'

const buckets = new Buckets()

export function proxy(request: NextRequest) {
  const rule = ruleFor(request.method, request.nextUrl.pathname)
  if (!rule) return NextResponse.next()
  const ip = clientIp(request.headers.get('x-forwarded-for'))
  const wait = buckets.take(`${rule}:${ip}`, RULES[rule], Date.now())
  if (wait === 0) return NextResponse.next()
  return NextResponse.json(
    { error: { code: 'rate_limited', message: `slow down; try again in ${wait} s` } },
    { status: 429, headers: { 'retry-after': String(wait) } },
  )
}

export const config = {
  matcher: ['/api/:path*'],
}
