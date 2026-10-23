import { mulberry32, type Random } from '@carwash/lab'
import { contractFee, type FeeContract, type FileLine, type Kind, type LedgerItem } from '@carwash/recon'

export const PRICES = [900n, 1500n, 2400n, 3500n, 4900n] as const

export const FAULTS = ['nextDay', 'feeDifference', 'wrongAmount', 'missingLine', 'duplicateLine', 'droppedReference'] as const

export type Fault = (typeof FAULTS)[number]

export interface GeneratorOptions {
  seed: number
  days: number
  perDay: number
  partialShare: number
  refundShare: number
  rates: Record<Fault, number>
  contract: FeeContract
  skewMs: number
}

export interface LabelledItem extends LedgerItem {
  fault: Fault | null
}

export interface World {
  items: LabelledItem[]
  files: Map<number, FileLine[]>
  owner: Map<FileLine, LabelledItem>
}

export const DAY_MS = 86_400_000

function pickFault(random: Random, rates: Record<Fault, number>): Fault | null {
  let draw = random()
  for (const fault of FAULTS) {
    if (draw < rates[fault]) return fault
    draw -= rates[fault]
  }
  return null
}

export function generate(options: GeneratorOptions): World {
  const random = mulberry32(options.seed)
  const items: LabelledItem[] = []
  const files = new Map<number, FileLine[]>()
  const owner = new Map<FileLine, LabelledItem>()
  const place = (day: number, line: Omit<FileLine, 'fileId' | 'day' | 'line'>, item: LabelledItem) => {
    const list = files.get(day) ?? []
    const placed = { ...line, fileId: `stl_EUR_${day}`, day, line: list.length + 1 }
    list.push(placed)
    files.set(day, list)
    owner.set(placed, item)
  }
  const settle = (item: LabelledItem, operatedAt: number) => {
    const day = Math.floor(operatedAt / DAY_MS)
    const fault = item.fault
    if (fault === 'missingLine') return
    const shrink = fault === 'wrongAmount' ? (item.gross > 0n ? -1n : 1n) : 0n
    const gross = item.gross + shrink
    const fee = contractFee(item.kind, item.gross, options.contract) + (fault === 'feeDifference' ? BigInt(1 + Math.floor(random() * 5)) : 0n)
    const dropped = fault === 'droppedReference'
    const line = {
      operation: dropped ? `stl_${item.attemptId}` : `op_${item.attemptId}`,
      reference: dropped ? '' : item.attemptId,
      kind: item.kind,
      gross,
      fee,
      net: gross - fee,
    }
    place(fault === 'nextDay' ? day + 1 : day, line, item)
    if (fault === 'duplicateLine') place(day, line, item)
  }
  const add = (kind: Kind, gross: bigint, resolvedAt: number, id: string) => {
    const item: LabelledItem = {
      journalRef: `${kind}:${id}`,
      attemptId: id,
      kind,
      gross,
      day: Math.floor(resolvedAt / DAY_MS),
      resolvedAt,
      fault: pickFault(random, options.rates),
    }
    items.push(item)
    settle(item, resolvedAt - Math.floor(random() * options.skewMs))
  }
  for (let day = 0; day < options.days; day++) {
    for (let n = 0; n < options.perDay; n++) {
      const at = day * DAY_MS + Math.floor(random() * DAY_MS)
      const price = PRICES[Math.floor(random() * PRICES.length)]
      if (price === undefined) throw new Error('there is no price to pick')
      const captured = random() < options.partialShare ? price / 2n + BigInt(Math.floor(random() * Number(price / 2n))) : price
      add('capture', captured, at, `cap-${day}-${n}`)
      if (random() < options.refundShare) {
        const refundAt = at + Math.floor(random() * 6 * 3_600_000)
        add('refund', -(captured < 2n ? captured : captured / 2n), refundAt, `ref-${day}-${n}`)
      }
    }
  }
  return { items, files, owner }
}
