import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AgentConversation, type PlatformSettings, type TaskRecord } from '../src/types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from '../src/lib/apiProfiles'
import { hashToken } from './crypto'
import type { Db } from './db'
import { registerCloudRoutes } from './routes'
import type { ServerConfig } from './config'
import { S3Client } from '@aws-sdk/client-s3'

const agentApiMocks = vi.hoisted(() => ({
  callAgentResponsesApi: vi.fn(),
}))

vi.mock('../src/lib/agentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/agentApi')>()
  return {
    ...actual,
    callAgentResponsesApi: agentApiMocks.callAgentResponsesApi,
  }
})

type MemoryUser = {
  id: string
  email: string
  is_admin: boolean
  disabled_at: string | null
  registration_status: 'approved' | 'pending' | 'rejected'
  registration_requested_at: string | null
  registration_reviewed_at: string | null
  registration_reviewed_by: string | null
  password_hash: string
  storage_quota_bytes: number | null
  task_quota_count: number | null
  created_at: string
  updated_at: string
}

const NOW_ISO = '2026-01-01T00:00:00.000Z'
const ADMIN_USER: MemoryUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@example.com',
  is_admin: true,
  disabled_at: null,
  registration_status: 'approved',
  registration_requested_at: NOW_ISO,
  registration_reviewed_at: NOW_ISO,
  registration_reviewed_by: null,
  password_hash: 'hash-admin',
  storage_quota_bytes: null,
  task_quota_count: null,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
}
const USER_A: MemoryUser = {
  id: '00000000-0000-0000-0000-00000000000a',
  email: 'a@example.com',
  is_admin: false,
  disabled_at: null,
  registration_status: 'approved',
  registration_requested_at: NOW_ISO,
  registration_reviewed_at: NOW_ISO,
  registration_reviewed_by: ADMIN_USER.id,
  password_hash: 'hash-a',
  storage_quota_bytes: null,
  task_quota_count: null,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
}
const USER_B: MemoryUser = {
  id: '00000000-0000-0000-0000-00000000000b',
  email: 'b@example.com',
  is_admin: false,
  disabled_at: null,
  registration_status: 'approved',
  registration_requested_at: NOW_ISO,
  registration_reviewed_at: NOW_ISO,
  registration_reviewed_by: ADMIN_USER.id,
  password_hash: 'hash-b',
  storage_quota_bytes: null,
  task_quota_count: null,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
}

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, ' ').trim()
}

function rowKey(userId: string, id: string) {
  return `${userId}:${id}`
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

function createMemoryDb() {
  const users = new Map([ADMIN_USER, USER_A, USER_B].map((user) => [user.id, { ...user }]))
  const sessions = new Map([
    [hashToken('token-admin'), ADMIN_USER.id],
    [hashToken('token-a'), USER_A.id],
    [hashToken('token-b'), USER_B.id],
  ])
  const userAProfile = createDefaultOpenAIProfile({
    apiKey: 'test-key',
    apiMode: 'responses',
    model: 'gpt-image-2',
  })
  const settings = new Map<string, { settings: typeof DEFAULT_SETTINGS; params: typeof DEFAULT_PARAMS; workspace: Record<string, unknown> }>([
    [USER_A.id, { settings: { ...DEFAULT_SETTINGS, profiles: [userAProfile], activeProfileId: userAProfile.id }, params: DEFAULT_PARAMS, workspace: { prompt: 'user-a-prompt' } }],
    [USER_B.id, { settings: { ...DEFAULT_SETTINGS, model: 'model-b' }, params: DEFAULT_PARAMS, workspace: { prompt: 'user-b-prompt' } }],
  ])
  const images = new Map([
    [rowKey(USER_A.id, 'image-owned'), {
      storage_key: 'users/user-a/library/images/image-owned.png',
      mime_type: 'image/png',
      byte_size: 11,
    }],
    [rowKey(USER_B.id, 'image-private'), {
      storage_key: 'users/user-b/library/images/image-private.png',
      mime_type: 'image/png',
      byte_size: 13,
    }],
  ])
  const thumbnails = new Map([
    [rowKey(USER_A.id, 'image-owned'), {
      storage_key: 'users/user-a/library/thumbnails/image-owned.png',
      mime_type: 'image/png',
      width: 1,
      height: 1,
      thumbnail_version: 2,
    }],
    [rowKey(USER_B.id, 'image-private'), {
      storage_key: 'users/user-b/library/thumbnails/image-private.png',
      mime_type: 'image/png',
      width: 1,
      height: 1,
      thumbnail_version: 2,
    }],
  ])
  const tasks = new Map<string, TaskRecord>([
    [rowKey(USER_A.id, 'task-owned'), {
      id: 'task-owned',
      prompt: 'owned task',
      params: DEFAULT_PARAMS,
      inputImageIds: [],
      outputImages: ['image-owned'],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      sourceMode: 'agent',
      agentConversationId: 'agent-conversation-a',
      agentRoundId: 'round-a',
      agentToolAction: 'edit',
    }],
    [rowKey(USER_B.id, 'task-private'), {
      id: 'task-private',
      prompt: 'private task',
      params: DEFAULT_PARAMS,
      inputImageIds: [],
      outputImages: [],
      status: 'done',
      error: null,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
    }],
  ])
  const agentConversations = new Map<string, AgentConversation>([
    [rowKey(USER_A.id, 'agent-conversation-a'), {
      id: 'agent-conversation-a',
      title: '温州风景 Agent',
      activeRoundId: 'round-a',
      createdAt: 1,
      updatedAt: 2,
      rounds: [{
        id: 'round-a',
        index: 1,
        userMessageId: 'message-user-a',
        assistantMessageId: 'message-assistant-a',
        prompt: 'owned task',
        inputImageIds: [],
        outputTaskIds: ['task-owned'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'message-user-a', role: 'user', content: '生成温州风景主视觉', roundId: 'round-a', createdAt: 1 },
        { id: 'message-assistant-a', role: 'assistant', content: '请求失败：超时', roundId: 'round-a', outputTaskIds: ['task-owned'], createdAt: 2 },
      ],
    }],
  ])
  const auditLogs: Array<{
    id: string
    actor_user_id: string | null
    target_user_id: string | null
    action: string
    details: Record<string, unknown>
    ip: string | null
    user_agent: string | null
    created_at: string
  }> = []
  let platformSettingsRow: { value: unknown; updated_at: string } | null = null

  const query = vi.fn(async (sqlText: string, params: unknown[] = []) => {
    const sql = normalizeSql(sqlText)
    if (sql.includes('FROM sessions') && sql.includes('JOIN users')) {
      const userId = sessions.get(params[0] as string)
      const user = userId ? users.get(userId) : null
      return { rows: user && !user.disabled_at ? [{ id: user.id, email: user.email, is_admin: user.is_admin }] : [] }
    }
    if (sql.startsWith('SELECT value, updated_at FROM platform_settings')) {
      return { rows: platformSettingsRow ? [platformSettingsRow] : [] }
    }
    if (sql.startsWith('SELECT value FROM platform_settings')) {
      return { rows: platformSettingsRow ? [{ value: platformSettingsRow.value }] : [] }
    }
    if (sql.startsWith('INSERT INTO platform_settings')) {
      platformSettingsRow = { value: params[1], updated_at: NOW_ISO }
      return { rows: [{ value: platformSettingsRow.value, updated_at: platformSettingsRow.updated_at }] }
    }
    if (sql.includes('users.storage_quota_bytes') && sql.includes('WHERE users.id = $1')) {
      const user = users.get(params[0] as string)
      if (!user) return { rows: [] }
      const userImages = [...images.entries()]
        .filter(([key]) => key.startsWith(`${user.id}:`))
        .map(([, image]) => image)
      const userTasks = [...tasks.keys()].filter((key) => key.startsWith(`${user.id}:`))
      return {
        rows: [{
          storage_quota_bytes: user.storage_quota_bytes,
          task_quota_count: user.task_quota_count,
          storage_bytes: userImages.reduce((sum, image) => sum + image.byte_size, 0),
          task_count: userTasks.length,
        }],
      }
    }
    if (sql.includes('FROM users LEFT JOIN')) {
      return {
        rows: [...users.values()].map((user) => {
          const userTasks = [...tasks.entries()]
            .filter(([key]) => key.startsWith(`${user.id}:`))
            .map(([, task]) => task)
          const userImages = [...images.entries()]
            .filter(([key]) => key.startsWith(`${user.id}:`))
            .map(([, image]) => image)
          return {
            id: user.id,
	            email: user.email,
	            is_admin: user.is_admin,
	            disabled_at: user.disabled_at,
	            registration_status: user.registration_status,
	            registration_requested_at: user.registration_requested_at,
	            registration_reviewed_at: user.registration_reviewed_at,
	            registration_reviewed_by: user.registration_reviewed_by,
	            created_at: user.created_at,
            updated_at: user.updated_at,
            storage_quota_bytes: user.storage_quota_bytes,
            task_quota_count: user.task_quota_count,
            latest_session_at: NOW_ISO,
            task_count: userTasks.length,
            running_task_count: userTasks.filter((task) => task.status === 'running').length,
            image_count: userImages.length,
            storage_bytes: userImages.reduce((sum, image) => sum + image.byte_size, 0),
	            conversation_count: [...agentConversations.keys()].filter((key) => key.startsWith(`${user.id}:`)).length,
            session_count: [...sessions.values()].filter((id) => id === user.id).length,
          }
        }),
      }
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM users WHERE is_admin = true')) {
      const count = [...users.values()].filter((user) => user.is_admin && !user.disabled_at).length
      return { rows: [{ count: String(count) }] }
    }
    if (sql.startsWith('INSERT INTO users (email, password_hash, is_admin, disabled_at') || sql.startsWith('INSERT INTO users ( email, password_hash, is_admin, disabled_at')) {
      if ([...users.values()].some((user) => user.email === params[0])) {
        throw Object.assign(new Error('duplicate email'), { code: '23505' })
      }
      const id = `00000000-0000-0000-0000-created${String(users.size).padStart(6, '0')}`.slice(0, 36)
      const user: MemoryUser = {
        id,
        email: params[0] as string,
        password_hash: params[1] as string,
        is_admin: Boolean(params[2]),
        disabled_at: null,
        registration_status: 'approved',
        registration_requested_at: NOW_ISO,
        registration_reviewed_at: NOW_ISO,
        registration_reviewed_by: (params[5] as string | null | undefined) ?? null,
        storage_quota_bytes: (params[3] as number | null | undefined) ?? null,
        task_quota_count: (params[4] as number | null | undefined) ?? null,
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      }
      users.set(id, user)
      return { rows: [user] }
    }
    if (sql.startsWith('SELECT id FROM users WHERE id = $1')) {
      const user = users.get(params[0] as string)
      return { rows: user ? [{ id: user.id }] : [] }
    }
    if (sql.startsWith('SELECT id, email, is_admin FROM users WHERE id = $1')) {
      const user = users.get(params[0] as string)
      return { rows: user ? [{ id: user.id, email: user.email, is_admin: user.is_admin }] : [] }
    }
    if (sql.startsWith('SELECT email, registration_status FROM users WHERE id = $1')) {
      const user = users.get(params[0] as string)
      return { rows: user ? [{ email: user.email, registration_status: user.registration_status }] : [] }
    }
    if (sql.startsWith('SELECT is_admin, disabled_at FROM users WHERE id = $1')) {
      const user = users.get(params[0] as string)
      return { rows: user ? [{ is_admin: user.is_admin, disabled_at: user.disabled_at }] : [] }
    }
    if (sql.startsWith('UPDATE users SET disabled_at') && sql.includes('WHERE id = ANY')) {
      const ids = params[0] as string[]
      for (const id of ids) {
        const user = users.get(id)
        if (user) user.disabled_at = sql.includes('disabled_at = now()') ? NOW_ISO : null
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE users SET')) {
      const id = params[params.length - 1] as string
      const user = users.get(id)
      if (!user) return { rows: [] }
      let valueIndex = 0
      if (sql.includes('is_admin = $')) {
        user.is_admin = Boolean(params[valueIndex])
        valueIndex++
      }
      if (sql.includes('password_hash = $')) {
        user.password_hash = params[valueIndex] as string
        valueIndex++
      }
      if (sql.includes('storage_quota_bytes = $')) {
        user.storage_quota_bytes = params[valueIndex] as number | null
        valueIndex++
      }
      if (sql.includes('task_quota_count = $')) {
        user.task_quota_count = params[valueIndex] as number | null
        valueIndex++
      }
      if (sql.includes('disabled_at = now()')) user.disabled_at = NOW_ISO
      if (sql.includes('disabled_at = null')) user.disabled_at = null
      if (sql.includes('registration_status = $1')) {
        user.registration_status = params[0] as MemoryUser['registration_status']
        user.registration_reviewed_by = params[1] as string
      }
      user.updated_at = NOW_ISO
      return { rows: [{ id }] }
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = $1')) {
      const userId = params[0] as string
      for (const [tokenHash, sessionUserId] of [...sessions.entries()]) {
        if (sessionUserId === userId) sessions.delete(tokenHash)
      }
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM users WHERE id = $1')) {
      users.delete(params[0] as string)
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO audit_logs')) {
      auditLogs.push({
        id: `audit-${auditLogs.length + 1}`,
        actor_user_id: params[0] as string | null,
        target_user_id: params[1] as string | null,
        action: params[2] as string,
        details: params[3] as Record<string, unknown>,
        ip: params[4] as string | null,
        user_agent: params[5] as string | null,
        created_at: NOW_ISO,
      })
      return { rows: [] }
    }
    if (sql.startsWith('SELECT COUNT(*)::text AS count FROM audit_logs')) {
      return { rows: [{ count: String(auditLogs.length) }] }
    }
	    if (sql.includes('FROM audit_logs')) {
	      return {
	        rows: auditLogs.map((log) => ({
          id: log.id,
          action: log.action,
          details: log.details,
          ip: log.ip,
          user_agent: log.user_agent,
          created_at: log.created_at,
          actor_email: log.actor_user_id ? users.get(log.actor_user_id)?.email ?? null : null,
          target_email: log.target_user_id ? users.get(log.target_user_id)?.email ?? null : null,
	        })),
	      }
	    }
    if (sql.startsWith('SELECT conversation FROM agent_conversations WHERE user_id = $1 AND id = $2')) {
      const conversation = agentConversations.get(rowKey(params[0] as string, params[1] as string))
      return { rows: conversation ? [{ conversation }] : [] }
    }
    if (sql.startsWith('SELECT user_id, id, conversation FROM agent_conversations')) {
      const userIds = new Set(params[0] as string[])
      const conversationIds = new Set(params[1] as string[])
      return {
        rows: [...agentConversations.entries()]
          .filter(([key, conversation]) => {
            const [userId] = key.split(':')
            return userIds.has(userId) && conversationIds.has(conversation.id)
          })
          .map(([key, conversation]) => {
            const [userId] = key.split(':')
            return {
              user_id: userId,
              id: conversation.id,
              conversation,
            }
          }),
      }
    }
    if (sql.includes('tasks.user_id') && sql.includes('users.email AS user_email') && sql.includes('WHERE tasks.user_id = $1 AND tasks.id = $2')) {
      const userId = params[0] as string
      const record = tasks.get(rowKey(userId, params[1] as string))
      return {
        rows: record ? [{
          user_id: userId,
          user_email: users.get(userId)?.email ?? null,
          record,
          updated_at: NOW_ISO,
        }] : [],
      }
    }
	    if (sql.includes('tasks.user_id') && sql.includes('users.email AS user_email')) {
	      const userFilter = params.length > 1 ? params[0] as string : null
	      const agentFilter = sql.includes("tasks.record->>'agentConversationId'")
	        ? params[userFilter ? 1 : 0] as string
	        : null
	      return {
	        rows: [...tasks.entries()]
	          .filter(([key]) => !userFilter || key.startsWith(`${userFilter}:`))
	          .filter(([, record]) => !agentFilter || record.agentConversationId === agentFilter)
	          .map(([key, record]) => {
            const [userId] = key.split(':')
            return {
              user_id: userId,
              user_email: users.get(userId)?.email ?? null,
              record,
              updated_at: NOW_ISO,
            }
          }),
      }
    }
    if (sql.includes('images.id') && sql.includes('image_thumbnails.image_id IS NOT NULL AS has_thumbnail')) {
      const userId = params[0] as string
      const ids = params[1] as string[]
      return {
        rows: ids.flatMap((id) => {
          const row = images.get(rowKey(userId, id))
          if (!row) return []
          return [{
            id,
            source: 'generated',
            byte_size: row.byte_size,
            width: null,
            height: null,
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
            has_thumbnail: thumbnails.has(rowKey(userId, id)),
          }]
        }),
      }
    }
    if (sql.startsWith('SELECT storage_key FROM images UNION')) {
      return {
        rows: [
          ...[...images.values()].map((row) => ({ storage_key: row.storage_key })),
          ...[...thumbnails.values()].map((row) => ({ storage_key: row.storage_key })),
        ],
      }
    }
    if (sql.startsWith('SELECT record, updated_at FROM tasks WHERE user_id = $1')) {
      const userId = params[0] as string
      return {
        rows: [...tasks.entries()]
          .filter(([key]) => key.startsWith(`${userId}:`))
          .map(([, record]) => ({ record, updated_at: NOW_ISO })),
      }
    }
    if (sql.startsWith('SELECT id, source, byte_size, created_at, updated_at FROM images')) {
      const userId = params[0] as string
      return {
        rows: [...images.entries()]
          .filter(([key]) => key.startsWith(`${userId}:`))
          .map(([key, row]) => ({
            id: key.slice(userId.length + 1),
            source: 'upload',
            byte_size: row.byte_size,
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
          })),
      }
    }
    if (sql.startsWith('SELECT settings, params, workspace FROM user_settings')) {
      const row = settings.get(params[0] as string)
      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith('SELECT id, encrypted_api_key FROM api_profiles')) return { rows: [] }
    if (sql.startsWith('SELECT id FROM api_profiles')) return { rows: [] }
    if (sql.startsWith('SELECT id FROM tasks WHERE user_id = $1')) {
      const userId = params[0] as string
      return {
        rows: [...tasks.keys()]
          .filter((key) => key.startsWith(`${userId}:`))
          .map((key) => ({ id: key.slice(userId.length + 1) })),
      }
    }
    if (sql.startsWith('SELECT storage_key FROM images') && sql.includes('UNION ALL') && params.length === 1) {
      const userId = params[0] as string
      const rows: Array<{ storage_key: string }> = []
      for (const [key, row] of images) {
        if (key.startsWith(`${userId}:`)) rows.push({ storage_key: row.storage_key })
      }
      for (const [key, row] of thumbnails) {
        if (key.startsWith(`${userId}:`)) rows.push({ storage_key: row.storage_key })
      }
      return { rows }
    }
    if (sql.startsWith('SELECT storage_key FROM images') && sql.includes('UNION ALL')) {
      const key = rowKey(params[0] as string, params[1] as string)
      const rows: Array<{ storage_key: string }> = []
      for (const row of [images.get(key), thumbnails.get(key)]) {
        if (row) rows.push({ storage_key: row.storage_key })
      }
      return { rows }
    }
    if (sql.startsWith('SELECT storage_key, mime_type FROM images')) {
      const row = images.get(rowKey(params[0] as string, params[1] as string))
      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith('SELECT storage_key, mime_type, width, height, thumbnail_version FROM image_thumbnails')) {
      const row = thumbnails.get(rowKey(params[0] as string, params[1] as string))
      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith('INSERT INTO images')) {
      images.set(rowKey(params[1] as string, params[0] as string), {
        storage_key: params[4] as string,
        mime_type: params[5] as string,
        byte_size: params[6] as number,
      })
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM image_thumbnails') && sql.includes('image_id = $2')) {
      thumbnails.delete(rowKey(params[0] as string, params[1] as string))
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM image_thumbnails')) {
      const userId = params[0] as string
      for (const key of [...thumbnails.keys()]) {
        if (key.startsWith(`${userId}:`)) thumbnails.delete(key)
      }
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM images') && sql.includes('id = $2')) {
      images.delete(rowKey(params[0] as string, params[1] as string))
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM images')) {
      const userId = params[0] as string
      for (const key of [...images.keys()]) {
        if (key.startsWith(`${userId}:`)) images.delete(key)
      }
      return { rows: [] }
    }
    if (sql.startsWith('SELECT record FROM tasks WHERE user_id = $1 AND id = $2')) {
      const record = tasks.get(rowKey(params[0] as string, params[1] as string))
      return { rows: record ? [{ record }] : [] }
    }
    if (sql.startsWith('SELECT record FROM tasks WHERE user_id = $1 ORDER BY created_at ASC')) {
      const userId = params[0] as string
      return {
        rows: [...tasks.entries()]
          .filter(([key]) => key.startsWith(`${userId}:`))
          .map(([, record]) => ({ record })),
      }
    }
    if (sql.startsWith('DELETE FROM tasks') && sql.includes('id = $2')) {
      tasks.delete(rowKey(params[0] as string, params[1] as string))
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM tasks')) {
      const userId = params[0] as string
      for (const key of [...tasks.keys()]) {
        if (key.startsWith(`${userId}:`)) tasks.delete(key)
      }
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM agent_conversations')) {
      const userId = params[0] as string
      for (const key of [...agentConversations.keys()]) {
        if (key.startsWith(`${userId}:`)) agentConversations.delete(key)
      }
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO agent_conversations')) {
      agentConversations.set(rowKey(params[1] as string, params[0] as string), params[2] as AgentConversation)
      return { rows: [] }
    }
	    if (sql.startsWith('UPDATE user_settings SET workspace')) {
	      const row = settings.get(params[0] as string)
	      if (row) settings.set(params[0] as string, { ...row, workspace: params[1] as Record<string, unknown> })
	      return { rows: [] }
	    }
	    if (sql.startsWith('INSERT INTO api_profiles')) return { rows: [] }
	    if (sql.startsWith('DELETE FROM api_profiles')) return { rows: [] }
	    if (sql.startsWith('DELETE FROM user_settings')) {
	      settings.delete(params[0] as string)
	      return { rows: [] }
	    }
	    if (sql.startsWith('INSERT INTO user_settings')) {
	      settings.set(params[0] as string, {
	        settings: params[1] as typeof DEFAULT_SETTINGS,
	        params: params[2] as typeof DEFAULT_PARAMS,
	        workspace: params[3] as Record<string, unknown>,
	      })
	      return { rows: [] }
	    }
	    if (sql.startsWith('INSERT INTO tasks')) {
	      tasks.set(rowKey(params[1] as string, params[0] as string), params[2] as TaskRecord)
	      return { rows: [] }
    }
    throw new Error(`未处理的测试 SQL：${sql}`)
  })

  return { db: { query } as unknown as Db, users, images, thumbnails, tasks, agentConversations, auditLogs }
}

function createMemoryS3() {
  const objects = new Map<string, Buffer<ArrayBufferLike>>([
    ['users/user-a/library/images/image-owned.png', Buffer.from('owned-image')],
    ['users/user-a/library/thumbnails/image-owned.png', Buffer.from('owned-thumbnail')],
    ['users/user-b/library/images/image-private.png', Buffer.from('private-image')],
    ['users/user-b/library/thumbnails/image-private.png', Buffer.from('private-thumbnail')],
    ['users/orphan/library/images/orphan.png', Buffer.from('orphan')],
  ])
  const deletedKeys: string[] = []
  const s3 = new S3Client({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const send = vi.fn(async (command: { input?: { Key?: string; Prefix?: string; Body?: unknown }; constructor: { name: string } }) => {
    const key = command.input?.Key ?? ''
    if (command.constructor.name === 'ListObjectsV2Command') {
      const prefix = command.input?.Prefix ?? ''
      return {
        Contents: [...objects.keys()]
          .filter((objectKey) => objectKey.startsWith(prefix))
          .map((objectKey) => ({ Key: objectKey })),
      }
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const body = objects.get(key)
      return { Body: body ? { transformToByteArray: async () => Uint8Array.from(body) } : undefined }
    }
    if (command.constructor.name === 'PutObjectCommand') {
      const body = command.input?.Body
      objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array))
      return {}
    }
    if (command.constructor.name === 'DeleteObjectCommand') {
      deletedKeys.push(key)
      objects.delete(key)
      return {}
    }
    throw new Error(`未处理的 S3 命令：${command.constructor.name}`)
  })
  s3.send = send as unknown as S3Client['send']
  return { s3, objects, deletedKeys, send }
}

async function createTestApp() {
  const app = Fastify()
  await app.register(cookie)
  const memoryDb = createMemoryDb()
  const memoryS3 = createMemoryS3()
  registerCloudRoutes(app, memoryDb.db, memoryS3.s3, createConfig())
  await app.ready()
  return { app, ...memoryDb, ...memoryS3 }
}

describe('云端多用户隔离', () => {
	  it('只返回当前用户自己的 settings 工作台快照', async () => {
	    const { app } = await createTestApp()
	    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: 'gip_session=token-a' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
	    expect(response.json()).toMatchObject({ prompt: 'user-a-prompt' })
	    expect(response.json()).not.toMatchObject({ prompt: 'user-b-prompt' })
	  })

	  it('settings 工作台快照会同步收藏夹配置', async () => {
	    const { app } = await createTestApp()
	    const favoriteCollections = [
	      { id: 'collection-design', name: '设计项目', createdAt: 1, updatedAt: 2 },
	      { id: 'collection-avatar', name: '头像方案', createdAt: 3, updatedAt: 4 },
	    ]
	    const saveResponse = await app.inject({
	      method: 'PUT',
	      url: '/api/settings',
	      headers: { cookie: 'gip_session=token-a' },
	      payload: {
	        settings: DEFAULT_SETTINGS,
	        params: DEFAULT_PARAMS,
	        activeAgentConversationId: null,
	        appMode: 'gallery',
	        agentSidebarCollapsed: false,
	        agentAssetTab: 'outputs',
	        agentAssetPanelCollapsed: false,
	        favoriteCollections,
	        defaultFavoriteCollectionId: 'collection-avatar',
	      },
	    })
	    const loadResponse = await app.inject({
	      method: 'GET',
	      url: '/api/settings',
	      headers: { cookie: 'gip_session=token-a' },
	    })
	    await app.close()

	    expect(saveResponse.statusCode).toBe(200)
	    expect(saveResponse.json()).toMatchObject({
	      favoriteCollections,
	      defaultFavoriteCollectionId: 'collection-avatar',
	    })
	    expect(loadResponse.json()).toMatchObject({
	      favoriteCollections,
	      defaultFavoriteCollectionId: 'collection-avatar',
	    })
	  })

	  it('用户不能读取其他用户的图片对象', async () => {
    const { app, s3 } = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/images/image-private/data',
      headers: { cookie: 'gip_session=token-a' },
    })
    await app.close()

    expect(response.statusCode).toBe(404)
    expect(s3.send).not.toHaveBeenCalled()
  })

  it('用户删除同名图片时不会删除其他用户的对象', async () => {
    const { app, images, thumbnails, objects, deletedKeys } = await createTestApp()
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/images/image-private',
      headers: { cookie: 'gip_session=token-a' },
    })

    expect(response.statusCode).toBe(200)
    expect(images.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(thumbnails.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(objects.has('users/user-b/library/images/image-private.png')).toBe(true)
    expect(deletedKeys).toEqual([])

    await app.close()
  })

  it('图片所有者删除图片时会清理原图和缩略图对象', async () => {
    const { app, images, thumbnails, objects, deletedKeys } = await createTestApp()
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/images/image-private',
      headers: { cookie: 'gip_session=token-b' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(images.has(rowKey(USER_B.id, 'image-private'))).toBe(false)
    expect(thumbnails.has(rowKey(USER_B.id, 'image-private'))).toBe(false)
    expect(objects.has('users/user-b/library/images/image-private.png')).toBe(false)
    expect(objects.has('users/user-b/library/thumbnails/image-private.png')).toBe(false)
    expect(deletedKeys.sort()).toEqual([
      'users/user-b/library/images/image-private.png',
      'users/user-b/library/thumbnails/image-private.png',
    ].sort())
  })

  it('用户不能读取或删除其他用户的任务', async () => {
    const { app, tasks } = await createTestApp()
    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-private',
      headers: { cookie: 'gip_session=token-a' },
    })
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/task-private',
      headers: { cookie: 'gip_session=token-a' },
    })
    await app.close()

    expect(getResponse.statusCode).toBe(404)
    expect(deleteResponse.statusCode).toBe(200)
    expect(tasks.has(rowKey(USER_B.id, 'task-private'))).toBe(true)
  })

  it('PATCH 可以为当前用户创建前端托管任务且强制使用路由 id', async () => {
    const { app, tasks } = await createTestApp()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-agent',
      headers: { cookie: 'gip_session=token-a' },
      payload: {
        id: 'malicious-id',
        prompt: 'agent task',
        params: DEFAULT_PARAMS,
        inputImageIds: [],
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: 10,
        finishedAt: null,
        elapsed: null,
        sourceMode: 'agent',
      } satisfies TaskRecord,
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json().task.id).toBe('task-agent')
    expect(tasks.get(rowKey(USER_A.id, 'task-agent'))?.id).toBe('task-agent')
    expect(tasks.has(rowKey(USER_B.id, 'task-agent'))).toBe(false)
  })

  it('清空云端数据只删除当前用户的任务、图片和配置', async () => {
    const { app, images, thumbnails, objects, tasks, deletedKeys } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/data/clear',
      headers: { cookie: 'gip_session=token-a' },
      payload: { clearConfig: true, clearTasks: true },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(tasks.has(rowKey(USER_A.id, 'task-owned'))).toBe(false)
    expect(images.has(rowKey(USER_A.id, 'image-owned'))).toBe(false)
    expect(thumbnails.has(rowKey(USER_A.id, 'image-owned'))).toBe(false)
    expect(objects.has('users/user-a/library/images/image-owned.png')).toBe(false)
    expect(objects.has('users/user-a/library/thumbnails/image-owned.png')).toBe(false)
    expect(tasks.has(rowKey(USER_B.id, 'task-private'))).toBe(true)
    expect(images.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(thumbnails.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(objects.has('users/user-b/library/images/image-private.png')).toBe(true)
    expect(deletedKeys.sort()).toEqual([
      'users/user-a/library/images/image-owned.png',
      'users/user-a/library/thumbnails/image-owned.png',
    ].sort())
  })

  it('非管理员不能访问管理后台接口', async () => {
    const { app } = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: 'gip_session=token-a' },
    })
    await app.close()

    expect(response.statusCode).toBe(403)
  })

  it('管理员可以查看系统概览和用户列表', async () => {
    const { app } = await createTestApp()
    const overviewResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: 'gip_session=token-admin' },
    })
    const usersResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(overviewResponse.statusCode).toBe(200)
    expect(overviewResponse.json()).toMatchObject({
      userCount: 3,
      taskCount: 2,
      imageCount: 2,
      storageBytes: 24,
    })
    expect(usersResponse.statusCode).toBe(200)
    expect(usersResponse.json().users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ADMIN_USER.id, email: ADMIN_USER.email, isAdmin: true }),
      expect.objectContaining({ id: USER_A.id, email: USER_A.email, isAdmin: false }),
    ]))
  })

  it('管理员可以审计用户生成请求和关联图片', async () => {
    const { app } = await createTestApp()
    const auditResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/generation-audits?userId=${USER_A.id}`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const agentAuditResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/generation-audits?userId=${USER_A.id}&agentConversationId=agent-conversation-a&limit=1000`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const imageResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${USER_A.id}/images/image-owned/data`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(auditResponse.statusCode).toBe(200)
    expect(auditResponse.json().audits).toEqual(expect.arrayContaining([
	      expect.objectContaining({
	        user: expect.objectContaining({ id: USER_A.id, email: USER_A.email }),
	        task: expect.objectContaining({ id: 'task-owned', prompt: 'owned task' }),
	        agentContext: expect.objectContaining({
	          conversationId: 'agent-conversation-a',
	          title: '温州风景 Agent',
	          roundId: 'round-a',
	          roundIndex: 1,
	          toolAction: 'edit',
	        }),
	        images: expect.arrayContaining([
	          expect.objectContaining({
	            id: 'image-owned',
            role: 'output',
            imageUrl: `/api/admin/users/${USER_A.id}/images/image-owned/data`,
          }),
        ]),
      }),
    ]))
    expect(agentAuditResponse.statusCode).toBe(200)
    expect(agentAuditResponse.json().audits).toHaveLength(1)
    expect(agentAuditResponse.json().audits[0]).toMatchObject({
      task: { id: 'task-owned', agentConversationId: 'agent-conversation-a' },
      agentContext: { title: '温州风景 Agent' },
    })
    expect(imageResponse.statusCode).toBe(200)
    expect(imageResponse.headers['content-type']).toContain('image/png')
  })

  it('管理员可以带完整 Agent 上下文原地重新生成失败任务', async () => {
    agentApiMocks.callAgentResponsesApi.mockReset()
    const { app, tasks, agentConversations, auditLogs } = await createTestApp()
    const taskKey = rowKey(USER_A.id, 'task-owned')
    const failedTask = tasks.get(taskKey)!
    tasks.set(rowKey(USER_A.id, 'task-parent'), {
      ...failedTask,
      id: 'task-parent',
      prompt: '上一轮温州参考底图',
      outputImages: ['image-owned'],
      status: 'done',
      error: null,
      agentRoundId: 'round-parent',
      agentToolCallId: 'ig-parent',
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
    })
    tasks.set(taskKey, {
      ...failedTask,
      status: 'error',
      error: '请求超时',
      outputImages: [],
      finishedAt: 2,
      elapsed: 1,
    })
    const conversationKey = rowKey(USER_A.id, 'agent-conversation-a')
    const conversation = agentConversations.get(conversationKey)!
    agentConversations.set(conversationKey, {
      ...conversation,
      activeRoundId: 'round-a',
      rounds: [
        {
          id: 'round-parent',
          index: 1,
          userMessageId: 'message-parent-user',
          assistantMessageId: 'message-parent-assistant',
          prompt: '先生成温州参考底图',
          inputImageIds: [],
          outputTaskIds: ['task-parent'],
          responseOutput: [{ type: 'message', content: [{ type: 'output_text', text: '已生成参考底图。' }] }],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          ...conversation.rounds[0],
          index: 2,
          parentRoundId: 'round-parent',
          outputTaskIds: ['task-owned'],
        },
      ],
      messages: [
        { id: 'message-parent-user', role: 'user', content: '先生成温州参考底图', roundId: 'round-parent', createdAt: 1 },
        { id: 'message-parent-assistant', role: 'assistant', content: '已生成参考底图。', roundId: 'round-parent', outputTaskIds: ['task-parent'], createdAt: 2 },
        ...conversation.messages,
      ],
    })
    const taskKeysBefore = [...tasks.keys()].filter((key) => key.startsWith(`${USER_A.id}:`)).sort()
    agentApiMocks.callAgentResponsesApi.mockResolvedValueOnce({
      responseId: 'response-regenerated',
      text: '已重新生成。',
      images: [{
        toolCallId: 'ig-regenerated',
        action: 'generate',
        dataUrl: 'data:image/png;base64,cmVnZW4=',
        revisedPrompt: '重新生成的温州风景主视觉',
        actualParams: { quality: 'high' },
      }],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '已重新生成。' }] }],
      rawResponsePayload: '{"output":[]}',
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${USER_A.id}/tasks/task-owned/regenerate`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(response.statusCode, response.body).toBe(200)
    const updatedTask = tasks.get(taskKey)!
    expect(updatedTask).toMatchObject({
      id: 'task-owned',
      status: 'done',
      error: null,
      agentToolCallId: 'ig-regenerated',
    })
    expect(updatedTask.outputImages).toHaveLength(1)
    expect([...tasks.keys()].filter((key) => key.startsWith(`${USER_A.id}:`)).sort()).toEqual(taskKeysBefore)
    expect(agentApiMocks.callAgentResponsesApi).toHaveBeenCalledTimes(1)
    const agentCall = agentApiMocks.callAgentResponsesApi.mock.calls[0][0]
    expect(agentCall.imageOnly).toBe(true)
    const input = JSON.stringify(agentCall.input)
    expect(input).toContain('先生成温州参考底图')
    expect(input).toContain('生成温州风景主视觉')
    expect(input).toContain('round-1-image-1')
    expect(input).toContain('data:image/png;base64,b3duZWQtaW1hZ2U=')
    expect(input).toContain('目标任务 ID：task-owned')
    expect(response.json().audit.task).toMatchObject({ id: 'task-owned', status: 'done' })
    expect(response.json().audit.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'output', missing: false }),
    ]))
    expect(auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'generation.regenerate',
        target_user_id: USER_A.id,
      }),
    ]))
  })

  it('管理员可以创建新用户', async () => {
    const { app, users } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: 'gip_session=token-admin' },
      payload: {
        email: 'new@example.com',
        password: 'password123',
        isAdmin: true,
        storageQuotaBytes: 1024,
        taskQuotaCount: 3,
      },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json().user).toMatchObject({
      email: 'new@example.com',
      isAdmin: true,
      storageQuotaBytes: 1024,
      taskQuotaCount: 3,
    })
    expect([...users.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'new@example.com',
        is_admin: true,
        storage_quota_bytes: 1024,
        task_quota_count: 3,
      }),
    ]))
  })

  it('管理员创建重复邮箱时返回明确错误', async () => {
    const { app } = await createTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: 'gip_session=token-admin' },
      payload: {
        email: USER_A.email,
        password: 'password123',
        isAdmin: false,
      },
    })
    await app.close()

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: '邮箱已存在' })
  })

  it('管理员可以审批和拒绝注册申请', async () => {
    const { app, users, auditLogs } = await createTestApp()
    const pendingUser: MemoryUser = {
      ...USER_A,
      id: '00000000-0000-0000-0000-0000000000c1',
      email: 'pending@example.com',
      disabled_at: NOW_ISO,
      registration_status: 'pending',
      registration_requested_at: NOW_ISO,
      registration_reviewed_at: null,
      registration_reviewed_by: null,
    }
    const rejectedUser: MemoryUser = {
      ...USER_B,
      id: '00000000-0000-0000-0000-0000000000c2',
      email: 'reject@example.com',
      disabled_at: NOW_ISO,
      registration_status: 'pending',
      registration_requested_at: NOW_ISO,
      registration_reviewed_at: null,
      registration_reviewed_by: null,
    }
    users.set(pendingUser.id, pendingUser)
    users.set(rejectedUser.id, rejectedUser)

    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${pendingUser.id}/registration`,
      headers: { cookie: 'gip_session=token-admin' },
      payload: { action: 'approve' },
    })
    const rejectResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${rejectedUser.id}/registration`,
      headers: { cookie: 'gip_session=token-admin' },
      payload: { action: 'reject' },
    })
    await app.close()

    expect(approveResponse.statusCode).toBe(200)
    expect(rejectResponse.statusCode).toBe(200)
    expect(users.get(pendingUser.id)).toMatchObject({ registration_status: 'approved', disabled_at: null })
    expect(users.get(rejectedUser.id)).toMatchObject({ registration_status: 'rejected', disabled_at: NOW_ISO })
    expect(auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'user.registration_approve', target_user_id: pendingUser.id }),
      expect.objectContaining({ action: 'user.registration_reject', target_user_id: rejectedUser.id }),
    ]))
  })

  it('管理员不能禁用自己或删除自己', async () => {
    const { app, users } = await createTestApp()
    const disableResponse = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ADMIN_USER.id}`,
      headers: { cookie: 'gip_session=token-admin' },
      payload: { disabled: true },
    })
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${ADMIN_USER.id}`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(disableResponse.statusCode).toBe(400)
    expect(deleteResponse.statusCode).toBe(400)
    expect(users.get(ADMIN_USER.id)?.disabled_at).toBeNull()
    expect(users.has(ADMIN_USER.id)).toBe(true)
  })

  it('管理员可以删除其他用户并保留审计追踪', async () => {
    const { app, users } = await createTestApp()
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${USER_B.id}`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const logsResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(deleteResponse.statusCode).toBe(200)
    expect(users.has(USER_B.id)).toBe(false)
    expect(logsResponse.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'user.delete',
        details: { deletedUserId: USER_B.id },
      }),
    ]))
  })

  it('管理员清空指定用户数据不会影响其他用户', async () => {
    const { app, images, thumbnails, objects, tasks, deletedKeys, users } = await createTestApp()
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${USER_A.id}/data`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(users.has(USER_A.id)).toBe(true)
    expect(tasks.has(rowKey(USER_A.id, 'task-owned'))).toBe(false)
    expect(images.has(rowKey(USER_A.id, 'image-owned'))).toBe(false)
    expect(thumbnails.has(rowKey(USER_A.id, 'image-owned'))).toBe(false)
    expect(objects.has('users/user-a/library/images/image-owned.png')).toBe(false)
    expect(tasks.has(rowKey(USER_B.id, 'task-private'))).toBe(true)
    expect(images.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(thumbnails.has(rowKey(USER_B.id, 'image-private'))).toBe(true)
    expect(objects.has('users/user-b/library/images/image-private.png')).toBe(true)
    expect(deletedKeys.sort()).toEqual([
      'users/user-a/library/images/image-owned.png',
      'users/user-a/library/thumbnails/image-owned.png',
    ].sort())
  })

  it('管理员清空不存在用户的数据时返回 404', async () => {
    const { app } = await createTestApp()
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/00000000-0000-0000-0000-000000000099/data',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(response.statusCode).toBe(404)
  })

  it('管理员可以清理其他用户会话且不能清理自己的会话', async () => {
    const { app } = await createTestApp()
    const selfResponse = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${ADMIN_USER.id}/sessions`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${USER_B.id}/sessions`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const userResponse = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: 'gip_session=token-b' },
    })
    const adminResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(selfResponse.statusCode).toBe(400)
    expect(revokeResponse.statusCode).toBe(200)
    expect(userResponse.statusCode).toBe(401)
    expect(adminResponse.statusCode).toBe(200)
  })

  it('管理员操作会写入审计日志并可查询', async () => {
    const { app } = await createTestApp()
    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_A.id}`,
      headers: { cookie: 'gip_session=token-admin' },
      payload: { disabled: true },
    })
    const logsResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(updateResponse.statusCode).toBe(200)
    expect(logsResponse.statusCode).toBe(200)
    expect(logsResponse.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'user.update', actorEmail: ADMIN_USER.email, targetEmail: USER_A.email }),
    ]))
  })

  it('管理员可以查看用户详情和系统快照', async () => {
    const { app } = await createTestApp()
    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${USER_A.id}`,
      headers: { cookie: 'gip_session=token-admin' },
    })
    const systemResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(detailResponse.statusCode).toBe(200)
    expect(detailResponse.json()).toMatchObject({
      user: { id: USER_A.id, email: USER_A.email },
    })
    expect(detailResponse.json().recentTasks.length).toBeGreaterThan(0)
	    expect(detailResponse.json().generationAudits[0]).toMatchObject({
	      user: { id: USER_A.id, email: USER_A.email },
	      task: { id: 'task-owned' },
	      agentContext: { title: '温州风景 Agent', roundIndex: 1 },
	    })
    expect(systemResponse.statusCode).toBe(200)
    expect(systemResponse.json()).toMatchObject({
      database: { userCount: 3, taskCount: 2, imageCount: 2 },
      storage: { objectCount: 5 },
    })
  })

  it('管理员可以保存平台配置且不会向前端泄露 API Key', async () => {
    const { app } = await createTestApp()
    const payload = {
      api: {
        managed: true,
        allowUserProfiles: false,
        settings: {
          ...DEFAULT_SETTINGS,
          profiles: [{
            ...DEFAULT_SETTINGS.profiles[0],
            apiKey: 'platform-secret-key',
            model: 'gpt-image-platform',
          }],
          activeProfileId: DEFAULT_SETTINGS.profiles[0].id,
        },
      },
      agent: {
        lockSettings: true,
        maxToolRounds: 7,
        webSearchEnabled: true,
      },
    }
    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/admin/platform-settings',
      headers: { cookie: 'gip_session=token-admin' },
      payload,
    })
    const publicResponse = await app.inject({
      method: 'GET',
      url: '/api/platform/settings',
    })
    const savedPlatformSettings = saveResponse.json() as PlatformSettings
    const clearKeyResponse = await app.inject({
      method: 'PUT',
      url: '/api/admin/platform-settings',
      headers: { cookie: 'gip_session=token-admin' },
      payload: {
        ...savedPlatformSettings,
        api: {
          ...savedPlatformSettings.api,
          settings: {
            ...savedPlatformSettings.api.settings,
            profiles: [{
              ...savedPlatformSettings.api.settings.profiles[0],
              hasStoredApiKey: false,
              apiKey: '',
            }],
          },
        },
      },
    })
    const logsResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { cookie: 'gip_session=token-admin' },
    })
    await app.close()

    expect(saveResponse.statusCode).toBe(200)
    expect(saveResponse.json()).toMatchObject({
      api: {
        managed: true,
        allowUserProfiles: false,
        settings: {
          profiles: [expect.objectContaining({
            apiKey: '',
            hasStoredApiKey: true,
            model: 'gpt-image-platform',
          })],
        },
      },
      agent: {
        lockSettings: true,
        maxToolRounds: 7,
        webSearchEnabled: true,
      },
    })
    expect(publicResponse.statusCode).toBe(200)
    expect(JSON.stringify(publicResponse.json())).not.toContain('platform-secret-key')
    expect(publicResponse.json().api.settings.profiles[0]).toMatchObject({ apiKey: '', hasStoredApiKey: true })
    expect(clearKeyResponse.statusCode).toBe(200)
    expect(clearKeyResponse.json().api.settings.profiles[0].hasStoredApiKey).toBeUndefined()
    expect(logsResponse.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'platform.update', actorEmail: ADMIN_USER.email }),
    ]))
  })

  it('管理员测试平台配置时会沿用已保存的 API Key', async () => {
    const { app } = await createTestApp()
    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/admin/platform-settings',
      headers: { cookie: 'gip_session=token-admin' },
      payload: {
        api: {
          managed: true,
          allowUserProfiles: false,
          settings: {
            ...DEFAULT_SETTINGS,
            profiles: [{
              ...DEFAULT_SETTINGS.profiles[0],
              apiKey: 'platform-secret-key',
              baseUrl: 'not a url',
              model: 'gpt-image-platform',
            }],
            activeProfileId: DEFAULT_SETTINGS.profiles[0].id,
          },
        },
        agent: {
          lockSettings: true,
          maxToolRounds: 7,
          webSearchEnabled: true,
        },
      },
    })
    const savedPlatformSettings = saveResponse.json() as PlatformSettings
    const testResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/platform-settings/test',
      headers: { cookie: 'gip_session=token-admin' },
      payload: savedPlatformSettings,
    })
    await app.close()

    expect(saveResponse.statusCode).toBe(200)
    expect(savedPlatformSettings.api.settings.profiles[0]).toMatchObject({
      apiKey: '',
      hasStoredApiKey: true,
    })
    expect(testResponse.statusCode).toBe(200)
    expect(testResponse.json()).toMatchObject({
      ok: false,
      profile: {
        hasApiKey: true,
        model: 'gpt-image-platform',
      },
      checks: [expect.objectContaining({
        id: 'config',
        status: 'error',
        detail: 'API URL 格式无效',
      })],
    })
    expect(JSON.stringify(testResponse.json())).not.toContain('platform-secret-key')
  })

  it('管理员可以批量禁用用户并清理孤立对象', async () => {
    const { app, users, objects } = await createTestApp()
    const batchResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/users/batch',
      headers: { cookie: 'gip_session=token-admin' },
      payload: { ids: [USER_A.id, USER_B.id], action: 'disable' },
    })
    const scanResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/maintenance/orphans',
      headers: { cookie: 'gip_session=token-admin' },
      payload: { delete: true },
    })
    await app.close()

    expect(batchResponse.statusCode).toBe(200)
    expect(users.get(USER_A.id)?.disabled_at).toBe(NOW_ISO)
    expect(users.get(USER_B.id)?.disabled_at).toBe(NOW_ISO)
    expect(scanResponse.statusCode).toBe(200)
    expect(scanResponse.json()).toMatchObject({ orphanCount: 1, deleted: true })
    expect(objects.has('users/orphan/library/images/orphan.png')).toBe(false)
  })

  it('用户配额会阻止继续创建任务', async () => {
    const { app, users } = await createTestApp()
    const user = users.get(USER_A.id)
    if (user) user.task_quota_count = 1
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-over-quota',
      headers: { cookie: 'gip_session=token-a' },
      payload: {
        id: 'task-over-quota',
        prompt: 'over quota',
        params: DEFAULT_PARAMS,
        inputImageIds: [],
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: 10,
        finishedAt: null,
        elapsed: null,
      } satisfies TaskRecord,
    })
    await app.close()

    expect(response.statusCode).toBe(400)
    expect(response.json().message || response.json().error).toContain('任务数量配额')
  })
})
