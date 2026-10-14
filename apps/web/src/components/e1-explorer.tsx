'use client'

import { useState } from 'react'
import { LineChart, type Series } from './line-chart'

export interface E1Point {
  mode: string
  connections: number
  rate: number
  achieved: number
  p99: number
}

const MODES: { mode: string; label: string; color: string }[] = [
  { mode: 'locked', label: 'Locked row', color: 'var(--series-1)' },
  { mode: 'locked-async', label: 'Async commit', color: 'var(--series-2)' },
  { mode: 'serializable', label: 'Serializable', color: 'var(--series-3)' },
  { mode: 'derived', label: 'Derived', color: 'var(--series-4)' },
  { mode: 'sharded-16', label: 'Sharded, 16', color: 'var(--series-5)' },
]

function ms(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} s`
  return `${value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 1 : 0 })} ms`
}

export function E1Explorer({ points, connections }: { points: E1Point[]; connections: number[] }) {
  const [chosen, setChosen] = useState(connections.includes(32) ? 32 : connections[0]!)
  const series = (pick: (p: E1Point) => number): Series[] =>
    MODES.map((m) => ({
      key: m.mode,
      label: m.label,
      color: m.color,
      points: points.filter((p) => p.mode === m.mode && p.connections === chosen).map((p) => ({ x: p.rate, y: pick(p) })),
    })).filter((s) => s.points.length > 0)
  const rates = [...new Set(points.filter((p) => p.connections === chosen).map((p) => p.rate))].sort((a, b) => a - b)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Connections</span>
        {connections.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChosen(c)}
            aria-pressed={c === chosen}
            className={`rounded-lg border px-3 py-1 font-mono tabular-nums ${c === chosen ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
          <LineChart title="Journals a second, achieved" series={series((p) => p.achieved)} xLabel="journals a second offered" yLabel="achieved" format={(y) => y.toLocaleString('en', { maximumFractionDigits: 0 })} />
        </div>
        <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
          <LineChart title="p99 latency" series={series((p) => p.p99)} xLabel="journals a second offered" yLabel="p99" yLog format={ms} />
        </div>
      </div>
      <details className="rounded-xl border border-line bg-surface p-4 text-sm">
        <summary className="cursor-pointer font-medium">The numbers as a table</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Offered</th>
                {MODES.map((m) => (
                  <th key={m.mode} className="py-1 pr-3 text-right font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rates.map((rate) => (
                <tr key={rate}>
                  <td className="py-1 pr-3 font-mono tabular-nums">{rate.toLocaleString('en')}</td>
                  {MODES.map((m) => {
                    const p = points.find((q) => q.mode === m.mode && q.connections === chosen && q.rate === rate)
                    return (
                      <td key={m.mode} className="py-1 pr-3 text-right font-mono tabular-nums">
                        {p ? `${Math.round(p.achieved).toLocaleString('en')} · ${ms(p.p99)}` : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-muted">Each cell is achieved journals a second and p99, the median of three runs.</p>
        </div>
      </details>
    </div>
  )
}
