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
  if (xs.length === 0 || ys.length === 0) return null
  const [x0, x1] = [Math.log(xs[0]!), Math.log(xs.at(-1)!)]
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
    .filter((s) => s.points.length > 0)
    .map((s) => ({ key: s.key, label: s.label, x: px(s.points.at(-1)!.x) + 7, y: py(s.points.at(-1)!.y) }))
    .sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) {
    for (let j = 0; j < i; j++) {
      const near = Math.abs(ends[i]!.x - ends[j]!.x) < 96 && Math.abs(ends[i]!.y - ends[j]!.y) < 13
      if (near) ends[i]!.y = ends[j]!.y + 13
    }
  }
  const at = hover === null ? null : xs[hover]!

  function move(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * W
    let best = 0
    for (let i = 1; i < xs.length; i++) if (Math.abs(px(xs[i]!) - x) < Math.abs(px(xs[best]!) - x)) best = i
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
