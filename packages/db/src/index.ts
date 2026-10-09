import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.ts'

export * from './generated/prisma/client.ts'

export function createPrisma(connectionString: string, max = 10): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max }) })
}
