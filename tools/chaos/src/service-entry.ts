import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { optional, required } from '@carwash/env'
import { armFailpoints, disarmFailpoints, parseFailpoints } from '@carwash/failpoints'

armFailpoints(parseFailpoints(optional(process.env, 'CHAOS_FAILPOINTS') ?? ''), (name) => {
  writeSync(4, `failpoint ${name}\n`)
  process.kill(process.pid, 'SIGKILL')
})

process.on('message', (message: { type?: string }) => {
  if (message.type === 'disarm') disarmFailpoints()
})
process.on('disconnect', () => process.exit(0))

await import(pathToFileURL(required(process.env, 'CHAOS_ENTRY')).href)
process.send?.({ type: 'ready' })
