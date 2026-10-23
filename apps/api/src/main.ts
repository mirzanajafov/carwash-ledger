import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule, configureApp } from './app.module.ts'
import { loadApiConfig, loadCoreConfig } from './config.ts'

const config = { core: loadCoreConfig(process.env), api: loadApiConfig(process.env) }
const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: false, rawBody: true })
configureApp(app, config.api)
await app.listen(config.api.port, '0.0.0.0')
