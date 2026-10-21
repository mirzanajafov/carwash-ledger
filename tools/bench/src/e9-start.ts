import { ORIGIN } from '@carwash/audit'
import { Witness } from '@carwash/witness'

const dir = process.argv[2]
if (!dir) throw new Error('usage: e9-start <witness dir>')
const started = performance.now()
const witness = new Witness(dir, ORIGIN)
const ms = performance.now() - started
global.gc?.()
const { rss, heapUsed } = process.memoryUsage()
process.stdout.write(
  `${JSON.stringify({ ms: Math.round(ms), rssMb: Math.round(rss / 1048576), heapMb: Math.round(heapUsed / 1048576), latest: witness.latest()?.size })}\n`,
)
