import { execFileSync } from 'node:child_process'
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkpointBody, ORIGIN } from '@carwash/audit'
import { Witness } from '@carwash/witness'
import { appendJsonLine, createResultsDir, median, writeJson } from './env.ts'

const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '51000,510000' },
    repeats: { type: 'string', default: '3' },
    out: { type: 'string', default: 'results/e9' },
  },
})

const START = fileURLToPath(new URL('e9-start.ts', import.meta.url))

function seed(dir: string, count: number): void {
  new Witness(dir, ORIGIN)
  const key = createPrivateKey(readFileSync(join(dir, 'witness.key')))
  const fd = openSync(join(dir, 'checkpoints.jsonl'), 'w')
  try {
    let size = 0
    let lines: string[] = []
    for (let i = 0; i < count; i++) {
      size += 1 + (i % 4)
      const root = randomBytes(32).toString('hex')
      const signature = sign(null, Buffer.from(checkpointBody({ size, root }, ORIGIN)), key).toString('base64')
      lines.push(JSON.stringify({ size, root, signature, signed_at: new Date().toISOString() }))
      if (lines.length === 10_000 || i === count - 1) {
        writeSync(fd, `${lines.join('\n')}\n`)
        lines = []
      }
    }
  } finally {
    closeSync(fd)
  }
}

interface Start {
  ms: number
  rssMb: number
  heapMb: number
  latest: number
}

function start(dir: string): Start {
  return JSON.parse(execFileSync(process.execPath, ['--conditions=source', '--expose-gc', START, dir], { encoding: 'utf8' })) as Start
}

const dir = createResultsDir(values.out)
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
writeJson(join(dir, 'run.json'), { experiment: 'e9', options: values, commit, node: process.version, cpu: cpus()[0]?.model })
for (const count of values.sizes.split(',').map(Number)) {
  const logDir = mkdtempSync(join(tmpdir(), 'e9-'))
  try {
    seed(logDir, count)
    const runs: Start[] = []
    for (let r = 0; r < Number(values.repeats); r++) runs.push(start(logDir))
    const step = {
      checkpoints: count,
      fileMb: Math.round(statSync(join(logDir, 'checkpoints.jsonl')).size / 1048576),
      runs,
      msMedian: median(runs.map((run) => run.ms)),
      rssMbMedian: median(runs.map((run) => run.rssMb)),
    }
    appendJsonLine(join(dir, 'e9.jsonl'), step)
    console.log(JSON.stringify(step))
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
}
console.log(`results in ${dir}`)
