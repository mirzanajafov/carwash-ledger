import type pg from 'pg'

const TAKE = `
  INSERT INTO demo_limits (name, last_at) VALUES ($1, now())
  ON CONFLICT (name) DO UPDATE SET last_at = now()
  WHERE demo_limits.last_at <= now() - make_interval(secs => $2::double precision / 1000)
  RETURNING last_at`

const WAIT = `
  SELECT greatest(0, extract(epoch FROM last_at + make_interval(secs => $2::double precision / 1000) - now()) * 1000)::float8 AS ms
  FROM demo_limits WHERE name = $1`

export async function takeTurn(pool: pg.Pool, name: string, everyMs: number): Promise<number | null> {
  if (everyMs <= 0) return null
  const taken = await pool.query(TAKE, [name, everyMs])
  if (taken.rowCount === 1) return null
  const { rows } = await pool.query<{ ms: number }>(WAIT, [name, everyMs])
  return Math.max(1, Math.ceil(rows[0]?.ms ?? everyMs))
}
