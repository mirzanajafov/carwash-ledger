import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule, configureApp } from './app.module.ts'
import { loadConfig } from './config.ts'

const config = loadConfig(process.env)
const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, rawBody: true })
configureApp(app, config)
await app.listen(config.port, '0.0.0.0')
