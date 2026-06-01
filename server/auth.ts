import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db'
import type { ServerConfig } from './config'
import { hashToken } from './crypto'
import { normalizePlatformSettings } from '../src/lib/platformSettings'

export interface AuthUser {
  id: string
  email: string
  isAdmin: boolean
}

export interface AuthContext {
  user: AuthUser
}

const SESSION_COOKIE = 'gip_session'
const SESSION_DAYS = 30
const PASSWORD_HASH_PREFIX = 'scrypt'
const PASSWORD_KEY_BYTES = 64
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 8
const scryptAsync = promisify(scrypt)
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const registrationAttempts = new Map<string, { count: number; resetAt: number }>()

type RegistrationStatus = 'approved' | 'pending' | 'rejected'
const PLATFORM_SETTINGS_KEY = 'platform'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url')
  const key = await scryptAsync(password, salt, PASSWORD_KEY_BYTES) as Buffer
  return [PASSWORD_HASH_PREFIX, salt, key.toString('base64url')].join('$')
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  const [prefix, salt, expectedHash] = passwordHash.split('$')
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !expectedHash) return false

  const expected = Buffer.from(expectedHash, 'base64url')
  const actual = await scryptAsync(password, salt, expected.length) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function getLoginRateLimitKey(request: FastifyRequest, email: string) {
  const ip = request.ip || request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown'
  return `${String(ip).split(',')[0].trim()}:${email}`
}

function checkLoginRateLimit(key: string) {
  const now = Date.now()
  const current = loginAttempts.get(key)
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS })
    return { allowed: true, retryAfterSeconds: 0 }
  }
  if (current.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

function recordFailedLogin(key: string) {
  const now = Date.now()
  const current = loginAttempts.get(key)
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  current.count += 1
}

function clearLoginRateLimit(key: string) {
  loginAttempts.delete(key)
}

function checkRegistrationRateLimit(key: string) {
  const now = Date.now()
  const current = registrationAttempts.get(key)
  if (!current || current.resetAt <= now) {
    registrationAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return { allowed: true, retryAfterSeconds: 0 }
  }
  if (current.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
  }
  current.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

function normalizeRegistrationStatus(value: unknown): RegistrationStatus {
  return value === 'pending' || value === 'rejected' ? value : 'approved'
}

async function getRegistrationRequireApproval(db: Db): Promise<boolean> {
  const result = await db.query<{ value: unknown }>(
    'SELECT value FROM platform_settings WHERE key = $1',
    [PLATFORM_SETTINGS_KEY],
  )
  return normalizePlatformSettings(result.rows[0]?.value).registration.requireApproval
}

function getRegistrationRateLimitKey(request: FastifyRequest, email: string) {
  const ip = request.ip || request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown'
  return `${String(ip).split(',')[0].trim()}:${email}`
}

async function writeAuthAuditLog(db: Db, request: FastifyRequest, input: {
  targetUserId?: string | null
  action: string
  details?: Record<string, unknown>
}) {
  await db.query(
    `
      INSERT INTO audit_logs (actor_user_id, target_user_id, action, details, ip, user_agent)
      VALUES (null, $1, $2, $3, $4, $5)
    `,
    [
      input.targetUserId ?? null,
      input.action,
      input.details ?? {},
      request.ip,
      request.headers['user-agent'] ?? null,
    ],
  )
}

export async function seedAdminUsers(db: Db, config: ServerConfig) {
  for (const admin of config.adminUsers) {
    const passwordHash = await hashPassword(admin.password)
    await db.query(
      `
        INSERT INTO users (email, password_hash, is_admin, disabled_at, registration_status, registration_requested_at)
        VALUES ($1, $2, true, null, 'approved', now())
        ON CONFLICT (email)
        DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          is_admin = true,
          disabled_at = null,
          registration_status = 'approved',
          registration_reviewed_at = now(),
          updated_at = now()
      `,
      [admin.email, passwordHash],
    )
  }
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  )
  return { token, expiresAt }
}

export async function destroySession(db: Db, token: string | undefined) {
  if (!token) return
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
}

async function destroyOtherSessions(db: Db, userId: string, token: string | undefined) {
  if (!token) {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [userId])
    return
  }
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, hashToken(token)])
}

export function setSessionCookie(reply: FastifyReply, config: ServerConfig, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig) {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
  })
}

export async function authenticateRequest(db: Db, request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return null
  const result = await db.query<{
    id: string
    email: string
    is_admin: boolean
  }>(
    `
      SELECT users.id, users.email, users.is_admin
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE
        sessions.token_hash = $1
        AND sessions.expires_at > now()
        AND users.disabled_at IS NULL
        AND users.registration_status = 'approved'
      LIMIT 1
    `,
    [hashToken(token)],
  )
  const user = result.rows[0]
  return user ? { id: user.id, email: user.email, isAdmin: Boolean(user.is_admin) } : null
}

export async function requireAuth(db: Db, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await authenticateRequest(db, request)
  if (!user) {
    void reply.code(401).send({ error: '未登录' })
    return null
  }
  return user
}

function getHeaderHost(value: string | undefined) {
  return value?.split(',')[0]?.trim().toLowerCase() ?? ''
}

function isSameOrigin(request: FastifyRequest, value: string | undefined) {
  if (!value) return true
  try {
    const url = new URL(value)
    const host = getHeaderHost(request.headers.host)
    return Boolean(host) && url.host.toLowerCase() === host
  } catch {
    return false
  }
}

export function registerOriginProtection(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return
    if (request.url === '/api/health') return
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    const referer = Array.isArray(request.headers.referer) ? request.headers.referer[0] : request.headers.referer
    if (!isSameOrigin(request, origin) || !isSameOrigin(request, referer)) {
      return reply.code(403).send({ error: '请求来源不合法' })
    }
  })
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, config: ServerConfig) {
  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body as { email?: string; password?: string }
    const email = body.email?.trim().toLowerCase() ?? ''
    const password = body.password ?? ''
    if (!email || !password) return reply.code(400).send({ error: '请输入邮箱和密码' })
    if (password.length < 8) return reply.code(400).send({ error: '密码至少需要 8 位' })

    const rateLimitKey = getRegistrationRateLimitKey(request, email)
    const rateLimit = checkRegistrationRateLimit(rateLimitKey)
    if (!rateLimit.allowed) {
      reply.header('Retry-After', String(rateLimit.retryAfterSeconds))
      return reply.code(429).send({ error: '注册申请过多，请稍后再试' })
    }

    const requireApproval = await getRegistrationRequireApproval(db)
    const nextStatus: RegistrationStatus = requireApproval ? 'pending' : 'approved'
    const auditAction = requireApproval ? 'user.registration_request' : 'user.registration_auto_approve'

    const existingResult = await db.query<{ id: string; registration_status: string }>(
      'SELECT id, registration_status FROM users WHERE email = $1 LIMIT 1',
      [email],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      const status = normalizeRegistrationStatus(existing.registration_status)
      if (status === 'pending' && requireApproval) return reply.code(409).send({ error: '注册申请已提交，请等待管理员审批' })
      if (status === 'approved') return reply.code(409).send({ error: '邮箱已存在' })

      await db.query(
        `
          UPDATE users
          SET
            password_hash = $2,
            is_admin = false,
            disabled_at = CASE WHEN $3 THEN now() ELSE null END,
            registration_status = CASE WHEN $3 THEN 'pending' ELSE 'approved' END,
            registration_requested_at = now(),
            registration_reviewed_at = CASE WHEN $3 THEN null ELSE now() END,
            registration_reviewed_by = null,
            updated_at = now()
          WHERE id = $1
        `,
        [existing.id, await hashPassword(password), requireApproval],
      )
      await writeAuthAuditLog(db, request, {
        targetUserId: existing.id,
        action: auditAction,
        details: { email, reapplied: true, requireApproval },
      })
      return { ok: true, status: nextStatus }
    }

    const result = await db.query<{ id: string }>(
      `
        INSERT INTO users (
          email,
          password_hash,
          is_admin,
          disabled_at,
          registration_status,
          registration_requested_at,
          registration_reviewed_at
        )
        VALUES (
          $1,
          $2,
          false,
          CASE WHEN $3 THEN now() ELSE null END,
          CASE WHEN $3 THEN 'pending' ELSE 'approved' END,
          now(),
          CASE WHEN $3 THEN null ELSE now() END
        )
        RETURNING id
      `,
      [email, await hashPassword(password), requireApproval],
    )
    await writeAuthAuditLog(db, request, {
      targetUserId: result.rows[0]?.id,
      action: auditAction,
      details: { email, requireApproval },
    })
    return { ok: true, status: nextStatus }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string }
    const email = body.email?.trim().toLowerCase() ?? ''
    const password = body.password ?? ''
    if (!email || !password) return reply.code(400).send({ error: '请输入邮箱和密码' })
    const rateLimitKey = getLoginRateLimitKey(request, email)
    const rateLimit = checkLoginRateLimit(rateLimitKey)
    if (!rateLimit.allowed) {
      reply.header('Retry-After', String(rateLimit.retryAfterSeconds))
      return reply.code(429).send({ error: '登录尝试过多，请稍后再试' })
    }

    const result = await db.query<{ id: string; email: string; password_hash: string; is_admin: boolean; disabled_at: Date | null; registration_status: string }>(
      'SELECT id, email, password_hash, is_admin, disabled_at, registration_status FROM users WHERE email = $1 LIMIT 1',
      [email],
    )
    const user = result.rows[0]
    const registrationStatus = normalizeRegistrationStatus(user?.registration_status)
    if (registrationStatus === 'pending') return reply.code(403).send({ error: '账号正在等待管理员审批' })
    if (registrationStatus === 'rejected') return reply.code(403).send({ error: '注册申请已被拒绝，请联系管理员' })
    if (user?.disabled_at) return reply.code(403).send({ error: '账号已被禁用' })
    if (!user || !(await verifyPassword(user.password_hash, password))) {
      recordFailedLogin(rateLimitKey)
      return reply.code(401).send({ error: '邮箱或密码错误' })
    }

    clearLoginRateLimit(rateLimitKey)
    const session = await createSession(db, user.id)
    setSessionCookie(reply, config, session.token, session.expiresAt)
    return { user: { id: user.id, email: user.email, isAdmin: Boolean(user.is_admin) } }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(db, request.cookies[SESSION_COOKIE])
    clearSessionCookie(reply, config)
    return { ok: true }
  })

  app.get('/api/auth/me', async (request) => {
    const user = await authenticateRequest(db, request)
    return { user }
  })

  app.post('/api/auth/password', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const body = request.body as { currentPassword?: string; newPassword?: string }
    const currentPassword = body.currentPassword ?? ''
    const newPassword = body.newPassword ?? ''
    if (!currentPassword || !newPassword) return reply.code(400).send({ error: '请输入当前密码和新密码' })
    if (newPassword.length < 8) return reply.code(400).send({ error: '新密码至少需要 8 位' })

    const result = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id])
    const passwordHash = result.rows[0]?.password_hash
    if (!passwordHash || !(await verifyPassword(passwordHash, currentPassword))) {
      return reply.code(401).send({ error: '当前密码错误' })
    }

    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(newPassword)])
    await destroyOtherSessions(db, user.id, request.cookies[SESSION_COOKIE])
    return { ok: true }
  })
}
