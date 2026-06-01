import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from './db'
import type { ServerConfig } from './config'
import { hashToken } from './crypto'
import { hashPassword, registerAuthRoutes, registerOriginProtection } from './auth'

type TestAuthUser = {
  id: string
  email: string
  password_hash: string
  is_admin: boolean
  disabled_at: string | null
  registration_status: string
}

function createConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test',
    sessionSecret: 'test-session-secret-at-least-32-chars',
    keyEncryptionSecret: 'test-key-encryption-secret-at-least-32',
    allowInsecureDefaults: true,
    cookieSecure: false,
    adminUsers: [],
    s3: {
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'test-bucket',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
      publicBaseUrl: '',
    },
  }
}

async function createAuthApp(email = `user-${Date.now()}@example.com`, options: { registrationRequireApproval?: boolean } = {}) {
  const user: TestAuthUser = {
    id: '00000000-0000-0000-0000-0000000000aa',
    email,
    password_hash: await hashPassword('password123'),
    is_admin: false,
    disabled_at: null,
    registration_status: 'approved',
  }
  const users = new Map<string, TestAuthUser>([[user.email, user]])
  const sessions = new Map<string, string>()
  const registrationRequireApproval = options.registrationRequireApproval ?? true
  const query = vi.fn(async (sqlText: string, params: unknown[] = []) => {
    const sql = sqlText.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT value FROM platform_settings')) {
      return {
        rows: params[0] === 'platform'
          ? [{ value: { registration: { requireApproval: registrationRequireApproval } } }]
          : [],
      }
    }
    if (sql.startsWith('SELECT id, registration_status FROM users WHERE email = $1')) {
      const found = users.get(params[0] as string)
      return { rows: found ? [{ id: found.id, registration_status: found.registration_status }] : [] }
    }
    if (sql.startsWith('SELECT id, email, password_hash, is_admin, disabled_at, registration_status FROM users WHERE email = $1')) {
      const found = users.get(params[0] as string)
      return { rows: found ? [found] : [] }
    }
    if (sql.startsWith('INSERT INTO users')) {
      if (users.has(params[0] as string)) throw Object.assign(new Error('duplicate email'), { code: '23505' })
      const nextUser: TestAuthUser = {
        id: '00000000-0000-0000-0000-0000000000bb',
        email: params[0] as string,
        password_hash: params[1] as string,
        is_admin: false,
        disabled_at: params[2] ? '2026-01-01T00:00:00.000Z' : null,
        registration_status: params[2] ? 'pending' : 'approved',
      }
      users.set(nextUser.email, nextUser)
      return { rows: [{ id: nextUser.id }] }
    }
    if (sql.startsWith('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1')) {
      user.password_hash = params[1] as string
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE users')) {
      const found = [...users.values()].find((item) => item.id === params[0])
      if (found) {
        found.password_hash = params[1] as string
        found.is_admin = false
        found.disabled_at = params[2] ? '2026-01-01T00:00:00.000Z' : null
        found.registration_status = params[2] ? 'pending' : 'approved'
      }
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      sessions.set(params[1] as string, params[0] as string)
      return { rows: [] }
    }
    if (sql.includes('FROM sessions') && sql.includes('JOIN users')) {
      const userId = sessions.get(params[0] as string)
      const found = [...users.values()].find((item) => item.id === userId)
      return { rows: found && !found.disabled_at && found.registration_status === 'approved' ? [{ id: found.id, email: found.email, is_admin: found.is_admin }] : [] }
    }
    if (sql.startsWith('DELETE FROM sessions WHERE token_hash = $1')) {
      sessions.delete(params[0] as string)
      return { rows: [] }
    }
    if (sql.startsWith('SELECT password_hash FROM users WHERE id = $1')) {
      return { rows: params[0] === user.id ? [{ password_hash: user.password_hash }] : [] }
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2')) {
      for (const [tokenHash, userId] of [...sessions.entries()]) {
        if (userId === params[0] && tokenHash !== params[1]) sessions.delete(tokenHash)
      }
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    throw new Error(`未处理的测试 SQL：${sql}`)
  })
  const app = Fastify()
  await app.register(cookie)
  registerOriginProtection(app)
  registerAuthRoutes(app, { query } as unknown as Db, createConfig())
  await app.ready()
  return { app, user, users, sessions }
}

describe('认证安全', () => {
  it('登录失败过多会触发限流', async () => {
    const { app, user } = await createAuthApp(`limit-${Date.now()}@example.com`)
    for (let index = 0; index < 8; index++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: 'wrong-password' },
      })
      expect(response.statusCode).toBe(401)
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'wrong-password' },
    })
    await app.close()

    expect(blocked.statusCode).toBe(429)
  }, 15000)

  it('会拒绝跨来源写请求', async () => {
    const { app, user } = await createAuthApp(`origin-${Date.now()}@example.com`)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:8788', origin: 'https://evil.example' },
      payload: { email: user.email, password: 'password123' },
    })
    await app.close()

    expect(response.statusCode).toBe(403)
  })

  it('允许带端口的同源写请求', async () => {
    const { app, user } = await createAuthApp(`same-origin-${Date.now()}@example.com`)
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:18080', origin: 'http://localhost:18080' },
      payload: { email: user.email, password: 'password123' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
  })

  it('用户可以修改密码且保留当前会话', async () => {
    const { app, user, sessions } = await createAuthApp(`password-${Date.now()}@example.com`)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'password123' },
    })
    const cookie = login.cookies[0]?.value
    const tokenHash = hashToken(cookie)
    expect(sessions.has(tokenHash)).toBe(true)

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: `gip_session=${cookie}` },
      payload: { currentPassword: 'password123', newPassword: 'new-password-123' },
    })
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `gip_session=${cookie}` },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ email: user.email })
    expect(sessions.has(tokenHash)).toBe(true)
  })

  it('用户可提交注册申请，审批前不能登录', async () => {
    const { app, users } = await createAuthApp(`register-base-${Date.now()}@example.com`)
    const email = `register-${Date.now()}@example.com`
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password123' },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password123' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(users.get(email)).toMatchObject({ registration_status: 'pending' })
    expect(login.statusCode).toBe(403)
    expect(login.json()).toMatchObject({ error: '账号正在等待管理员审批' })
  })

  it('关闭注册审批后，新用户注册后可直接登录', async () => {
    const { app, users } = await createAuthApp(`register-open-base-${Date.now()}@example.com`, { registrationRequireApproval: false })
    const email = `register-open-${Date.now()}@example.com`
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password123' },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password123' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'approved' })
    expect(users.get(email)).toMatchObject({ registration_status: 'approved', disabled_at: null })
    expect(login.statusCode).toBe(200)
  })

  it('关闭注册审批后，待审批用户再次注册会直接通过', async () => {
    const { app, users } = await createAuthApp(`register-pending-base-${Date.now()}@example.com`, { registrationRequireApproval: false })
    const email = `register-pending-${Date.now()}@example.com`
    users.set(email, {
      id: '00000000-0000-0000-0000-0000000000cc',
      email,
      password_hash: await hashPassword('old-password-123'),
      is_admin: false,
      disabled_at: '2026-01-01T00:00:00.000Z',
      registration_status: 'pending',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password123' },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password123' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'approved' })
    expect(users.get(email)).toMatchObject({ registration_status: 'approved', disabled_at: null })
    expect(login.statusCode).toBe(200)
  })
})
