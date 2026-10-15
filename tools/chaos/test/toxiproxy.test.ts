import { describe, expect, it } from 'vitest'
import { callWithRetries } from '../src/toxiproxy.ts'

function answers(...statuses: (number | Error)[]) {
  const calls: number[] = []
  const send = async () => {
    const next = statuses[calls.length] ?? 200
    calls.push(calls.length)
    if (next instanceof Error) throw next
    return new Response(next === 200 ? '{}' : 'Timeout', { status: next })
  }
  return { send, calls }
}

const noPause = async () => undefined

describe('calling the Toxiproxy API', () => {
  it('retries a timeout or a dropped connection until it gets through', async () => {
    const { send, calls } = answers(503, new Error('fetch failed'), 200)
    await callWithRetries(send, 'toxiproxy POST /reset', 5, noPause)
    expect(calls).toHaveLength(3)
  })

  it('counts a conflict on a retry as done, since the first try may have worked', async () => {
    const { send, calls } = answers(503, 409)
    await callWithRetries(send, 'toxiproxy POST /proxies', 5, noPause)
    expect(calls).toHaveLength(2)
  })

  it('gives up on a client error at once and on a server error after the last try', async () => {
    await expect(callWithRetries(answers(400).send, 'toxiproxy POST /proxies', 5, noPause)).rejects.toThrow('toxiproxy POST /proxies: 400')
    await expect(callWithRetries(answers(409).send, 'toxiproxy POST /proxies', 5, noPause)).rejects.toThrow('409')
    await expect(callWithRetries(answers(503, 503, 503).send, 'toxiproxy POST /reset', 3, noPause)).rejects.toThrow('after 3 attempts')
  })

  it('treats a missing proxy as nothing to do', async () => {
    const { send, calls } = answers(404)
    await callWithRetries(send, 'toxiproxy DELETE /proxies/api', 5, noPause)
    expect(calls).toHaveLength(1)
  })
})
