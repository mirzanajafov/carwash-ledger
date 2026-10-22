'use client'

import { useState } from 'react'

export interface Series {
  key: string
  label: string
  color: string
  points: { x: number; y: number }[]
}

interface Props {
  title: string
  series: Series[]
  xLabel: string
  yLabel: string
  yLog?: boolean
  format: (y: number) => string
}

const W = 640
const H = 280
const M = { top: 14, right: 104, bottom: 38, left: 54 }

function niceMax(max: number): number {
  const step = 10 ** Math.floor(Math.log10(max))
  return Math.ceil(max / step) * step
}

export function LineChart({ title, series, xLabel, yLabel, yLog = false, format }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b)
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((y) => y > 0)
  const [first] = xs
  const last = xs.at(-1)
  if (first === undefined || last === undefined || ys.length === 0) return null
  const [x0, x1] = [Math.log(first), Math.log(last)]
  const yMin = yLog ? 10 ** Math.floor(Math.log10(Math.min(...ys))) : 0
  const yMax = yLog ? 10 ** Math.ceil(Math.log10(Math.max(...ys))) : niceMax(Math.max(...ys))
  const snap = (v: number) => Math.round(v * 10) / 10
  const px = (x: number) => snap(M.left + ((Math.log(x) - x0) / (x1 - x0)) * (W - M.left - M.right))
  const py = (y: number) => {
    const t = yLog ? (Math.log10(Math.max(y, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin)) : y / yMax
    return snap(H - M.bottom - t * (H - M.top - M.bottom))
  }
  const yTicks = yLog
    ? Array.from({ length: Math.round(Math.log10(yMax / yMin)) + 1 }, (_, i) => yMin * 10 ** i)
    : Array.from({ length: 5 }, (_, i) => (yMax / 4) * i)
  const ends = series
    .flatMap((s) => {
      const end = s.points.at(-1)
      return end ? [{ key: s.key, label: s.label, x: px(end.x) + 7, y: py(end.y) }] : []
    })
    .sort((a, b) => a.y - b.y)
  for (const [i, end] of ends.entries()) {
    for (const other of ends.slice(0, i)) {
      const near = Math.abs(end.x - other.x) < 96 && Math.abs(end.y - other.y) < 13
      if (near) end.y = other.y + 13
    }
  }
  const at = hover === null ? null : (xs[hover] ?? null)

  function move(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * W
    let best = 0
    let nearest = Infinity
    for (const [i, value] of xs.entries()) {
      const distance = Math.abs(px(value) - x)
      if (distance < nearest) {
        best = i
        nearest = distance
      }
    }
    setHover(best)
  }

  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="-mx-1 overflow-x-auto px-1">
        <div className="relative min-w-[34rem]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full touch-none select-none"
            role="img"
            aria-label={title}
            onPointerMove={move}
            onPointerDown={move}
            onPointerLeave={() => setHover(null)}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={W - M.right} y1={py(t)} y2={py(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={M.left - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
                  {format(t)}
                </text>
              </g>
            ))}
            {xs.map((x) => (
              <text key={x} x={px(x)} y={H - M.bottom + 16} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {x.toLocaleString('en')}
              </text>
            ))}
            <text x={(M.left + W - M.right) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--muted)">
              {xLabel}
            </text>
            <text
              x={12}
              y={M.top + (H - M.top - M.bottom) / 2}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted)"
              transform={`rotate(-90 12 ${M.top + (H - M.top - M.bottom) / 2})`}
            >
              {yLabel}
            </text>
            {at !== null ? <line x1={px(at)} x2={px(at)} y1={M.top} y2={H - M.bottom} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" /> : null}
            {series.map((s) => (
              <g key={s.key}>
                <polyline
                  points={s.points.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {s.points.map((p) => (
                  <circle key={p.x} cx={px(p.x)} cy={py(p.y)} r={p.x === at ? 5 : 3.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            ))}
            {ends.map((e) => (
              <text key={e.key} x={e.x} y={e.y + 4} fontSize={11} fill="var(--ink)">
                {e.label}
              </text>
            ))}
          </svg>
          {at !== null ? (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm"
              style={px(at) > W / 2 ? { right: `${((W - px(at)) / W) * 100 + 2}%` } : { left: `${(px(at) / W) * 100 + 2}%` }}
            >
              <p className="mb-1 font-medium">
                {xLabel.replace(/^./, (c) => c.toUpperCase())}: {at.toLocaleString('en')}
              </p>
              {series.map((s) => {
                const point = s.points.find((p) => p.x === at)
                return (
                  <p key={s.key} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <span className="inline-block size-2 rounded-full" style={{ background: s.color }} aria-hidden />
                      {s.label}
                    </span>
                    <span className="font-mono tabular-nums">{point ? format(point.y) : '—'}</span>
                  </p>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    </figure>
  )
}
