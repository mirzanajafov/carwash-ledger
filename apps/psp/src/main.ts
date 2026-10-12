import { startPsp } from './app.ts'
import { loadConfig } from './config.ts'

const log = (message: string) => process.stderr.write(`${message}\n`)
const running = await startPsp(loadConfig(process.env), log)
log(`psp listening on ${running.url}`)

let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    running.close().then(
      () => process.exit(0),
      (error: Error) => {
        log(`psp: ${error.message}`)
        process.exit(1)
      },
    )
  })
}
