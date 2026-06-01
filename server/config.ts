import { randomBytes } from 'node:crypto'

export interface ServerConfig {
  host: string
  port: number
  databaseUrl: string
  sessionSecret: string
  keyEncryptionSecret: string
  adminUsers: Array<{ email: string; password: string }>
  allowInsecureDefaults: boolean
  cookieSecure: boolean
  s3: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
    publicBaseUrl: string
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function parseAdminUsers(): Array<{ email: string; password: string }> {
  const rawJson = process.env.ADMIN_USERS?.trim()
  if (rawJson) {
    const users = JSON.parse(rawJson) as unknown
    if (!Array.isArray(users)) throw new Error('ADMIN_USERS 必须是数组 JSON')
    return users.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('ADMIN_USERS 元素格式错误')
      const record = item as Record<string, unknown>
      const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : ''
      const password = typeof record.password === 'string' ? record.password : ''
      if (!email || !password) throw new Error('ADMIN_USERS 必须包含 email/password')
      return { email, password }
    })
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password) throw new Error('缺少 ADMIN_USERS 或 ADMIN_EMAIL/ADMIN_PASSWORD')
  return [{ email, password }]
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8788)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT 必须是合法端口')
  return port
}

function readSecret(name: string): string {
  const value = readRequiredEnv(name)
  if (value.length < 32) throw new Error(`${name} 长度至少需要 32 个字符`)
  return value
}

function assertNoInsecureDefaults(config: Pick<ServerConfig, 'sessionSecret' | 'keyEncryptionSecret' | 'adminUsers' | 'allowInsecureDefaults'>) {
  if (config.allowInsecureDefaults) return
  const insecureValues = [
    'change-me-now',
    'change-this-session-secret-at-least-32-chars',
    'change-this-key-encryption-secret-32',
  ]
  const hasDefaultSecret =
    insecureValues.includes(config.sessionSecret) ||
    insecureValues.includes(config.keyEncryptionSecret)
  const hasDefaultAdminPassword = config.adminUsers.some((user) => insecureValues.includes(user.password))
  if (hasDefaultSecret || hasDefaultAdminPassword) {
    throw new Error('检测到默认管理员密码或默认密钥。生产环境请修改 ADMIN_PASSWORD、SESSION_SECRET、KEY_ENCRYPTION_SECRET；本地演示可设置 ALLOW_INSECURE_DEFAULTS=true。')
  }
}

export function createServerConfig(): ServerConfig {
  const config = {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: parsePort(process.env.PORT),
    databaseUrl: readRequiredEnv('DATABASE_URL'),
    sessionSecret: readSecret('SESSION_SECRET'),
    keyEncryptionSecret: readSecret('KEY_ENCRYPTION_SECRET'),
    adminUsers: parseAdminUsers(),
    allowInsecureDefaults: process.env.ALLOW_INSECURE_DEFAULTS === 'true',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    s3: {
      endpoint: readRequiredEnv('S3_ENDPOINT'),
      region: process.env.S3_REGION?.trim() || 'us-east-1',
      bucket: readRequiredEnv('S3_BUCKET'),
      accessKeyId: readRequiredEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: readRequiredEnv('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL?.trim() || '',
    },
  }
  assertNoInsecureDefaults(config)
  return config
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex')
}
