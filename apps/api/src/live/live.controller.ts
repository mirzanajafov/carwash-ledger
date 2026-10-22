import { Controller, Get, Inject, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { Public } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { ApiError } from '../http/api-error.ts'
import { LiveFeed } from './live-feed.ts'

@Public()
@Controller('v1')
export class LiveController {
  readonly #feed: LiveFeed
  readonly #config: ApiConfig

  constructor(feed: LiveFeed, @Inject(API_CONFIG) config: ApiConfig) {
    this.#feed = feed
    this.#config = config
  }

  @Get('live')
  live(@Req() request: Request, @Res() response: Response): void {
    if (this.#feed.listeners >= this.#config.liveMaxConnections) {
      throw new ApiError(503, 'too_many_watchers', 'the live feed is full, so try again in a minute', 60)
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': live\n\n')
    const unsubscribe = this.#feed.subscribe((event) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    })
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }
}
