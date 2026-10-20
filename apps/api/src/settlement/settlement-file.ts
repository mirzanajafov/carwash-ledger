import type { FileLine, Kind } from '@carwash/recon'

export interface ParsedFile {
  id: string
  day: number
  currency: string
  lines: FileLine[]
  gross: bigint
  fee: bigint
  net: bigint
  operatedAt: Date[]
}

const HEAD = 'file,day,currency,lines,gross,fee,net'
const COLUMNS = 'line,operation,reference,kind,gross,fee,net,operated_at'

function integer(value: string | undefined, what: string): bigint {
  if (value === undefined || !/^-?\d{1,18}$/.test(value)) throw new Error(`settlement file: ${what} is not an integer`)
  return BigInt(value)
}

export function parseSettlementFile(csv: string): ParsedFile {
  const rows = csv.replace(/\r\n/g, '\n').trimEnd().split('\n')
  if (rows[0] !== HEAD || rows[2] !== COLUMNS) throw new Error('settlement file: unexpected header')
  const [id, day, currency, count, gross, fee, net] = rows[1]!.split(',')
  if (!id || !/^[A-Z]{3}$/.test(currency ?? '')) throw new Error('settlement file: bad header record')
  const dayNumber = Number(integer(day, 'day'))
  const lines: FileLine[] = []
  const operatedAt: Date[] = []
  for (const row of rows.slice(3)) {
    const cells = row.split(',')
    if (cells.length !== 8) throw new Error(`settlement file: line "${row}" has ${cells.length} fields`)
    const [line, operation, reference, kind, lineGross, lineFee, lineNet, at] = cells as [string, string, string, string, string, string, string, string]
    if (kind !== 'capture' && kind !== 'refund') throw new Error(`settlement file: unknown kind ${kind}`)
    const time = new Date(at)
    if (Number.isNaN(time.getTime())) throw new Error(`settlement file: bad time ${at}`)
    const parsed: FileLine = {
      fileId: id,
      day: dayNumber,
      line: Number(integer(line, 'line')),
      operation,
      reference,
      kind: kind as Kind,
      gross: integer(lineGross, 'gross'),
      fee: integer(lineFee, 'fee'),
      net: integer(lineNet, 'net'),
    }
    if (parsed.net !== parsed.gross - parsed.fee) throw new Error(`settlement file: line ${line} does not add up`)
    lines.push(parsed)
    operatedAt.push(time)
  }
  const file = {
    id,
    day: dayNumber,
    currency: currency!,
    lines,
    gross: integer(gross, 'gross'),
    fee: integer(fee, 'fee'),
    net: integer(net, 'net'),
    operatedAt,
  }
  if (Number(integer(count, 'lines')) !== lines.length) throw new Error('settlement file: line count does not match')
  const sum = (pick: (l: FileLine) => bigint) => lines.reduce((total, l) => total + pick(l), 0n)
  if (sum((l) => l.gross) !== file.gross || sum((l) => l.fee) !== file.fee || sum((l) => l.net) !== file.net) {
    throw new Error('settlement file: totals do not match its lines')
  }
  return file
}
