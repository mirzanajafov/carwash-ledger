import type { Step } from './plug'
import { reportStep } from './visit'

export async function followPlug(body: ReadableStream<Uint8Array<ArrayBuffer>>, show: (step: Step) => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const step = JSON.parse(line) as Step
      show(step)
      if (step.kind === 'back') reportStep('pulled-plug')
    }
  }
}
