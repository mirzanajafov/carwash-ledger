import { Module } from '@nestjs/common'
import { LiveFeed } from './live-feed.ts'
import { LiveController } from './live.controller.ts'

@Module({ controllers: [LiveController], providers: [LiveFeed] })
export class LiveModule {}
