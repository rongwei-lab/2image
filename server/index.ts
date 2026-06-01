import fastify from 'fastify'
import cookie from '@fastify/cookie'
import { createServerConfig } from './config'
import { registerAuthRoutes, registerOriginProtection, seedAdminUsers } from './auth'
import { createDb, markInterruptedRunningTasks, migrateDb } from './db'
import { assertBucketReachable, createS3Client } from './storage'
import { registerCloudRoutes } from './routes'

async function main() {
  const config = createServerConfig()
  const db = createDb(config)
  const s3 = createS3Client(config)

  await migrateDb(db)
  await seedAdminUsers(db, config)
  const interruptedTasks = await markInterruptedRunningTasks(db)
  if (interruptedTasks > 0) {
    console.warn(`服务启动后已标记 ${interruptedTasks} 个中断的运行中任务`)
  }
  await assertBucketReachable(s3, config)

  const app = fastify({
    logger: true,
    bodyLimit: 600 * 1024 * 1024,
  })

  await app.register(cookie, {
    secret: config.sessionSecret,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store')
    }
  })

  app.get('/api/health', async () => ({ ok: true }))
  registerOriginProtection(app)
  registerAuthRoutes(app, db, config)
  registerCloudRoutes(app, db, s3, config)

  await app.listen({ host: config.host, port: config.port })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
