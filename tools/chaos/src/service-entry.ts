import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { armFailpoints, disarmFailpoints, parseFailpoints } from '@carwash/failpoints'

armFailpoints(parseFailpoints(process.env.CHAOS_FAILPOINTS ?? ''), (name) => {
  writeSync(4, `failpoint ${name}\n`)
  process.kill(process.pid, 'SIGKILL')
})

process.on('message', (message: { type?: string }) => {
  if (message.type === 'disarm') disarmFailpoints()
})
process.on('disconnect', () => process.exit(0))

const entry = process.env.CHAOS_ENTRY
if (!entry) throw new Error('CHAOS_ENTRY is required')
await import(pathToFileURL(entry).href)
process.send?.({ type: 'ready' })
