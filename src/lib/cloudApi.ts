import type { AgentConversation, AppMode, AppSettings, FavoriteCollection, InputImage, MaskDraft, PlatformSettings, TaskParams, TaskRecord } from '../types'
import type { AgentApiResult, AgentApiResultImage, BatchImageCallResult } from './agentApi'

export interface CloudUser {
  id: string
  email: string
  isAdmin?: boolean
}

export interface CloudAdminOverview {
  userCount: number
  disabledUserCount: number
  pendingRegistrationCount?: number
  taskCount: number
  runningTaskCount: number
  imageCount: number
  storageBytes: number
}

export interface CloudAdminUser {
  id: string
  email: string
  isAdmin: boolean
  disabledAt: string | null
  registrationStatus?: 'approved' | 'pending' | 'rejected'
  registrationRequestedAt?: string | null
  registrationReviewedAt?: string | null
  registrationReviewedBy?: string | null
  createdAt: string
  updatedAt: string
  storageQuotaBytes: number | null
  taskQuotaCount: number | null
  latestSessionAt: string | null
  taskCount: number
  runningTaskCount: number
  imageCount: number
  storageBytes: number
  conversationCount: number
  sessionCount: number
}

export interface CloudAdminAuditLog {
  id: string
  action: string
  details: Record<string, unknown>
  ip: string | null
  userAgent: string | null
  createdAt: string
  actorEmail: string | null
  targetEmail: string | null
}

export interface CloudAdminSystemSnapshot {
  database: {
    userCount: number
    taskCount: number
    imageCount: number
    auditLogCount: number
  }
  storage: {
    bucket: string
    objectCount: number
  }
}

export interface CloudAdminUserDetail {
  user: CloudAdminUser
  recentTasks: Array<{ task: TaskRecord; updatedAt: string }>
  recentImages: Array<{ id: string; source: string; byteSize: number; createdAt: string; updatedAt: string }>
  recentLogs: CloudAdminAuditLog[]
  generationAudits: CloudAdminGenerationAudit[]
}

export interface CloudAdminGenerationAuditImage {
  id: string
  role: 'input' | 'mask' | 'output' | 'partial' | 'original'
  source: string
  byteSize: number
  width: number | null
  height: number | null
  createdAt: string | null
  updatedAt: string | null
  missing: boolean
  hasThumbnail: boolean
  imageUrl: string
  thumbnailUrl: string
}

export interface CloudAdminGenerationAudit {
  user: {
    id: string
    email: string
  }
  task: TaskRecord
  updatedAt: string
  agentContext?: {
    conversationId: string | null
    title: string | null
    roundId: string | null
    roundIndex: number | null
    roundStatus: string | null
    toolCallId: string | null
    batchCallId: string | null
    toolAction: string | null
  } | null
  images: CloudAdminGenerationAuditImage[]
}

export interface CloudAdminOrphanScan {
  orphanCount: number
  orphanKeys: string[]
  deleted: boolean
}

export type CloudPlatformSettings = PlatformSettings

export interface CloudPlatformTestCheck {
  id: string
  label: string
  status: 'success' | 'warning' | 'error' | 'skipped'
  detail: string
  elapsedMs?: number
}

export interface CloudPlatformTestResult {
  ok: boolean
  testedAt: string
  profile: {
    id: string
    name: string
    provider: string
    baseUrl: string
    model: string
    apiMode: string
    hasApiKey: boolean
  }
  checks: CloudPlatformTestCheck[]
}

export interface CloudSettingsSnapshot {
  settings: AppSettings
  params: TaskParams
  promptStylePresetId?: string
  activeAgentConversationId: string | null
  appMode: AppMode
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  favoriteCollections?: FavoriteCollection[]
  defaultFavoriteCollectionId?: string | null
  prompt?: string
  inputImages?: InputImage[]
  maskDraft?: MaskDraft | null
  galleryInputDraft?: {
    prompt: string
    inputImages: InputImage[]
    maskDraft: MaskDraft | null
    maskEditorImageId: string | null
    updatedAt?: number
  } | null
  agentInputDrafts?: Record<string, {
    prompt: string
    inputImages: InputImage[]
    maskDraft: MaskDraft | null
    maskEditorImageId: string | null
    updatedAt?: number
  }>
}

export interface CloudImageRecord {
  id: string
  source: 'upload' | 'generated' | 'mask'
  width?: number
  height?: number
  url?: string
}

export type CloudTaskEvent =
  | { type: 'task'; task: TaskRecord }
  | { type: 'partial'; taskId: string; image: string; requestIndex?: number }
  | { type: 'done'; task: TaskRecord }
  | { type: 'error'; task: TaskRecord }

type CloudAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'output_items'; outputItems: AgentApiResult['outputItems'] }
  | { type: 'image_tool_started'; event: { toolCallId: string; outputIndex?: number } }
  | { type: 'image_partial_image'; event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number } }
  | { type: 'image_tool_completed'; image: AgentApiResultImage }
  | { type: 'batch_image_started' }
  | { type: 'batch_partial_image'; event: { image: string; partialImageIndex?: number } }
  | { type: 'batch_image_completed'; image: AgentApiResultImage }
  | { type: 'done'; result: AgentApiResult | BatchImageCallResult }
  | { type: 'error'; error: string }

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  let message = `HTTP ${response.status}`
  try {
    const payload = await response.json() as { error?: string; message?: string }
    message = payload.error || payload.message || message
  } catch {
    try {
      message = await response.text()
    } catch {
      /* ignore */
    }
  }
  throw new Error(message)
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined
  const method = init?.method?.toUpperCase() ?? 'GET'
  return fetch(path, {
    ...init,
    ...(method === 'GET' || method === 'HEAD' ? { cache: 'no-store' as const } : {}),
    credentials: 'include',
    headers: {
      ...(hasBody && !(init?.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  }).then(readJson<T>)
}

async function postEventStream<T>(
  path: string,
  body: unknown,
  onEvent: (event: CloudAgentEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) return readJson<T>(response)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: T | undefined

  const processBlock = async (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data) return
    const event = JSON.parse(data) as CloudAgentEvent
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'done') {
      result = event.result as T
      return
    }
    await onEvent(event)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let separator = buffer.search(/\r?\n\r?\n/)
    while (separator >= 0) {
      const block = buffer.slice(0, separator)
      const match = buffer.match(/\r?\n\r?\n/)
      buffer = buffer.slice(separator + (match?.[0].length ?? 2))
      await processBlock(block)
      separator = buffer.search(/\r?\n\r?\n/)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) await processBlock(buffer)
  if (result === undefined) throw new Error('云端 Agent 响应未完成')
  return result
}

export async function getCurrentUser(): Promise<CloudUser | null> {
  const data = await request<{ user: CloudUser | null }>('/api/auth/me')
  return data.user
}

export async function loginCloud(email: string, password: string): Promise<CloudUser> {
  const data = await request<{ user: CloudUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  return data.user
}

export async function registerCloud(input: { email: string; password: string }): Promise<{ status: 'approved' | 'pending' }> {
  return request<{ status: 'approved' | 'pending' }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function logoutCloud(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' })
}

export async function changeCloudPassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  await request('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getPlatformSettings(): Promise<CloudPlatformSettings | null> {
  try {
    return await request<CloudPlatformSettings>('/api/platform/settings')
  } catch {
    return null
  }
}

export async function getCloudSettings(): Promise<CloudSettingsSnapshot | null> {
  return request<CloudSettingsSnapshot | null>('/api/settings')
}

export async function saveCloudSettings(snapshot: CloudSettingsSnapshot): Promise<CloudSettingsSnapshot> {
  return request<CloudSettingsSnapshot>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(snapshot),
  })
}

export async function uploadCloudImage(
  image: InputImage & { width?: number; height?: number },
  source: 'upload' | 'generated' | 'mask',
  taskId?: string | null,
): Promise<CloudImageRecord> {
  return request<CloudImageRecord>('/api/images', {
    method: 'POST',
    body: JSON.stringify({
      id: image.id,
      dataUrl: image.dataUrl,
      source,
      taskId,
      width: image.width,
      height: image.height,
    }),
  })
}

export async function uploadCloudImageThumbnail(
  id: string,
  thumbnail: { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number },
): Promise<void> {
  await request(`/api/images/${encodeURIComponent(id)}/thumbnail`, {
    method: 'POST',
    body: JSON.stringify({
      dataUrl: thumbnail.dataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    }),
  })
}

export async function deleteCloudImage(id: string): Promise<void> {
  await request(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function getCloudImageDataUrl(id: string): Promise<string | undefined> {
  const response = await fetch(`/api/images/${encodeURIComponent(id)}/data`, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (response.status === 404 || response.status === 401) return undefined
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export async function getCloudImageThumbnail(id: string): Promise<{ dataUrl: string; width?: number; height?: number; thumbnailVersion?: number } | undefined> {
  const response = await fetch(`/api/images/${encodeURIComponent(id)}/thumbnail/data`, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (response.status === 404 || response.status === 401) return undefined
  if (!response.ok) throw new Error(`缩略图读取失败：HTTP ${response.status}`)
  const width = Number(response.headers.get('X-Image-Width') || '')
  const height = Number(response.headers.get('X-Image-Height') || '')
  const thumbnailVersion = Number(response.headers.get('X-Thumbnail-Version') || '')
  const blob = await response.blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('缩略图读取失败'))
    reader.readAsDataURL(blob)
  })
  return {
    dataUrl,
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
    thumbnailVersion: Number.isFinite(thumbnailVersion) ? thumbnailVersion : undefined,
  }
}

export async function getCloudTasks(): Promise<TaskRecord[]> {
  const data = await request<{ tasks: TaskRecord[] }>('/api/tasks')
  return data.tasks
}

export async function createCloudTask(task: TaskRecord): Promise<TaskRecord> {
  const data = await request<{ task: TaskRecord }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  })
  return data.task
}

export async function patchCloudTask(task: TaskRecord): Promise<TaskRecord> {
  const data = await request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(task),
  })
  return data.task
}

export async function deleteCloudTask(id: string): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function clearCloudData(options: { clearConfig?: boolean; clearTasks?: boolean }): Promise<void> {
  await request('/api/data/clear', {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function getCloudAdminOverview(): Promise<CloudAdminOverview> {
  return request<CloudAdminOverview>('/api/admin/overview')
}

export async function getCloudAdminSystem(): Promise<CloudAdminSystemSnapshot> {
  return request<CloudAdminSystemSnapshot>('/api/admin/system')
}

export async function getCloudAdminAuditLogs(limit = 80): Promise<CloudAdminAuditLog[]> {
  const data = await request<{ logs: CloudAdminAuditLog[] }>(`/api/admin/audit-logs?limit=${encodeURIComponent(String(limit))}`)
  return data.logs
}

export async function getCloudAdminGenerationAudits(input: { userId?: string; agentConversationId?: string; limit?: number } = {}): Promise<CloudAdminGenerationAudit[]> {
  const searchParams = new URLSearchParams()
  if (input.userId) searchParams.set('userId', input.userId)
  if (input.agentConversationId) searchParams.set('agentConversationId', input.agentConversationId)
  if (input.limit) searchParams.set('limit', String(input.limit))
  const suffix = searchParams.toString()
  const data = await request<{ audits: CloudAdminGenerationAudit[] }>(`/api/admin/generation-audits${suffix ? `?${suffix}` : ''}`)
  return data.audits
}

export async function regenerateCloudAdminGenerationTask(input: { userId: string; taskId: string }): Promise<CloudAdminGenerationAudit> {
  const data = await request<{ audit: CloudAdminGenerationAudit }>(
    `/api/admin/users/${encodeURIComponent(input.userId)}/tasks/${encodeURIComponent(input.taskId)}/regenerate`,
    { method: 'POST' },
  )
  return data.audit
}

export async function getCloudAdminPlatformSettings(): Promise<CloudPlatformSettings> {
  return request<CloudPlatformSettings>('/api/admin/platform-settings')
}

export async function updateCloudAdminPlatformSettings(settings: CloudPlatformSettings): Promise<CloudPlatformSettings> {
  return request<CloudPlatformSettings>('/api/admin/platform-settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

export async function testCloudAdminPlatformSettings(settings: CloudPlatformSettings): Promise<CloudPlatformTestResult> {
  return request<CloudPlatformTestResult>('/api/admin/platform-settings/test', {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export async function getCloudAdminUsers(): Promise<CloudAdminUser[]> {
  const data = await request<{ users: CloudAdminUser[] }>('/api/admin/users')
  return data.users
}

export async function getCloudAdminUserDetail(id: string): Promise<CloudAdminUserDetail> {
  return request<CloudAdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`)
}

export async function batchCloudAdminUsers(input: { ids: string[]; action: 'disable' | 'enable' | 'clearData' }): Promise<void> {
  await request('/api/admin/users/batch', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function createCloudAdminUser(input: { email: string; password: string; isAdmin?: boolean; storageQuotaBytes?: number | null; taskQuotaCount?: number | null }): Promise<CloudAdminUser> {
  const data = await request<{ user: CloudAdminUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.user
}

export async function updateCloudAdminUser(id: string, patch: { password?: string; isAdmin?: boolean; disabled?: boolean; storageQuotaBytes?: number | null; taskQuotaCount?: number | null }): Promise<CloudAdminUser> {
  const data = await request<{ user: CloudAdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.user
}

export async function reviewCloudAdminRegistration(id: string, action: 'approve' | 'reject'): Promise<CloudAdminUser> {
  const data = await request<{ user: CloudAdminUser }>(`/api/admin/users/${encodeURIComponent(id)}/registration`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
  return data.user
}

export async function clearCloudAdminUserData(id: string): Promise<void> {
  await request(`/api/admin/users/${encodeURIComponent(id)}/data`, { method: 'DELETE' })
}

export async function revokeCloudAdminUserSessions(id: string): Promise<void> {
  await request(`/api/admin/users/${encodeURIComponent(id)}/sessions`, { method: 'DELETE' })
}

export async function deleteCloudAdminUser(id: string): Promise<void> {
  await request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function scanCloudAdminOrphans(deleteObjects = false): Promise<CloudAdminOrphanScan> {
  return request<CloudAdminOrphanScan>('/api/admin/maintenance/orphans', {
    method: 'POST',
    body: JSON.stringify({ delete: deleteObjects }),
  })
}

export function subscribeCloudTask(
  taskId: string,
  onEvent: (event: CloudTaskEvent) => void,
  onError: (error: Error) => void,
) {
  const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`, { withCredentials: true })
  let closed = false
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as CloudTaskEvent)
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
  source.onerror = () => {
    if (closed) return
    closed = true
    source.close()
    onError(new Error('云端任务事件连接中断'))
  }
  return () => {
    closed = true
    source.close()
  }
}

export async function getCloudAgentConversations(): Promise<AgentConversation[]> {
  const data = await request<{ conversations: AgentConversation[] }>('/api/agent/conversations')
  return data.conversations
}

export async function saveCloudAgentConversations(conversations: AgentConversation[]): Promise<void> {
  await request('/api/agent/conversations', {
    method: 'PUT',
    body: JSON.stringify({ conversations }),
  })
}

export async function callCloudAgentConversationTitleApi(opts: {
  prompt: string
  inputImageIds: string[]
}): Promise<string> {
  const data = await request<{ title: string }>('/api/agent/title', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
  return data.title
}

export async function callCloudAgentResponsesApi(opts: {
  params: TaskParams
  input: unknown
  maskImageId?: string | null
  maskDataUrl?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onOutputItems?: (outputItems: AgentApiResult['outputItems']) => void
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<AgentApiResult> {
  return postEventStream<AgentApiResult>('/api/agent/responses/stream', {
    params: opts.params,
    input: opts.input,
    maskImageId: opts.maskImageId,
    maskDataUrl: opts.maskDataUrl,
  }, async (event) => {
    if (event.type === 'text_delta') opts.onTextDelta?.(event.delta)
    if (event.type === 'output_items') opts.onOutputItems?.(event.outputItems)
    if (event.type === 'image_tool_started') await opts.onImageToolStarted?.(event.event)
    if (event.type === 'image_partial_image') await opts.onImagePartialImage?.(event.event)
    if (event.type === 'image_tool_completed') await opts.onImageToolCompleted?.(event.image)
  }, opts.signal)
}

export async function callCloudBatchImageSingle(opts: {
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  referenceIds?: string[]
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  return postEventStream<BatchImageCallResult>('/api/agent/batch-image/stream', {
    params: opts.params,
    batchItemId: opts.batchItemId,
    prompt: opts.prompt,
    referenceImageDataUrls: opts.referenceImageDataUrls,
    referenceIds: opts.referenceIds,
  }, async (event) => {
    if (event.type === 'batch_image_started') await opts.onImageToolStarted?.()
    if (event.type === 'batch_partial_image') await opts.onPartialImage?.(event.event)
    if (event.type === 'batch_image_completed') await opts.onImageToolCompleted?.(event.image)
  }, opts.signal)
}
