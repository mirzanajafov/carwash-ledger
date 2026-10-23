'use client'

import { LiveBalance, LiveJournal, LivePayment } from '@carwash/contracts'
import { useEffect, useReducer, useState } from 'react'
import * as z from 'zod/mini'
import { EMPTY, reduce } from './live'

export type Connection = 'connecting' | 'live' | 'reconnecting'

export function useLive() {
  const [state, dispatch] = useReducer(reduce, EMPTY)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const source = new EventSource('/api/live')
    const read = (event: MessageEvent<string>): unknown => JSON.parse(event.data)
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('balances', (event: MessageEvent<string>) => {
      dispatch({ type: 'balances', data: z.array(LiveBalance).parse(read(event)), at: Date.now() })
    })
    source.addEventListener('journal', (event: MessageEvent<string>) => {
      dispatch({ type: 'journal', data: LiveJournal.parse(read(event)), at: Date.now() })
    })
    source.addEventListener('payment', (event: MessageEvent<string>) => {
      dispatch({ type: 'payment', data: LivePayment.parse(read(event)), at: Date.now() })
    })
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
