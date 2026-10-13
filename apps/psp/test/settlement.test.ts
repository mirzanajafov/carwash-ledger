import { describe, expect, it } from 'vitest'
import { Faults, NO_FAULTS, SETTLEMENT_FAULTS, type SettlementFault } from '../src/faults.ts'
import { belongsTo, planLines, pspFee, renderCsv, type SettleableOperation } from '../src/settlement.ts'

const settings = { daySeconds: 86_400, feeBps: 120, feeFixed: 8 }

function operation(id: string, kind: 'capture' | 'refund', amount: number, day: number): SettleableOperation {
  return { id, key: `key-${id}`, kind, amount, operatedAt: new Date(day * 86_400_000 + 1000), day }
}

function only(fault: SettlementFault): Faults {
  const settlement = Object.fromEntries(SETTLEMENT_FAULTS.map((f) => [f, f === fault ? 1 : 0])) as Record<SettlementFault, number>
  return new Faults({ ...NO_FAULTS, settlement })
}

describe('pspFee', () => {
  it('charges 1.2% plus 8 cents per capture, rounded half up, and nothing per refund', () => {
    expect(pspFee('capture', 1500, settings)).toBe(26)
    expect(pspFee('capture', 2400, settings)).toBe(37)
    expect(pspFee('capture', 1250, settings)).toBe(23)
    expect(pspFee('capture', 125, settings)).toBe(10)
    expect(pspFee('refund', 1500, settings)).toBe(0)
  })
})

describe('belongsTo', () => {
  it('keeps a line in its own day unless it settles a day late or its own day was already settled', () => {
    const op = operation('a', 'capture', 900, 10)
    expect(belongsTo(10, op, false, new Set())).toBe(true)
    expect(belongsTo(10, op, true, new Set())).toBe(false)
    expect(belongsTo(11, op, true, new Set())).toBe(true)
    expect(belongsTo(11, op, false, new Set())).toBe(false)
    expect(belongsTo(12, op, false, new Set([10]))).toBe(true)
    expect(belongsTo(9, op, false, new Set())).toBe(false)
  })
})

describe('planLines', () => {
  const ops = [operation('c1', 'capture', 1500, 10), operation('r1', 'refund', 500, 10)]

  it('lists captures and refunds with the contracted fee when nothing goes wrong', () => {
    expect(planLines(ops, 10, new Set(), new Faults(NO_FAULTS), settings).map((l) => [l.reference, l.kind, l.gross, l.fee, l.net, l.listed])).toEqual([
      ['key-c1', 'capture', 1500, 26, 1474, true],
      ['key-r1', 'refund', -500, 0, -500, true],
    ])
  })

  it('applies each file fault the way the design describes', () => {
    const plan = (fault: SettlementFault, day = 10) => planLines(ops, day, new Set(), only(fault), settings)
    expect(plan('wrongAmount').map((l) => l.gross)).toEqual([1499, -499])
    expect(plan('feeDifference').map((l) => l.fee - (l.kind === 'capture' ? 26 : 0))).toSatisfy((extra: number[]) => extra.every((c) => c >= 1 && c <= 5))
    expect(plan('missingLine').map((l) => l.listed)).toEqual([false, false])
    expect(plan('duplicateLine').map((l) => l.operationId)).toEqual(['c1', 'c1', 'r1', 'r1'])
    const dropped = plan('droppedReference')
    expect(dropped.every((l) => l.reference === '' && l.shownOperation.startsWith('stl_') && l.shownOperation !== l.operationId)).toBe(true)
    expect(plan('nextDay')).toEqual([])
    expect(plan('nextDay', 11).map((l) => [l.operationId, l.faults])).toEqual([
      ['c1', []],
      ['r1', []],
    ])
  })

  it('renders a header record and one record per listed line', () => {
    const lines = planLines(ops, 10, new Set(), new Faults(NO_FAULTS), settings)
    const csv = renderCsv({ id: 'stl_EUR_10', day: 10, currency: 'EUR', lines: 2, gross: 1000, fee: 26, net: 974 }, lines)
    expect(csv.trim().split('\n')).toEqual([
      'file,day,currency,lines,gross,fee,net',
      'stl_EUR_10,10,EUR,2,1000,26,974',
      'line,operation,reference,kind,gross,fee,net,operated_at',
      `1,c1,key-c1,capture,1500,26,1474,${lines[0]!.operatedAt.toISOString()}`,
      `2,r1,key-r1,refund,-500,0,-500,${lines[1]!.operatedAt.toISOString()}`,
    ])
  })
})
