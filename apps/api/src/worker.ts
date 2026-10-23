import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { loadCoreConfig, loadWorkerConfig } from './config.ts'
import { WorkerModule } from './worker/worker.module.ts'

const config = { core: loadCoreConfig(process.env), worker: loadWorkerConfig(process.env) }
const worker = await NestFactory.create(WorkerModule.register(config))
worker.enableShutdownHooks()
await worker.listen(config.worker.port, '0.0.0.0')
