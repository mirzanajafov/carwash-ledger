import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'

interface Seen {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

export async function upstream(status: number, headers: Record<string, string>, body: unknown) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    void text(request).then((raw) => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: raw })
      response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen, close: () => server.close() }
}
