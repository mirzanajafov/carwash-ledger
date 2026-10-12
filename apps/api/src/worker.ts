import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { loadConfig } from './config.ts'
import { WorkerModule } from './worker/worker.module.ts'

const config = loadConfig(process.env)
const worker = await NestFactory.create(WorkerModule.register(config))
worker.enableShutdownHooks()
await worker.listen(config.workerPort, '0.0.0.0')
