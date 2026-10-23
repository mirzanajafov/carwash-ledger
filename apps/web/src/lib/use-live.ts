'use client'

import { liveEvent } from '@carwash/contracts'
import { useEffect, useReducer, useState } from 'react'
import { EMPTY, reduce } from './live'

export type Connection = 'connecting' | 'live' | 'reconnecting'

export function useLive() {
  const [state, dispatch] = useReducer(reduce, EMPTY)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const source = new EventSource('/api/live')
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    for (const type of ['balances', 'journal', 'payment']) {
      source.addEventListener(type, (event: MessageEvent<string>) => {
        const live = liveEvent(type, JSON.parse(event.data))
        if (live) dispatch({ ...live, at: Date.now() })
      })
    }
    return () => source.close()
  }, [])

  return { state, connection }
}
