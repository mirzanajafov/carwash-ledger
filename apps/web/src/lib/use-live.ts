'use client'

import { useEffect, useReducer, useState } from 'react'
import { EMPTY, reduce, type LiveAction } from './live'

export type Connection = 'connecting' | 'live' | 'reconnecting'

export function useLive() {
  const [state, dispatch] = useReducer(reduce, EMPTY)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const source = new EventSource('/api/live')
    const on = (type: LiveAction['type']) => (event: MessageEvent<string>) => {
      dispatch({ type, data: JSON.parse(event.data), at: Date.now() } as LiveAction)
    }
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('balances', on('balances'))
    source.addEventListener('journal', on('journal'))
    source.addEventListener('payment', on('payment'))
    return () => source.close()
  }, [])

  return { state, connection }
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
