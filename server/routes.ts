import type { FastifyInstance, FastifyReply } from 'fastify'
import type { S3Client } from '@aws-sdk/client-s3'
import net from 'node:net'
import type { AgentConversation, AgentMessage, AgentRound, ApiProfile, AppSettings, PlatformSettings, ResponsesApiResponse, ResponsesOutputItem, TaskRecord, TaskParams } from '../src/types'
import { DEFAULT_PARAMS } from '../src/types'
import { getActiveApiProfile, getAgentImageApiProfile, getAgentTextApiProfile, normalizeSettings, resolveApiProfileModel } from '../src/lib/apiProfiles'
import { applyPlatformSettingsToAppSettings, getPlatformManagedTaskParams, normalizePlatformSettings, sanitizePlatformSettingsForClient } from '../src/lib/platformSettings'
import { callImageApi } from '../src/lib/api'
import { normalizeParamsForSettings } from '../src/lib/paramCompatibility'
import { replaceImageMentionsForApi } from '../src/lib/promptImageMentions'
import { applyPromptStylePreset, normalizePromptStylePresetId } from '../src/lib/promptStyles'
import {
  collectAgentRoundOutputImageSlots,
  getAgentCurrentReferenceId,
  getAgentGeneratedImageReferenceId,
  replaceAgentPromptImageReferencesForApi,
} from '../src/lib/agentImageReferences'
import {
  callAgentConversationTitleApi,
  callAgentResponsesApi,
  callBatchImageSingle,
  type AgentApiResult,
  type AgentApiResultImage,
  type BatchImageCallResult,
} from '../src/lib/agentApi'
import type { Db } from './db'
import type { ServerConfig } from './config'
import { hashPassword, requireAuth, type AuthUser } from './auth'
import { decryptText, encryptText } from './crypto'
import { bufferToDataUrl, parseImageDataUrl, resolveImageStorageId } from './imageData'
import { createSignedImageUrl, deleteObjects, getObjectBuffer, listObjectKeys, putObject } from './storage'
import { createTransparentOutputMeta } from '../src/lib/transparentImage'
import { removeKeyedBackgroundFromDataUrl } from './transparentImage'

type TaskEvent =
  | { type: 'task'; task: TaskRecord }
  | { type: 'partial'; taskId: string; image: string; requestIndex?: number }
  | { type: 'done'; task: TaskRecord }
  | { type: 'error'; task: TaskRecord }

const taskSubscribers = new Map<string, Set<FastifyReply>>()
const runningCloudTaskIds = new Set<string>()
const PLATFORM_SETTINGS_KEY = 'platform'
const UPSTREAM_CONNECT_TIMEOUT_MS = 8_000
const PLATFORM_TEST_TIMEOUT_MS = 10_000
const PLATFORM_IMAGE_TEST_TIMEOUT_MS = 120_000

type SseEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'output_items'; outputItems: unknown[] }
  | { type: 'image_tool_started'; event: { toolCallId: string; outputIndex?: number } }
  | { type: 'image_partial_image'; event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number } }
  | { type: 'image_tool_completed'; image: AgentApiResultImage }
  | { type: 'image_tool_failed'; event: { toolCallId: string; error: string } }
  | { type: 'batch_image_started' }
  | { type: 'batch_partial_image'; event: { image: string; partialImageIndex?: number } }
  | { type: 'batch_image_completed'; image: AgentApiResultImage }
  | { type: 'done'; result: AgentApiResult | BatchImageCallResult }
  | { type: 'error'; error: string }

type AdminUserRow = {
  id: string
  email: string
  is_admin: boolean
  disabled_at: string | null
  registration_status: string
  registration_requested_at: string | null
  registration_reviewed_at: string | null
  registration_reviewed_by: string | null
  created_at: string
  updated_at: string
  storage_quota_bytes: string | number | null
  task_quota_count: string | number | null
  latest_session_at: string | null
  task_count: string | number
  running_task_count: string | number
  image_count: string | number
  storage_bytes: string | number
  conversation_count: string | number
  session_count: string | number
}

type AuditLogRow = {
  id: string
  action: string
  details: Record<string, unknown>
  ip: string | null
  user_agent: string | null
  created_at: string
  actor_email: string | null
  target_email: string | null
}

type AdminGenerationTaskRow = {
  user_id: string
  user_email: string
  record: TaskRecord
  updated_at: string
}

type AdminGenerationConversationRow = {
  user_id: string
  id: string
  conversation: AgentConversation
}

type AdminGenerationImageRow = {
  id: string
  source: string
  byte_size: string | number
  width: string | number | null
  height: string | number | null
  created_at: string
  updated_at: string
  has_thumbnail: boolean
}

type PlatformTestStatus = 'success' | 'warning' | 'error' | 'skipped'

type PlatformTestCheck = {
  id: string
  label: string
  status: PlatformTestStatus
  detail: string
  elapsedMs?: number
}

type PlatformTestResult = {
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
  checks: PlatformTestCheck[]
}

type RegistrationStatus = 'approved' | 'pending' | 'rejected'

function taskEventKey(userId: string, taskId: string) {
  return `${userId}:${taskId}`
}

function publishTaskEvent(userId: string, taskId: string, event: TaskEvent) {
  const subscribers = taskSubscribers.get(taskEventKey(userId, taskId))
  if (!subscribers?.size) return
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const reply of subscribers) {
    reply.raw.write(payload)
  }
}

function getErrorCauseMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('cause' in error)) return null
  const cause = (error as { cause?: unknown }).cause
  if (!cause) return null
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'object' && 'code' in cause) return String((cause as { code?: unknown }).code)
  return String(cause)
}

function formatGenerationError(error: unknown, profile?: ApiProfile | null) {
  const message = error instanceof Error ? error.message : String(error)
  const causeMessage = getErrorCauseMessage(error)
  const diagnostic = [message, causeMessage].filter(Boolean).join(' / ')
  const isNetworkError = /fetch failed|operation was aborted|aborted|timeout|timed out|超时|无法连接|连接.*失败|ECONN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/i.test(diagnostic)
  if (!isNetworkError) return message

  const target = profile?.baseUrl ? `（${profile.baseUrl}）` : ''
  return [
    `连接上游 API 失败${target}：${message}`,
    causeMessage ? `底层原因：${causeMessage}` : '',
    '请检查后端 Docker 容器是否能访问外网；如果本机使用代理/TUN，请开启代理的局域网访问，并在 .env 中配置 APP_HTTP_PROXY/APP_HTTPS_PROXY 后重启 Docker。',
  ].filter(Boolean).join('。')
}

function normalizeProxyUrl(raw: string | undefined) {
  const value = raw?.trim()
  if (!value) return null
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)
    ? value
    : `http://${value}`
  try {
    const url = new URL(withProtocol)
    if (!url.hostname) return null
    return url
  } catch {
    return null
  }
}

function getProxyForProtocol(protocol: string) {
  const env = process.env
  if (protocol === 'http:') {
    return normalizeProxyUrl(env.HTTP_PROXY ?? env.http_proxy) ??
      normalizeProxyUrl(env.ALL_PROXY ?? env.all_proxy)
  }
  if (protocol === 'https:') {
    return normalizeProxyUrl(env.HTTPS_PROXY ?? env.https_proxy) ??
      normalizeProxyUrl(env.HTTP_PROXY ?? env.http_proxy) ??
      normalizeProxyUrl(env.ALL_PROXY ?? env.all_proxy)
  }
  return normalizeProxyUrl(env.ALL_PROXY ?? env.all_proxy)
}

async function assertTcpReachable(host: string, port: number, timeoutMessage: string, errorMessage: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: UPSTREAM_CONNECT_TIMEOUT_MS }, () => {
      socket.destroy()
      resolve()
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error(timeoutMessage))
    })
    socket.on('error', (error) => {
      socket.destroy()
      reject(new Error(`${errorMessage}（${error.message}）`))
    })
  })
}

async function assertUpstreamTcpReachable(profile: ApiProfile) {
  let url: URL
  try {
    url = new URL(profile.baseUrl)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  const proxy = getProxyForProtocol(url.protocol)
  if (proxy) {
    const proxyPort = proxy.port ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80
    await assertTcpReachable(
      proxy.hostname,
      proxyPort,
      `后端容器连接代理服务器超时：${proxy.hostname}:${proxyPort}`,
      `后端容器连接代理服务器失败：${proxy.hostname}:${proxyPort}`,
    )
    return
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  await assertTcpReachable(
    url.hostname,
    port,
    `后端容器连接上游 API 超时：${url.hostname}:${port}`,
    `后端容器连接上游 API 失败：${url.hostname}:${port}`,
  )
}

function createPlatformTestCheck(
  id: string,
  label: string,
  status: PlatformTestStatus,
  detail: string,
  elapsedMs?: number,
): PlatformTestCheck {
  return {
    id,
    label,
    status,
    detail,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  }
}

async function measureCheck(run: () => Promise<string>) {
  const startedAt = Date.now()
  const detail = await run()
  return { detail, elapsedMs: Date.now() - startedAt }
}

function buildOpenAiCompatibleEndpoint(baseUrl: string, endpoint: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const path = endpoint.replace(/^\/+/, '')
  if (!trimmed) throw new Error('缺少 API URL')
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  const normalizedPath = url.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith('/v1')) {
    url.pathname = `${normalizedPath}/${path}`
  } else {
    url.pathname = `${normalizedPath}/v1/${path}`.replace(/\/+/g, '/')
  }
  return url.toString()
}

function getStringFromRecord(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getResponsesFailureMessage(event: unknown): string | null {
  if (!isRecord(event)) return null
  const error = event.error
  if (isRecord(error)) {
    const message = getStringFromRecord(error, 'message')
    if (message) return message
  } else if (typeof error === 'string' && error.trim()) {
    return error
  }

  const response = event.response
  if (isRecord(response) && isRecord(response.error)) {
    const message = getStringFromRecord(response.error, 'message')
    if (message) return message
  }

  const type = getStringFromRecord(event, 'type')
  if (type?.endsWith('.failed')) return getStringFromRecord(event, 'message') ?? 'Responses 流式请求失败'
  return null
}

function outputContainsImageResult(output: unknown): boolean {
  if (!Array.isArray(output)) return false
  return output.some((item) => isRecord(item) && item.type === 'image_generation_call' && Boolean(item.result))
}

async function parsePlatformImageTestStream(response: Response) {
  if (!response.body) throw new Error('真实出图测试未返回可读取的流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let hasImageResult = false
  let sawImageTool = false
  let eventCount = 0

  const processBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('真实出图测试返回了无法解析的流式 JSON 事件')
    }
    eventCount += 1

    const failureMessage = getResponsesFailureMessage(event)
    if (failureMessage) throw new Error(failureMessage)

    const output = isRecord(event)
      ? (isRecord(event.response) && Array.isArray(event.response.output) ? event.response.output : isRecord(event.item) ? [event.item] : null)
      : null
    if (outputContainsImageResult(output)) hasImageResult = true
    if (Array.isArray(output) && output.some((item) => isRecord(item) && item.type === 'image_generation_call')) {
      sawImageTool = true
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let separatorIndex = buffer.search(/\r?\n\r?\n/)
    while (separatorIndex >= 0) {
      const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
      processBlock(buffer.slice(0, separatorIndex))
      buffer = buffer.slice(separatorIndex + separator.length)
      separatorIndex = buffer.search(/\r?\n\r?\n/)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) processBlock(buffer)

  return { hasImageResult, sawImageTool, eventCount }
}

async function assertPlatformImageGenerationWorks(profile: ApiProfile) {
  const endpoint = buildOpenAiCompatibleEndpoint(profile.baseUrl, 'responses')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      model: profile.model,
      input: 'Generate a tiny simple red square icon on a white background.',
      tools: [{
        type: 'image_generation',
        size: '1024x1024',
        quality: 'low',
        output_format: 'jpeg',
        moderation: 'low',
        ...(profile.streamImages ? { partial_images: Math.max(1, profile.streamPartialImages ?? 1) } : {}),
      }],
      tool_choice: 'required',
      ...(profile.streamImages ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(PLATFORM_IMAGE_TEST_TIMEOUT_MS),
  })

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`真实出图测试失败（HTTP ${response.status}）：${errorText.slice(0, 500) || response.statusText}`)
  }

  if (contentType.includes('text/event-stream')) {
    const result = await parsePlatformImageTestStream(response)
    if (!result.hasImageResult) {
      throw new Error(result.sawImageTool
        ? '真实出图测试调用了 image_generation，但上游未返回最终图片'
        : '真实出图测试未触发 image_generation 工具')
    }
    return `真实出图测试通过：流式响应返回最终图片（${result.eventCount} 个事件）`
  }

  const payload = await response.json().catch(() => null) as ResponsesApiResponse | null
  if (!outputContainsImageResult(payload?.output)) {
    const text = JSON.stringify(payload ?? {}).slice(0, 500)
    throw new Error(`真实出图测试未返回图片数据：${text || '空响应'}`)
  }
  return '真实出图测试通过：Responses 返回最终图片'
}

function getImagesApiResultItems(payload: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 2) return []
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []

  const items: Array<Record<string, unknown>> = []
  if (Array.isArray(payload.data)) items.push(...payload.data.filter(isRecord))
  if (isRecord(payload.data)) items.push(payload.data)
  if (typeof payload.b64_json === 'string' || typeof payload.url === 'string') items.push(payload)

  for (const key of ['result', 'image', 'response', 'output']) {
    const nested = payload[key]
    if (nested !== undefined) items.push(...getImagesApiResultItems(nested, depth + 1))
  }
  return items
}

function hasImagesApiResult(payload: unknown): boolean {
  return getImagesApiResultItems(payload).some((item) =>
    (typeof item.b64_json === 'string' && item.b64_json.trim().length > 0) ||
    (typeof item.url === 'string' && item.url.trim().length > 0),
  )
}

function hasFinalImagesApiResult(payload: unknown): boolean {
  if (!hasImagesApiResult(payload)) return false
  if (!isRecord(payload)) return true
  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : ''
  const object = typeof payload.object === 'string' ? payload.object.toLowerCase() : ''
  return !type.includes('partial') && !object.includes('partial')
}

async function assertPlatformImagesApiGenerationWorks(profile: ApiProfile) {
  const endpoint = buildOpenAiCompatibleEndpoint(profile.baseUrl, 'images/generations')
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt: 'Generate a tiny simple red square icon on a white background.',
    output_format: 'jpeg',
    moderation: 'low',
    n: 1,
  }
  if (!profile.codexCli) {
    body.size = '1024x1024'
    body.quality = 'low'
  }
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'
  if (profile.streamImages) {
    body.stream = true
    body.partial_images = Math.max(1, profile.streamPartialImages ?? 1)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PLATFORM_IMAGE_TEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`真实出图测试失败（HTTP ${response.status}）：${errorText.slice(0, 500) || response.statusText}`)
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('text/event-stream')) {
    const streamText = await response.text()
    const events = streamText
      .split(/\r?\n\r?\n/)
      .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()))
      .filter((data) => data && data !== '[DONE]')
      .flatMap((data) => {
        try {
          return [JSON.parse(data) as unknown]
        } catch {
          return []
        }
      })
    if (!events.some(hasFinalImagesApiResult)) throw new Error('真实出图测试的 Images API 流式响应未返回最终图片')
    return `真实出图测试通过：Images API 流式响应返回图片（${events.length} 个事件）`
  }

  const payload = await response.json().catch(() => null) as unknown
  if (!hasImagesApiResult(payload)) {
    const text = JSON.stringify(payload ?? {}).slice(0, 500)
    throw new Error(`真实出图测试未返回图片数据：${text || '空响应'}`)
  }
  return '真实出图测试通过：Images API 返回最终图片'
}

function getProfileForPlatformTest(saved: PlatformSettings, draftInput: unknown) {
  const draft = normalizePlatformSettings(draftInput ?? saved)
  const savedSettings = normalizeSettings(saved.api.settings)
  const savedProfiles = new Map(savedSettings.profiles.map((profile) => [profile.id, profile]))
  const draftSettings = normalizeSettings(draft.api.settings)
  const profiles = draftSettings.profiles.map((profile) => {
    const savedProfile = savedProfiles.get(profile.id)
    const apiKey = profile.apiKey.trim() || savedProfile?.apiKey.trim() || ''
    return {
      ...profile,
      apiKey,
      hasStoredApiKey: Boolean(apiKey || profile.hasStoredApiKey || savedProfile?.hasStoredApiKey),
    }
  })
  const settings = normalizeSettings({ ...draftSettings, profiles })
  return {
    settings,
    profile: getActiveApiProfile(settings),
  }
}

async function testPlatformSettings(db: Db, config: ServerConfig, draftInput: unknown): Promise<PlatformTestResult> {
  const saved = await loadPlatformSettings(db, config, { includeApiKeys: true })
  const { settings, profile } = getProfileForPlatformTest(saved, draftInput)
  const checks: PlatformTestCheck[] = []

  const profileSummary = {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiMode: profile.apiMode,
    hasApiKey: Boolean(profile.apiKey.trim()),
  }

  let upstreamUrl: URL | null = null
  try {
    upstreamUrl = new URL(profile.baseUrl)
    checks.push(createPlatformTestCheck(
      'config',
      '配置检查',
      profile.apiKey.trim() ? 'success' : 'error',
      profile.apiKey.trim()
        ? `当前测试 ${profile.provider} / ${profile.model}`
        : '缺少 API Key：请输入新 Key，或先保存一次让后端沿用已保存 Key。',
    ))
  } catch {
    checks.push(createPlatformTestCheck('config', '配置检查', 'error', 'API URL 格式无效'))
  }

  if (!upstreamUrl || !profile.apiKey.trim()) {
    return { ok: false, testedAt: new Date().toISOString(), profile: profileSummary, checks }
  }

  const proxy = getProxyForProtocol(upstreamUrl.protocol)
  if (proxy) {
    const proxyPort = proxy.port ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80
    try {
      const measured = await measureCheck(async () => {
        await assertTcpReachable(
          proxy.hostname,
          proxyPort,
          `后端容器连接代理服务器超时：${proxy.hostname}:${proxyPort}`,
          `后端容器连接代理服务器失败：${proxy.hostname}:${proxyPort}`,
        )
        return `代理服务器可访问：${proxy.hostname}:${proxyPort}`
      })
      checks.push(createPlatformTestCheck('proxy', '代理连通性', 'success', measured.detail, measured.elapsedMs))
    } catch (error) {
      checks.push(createPlatformTestCheck(
        'proxy',
        '代理连通性',
        'error',
        error instanceof Error ? error.message : String(error),
      ))
      return { ok: false, testedAt: new Date().toISOString(), profile: profileSummary, checks }
    }
    checks.push(createPlatformTestCheck('upstream-tcp', '上游 TCP', 'skipped', '已配置代理，上游 TCP 由代理服务器访问。'))
  } else {
    const port = upstreamUrl.port ? Number(upstreamUrl.port) : upstreamUrl.protocol === 'https:' ? 443 : 80
    try {
      const measured = await measureCheck(async () => {
        await assertTcpReachable(
          upstreamUrl.hostname,
          port,
          `后端容器连接上游 API 超时：${upstreamUrl.hostname}:${port}`,
          `后端容器连接上游 API 失败：${upstreamUrl.hostname}:${port}`,
        )
        return `上游地址可访问：${upstreamUrl.hostname}:${port}`
      })
      checks.push(createPlatformTestCheck('upstream-tcp', '上游 TCP', 'success', measured.detail, measured.elapsedMs))
    } catch (error) {
      checks.push(createPlatformTestCheck(
        'upstream-tcp',
        '上游 TCP',
        'error',
        error instanceof Error ? error.message : String(error),
      ))
      return { ok: false, testedAt: new Date().toISOString(), profile: profileSummary, checks }
    }
  }

  if (settings.codexCli || profile.codexCli || profile.provider !== 'openai') {
    checks.push(createPlatformTestCheck('auth', '接口认证', 'skipped', '当前服务商暂只做网络连通性测试。'))
    return { ok: !checks.some((check) => check.status === 'error'), testedAt: new Date().toISOString(), profile: profileSummary, checks }
  }

  try {
    const endpoint = buildOpenAiCompatibleEndpoint(profile.baseUrl, 'models')
    const measured = await measureCheck(async () => {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(PLATFORM_TEST_TIMEOUT_MS),
      })
      const text = await response.text().catch(() => '')
      if (response.ok) return `/models 请求成功，API Key 可用（HTTP ${response.status}）`
      if (response.status === 401 || response.status === 403) {
        throw new Error(`API Key 认证失败（HTTP ${response.status}）：${text.slice(0, 300) || response.statusText}`)
      }
      if (response.status === 404 || response.status === 405) {
        return `上游可达，但不支持 /models 测试端点（HTTP ${response.status}）。生成接口仍可能可用。`
      }
      throw new Error(`测试端点返回 HTTP ${response.status}：${text.slice(0, 300) || response.statusText}`)
    })
    const isWarning = /不支持 \/models/.test(measured.detail)
    checks.push(createPlatformTestCheck('auth', '接口认证', isWarning ? 'warning' : 'success', measured.detail, measured.elapsedMs))
  } catch (error) {
    checks.push(createPlatformTestCheck('auth', '接口认证', 'error', formatGenerationError(error, profile)))
  }

  if (profile.apiMode === 'responses') {
    try {
      const measured = await measureCheck(() => assertPlatformImageGenerationWorks(profile))
      checks.push(createPlatformTestCheck('image-generation', '真实出图', 'success', measured.detail, measured.elapsedMs))
    } catch (error) {
      checks.push(createPlatformTestCheck('image-generation', '真实出图', 'error', formatGenerationError(error, profile)))
    }
  } else if (profile.provider === 'openai') {
    try {
      const measured = await measureCheck(() => assertPlatformImagesApiGenerationWorks(profile))
      checks.push(createPlatformTestCheck('image-generation', '真实出图', 'success', measured.detail, measured.elapsedMs))
    } catch (error) {
      checks.push(createPlatformTestCheck('image-generation', '真实出图', 'error', formatGenerationError(error, profile)))
    }
  } else {
    checks.push(createPlatformTestCheck('image-generation', '真实出图', 'skipped', '当前服务商未配置内置 Images API 测试，暂只检查网络连通性。'))
  }

  return {
    ok: !checks.some((check) => check.status === 'error'),
    testedAt: new Date().toISOString(),
    profile: profileSummary,
    checks,
  }
}

function writeSse(reply: FastifyReply, event: SseEvent) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
}

function openSse(reply: FastifyReply) {
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
}

async function requireAdmin(db: Db, request: Parameters<typeof requireAuth>[1], reply: FastifyReply): Promise<AuthUser | null> {
  const user = await requireAuth(db, request, reply)
  if (!user) return null
  if (!user.isAdmin) {
    void reply.code(403).send({ error: '需要管理员权限' })
    return null
  }
  return user
}

function toNumber(value: string | number | null | undefined): number {
  const numberValue = Number(value ?? 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function toOptionalNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getRequestIp(request: Parameters<typeof requireAuth>[1]) {
  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0]?.trim() ?? null
  return request.ip || request.socket.remoteAddress || null
}

async function writeAuditLog(
  db: Db,
  request: Parameters<typeof requireAuth>[1],
  input: {
    actor?: AuthUser | null
    targetUserId?: string | null
    action: string
    details?: Record<string, unknown>
  },
) {
  await db.query(
    `
      INSERT INTO audit_logs (actor_user_id, target_user_id, action, details, ip, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      input.actor?.id ?? null,
      input.targetUserId ?? null,
      input.action,
      input.details ?? {},
      getRequestIp(request),
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    ],
  )
}

async function loadAgentGenerationProfiles(db: Db, config: ServerConfig, userId: string) {
  const settings = await loadGenerationSettings(db, config, userId)
  if (!settings) throw new Error('缺少云端 API 配置')
  const textProfile = getAgentTextApiProfile(settings)
  const imageProfile = getAgentImageApiProfile(settings)
  if (!textProfile || textProfile.provider !== 'openai' || textProfile.apiMode !== 'responses') {
    throw new Error('Agent 文本模型必须使用支持 Responses API 的 OpenAI 配置')
  }
  if (!imageProfile) throw new Error('缺少 Agent 图像模型 API 配置')
  if (!textProfile.apiKey.trim()) throw new Error('缺少 Agent 文本模型 API Key，请在设置中保存 API Key')
  if (!imageProfile.apiKey.trim()) throw new Error('缺少 Agent 图像模型 API Key，请在设置中保存 API Key')
  return { settings, textProfile, imageProfile }
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile) {
  return normalizeSettings({
    ...settings,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: settings.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

async function loadManagedGenerationParams(db: Db, config: ServerConfig): Promise<TaskParams | null> {
  return getPlatformManagedTaskParams(await loadPlatformSettings(db, config))
}

function normalizeGenerationParams(params: TaskParams, settings: AppSettings, hasInputImages: boolean) {
  return normalizeParamsForSettings(params, settings, { hasInputImages })
}

async function applyManagedTaskParams(
  db: Db,
  config: ServerConfig,
  task: TaskRecord,
  settings: AppSettings,
): Promise<TaskRecord> {
  const managedParams = await loadManagedGenerationParams(db, config)
  if (!managedParams) return task
  const normalizedParams = normalizeGenerationParams(managedParams, settings, task.inputImageIds.length > 0)
  const taskParams = normalizedParams.output_format === 'png' && normalizedParams.transparent_output
    ? { ...normalizedParams, output_format: 'png' as const, output_compression: null, transparent_output: true }
    : { ...normalizedParams, transparent_output: false }
  const styledPrompt = applyPromptStylePreset(task.prompt.trim(), task.promptStylePresetId)
  const transparentMeta = taskParams.transparent_output
    ? createTransparentOutputMeta(styledPrompt)
    : null

  return {
    ...task,
    // 服务端覆盖任务参数，防止旧前端或手写请求绕过后台统一策略。
    params: taskParams,
    promptStylePresetId: normalizePromptStylePresetId(task.promptStylePresetId),
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
  }
}

function closeTaskSubscribers(userId: string, taskId: string) {
  const key = taskEventKey(userId, taskId)
  const subscribers = taskSubscribers.get(key)
  if (!subscribers?.size) return
  for (const reply of subscribers) reply.raw.end()
  taskSubscribers.delete(key)
}

function sanitizeSettingsForClient(settings: AppSettings): AppSettings {
  const normalized = normalizeSettings(settings)
  return {
    ...normalized,
    apiKey: '',
    profiles: normalized.profiles.map((profile) => ({ ...profile, apiKey: '' })),
  }
}

function getEncryptedPlatformApiKeys(value: unknown): Record<string, string> {
  const record = isRecord(value) ? value : {}
  const apiRecord = isRecord(record.api) ? record.api : {}
  const encryptedApiKeys = isRecord(apiRecord.encryptedApiKeys) ? apiRecord.encryptedApiKeys : {}
  return Object.fromEntries(
    Object.entries(encryptedApiKeys).filter((entry): entry is [string, string] =>
      typeof entry[0] === 'string' && typeof entry[1] === 'string' && Boolean(entry[1]),
    ),
  )
}

function tryDecryptText(payload: string | null | undefined, secret: string): string {
  try {
    return decryptText(payload, secret)
  } catch {
    return ''
  }
}

async function loadPlatformSettings(
  db: Db,
  config: ServerConfig,
  options: { includeApiKeys?: boolean } = {},
): Promise<PlatformSettings> {
  const result = await db.query<{ value: unknown; updated_at: string }>(
    'SELECT value, updated_at FROM platform_settings WHERE key = $1',
    [PLATFORM_SETTINGS_KEY],
  )
  const row = result.rows[0]
  const encryptedApiKeys = getEncryptedPlatformApiKeys(row?.value)
  const platform = normalizePlatformSettings(row?.value)
  const settings = normalizeSettings(platform.api.settings)
  const profiles = settings.profiles.map((profile) => ({
    ...profile,
    apiKey: options.includeApiKeys ? tryDecryptText(encryptedApiKeys[profile.id], config.keyEncryptionSecret) : '',
    hasStoredApiKey: encryptedApiKeys[profile.id] ? true : profile.hasStoredApiKey,
  }))
  return {
    ...platform,
    updatedAt: row?.updated_at ?? platform.updatedAt ?? null,
    api: {
      ...platform.api,
      settings: normalizeSettings({ ...settings, profiles }),
    },
  }
}

async function upsertPlatformSettings(db: Db, config: ServerConfig, body: unknown) {
  const existing = await db.query<{ value: unknown }>(
    'SELECT value FROM platform_settings WHERE key = $1',
    [PLATFORM_SETTINGS_KEY],
  )
  const previousEncryptedApiKeys = getEncryptedPlatformApiKeys(existing.rows[0]?.value)
  const platform = normalizePlatformSettings(body)
  const settings = normalizeSettings(platform.api.settings)
  const encryptedApiKeys: Record<string, string> = {}
  const sanitizedProfiles = settings.profiles.map((profile) => {
    const apiKey = profile.apiKey.trim()
    if (apiKey) encryptedApiKeys[profile.id] = encryptText(apiKey, config.keyEncryptionSecret)
    else if (profile.hasStoredApiKey && previousEncryptedApiKeys[profile.id]) encryptedApiKeys[profile.id] = previousEncryptedApiKeys[profile.id]
    return {
      ...profile,
      apiKey: '',
      hasStoredApiKey: encryptedApiKeys[profile.id] ? true : undefined,
    }
  })
  const value = {
    ...platform,
    updatedAt: undefined,
    api: {
      ...platform.api,
      settings: normalizeSettings({ ...settings, profiles: sanitizedProfiles }),
      encryptedApiKeys,
    },
  }
  const result = await db.query<{ value: unknown; updated_at: string }>(
    `
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      RETURNING value, updated_at
    `,
    [PLATFORM_SETTINGS_KEY, value],
  )
  const saved = normalizePlatformSettings(result.rows[0]?.value)
  return sanitizePlatformSettingsForClient({
    ...saved,
    updatedAt: result.rows[0]?.updated_at ?? null,
  })
}

async function saveApiProfiles(db: Db, config: ServerConfig, userId: string, settings: AppSettings) {
  const normalized = normalizeSettings(settings)
  for (const profile of normalized.profiles) {
    const apiKey = profile.apiKey.trim()
    const encryptedApiKey = apiKey ? encryptText(apiKey, config.keyEncryptionSecret) : null
    const sanitizedProfile = { ...profile, apiKey: '' }
    await db.query(
      `
        INSERT INTO api_profiles (id, user_id, profile, encrypted_api_key, updated_at)
        VALUES ($1, $2, $3, COALESCE($4, (
          SELECT encrypted_api_key FROM api_profiles WHERE user_id = $2 AND id = $1
        )), now())
        ON CONFLICT (user_id, id)
        DO UPDATE SET
          profile = EXCLUDED.profile,
          encrypted_api_key = COALESCE(EXCLUDED.encrypted_api_key, api_profiles.encrypted_api_key),
          updated_at = now()
      `,
      [profile.id, userId, sanitizedProfile, encryptedApiKey],
    )
  }

  const profileIds = normalized.profiles.map((profile) => profile.id)
  await db.query(
    'DELETE FROM api_profiles WHERE user_id = $1 AND NOT (id = ANY($2::text[]))',
    [userId, profileIds],
  )
}

async function loadSettings(db: Db, userId: string) {
  const result = await db.query<{
    settings: AppSettings
    params: TaskParams
    workspace: Record<string, unknown>
  }>(
    'SELECT settings, params, workspace FROM user_settings WHERE user_id = $1',
    [userId],
  )
  const saved = result.rows[0] ?? null
  if (!saved) return null
  const keyRows = await db.query<{ id: string }>(
    'SELECT id FROM api_profiles WHERE user_id = $1 AND encrypted_api_key IS NOT NULL',
    [userId],
  )
  const keyedProfileIds = new Set(keyRows.rows.map((row) => row.id))
  const settings = normalizeSettings(saved.settings)
  return {
    ...saved,
    settings: {
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        hasStoredApiKey: keyedProfileIds.has(profile.id) || undefined,
      })),
    },
  }
}

async function loadGenerationSettings(db: Db, config: ServerConfig, userId: string): Promise<AppSettings | null> {
  const platform = await loadPlatformSettings(db, config, { includeApiKeys: true })
  const saved = await loadSettings(db, userId)
  if (platform.api.managed) {
    // 平台接管 API 时仍保留用户选择的 Agent 文本/图像配置 ID，实际配置和 Key 只取后台数据。
    return applyPlatformSettingsToAppSettings(normalizeSettings(saved?.settings ?? {}), platform)
  }

  if (!saved) return null
  const profiles = await db.query<{ id: string; encrypted_api_key: string | null }>(
    'SELECT id, encrypted_api_key FROM api_profiles WHERE user_id = $1',
    [userId],
  )
  const apiKeys = new Map(profiles.rows.map((profile) => [
    profile.id,
    tryDecryptText(profile.encrypted_api_key, config.keyEncryptionSecret),
  ]))
  const settings = normalizeSettings(saved.settings)
  return applyPlatformSettingsToAppSettings(normalizeSettings({
    ...settings,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      apiKey: apiKeys.get(profile.id) ?? profile.apiKey ?? '',
    })),
  }), platform)
}

async function upsertSettings(
  db: Db,
  config: ServerConfig,
  userId: string,
  body: {
    settings: AppSettings
    params: TaskParams
    promptStylePresetId?: string
    imageSourceUrls?: unknown
    activeAgentConversationId?: string | null
    appMode?: string
    agentSidebarCollapsed?: boolean
    agentAssetTab?: string
    agentAssetPanelCollapsed?: boolean
    prompt?: string
	    inputImages?: unknown[]
	    maskDraft?: unknown
	    galleryInputDraft?: unknown
	    agentInputDrafts?: unknown
	    favoriteCollections?: unknown
	    defaultFavoriteCollectionId?: unknown
	  },
	) {
  const settings = sanitizeSettingsForClient(body.settings)
  const workspace = {
    activeAgentConversationId: body.activeAgentConversationId ?? null,
    appMode: body.appMode === 'agent' ? 'agent' : 'gallery',
    agentSidebarCollapsed: Boolean(body.agentSidebarCollapsed),
    agentAssetTab: body.agentAssetTab === 'references' ? 'references' : 'outputs',
    agentAssetPanelCollapsed: Boolean(body.agentAssetPanelCollapsed),
    promptStylePresetId: normalizePromptStylePresetId(body.promptStylePresetId),
    imageSourceUrls: body.imageSourceUrls && typeof body.imageSourceUrls === 'object' && !Array.isArray(body.imageSourceUrls)
      ? Object.fromEntries(Object.entries(body.imageSourceUrls).filter((entry) => typeof entry[1] === 'string' && /^https?:\/\//i.test(entry[1])))
      : {},
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    inputImages: Array.isArray(body.inputImages) ? body.inputImages : [],
	    maskDraft: body.maskDraft ?? null,
	    galleryInputDraft: body.galleryInputDraft ?? null,
	    agentInputDrafts: body.agentInputDrafts && typeof body.agentInputDrafts === 'object' ? body.agentInputDrafts : {},
	    favoriteCollections: Array.isArray(body.favoriteCollections) ? body.favoriteCollections : [],
	    defaultFavoriteCollectionId: typeof body.defaultFavoriteCollectionId === 'string' ? body.defaultFavoriteCollectionId : null,
	  }
  await saveApiProfiles(db, config, userId, body.settings)
  await db.query(
    `
      INSERT INTO user_settings (user_id, settings, params, workspace, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id)
      DO UPDATE SET settings = EXCLUDED.settings, params = EXCLUDED.params, workspace = EXCLUDED.workspace, updated_at = now()
    `,
    [userId, settings, body.params ?? DEFAULT_PARAMS, workspace],
  )
  return { settings, params: body.params ?? DEFAULT_PARAMS, ...workspace }
}

async function readImageDataUrl(db: Db, s3: S3Client, config: ServerConfig, userId: string, imageId: string) {
  const result = await db.query<{ storage_key: string; mime_type: string }>(
    'SELECT storage_key, mime_type FROM images WHERE user_id = $1 AND id = $2',
    [userId, imageId],
  )
  const image = result.rows[0]
  if (!image) throw new Error('图片不存在')
  const buffer = await getObjectBuffer(s3, config, image.storage_key)
  return bufferToDataUrl(buffer, image.mime_type)
}

async function upsertImage(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  user: AuthUser,
  input: {
    id?: string
    dataUrl: string
    source?: string
    taskId?: string | null
    width?: number
    height?: number
  },
) {
  const parsed = parseImageDataUrl(input.dataUrl)
  const imageId = resolveImageStorageId(parsed.id, input.id)
  const source = input.source === 'mask' || input.source === 'generated' ? input.source : 'upload'
  const taskSegment = input.taskId ? `tasks/${input.taskId}` : 'library'
  const storageKey = `users/${user.id}/${taskSegment}/images/${imageId}.${parsed.extension}`
  await assertUserLimits(db, user.id, { extraBytes: parsed.buffer.length })
  await putObject(s3, config, {
    key: storageKey,
    mimeType: parsed.mimeType,
    buffer: parsed.buffer,
  })
  await db.query(
    `
      INSERT INTO images (id, user_id, task_id, source, storage_key, mime_type, byte_size, width, height, upload_status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'done', now())
      ON CONFLICT (user_id, id)
      DO UPDATE SET
        task_id = COALESCE(EXCLUDED.task_id, images.task_id),
        source = EXCLUDED.source,
        storage_key = EXCLUDED.storage_key,
        mime_type = EXCLUDED.mime_type,
        byte_size = EXCLUDED.byte_size,
        width = COALESCE(EXCLUDED.width, images.width),
        height = COALESCE(EXCLUDED.height, images.height),
        upload_status = 'done',
        updated_at = now()
    `,
    [
      imageId,
      user.id,
      input.taskId ?? null,
      source,
      storageKey,
      parsed.mimeType,
      parsed.buffer.length,
      input.width ?? null,
      input.height ?? null,
    ],
  )
  return {
    id: imageId,
    source,
    width: input.width,
    height: input.height,
    url: await createSignedImageUrl(s3, config, storageKey),
  }
}

async function upsertImageThumbnail(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  user: AuthUser,
  imageId: string,
  input: {
    dataUrl: string
    width?: number
    height?: number
    thumbnailVersion?: number
  },
) {
  const existing = await db.query<{ task_id: string | null }>(
    'SELECT task_id FROM images WHERE user_id = $1 AND id = $2',
    [user.id, imageId],
  )
  if (!existing.rows[0]) throw new Error('图片不存在')
  const parsed = parseImageDataUrl(input.dataUrl)
  const taskSegment = existing.rows[0].task_id ? `tasks/${existing.rows[0].task_id}` : 'library'
  const storageKey = `users/${user.id}/${taskSegment}/thumbnails/${imageId}.${parsed.extension}`
  await putObject(s3, config, {
    key: storageKey,
    mimeType: parsed.mimeType,
    buffer: parsed.buffer,
  })
  await db.query(
    `
      INSERT INTO image_thumbnails (image_id, user_id, storage_key, mime_type, width, height, thumbnail_version, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (user_id, image_id)
      DO UPDATE SET
        storage_key = EXCLUDED.storage_key,
        mime_type = EXCLUDED.mime_type,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        thumbnail_version = EXCLUDED.thumbnail_version,
        updated_at = now()
    `,
    [imageId, user.id, storageKey, parsed.mimeType, input.width ?? null, input.height ?? null, input.thumbnailVersion ?? null],
  )
  return { id: imageId }
}

async function deleteImageForUser(db: Db, s3: S3Client, config: ServerConfig, userId: string, imageId: string) {
  const objects = await db.query<{ storage_key: string }>(
    `
      SELECT storage_key FROM images WHERE user_id = $1 AND id = $2
      UNION ALL
      SELECT storage_key FROM image_thumbnails WHERE user_id = $1 AND image_id = $2
    `,
    [userId, imageId],
  )
  await db.query('DELETE FROM image_thumbnails WHERE user_id = $1 AND image_id = $2', [userId, imageId])
  await db.query('DELETE FROM images WHERE user_id = $1 AND id = $2', [userId, imageId])
  await deleteObjects(s3, config, objects.rows.map((row) => row.storage_key))
}

function createEmptyWorkspace() {
  return {
    activeAgentConversationId: null,
    appMode: 'gallery',
    agentSidebarCollapsed: false,
    agentAssetTab: 'outputs',
    agentAssetPanelCollapsed: false,
    prompt: '',
    inputImages: [],
    maskDraft: null,
    galleryInputDraft: null,
    agentInputDrafts: {},
  }
}

async function clearUserDataForUser(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  userId: string,
  options: { clearConfig?: boolean; clearTasks?: boolean },
) {
  const clearConfig = Boolean(options.clearConfig)
  const clearTasks = Boolean(options.clearTasks)

  if (clearTasks) {
    const taskRows = await db.query<{ id: string }>('SELECT id FROM tasks WHERE user_id = $1', [userId])
    for (const task of taskRows.rows) closeTaskSubscribers(userId, task.id)

    const objects = await db.query<{ storage_key: string }>(
      `
        SELECT storage_key FROM images WHERE user_id = $1
        UNION ALL
        SELECT storage_key FROM image_thumbnails WHERE user_id = $1
      `,
      [userId],
    )

    await db.query('DELETE FROM image_thumbnails WHERE user_id = $1', [userId])
    await db.query('DELETE FROM images WHERE user_id = $1', [userId])
    await db.query('DELETE FROM tasks WHERE user_id = $1', [userId])
    await db.query('DELETE FROM agent_conversations WHERE user_id = $1', [userId])
    if (!clearConfig) {
      await db.query(
        'UPDATE user_settings SET workspace = $2, updated_at = now() WHERE user_id = $1',
        [userId, createEmptyWorkspace()],
      )
    }
    await deleteObjects(s3, config, objects.rows.map((row) => row.storage_key))
  }

  if (clearConfig) {
    await db.query('DELETE FROM api_profiles WHERE user_id = $1', [userId])
    await db.query('DELETE FROM user_settings WHERE user_id = $1', [userId])
  }
}

async function getAdminUserRows(db: Db): Promise<AdminUserRow[]> {
  const result = await db.query<AdminUserRow>(
    `
      SELECT
        users.id,
        users.email,
        users.is_admin,
        users.disabled_at,
        users.registration_status,
        users.registration_requested_at,
        users.registration_reviewed_at,
        users.registration_reviewed_by,
        users.created_at,
        users.updated_at,
        users.storage_quota_bytes,
        users.task_quota_count,
        session_stats.latest_session_at,
        COALESCE(task_stats.task_count, 0) AS task_count,
        COALESCE(task_stats.running_task_count, 0) AS running_task_count,
        COALESCE(image_stats.image_count, 0) AS image_count,
        COALESCE(image_stats.storage_bytes, 0) AS storage_bytes,
        COALESCE(conversation_stats.conversation_count, 0) AS conversation_count,
        COALESCE(session_stats.session_count, 0) AS session_count
      FROM users
      LEFT JOIN (
        SELECT
          user_id,
          COUNT(*) AS task_count,
          COUNT(*) FILTER (WHERE status = 'running') AS running_task_count
        FROM tasks
        GROUP BY user_id
      ) task_stats ON task_stats.user_id = users.id
      LEFT JOIN (
        SELECT
          user_id,
          COUNT(*) AS image_count,
          COALESCE(SUM(byte_size), 0) AS storage_bytes
        FROM images
        GROUP BY user_id
      ) image_stats ON image_stats.user_id = users.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS conversation_count
        FROM agent_conversations
        GROUP BY user_id
      ) conversation_stats ON conversation_stats.user_id = users.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS session_count, MAX(created_at) AS latest_session_at
        FROM sessions
        WHERE expires_at > now()
        GROUP BY user_id
      ) session_stats ON session_stats.user_id = users.id
      ORDER BY users.created_at DESC
    `,
  )
  return result.rows
}

function serializeAdminUser(row: AdminUserRow) {
  const registrationStatus = normalizeRegistrationStatus(row.registration_status)
  return {
    id: row.id,
    email: row.email,
    isAdmin: Boolean(row.is_admin),
    disabledAt: row.disabled_at,
    registrationStatus,
    registrationRequestedAt: row.registration_requested_at,
    registrationReviewedAt: row.registration_reviewed_at,
    registrationReviewedBy: row.registration_reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storageQuotaBytes: toOptionalNumber(row.storage_quota_bytes),
    taskQuotaCount: toOptionalNumber(row.task_quota_count),
    latestSessionAt: row.latest_session_at,
    taskCount: toNumber(row.task_count),
    runningTaskCount: toNumber(row.running_task_count),
    imageCount: toNumber(row.image_count),
    storageBytes: toNumber(row.storage_bytes),
    conversationCount: toNumber(row.conversation_count),
    sessionCount: toNumber(row.session_count),
  }
}

function normalizeRegistrationStatus(value: unknown): RegistrationStatus {
  return value === 'pending' || value === 'rejected' ? value : 'approved'
}

async function countEnabledAdmins(db: Db): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users WHERE is_admin = true AND disabled_at IS NULL',
  )
  return toNumber(result.rows[0]?.count)
}

function normalizeAdminEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeAdminPassword(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function normalizeNullableQuota(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createBadRequestError('配额必须是有效数字')
  }
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : null
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error != null && (error as { code?: string }).code === '23505'
}

function createBadRequestError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

async function adminUserExists(db: Db, userId: string) {
  const result = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId])
  return Boolean(result.rows[0])
}

function serializeAuditLog(row: AuditLogRow) {
  return {
    id: row.id,
    action: row.action,
    details: row.details ?? {},
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    actorEmail: row.actor_email,
    targetEmail: row.target_email,
  }
}

async function getAuditLogs(db: Db, limit: number) {
  const result = await db.query<AuditLogRow>(
    `
      SELECT
        audit_logs.id,
        audit_logs.action,
        audit_logs.details,
        audit_logs.ip,
        audit_logs.user_agent,
        audit_logs.created_at,
        actor.email AS actor_email,
        target.email AS target_email
      FROM audit_logs
      LEFT JOIN users actor ON actor.id = audit_logs.actor_user_id
      LEFT JOIN users target ON target.id = audit_logs.target_user_id
      ORDER BY audit_logs.created_at DESC
      LIMIT $1
    `,
    [limit],
  )
  return result.rows.map(serializeAuditLog)
}

function getTaskImageRefs(task: TaskRecord) {
  const refs: Array<{ id: string; role: 'input' | 'mask' | 'output' | 'partial' | 'original' }> = []
  for (const id of task.inputImageIds) refs.push({ id, role: 'input' })
  if (task.maskImageId) refs.push({ id: task.maskImageId, role: 'mask' })
  for (const id of task.outputImages) refs.push({ id, role: 'output' })
  for (const id of task.transparentOriginalImages ?? []) {
    if (id) refs.push({ id, role: 'original' })
  }
  for (const id of task.streamPartialImageIds ?? []) refs.push({ id, role: 'partial' })

  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.role}:${ref.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getAdminImageDataPath(userId: string, imageId: string, thumbnail = false) {
  const base = `/api/admin/users/${encodeURIComponent(userId)}/images/${encodeURIComponent(imageId)}`
  return thumbnail ? `${base}/thumbnail/data` : `${base}/data`
}

async function getAdminGenerationAuditImages(db: Db, userId: string, task: TaskRecord) {
  const refs = getTaskImageRefs(task)
  const ids = Array.from(new Set(refs.map((ref) => ref.id)))
  if (!ids.length) return []

  const result = await db.query<AdminGenerationImageRow>(
    `
      SELECT
        images.id,
        images.source,
        images.byte_size,
        images.width,
        images.height,
        images.created_at,
        images.updated_at,
        image_thumbnails.image_id IS NOT NULL AS has_thumbnail
      FROM images
      LEFT JOIN image_thumbnails
        ON image_thumbnails.user_id = images.user_id
       AND image_thumbnails.image_id = images.id
      WHERE images.user_id = $1 AND images.id = ANY($2::text[])
    `,
    [userId, ids],
  )
  const imagesById = new Map(result.rows.map((row) => [row.id, row]))
  return refs.map((ref) => {
    const row = imagesById.get(ref.id)
    return {
      id: ref.id,
      role: ref.role,
      source: row?.source ?? 'missing',
      byteSize: toNumber(row?.byte_size),
      width: toOptionalNumber(row?.width),
      height: toOptionalNumber(row?.height),
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null,
      missing: !row,
      hasThumbnail: Boolean(row?.has_thumbnail),
      imageUrl: getAdminImageDataPath(userId, ref.id),
      thumbnailUrl: row?.has_thumbnail ? getAdminImageDataPath(userId, ref.id, true) : getAdminImageDataPath(userId, ref.id),
    }
  })
}

async function getAdminGenerationConversationMap(db: Db, rows: AdminGenerationTaskRow[]) {
  const conversationIds = Array.from(new Set(rows.map((row) => row.record.agentConversationId).filter((id): id is string => Boolean(id))))
  const userIds = Array.from(new Set(rows.filter((row) => row.record.agentConversationId).map((row) => row.user_id)))
  if (!conversationIds.length || !userIds.length) return new Map<string, AgentConversation>()

  const result = await db.query<AdminGenerationConversationRow>(
    `
      SELECT user_id, id, conversation
      FROM agent_conversations
      WHERE user_id = ANY($1::uuid[]) AND id = ANY($2::text[])
    `,
    [userIds, conversationIds],
  )
  return new Map(result.rows.map((row) => [`${row.user_id}:${row.id}`, row.conversation]))
}

function getAdminGenerationAgentContext(task: TaskRecord, conversation?: AgentConversation) {
  if (task.sourceMode !== 'agent' && !task.agentConversationId) return null

  const round = Array.isArray(conversation?.rounds)
    ? conversation.rounds.find((item) => item.id === task.agentRoundId)
    : null
  return {
    conversationId: task.agentConversationId ?? conversation?.id ?? null,
    title: conversation?.title ?? null,
    roundId: task.agentRoundId ?? null,
    roundIndex: typeof round?.index === 'number' ? round.index : null,
    roundStatus: round?.status ?? null,
    toolCallId: task.agentToolCallId ?? null,
    batchCallId: task.agentBatchCallId ?? null,
    toolAction: task.agentToolAction ?? null,
  }
}

async function getAdminGenerationAudits(db: Db, input: { userId?: string; agentConversationId?: string; limit?: number } = {}) {
  const maxLimit = input.agentConversationId ? 1000 : 200
  const limit = Math.min(maxLimit, Math.max(1, input.limit ?? 80))
  const params: unknown[] = []
  const whereParts: string[] = []
  if (input.userId) {
    params.push(input.userId)
    whereParts.push(`tasks.user_id = $${params.length}`)
  }
  if (input.agentConversationId) {
    params.push(input.agentConversationId)
    whereParts.push(`tasks.record->>'agentConversationId' = $${params.length}`)
  }
  params.push(limit)
  const limitParam = `$${params.length}`
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''

  const result = await db.query<AdminGenerationTaskRow>(
    `
      SELECT
        tasks.user_id,
        users.email AS user_email,
        tasks.record,
        tasks.updated_at
      FROM tasks
      INNER JOIN users ON users.id = tasks.user_id
      ${where}
      ORDER BY
        CASE
          WHEN tasks.record->>'createdAt' ~ '^[0-9]+$' THEN (tasks.record->>'createdAt')::bigint
          ELSE (EXTRACT(EPOCH FROM tasks.created_at) * 1000)::bigint
        END DESC,
        tasks.updated_at DESC
      LIMIT ${limitParam}
    `,
    params,
  )

  const conversationsByKey = await getAdminGenerationConversationMap(db, result.rows)
  return Promise.all(result.rows.map(async (row) => ({
    user: {
      id: row.user_id,
      email: row.user_email,
    },
    task: row.record,
    updatedAt: row.updated_at,
    agentContext: getAdminGenerationAgentContext(row.record, conversationsByKey.get(`${row.user_id}:${row.record.agentConversationId}`)),
    images: await getAdminGenerationAuditImages(db, row.user_id, row.record),
  })))
}

async function getAdminGenerationAuditByTask(db: Db, userId: string, taskId: string) {
  const result = await db.query<AdminGenerationTaskRow>(
    `
      SELECT
        tasks.user_id,
        users.email AS user_email,
        tasks.record,
        tasks.updated_at
      FROM tasks
      INNER JOIN users ON users.id = tasks.user_id
      WHERE tasks.user_id = $1 AND tasks.id = $2
    `,
    [userId, taskId],
  )
  const row = result.rows[0]
  if (!row) return null
  const conversationsByKey = await getAdminGenerationConversationMap(db, [row])
  return {
    user: {
      id: row.user_id,
      email: row.user_email,
    },
    task: row.record,
    updatedAt: row.updated_at,
    agentContext: getAdminGenerationAgentContext(row.record, conversationsByKey.get(`${row.user_id}:${row.record.agentConversationId}`)),
    images: await getAdminGenerationAuditImages(db, row.user_id, row.record),
  }
}

function getAdminAgentRoundPath(conversation: AgentConversation, roundId: string | null | undefined) {
  if (!roundId) return []
  const byId = new Map(conversation.rounds.map((round) => [round.id, round]))
  const path: AgentRound[] = []
  const seen = new Set<string>()
  let current = byId.get(roundId) ?? null

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentRoundId ? byId.get(current.parentRoundId) ?? null : null
  }

  return path
}

async function readImageDataUrlIfExists(db: Db, s3: S3Client, config: ServerConfig, userId: string, imageId: string) {
  try {
    return await readImageDataUrl(db, s3, config, userId, imageId)
  } catch {
    return null
  }
}

async function readAdminAgentImageDataUrls(db: Db, s3: S3Client, config: ServerConfig, userId: string, imageIds: string[]) {
  const dataUrls: string[] = []
  for (const imageId of imageIds) {
    const dataUrl = await readImageDataUrlIfExists(db, s3, config, userId, imageId)
    if (dataUrl) dataUrls.push(dataUrl)
  }
  return dataUrls
}

async function createAdminAgentUserInputItem(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  userId: string,
  conversation: AgentConversation,
  round: AgentRound,
  message: AgentMessage,
  tasks: TaskRecord[],
) {
  const imageDataUrls = await readAdminAgentImageDataUrls(db, s3, config, userId, round.inputImageIds)
  const rounds = getAdminAgentRoundPath(conversation, round.id)
  const text = replaceAgentPromptImageReferencesForApi(message.content, round, rounds, tasks)
  const referenceText = round.inputImageIds.length > 0
    ? `\n\n<available_refs>${round.inputImageIds.map((_, index) => `\n  <ref id="${getAgentCurrentReferenceId(round, index)}" />`).join('')}\n</available_refs>`
    : ''
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: `${text}${referenceText}` },
      ...imageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function truncateAgentReferencePrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 1200 ? `${normalized.slice(0, 1200)}...` : normalized
}

async function createAdminAgentGeneratedImagesInputItem(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  userId: string,
  round: AgentRound,
  tasks: TaskRecord[],
) {
  const contentParts: Array<{ type: string; text?: string; image_url?: string }> = []
  let imageIndex = 0
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      contentParts.push({ type: 'input_text', text: `<removed_ref id="${getAgentGeneratedImageReferenceId(round, imageIndex)}" />` })
      imageIndex += 1
      continue
    }
    for (const imageId of task.outputImages) {
      const dataUrl = await readImageDataUrlIfExists(db, s3, config, userId, imageId)
      if (dataUrl) contentParts.push({ type: 'input_image', image_url: dataUrl })
      const refId = getAgentGeneratedImageReferenceId(round, imageIndex)
      const prompt = truncateAgentReferencePrompt(task.prompt || '')
      const promptAttribute = prompt ? ` prompt="${escapeXmlAttribute(prompt)}"` : ''
      contentParts.push({ type: 'input_text', text: `<ref id="${refId}"${promptAttribute} />` })
      imageIndex += 1
    }
  }
  return contentParts.length > 0 ? { role: 'user', content: contentParts } : null
}

function parseResponseOutputFromPayload(rawResponsePayload?: string): ResponsesOutputItem[] | null {
  if (!rawResponsePayload) return null
  try {
    const payload = JSON.parse(rawResponsePayload) as ResponsesApiResponse
    return Array.isArray(payload.output) ? payload.output : null
  } catch {
    return null
  }
}

function sanitizeResponseOutputItemForInput(item: ResponsesOutputItem): unknown | null {
  if (item.type === 'web_search_call' || item.type === 'image_generation_call') return null
  if (item.type === 'message') {
    const content = (item.content ?? [])
      .map((part) => {
        if (typeof part.text !== 'string') return null
        if (part.type === 'output_text' || part.type === 'text') {
          return { type: 'output_text', text: part.text }
        }
        return null
      })
      .filter((part): part is { type: 'output_text'; text: string } => Boolean(part))

    return content.length > 0 ? { role: 'assistant', content } : null
  }
  return item
}

function sanitizeResponseOutputForInput(output: ResponsesOutputItem[]) {
  const items = output
    .map(sanitizeResponseOutputItemForInput)
    .filter((item): item is unknown => item != null)

  const functionCallIds = new Set<string>()
  const functionOutputCallIds = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)) continue
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (!callId) continue
    if (item.type === 'function_call') functionCallIds.add(callId)
    if (item.type === 'function_call_output') functionOutputCallIds.add(callId)
  }

  return items.filter((item) => {
    if (!isRecord(item)) return true
    const callId = typeof item.call_id === 'string' ? item.call_id : ''
    if (item.type === 'function_call') return callId && functionOutputCallIds.has(callId)
    if (item.type === 'function_call_output') return callId && functionCallIds.has(callId)
    return true
  })
}

function getAdminAgentRoundResponseOutput(round: AgentRound, tasks: TaskRecord[]) {
  if (round.responseOutput?.length) return round.responseOutput
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    const output = parseResponseOutputFromPayload(task?.rawResponsePayload)
    if (output?.length) return output
  }
  return null
}

function createAdminAgentAssistantFallbackItem(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }
}

async function buildAdminAgentRegenerationInput(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  userId: string,
  conversation: AgentConversation,
  currentRound: AgentRound,
  targetTask: TaskRecord,
  tasks: TaskRecord[],
) {
  const input: unknown[] = []
  const rounds = getAdminAgentRoundPath(conversation, currentRound.id)

  for (const round of rounds) {
    const userMessage = conversation.messages.find((message) => message.id === round.userMessageId)
    if (!userMessage) continue

    input.push(await createAdminAgentUserInputItem(db, s3, config, userId, conversation, round, userMessage, tasks))
    if (round.id === currentRound.id) continue

    const output = getAdminAgentRoundResponseOutput(round, tasks)
    const assistantMessage = round.assistantMessageId
      ? conversation.messages.find((message) => message.id === round.assistantMessageId)
      : null
    if (output?.length) {
      const sanitizedOutput = sanitizeResponseOutputForInput(output)
      input.push(...(sanitizedOutput.length > 0
        ? sanitizedOutput
        : [createAdminAgentAssistantFallbackItem(assistantMessage?.content || '图像已生成。')]))
    } else {
      input.push(createAdminAgentAssistantFallbackItem(assistantMessage?.content || '[No text response]'))
    }

    // 普通 Agent 轮次会把已生成图片作为独立 user 消息注入；后台重生成也必须镜像这一点，
    // 否则前序轮次有文字回复时，模型只能看到文字而看不到真正的参考图。
    if (round.outputTaskIds.length > 0) {
      const generatedImagesItem = await createAdminAgentGeneratedImagesInputItem(db, s3, config, userId, round, tasks)
      if (generatedImagesItem) input.push(generatedImagesItem)
    }
  }

  input.push({
    role: 'user',
    content: [{
      type: 'input_text',
      text: [
        '[System] 管理员正在原地重新生成一个已有 Agent 图片任务。',
        `目标任务 ID：${targetTask.id}`,
        '请使用上方完整对话上下文重新生成这一张图片，直接调用 image_generation。',
        '不要调用 generate_image_batch，不要调用 continue_generation，不要生成新的任务或额外图片。',
        targetTask.prompt ? `原图像提示词：${targetTask.prompt}` : `当前轮用户请求：${currentRound.prompt}`,
      ].filter(Boolean).join('\n'),
    }],
  })

  return input
}

function selectTaskApiProfile(settings: AppSettings, task: TaskRecord) {
  const normalized = normalizeSettings(settings)
  const byId = task.apiProfileId
    ? normalized.profiles.find((profile) => profile.id === task.apiProfileId)
    : null
  return byId ? resolveApiProfileModel(byId, task.apiModel) : getActiveApiProfile(normalized)
}

async function getAdminTargetUser(db: Db, userId: string): Promise<AuthUser | null> {
  const result = await db.query<{ id: string; email: string; is_admin: boolean }>(
    'SELECT id, email, is_admin FROM users WHERE id = $1',
    [userId],
  )
  const row = result.rows[0]
  return row ? { id: row.id, email: row.email, isAdmin: row.is_admin } : null
}

async function getAgentConversation(db: Db, userId: string, conversationId: string) {
  const result = await db.query<{ conversation: AgentConversation }>(
    'SELECT conversation FROM agent_conversations WHERE user_id = $1 AND id = $2',
    [userId, conversationId],
  )
  return result.rows[0]?.conversation ?? null
}

async function putAgentConversationRecord(db: Db, userId: string, conversation: AgentConversation) {
  await db.query(
    `
      INSERT INTO agent_conversations (id, user_id, conversation, updated_at)
      VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
      ON CONFLICT (user_id, id)
      DO UPDATE SET conversation = EXCLUDED.conversation, updated_at = EXCLUDED.updated_at
    `,
    [conversation.id, userId, conversation, conversation.updatedAt ?? Date.now()],
  )
}

function updateConversationForRegeneratedTask(
  conversation: AgentConversation,
  task: TaskRecord,
  result: AgentApiResult,
  now: number,
): AgentConversation {
  const roundId = task.agentRoundId
  if (!roundId) return conversation
  const round = conversation.rounds.find((item) => item.id === roundId)
  if (!round) return conversation

  const assistantMessageId = task.agentMessageId
    ?? round.assistantMessageId
    ?? conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant')?.id
    ?? `${task.id}-assistant`
  const assistantContent = result.text.trim() || '图像已生成。'
  const assistantMessage: AgentMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: assistantContent,
    roundId,
    outputTaskIds: [task.id],
    createdAt: now,
  }

  return {
    ...conversation,
    activeRoundId: roundId,
    updatedAt: now,
    rounds: conversation.rounds.map((item) => item.id === roundId
      ? {
          ...item,
          assistantMessageId,
          outputTaskIds: item.outputTaskIds.includes(task.id) ? item.outputTaskIds : [...item.outputTaskIds, task.id],
          responseId: result.responseId,
          responseOutput: result.outputItems,
          status: 'done' as const,
          error: null,
          finishedAt: now,
        }
      : item,
    ),
    messages: conversation.messages.some((message) => message.id === assistantMessageId)
      ? conversation.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
      : [...conversation.messages, assistantMessage],
  }
}

function updateConversationForRegenerationError(conversation: AgentConversation, task: TaskRecord, error: string, now: number): AgentConversation {
  const roundId = task.agentRoundId
  if (!roundId) return conversation
  const round = conversation.rounds.find((item) => item.id === roundId)
  if (!round) return conversation

  const assistantMessageId = task.agentMessageId
    ?? round.assistantMessageId
    ?? conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant')?.id
    ?? `${task.id}-assistant`
  const assistantMessage: AgentMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: `请求失败：${error}`,
    roundId,
    outputTaskIds: [task.id],
    createdAt: now,
  }

  return {
    ...conversation,
    activeRoundId: roundId,
    updatedAt: now,
    rounds: conversation.rounds.map((item) => item.id === roundId
      ? {
          ...item,
          assistantMessageId,
          outputTaskIds: item.outputTaskIds.includes(task.id) ? item.outputTaskIds : [...item.outputTaskIds, task.id],
          status: 'error' as const,
          error,
          finishedAt: now,
        }
      : item,
    ),
    messages: conversation.messages.some((message) => message.id === assistantMessageId)
      ? conversation.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
      : [...conversation.messages, assistantMessage],
  }
}

async function regenerateAdminAgentTask(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  admin: AuthUser,
  userId: string,
  taskId: string,
  request: Parameters<typeof writeAuditLog>[1],
) {
  const targetUser = await getAdminTargetUser(db, userId)
  if (!targetUser) throw createBadRequestError('用户不存在')
  const task = await getTask(db, userId, taskId)
  if (!task) throw createBadRequestError('任务不存在')
  if (task.status === 'running') throw createBadRequestError('任务正在运行中，请等待完成后再重试')
  if (task.sourceMode !== 'agent' || !task.agentConversationId || !task.agentRoundId) {
    throw createBadRequestError('仅支持重新生成 Agent 图片任务')
  }

  const conversation = await getAgentConversation(db, userId, task.agentConversationId)
  if (!conversation) throw createBadRequestError('找不到任务所属 Agent 对话')
  const round = conversation.rounds.find((item) => item.id === task.agentRoundId)
  if (!round) throw createBadRequestError('找不到任务所属 Agent 轮次')

  const settings = await loadGenerationSettings(db, config, userId)
  if (!settings) throw new Error('缺少云端 API 配置')
  const profile = selectTaskApiProfile(settings, task)
  if (profile.provider !== 'openai' || profile.apiMode !== 'responses') {
    throw createBadRequestError('仅支持 Responses API 的 Agent 任务重新生成')
  }
  if (!profile.apiKey.trim()) throw new Error('缺少云端 API Key，请在后台配置中保存 API Key')

  const allTasks = await db.query<{ record: TaskRecord }>(
    'SELECT record FROM tasks WHERE user_id = $1 ORDER BY created_at ASC',
    [userId],
  )
  const tasks = allTasks.rows.map((row) => row.record)
  const startedAt = Date.now()
  const runningTask = applyTaskPatch(task, {
    status: 'running',
    error: null,
    params: { ...task.params, transparent_output: false },
    transparentOutput: false,
    transparentPrompt: undefined,
    transparentOriginalImages: undefined,
    outputImages: [],
    streamPartialImageIds: [],
    rawImageUrls: [],
    rawResponsePayload: undefined,
    actualParams: undefined,
    actualParamsByImage: undefined,
    revisedPromptByImage: undefined,
    createdAt: startedAt,
    finishedAt: null,
    elapsed: null,
  })
  await putTaskRecord(db, userId, runningTask)
  publishTaskEvent(userId, taskId, { type: 'task', task: runningTask })

  let latestConversation = conversation
  try {
    const input = await buildAdminAgentRegenerationInput(db, s3, config, userId, conversation, round, runningTask, tasks)
    const maskImageId = runningTask.maskImageId ?? round.maskImageId
    const maskDataUrl = maskImageId ? await readImageDataUrl(db, s3, config, userId, maskImageId) : undefined
    const completedImages: AgentApiResultImage[] = []
    const result = await callAgentResponsesApi({
      settings,
      profile,
      params: { ...runningTask.params, n: 1, transparent_output: false },
      input,
      maskDataUrl,
      onImageToolCompleted: (image) => {
        completedImages.push(image)
      },
      onImagePartialImage: async (event) => {
        const partial = await upsertImage(db, s3, config, targetUser, {
          dataUrl: event.image,
          source: 'generated',
          taskId,
        })
        const latest = await getTask(db, userId, taskId)
        if (!latest || latest.status !== 'running') return
        const streamPartialImageIds = Array.from(new Set([...(latest.streamPartialImageIds ?? []), partial.id]))
        const next = applyTaskPatch(latest, { streamPartialImageIds })
        await putTaskRecord(db, userId, next)
        publishTaskEvent(userId, taskId, { type: 'partial', taskId, image: event.image, requestIndex: event.partialImageIndex })
      },
      imageOnly: true,
    })
    const images = [...completedImages, ...result.images]
      .filter((image, index, list) => list.findIndex((item) => item.dataUrl === image.dataUrl) === index)
    if (!images.length) throw new Error('接口未返回图片数据')

    const outputIds: string[] = []
    const actualParamsByImage: Record<string, Partial<TaskParams>> = {}
    const revisedPromptByImage: Record<string, string> = {}
    for (const image of images) {
      const saved = await upsertImage(db, s3, config, targetUser, {
        dataUrl: image.dataUrl,
        source: 'generated',
        taskId,
      })
      outputIds.push(saved.id)
      const actualParams = { ...(image.actualParams ?? {}), n: 1 }
      actualParamsByImage[saved.id] = actualParams
      if (image.revisedPrompt?.trim()) revisedPromptByImage[saved.id] = image.revisedPrompt
    }

    const now = Date.now()
    const latest = await getTask(db, userId, taskId)
    const doneTask = applyTaskPatch(latest ?? runningTask, {
      prompt: images[0]?.revisedPrompt ?? runningTask.prompt ?? round.prompt,
      outputImages: outputIds,
      actualParams: { ...(images[0]?.actualParams ?? {}), n: outputIds.length },
      actualParamsByImage,
      revisedPromptByImage: Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
      rawResponsePayload: result.rawResponsePayload,
      status: 'done',
      error: null,
      finishedAt: now,
      elapsed: now - startedAt,
      agentToolCallId: images[0]?.toolCallId ?? runningTask.agentToolCallId,
      agentToolAction: images[0]?.action ?? runningTask.agentToolAction,
    })
    await putTaskRecord(db, userId, doneTask)
    latestConversation = updateConversationForRegeneratedTask(conversation, doneTask, result, now)
    await putAgentConversationRecord(db, userId, latestConversation)
    publishTaskEvent(userId, taskId, { type: 'done', task: doneTask })
    await writeAuditLog(db, request, {
      actor: admin,
      targetUserId: userId,
      action: 'generation.regenerate',
      details: { taskId, agentConversationId: task.agentConversationId, status: 'done' },
    })
  } catch (error) {
    const now = Date.now()
    const message = formatGenerationError(error, profile)
    const latest = await getTask(db, userId, taskId)
    const failedTask = applyTaskPatch(latest ?? runningTask, {
      status: 'error',
      error: message,
      finishedAt: now,
      elapsed: now - startedAt,
    })
    await putTaskRecord(db, userId, failedTask)
    latestConversation = updateConversationForRegenerationError(conversation, failedTask, message, now)
    await putAgentConversationRecord(db, userId, latestConversation)
    publishTaskEvent(userId, taskId, { type: 'error', task: failedTask })
    await writeAuditLog(db, request, {
      actor: admin,
      targetUserId: userId,
      action: 'generation.regenerate',
      details: { taskId, agentConversationId: task.agentConversationId, status: 'error', error: message },
    })
    throw error
  } finally {
    closeTaskSubscribers(userId, taskId)
  }

  return getAdminGenerationAuditByTask(db, userId, taskId)
}

async function getReferencedObjectKeys(db: Db) {
  const result = await db.query<{ storage_key: string }>(
    `
      SELECT storage_key FROM images
      UNION
      SELECT storage_key FROM image_thumbnails
    `,
  )
  return new Set(result.rows.map((row) => row.storage_key))
}

async function findOrphanObjects(db: Db, s3: S3Client, config: ServerConfig) {
  const [objectKeys, referencedKeys] = await Promise.all([
    listObjectKeys(s3, config, 'users/'),
    getReferencedObjectKeys(db),
  ])
  return objectKeys.filter((key) => !referencedKeys.has(key))
}

async function getSystemSnapshot(db: Db, s3: S3Client, config: ServerConfig) {
  const [users, objectKeys, auditCount] = await Promise.all([
    getAdminUserRows(db),
    listObjectKeys(s3, config, ''),
    db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM audit_logs'),
  ])
  return {
    database: {
      userCount: users.length,
      taskCount: users.reduce((sum, item) => sum + toNumber(item.task_count), 0),
      imageCount: users.reduce((sum, item) => sum + toNumber(item.image_count), 0),
      auditLogCount: toNumber(auditCount.rows[0]?.count),
    },
    storage: {
      bucket: config.s3.bucket,
      objectCount: objectKeys.length,
    },
  }
}

async function getTask(db: Db, userId: string, taskId: string): Promise<TaskRecord | null> {
  const result = await db.query<{ record: TaskRecord }>(
    'SELECT record FROM tasks WHERE user_id = $1 AND id = $2',
    [userId, taskId],
  )
  return result.rows[0]?.record ?? null
}

async function putTaskRecord(db: Db, userId: string, task: TaskRecord) {
  await db.query(
    `
      INSERT INTO tasks (id, user_id, record, status, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id, id)
      DO UPDATE SET record = EXCLUDED.record, status = EXCLUDED.status, updated_at = now()
    `,
    [task.id, userId, task, task.status],
  )
}

async function assertUserLimits(db: Db, userId: string, input: { extraBytes?: number; creatingTask?: boolean }) {
  const result = await db.query<{
    storage_quota_bytes: string | number | null
    task_quota_count: string | number | null
    storage_bytes: string | number
    task_count: string | number
  }>(
    `
      SELECT
        users.storage_quota_bytes,
        users.task_quota_count,
        COALESCE(image_stats.storage_bytes, 0) AS storage_bytes,
        COALESCE(task_stats.task_count, 0) AS task_count
      FROM users
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(byte_size), 0) AS storage_bytes
        FROM images
        GROUP BY user_id
      ) image_stats ON image_stats.user_id = users.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS task_count
        FROM tasks
        GROUP BY user_id
      ) task_stats ON task_stats.user_id = users.id
      WHERE users.id = $1
    `,
    [userId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('用户不存在')
  const storageQuotaBytes = toOptionalNumber(row.storage_quota_bytes)
  const taskQuotaCount = toOptionalNumber(row.task_quota_count)
  if (storageQuotaBytes != null && toNumber(row.storage_bytes) + (input.extraBytes ?? 0) > storageQuotaBytes) {
    throw createBadRequestError('已超过用户存储配额')
  }
  if (input.creatingTask && taskQuotaCount != null && toNumber(row.task_count) + 1 > taskQuotaCount) {
    throw createBadRequestError('已超过用户任务数量配额')
  }
}

async function assertTaskImagesBelongToUser(db: Db, userId: string, task: TaskRecord) {
  const ids = [
    ...task.inputImageIds,
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...task.outputImages,
    ...(task.transparentOriginalImages ?? []).filter(Boolean),
    ...(task.streamPartialImageIds ?? []),
  ]
  if (!ids.length) return
  const result = await db.query<{ id: string }>(
    'SELECT id FROM images WHERE user_id = $1 AND id = ANY($2::text[])',
    [userId, ids],
  )
  if (result.rows.length !== new Set(ids).size) throw new Error('任务引用了不存在的图片')
}

function isTaskRecordBody(value: Partial<TaskRecord>): value is TaskRecord {
  return typeof value.prompt === 'string' &&
    value.params != null &&
    Array.isArray(value.inputImageIds) &&
    Array.isArray(value.outputImages) &&
    (value.status === 'running' || value.status === 'done' || value.status === 'error') &&
    Object.prototype.hasOwnProperty.call(value, 'error') &&
    typeof value.createdAt === 'number'
}

function applyTaskPatch(task: TaskRecord, patch: Partial<TaskRecord>): TaskRecord {
  return { ...task, ...patch }
}

async function storeGeneratedTaskOutputImages(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  user: AuthUser,
  task: TaskRecord,
  images: string[],
) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const transparentOriginalImageIds: string[] = []

  for (const dataUrl of images) {
    let outputDataUrl = dataUrl

    if (task.transparentOutput) {
      const original = await upsertImage(db, s3, config, user, {
        dataUrl,
        source: 'generated',
        taskId: task.id,
      })

      try {
        outputDataUrl = removeKeyedBackgroundFromDataUrl(dataUrl)
        transparentOriginalImageIds.push(original.id)
      } catch (error) {
        // 云端任务不能因为透明后处理失败而丢失模型原图；空字符串用于前端标记该张图回退。
        console.warn('透明背景后处理失败，已回退为原始输出', error)
        outputIds.push(original.id)
        outputDataUrls.push(dataUrl)
        transparentOriginalImageIds.push('')
        continue
      }
    }

    const output = await upsertImage(db, s3, config, user, {
      dataUrl: outputDataUrl,
      source: 'generated',
      taskId: task.id,
    })
    outputIds.push(output.id)
    outputDataUrls.push(outputDataUrl)
  }

  return {
    outputIds,
    outputDataUrls,
    transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
  }
}

async function runTask(
  db: Db,
  s3: S3Client,
  config: ServerConfig,
  user: AuthUser,
  taskId: string,
) {
  const task = await getTask(db, user.id, taskId)
  if (!task || task.status !== 'running') return

  try {
    const savedSettings = await loadGenerationSettings(db, config, user.id)
    if (!savedSettings) throw new Error('缺少云端 API 配置')
    const settings = createSettingsForApiProfile(savedSettings, selectTaskApiProfile(savedSettings, task))

    const inputImageDataUrls = await Promise.all(task.inputImageIds.map((id) =>
      readImageDataUrl(db, s3, config, user.id, id),
    ))
    const maskDataUrl = task.maskImageId
      ? await readImageDataUrl(db, s3, config, user.id, task.maskImageId)
      : undefined

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : applyPromptStylePreset(task.prompt, task.promptStylePresetId)

    const result = await callImageApi({
      settings,
      prompt: replaceImageMentionsForApi(requestPrompt, task.inputImageIds.length),
      params: task.params,
      nativeTransparentBackground: task.params.transparent_output && !task.transparentOutput,
      inputImageDataUrls,
      inputImageUrls: task.inputImageIds.map((_, index) => {
        const url = task.inputImageUrls?.[index]
        return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
      }),
      maskDataUrl,
      onPartialImage: (partial) => {
        publishTaskEvent(user.id, taskId, {
          type: 'partial',
          taskId,
          image: partial.image,
          requestIndex: partial.requestIndex,
        })
      },
    })

    const { outputIds, transparentOriginalImageIds } = await storeGeneratedTaskOutputImages(db, s3, config, user, task, result.images)

    const latestBeforeSave = await getTask(db, user.id, taskId)
    if (!latestBeforeSave || latestBeforeSave.status !== 'running') return

    const now = Date.now()
    const doneTask = applyTaskPatch(latestBeforeSave, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams: { ...result.actualParams, n: outputIds.length },
      actualParamsByImage: result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
        const imageId = outputIds[index]
        if (imageId && params && Object.keys(params).length) acc[imageId] = params
        return acc
      }, {}),
      revisedPromptByImage: result.revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
        const imageId = outputIds[index]
        if (imageId && prompt?.trim()) acc[imageId] = prompt
        return acc
      }, {}),
      status: 'done',
      error: null,
      finishedAt: now,
      elapsed: now - (latestBeforeSave.startedAt ?? latestBeforeSave.createdAt),
    })
    await putTaskRecord(db, user.id, doneTask)
    publishTaskEvent(user.id, taskId, { type: 'done', task: doneTask })
  } catch (error) {
    const latestTask = await getTask(db, user.id, taskId)
    if (!latestTask || latestTask.status !== 'running') return
    const now = Date.now()
    const failedTask = applyTaskPatch(latestTask, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      finishedAt: now,
      elapsed: now - (latestTask.startedAt ?? latestTask.createdAt),
    })
    await putTaskRecord(db, user.id, failedTask)
    publishTaskEvent(user.id, taskId, { type: 'error', task: failedTask })
  } finally {
    closeTaskSubscribers(user.id, taskId)
  }
}

export function registerCloudRoutes(app: FastifyInstance, db: Db, s3: S3Client, config: ServerConfig) {
  app.get('/api/platform/settings', async () => (
    sanitizePlatformSettingsForClient(await loadPlatformSettings(db, config))
  ))

  app.get('/api/settings', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const saved = await loadSettings(db, user.id)
    return saved
      ? { settings: saved.settings, params: saved.params, ...saved.workspace }
      : null
  })

  app.put('/api/settings', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    return upsertSettings(db, config, user.id, request.body as Parameters<typeof upsertSettings>[3])
  })

  app.get('/api/admin/overview', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    const users = await getAdminUserRows(db)
    return {
      userCount: users.length,
      disabledUserCount: users.filter((item) => item.disabled_at).length,
      pendingRegistrationCount: users.filter((item) => normalizeRegistrationStatus(item.registration_status) === 'pending').length,
      taskCount: users.reduce((sum, item) => sum + toNumber(item.task_count), 0),
      runningTaskCount: users.reduce((sum, item) => sum + toNumber(item.running_task_count), 0),
      imageCount: users.reduce((sum, item) => sum + toNumber(item.image_count), 0),
      storageBytes: users.reduce((sum, item) => sum + toNumber(item.storage_bytes), 0),
    }
  })

  app.get('/api/admin/system', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    return getSystemSnapshot(db, s3, config)
  })

  app.get('/api/admin/audit-logs', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    const query = request.query as { limit?: string }
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 80))
    return { logs: await getAuditLogs(db, limit) }
  })

  app.get('/api/admin/generation-audits', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    const query = request.query as { limit?: string; userId?: string; agentConversationId?: string }
    const agentConversationId = typeof query.agentConversationId === 'string' && query.agentConversationId.trim() ? query.agentConversationId.trim() : undefined
    const maxLimit = agentConversationId ? 1000 : 200
    const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || 80))
    const userId = typeof query.userId === 'string' && query.userId.trim() ? query.userId.trim() : undefined
    if (userId && !(await adminUserExists(db, userId))) return reply.code(404).send({ error: '用户不存在' })
    return { audits: await getAdminGenerationAudits(db, { userId, agentConversationId, limit }) }
  })

  app.post('/api/admin/users/:userId/tasks/:taskId/regenerate', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { userId, taskId } = request.params as { userId: string; taskId: string }
    const audit = await regenerateAdminAgentTask(db, s3, config, admin, userId, taskId, request)
    if (!audit) return reply.code(404).send({ error: '任务不存在' })
    return { audit }
  })

  app.get('/api/admin/users/:userId/images/:imageId/data', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { userId, imageId } = request.params as { userId: string; imageId: string }
    const result = await db.query<{ storage_key: string; mime_type: string }>(
      'SELECT storage_key, mime_type FROM images WHERE user_id = $1 AND id = $2',
      [userId, imageId],
    )
    const image = result.rows[0]
    if (!image) return reply.code(404).send({ error: '图片不存在' })
    const buffer = await getObjectBuffer(s3, config, image.storage_key)
    return reply.type(image.mime_type).send(buffer)
  })

  app.get('/api/admin/users/:userId/images/:imageId/thumbnail/data', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { userId, imageId } = request.params as { userId: string; imageId: string }
    const result = await db.query<{ storage_key: string; mime_type: string; width: number | null; height: number | null; thumbnail_version: number | null }>(
      'SELECT storage_key, mime_type, width, height, thumbnail_version FROM image_thumbnails WHERE user_id = $1 AND image_id = $2',
      [userId, imageId],
    )
    const thumbnail = result.rows[0]
    if (!thumbnail) return reply.code(404).send({ error: '缩略图不存在' })
    const buffer = await getObjectBuffer(s3, config, thumbnail.storage_key)
    reply.header('X-Image-Width', String(thumbnail.width ?? ''))
    reply.header('X-Image-Height', String(thumbnail.height ?? ''))
    reply.header('X-Thumbnail-Version', String(thumbnail.thumbnail_version ?? ''))
    return reply.type(thumbnail.mime_type).send(buffer)
  })

  app.get('/api/admin/platform-settings', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    return sanitizePlatformSettingsForClient(await loadPlatformSettings(db, config))
  })

  app.post('/api/admin/platform-settings/test', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    return testPlatformSettings(db, config, request.body)
  })

  app.put('/api/admin/platform-settings', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const saved = await upsertPlatformSettings(db, config, request.body)
    await writeAuditLog(db, request, {
      actor: admin,
      action: 'platform.update',
      details: {
        apiManaged: saved.api.managed,
        activeProfileId: saved.api.settings.activeProfileId,
        agentLocked: saved.agent.lockSettings,
        zipDownloadRouteCount: saved.download.zipDownloadRoutes.length,
      },
    })
    return saved
  })

  app.get('/api/admin/users', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    const users = await getAdminUserRows(db)
    return { users: users.map(serializeAdminUser) }
  })

  app.get('/api/admin/users/:id', async (request, reply) => {
    const user = await requireAdmin(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const users = await getAdminUserRows(db)
    const target = users.map(serializeAdminUser).find((item) => item.id === id)
    if (!target) return reply.code(404).send({ error: '用户不存在' })
    const [tasks, images, logs, generationAudits] = await Promise.all([
      db.query<{ record: TaskRecord; updated_at: string }>(
        'SELECT record, updated_at FROM tasks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10',
        [id],
      ),
      db.query<{ id: string; source: string; byte_size: number; created_at: string; updated_at: string }>(
        'SELECT id, source, byte_size, created_at, updated_at FROM images WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10',
        [id],
      ),
      db.query<AuditLogRow>(
        `
          SELECT
            audit_logs.id,
            audit_logs.action,
            audit_logs.details,
            audit_logs.ip,
            audit_logs.user_agent,
            audit_logs.created_at,
            actor.email AS actor_email,
            target.email AS target_email
          FROM audit_logs
          LEFT JOIN users actor ON actor.id = audit_logs.actor_user_id
          LEFT JOIN users target ON target.id = audit_logs.target_user_id
          WHERE audit_logs.target_user_id = $1
          ORDER BY audit_logs.created_at DESC
          LIMIT 10
        `,
        [id],
      ),
      getAdminGenerationAudits(db, { userId: id, limit: 10 }),
    ])
    return {
      user: target,
      recentTasks: tasks.rows.map((row) => ({ task: row.record, updatedAt: row.updated_at })),
      recentImages: images.rows.map((row) => ({
        id: row.id,
        source: row.source,
        byteSize: row.byte_size,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      recentLogs: logs.rows.map(serializeAuditLog),
      generationAudits,
    }
  })

  app.post('/api/admin/users/batch', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const body = request.body as { ids?: unknown; action?: unknown }
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id !== admin.id))] : []
    if (!ids.length) return reply.code(400).send({ error: '请选择至少一个非当前账号用户' })
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'disable' || action === 'enable') {
      await db.query(
        `UPDATE users SET disabled_at = ${action === 'disable' ? 'now()' : 'null'}, updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      )
      await writeAuditLog(db, request, {
        actor: admin,
        action: `user.batch_${action}`,
        details: { ids },
      })
      return { ok: true }
    }
    if (action === 'clearData') {
      for (const id of ids) {
        if (await adminUserExists(db, id)) {
          await clearUserDataForUser(db, s3, config, id, { clearConfig: true, clearTasks: true })
        }
      }
      await writeAuditLog(db, request, {
        actor: admin,
        action: 'user.batch_clear_data',
        details: { ids },
      })
      return { ok: true }
    }
    return reply.code(400).send({ error: '不支持的批量操作' })
  })

  app.post('/api/admin/users', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const body = request.body as { email?: unknown; password?: unknown; isAdmin?: unknown; storageQuotaBytes?: unknown; taskQuotaCount?: unknown }
    const email = normalizeAdminEmail(body.email)
    const password = normalizeAdminPassword(body.password)
    if (!email || !password) return reply.code(400).send({ error: '请输入邮箱和密码' })
    if (password.length < 8) return reply.code(400).send({ error: '密码至少需要 8 位' })

    const passwordHash = await hashPassword(password)
    const storageQuotaBytes = normalizeNullableQuota(body.storageQuotaBytes) ?? null
    const taskQuotaCount = normalizeNullableQuota(body.taskQuotaCount) ?? null
    let row: {
      id: string
      email: string
      is_admin: boolean
      disabled_at: string | null
      registration_status: string
      registration_requested_at: string | null
      registration_reviewed_at: string | null
      registration_reviewed_by: string | null
      storage_quota_bytes: string | number | null
      task_quota_count: string | number | null
      created_at: string
      updated_at: string
    }
    try {
      const result = await db.query<typeof row>(
        `
          INSERT INTO users (
            email,
            password_hash,
            is_admin,
            disabled_at,
            registration_status,
            registration_requested_at,
            registration_reviewed_at,
            registration_reviewed_by,
            storage_quota_bytes,
            task_quota_count
          )
          VALUES ($1, $2, $3, null, 'approved', now(), now(), $6, $4, $5)
          RETURNING
            id,
            email,
            is_admin,
            disabled_at,
            registration_status,
            registration_requested_at,
            registration_reviewed_at,
            registration_reviewed_by,
            storage_quota_bytes,
            task_quota_count,
            created_at,
            updated_at
        `,
        [email, passwordHash, Boolean(body.isAdmin), storageQuotaBytes, taskQuotaCount, admin.id],
      )
      row = result.rows[0]
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: '邮箱已存在' })
      throw error
    }
    await writeAuditLog(db, request, {
      actor: admin,
      targetUserId: row.id,
      action: 'user.create',
      details: { email, isAdmin: Boolean(body.isAdmin), storageQuotaBytes, taskQuotaCount },
    })
    return {
      user: serializeAdminUser({
        ...row,
        latest_session_at: null,
        task_count: 0,
        running_task_count: 0,
        image_count: 0,
        storage_bytes: 0,
        conversation_count: 0,
        session_count: 0,
      }),
    }
  })

  app.post('/api/admin/users/:id/registration', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { id } = request.params as { id: string }
    const body = request.body as { action?: unknown }
    const action = typeof body.action === 'string' ? body.action : ''
    if (action !== 'approve' && action !== 'reject') return reply.code(400).send({ error: '不支持的审批操作' })

    const current = await db.query<{ email: string; registration_status: string }>(
      'SELECT email, registration_status FROM users WHERE id = $1',
      [id],
    )
    const targetUser = current.rows[0]
    if (!targetUser) return reply.code(404).send({ error: '用户不存在' })
    if (normalizeRegistrationStatus(targetUser.registration_status) !== 'pending') {
      return reply.code(400).send({ error: '只能审批待处理的注册申请' })
    }

    await db.query(
      `
        UPDATE users
        SET
          registration_status = $1,
          disabled_at = ${action === 'approve' ? 'null' : 'now()'},
          registration_reviewed_at = now(),
          registration_reviewed_by = $2,
          updated_at = now()
        WHERE id = $3
      `,
      [action === 'approve' ? 'approved' : 'rejected', admin.id, id],
    )
    if (action === 'reject') await db.query('DELETE FROM sessions WHERE user_id = $1', [id])
    await writeAuditLog(db, request, {
      actor: admin,
      targetUserId: id,
      action: action === 'approve' ? 'user.registration_approve' : 'user.registration_reject',
      details: { email: targetUser.email },
    })
    const users = await getAdminUserRows(db)
    return { user: users.map(serializeAdminUser).find((item) => item.id === id) }
  })

  app.patch('/api/admin/users/:id', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { id } = request.params as { id: string }
    const body = request.body as { password?: unknown; isAdmin?: unknown; disabled?: unknown; storageQuotaBytes?: unknown; taskQuotaCount?: unknown }
    const current = await db.query<{ is_admin: boolean; disabled_at: string | null }>(
      'SELECT is_admin, disabled_at FROM users WHERE id = $1',
      [id],
    )
    const targetUser = current.rows[0]
    if (!targetUser) return reply.code(404).send({ error: '用户不存在' })
    if (id === admin.id && (body.disabled === true || body.isAdmin === false)) {
      return reply.code(400).send({ error: '不能禁用自己或移除自己的管理员权限' })
    }
    if (targetUser.is_admin && !targetUser.disabled_at && body.isAdmin === false && await countEnabledAdmins(db) <= 1) {
      return reply.code(400).send({ error: '至少需要保留一个启用的管理员' })
    }

    const patches: string[] = []
    const values: unknown[] = []
    const addPatch = (sql: string, value: unknown) => {
      values.push(value)
      patches.push(`${sql} = $${values.length}`)
    }
    if (typeof body.isAdmin === 'boolean') addPatch('is_admin', body.isAdmin)
    const storageQuotaBytes = normalizeNullableQuota(body.storageQuotaBytes)
    const taskQuotaCount = normalizeNullableQuota(body.taskQuotaCount)
    if (storageQuotaBytes !== undefined) addPatch('storage_quota_bytes', storageQuotaBytes)
    if (taskQuotaCount !== undefined) addPatch('task_quota_count', taskQuotaCount)
    if (typeof body.disabled === 'boolean') {
      if (targetUser.is_admin && !targetUser.disabled_at && body.disabled && await countEnabledAdmins(db) <= 1) {
        return reply.code(400).send({ error: '至少需要保留一个启用的管理员' })
      }
      patches.push(`disabled_at = ${body.disabled ? 'now()' : 'null'}`)
    }
    const password = normalizeAdminPassword(body.password)
    if (password) {
      if (password.length < 8) return reply.code(400).send({ error: '密码至少需要 8 位' })
      addPatch('password_hash', await hashPassword(password))
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id])
    }
    if (!patches.length) return reply.code(400).send({ error: '没有需要更新的字段' })

    values.push(id)
    const result = await db.query<{ id: string }>(
      `UPDATE users SET ${patches.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
      values,
    )
    await writeAuditLog(db, request, {
      actor: admin,
      targetUserId: id,
      action: 'user.update',
      details: {
        isAdmin: typeof body.isAdmin === 'boolean' ? body.isAdmin : undefined,
        disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
        passwordChanged: Boolean(password),
        storageQuotaBytes: body.storageQuotaBytes,
        taskQuotaCount: body.taskQuotaCount,
      },
    })
    const users = await getAdminUserRows(db)
    return { user: users.map(serializeAdminUser).find((item) => item.id === id) }
  })

  app.delete('/api/admin/users/:id/data', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { id } = request.params as { id: string }
    if (!(await adminUserExists(db, id))) return reply.code(404).send({ error: '用户不存在' })
    await clearUserDataForUser(db, s3, config, id, { clearConfig: true, clearTasks: true })
    await writeAuditLog(db, request, { actor: admin, targetUserId: id, action: 'user.clear_data' })
    return { ok: true }
  })

  app.delete('/api/admin/users/:id/sessions', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { id } = request.params as { id: string }
    if (id === admin.id) return reply.code(400).send({ error: '不能清理当前登录管理员自己的会话' })
    if (!(await adminUserExists(db, id))) return reply.code(404).send({ error: '用户不存在' })
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id])
    await writeAuditLog(db, request, { actor: admin, targetUserId: id, action: 'user.revoke_sessions' })
    return { ok: true }
  })

  app.delete('/api/admin/users/:id', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const { id } = request.params as { id: string }
    if (id === admin.id) return reply.code(400).send({ error: '不能删除当前登录的管理员账号' })
    const target = await db.query<{ is_admin: boolean; disabled_at: string | null }>(
      'SELECT is_admin, disabled_at FROM users WHERE id = $1',
      [id],
    )
    if (!target.rows[0]) return reply.code(404).send({ error: '用户不存在' })
    if (target.rows[0].is_admin && !target.rows[0].disabled_at && await countEnabledAdmins(db) <= 1) {
      return reply.code(400).send({ error: '至少需要保留一个启用的管理员' })
    }
    await clearUserDataForUser(db, s3, config, id, { clearConfig: true, clearTasks: true })
    await writeAuditLog(db, request, { actor: admin, targetUserId: id, action: 'user.delete', details: { deletedUserId: id } })
    await db.query('DELETE FROM users WHERE id = $1', [id])
    return { ok: true }
  })

  app.post('/api/admin/maintenance/orphans', async (request, reply) => {
    const admin = await requireAdmin(db, request, reply)
    if (!admin) return
    const body = request.body as { delete?: unknown }
    const orphanKeys = await findOrphanObjects(db, s3, config)
    const shouldDelete = body.delete === true
    if (shouldDelete) {
      await deleteObjects(s3, config, orphanKeys)
      await writeAuditLog(db, request, {
        actor: admin,
        action: 'maintenance.delete_orphans',
        details: { count: orphanKeys.length },
      })
    }
    return { orphanCount: orphanKeys.length, orphanKeys: orphanKeys.slice(0, 100), deleted: shouldDelete }
  })

  app.post('/api/data/clear', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    await clearUserDataForUser(db, s3, config, user.id, request.body as { clearConfig?: boolean; clearTasks?: boolean })
    return { ok: true }
  })

  app.post('/api/images', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    return upsertImage(db, s3, config, user, request.body as Parameters<typeof upsertImage>[4])
  })

  app.post('/api/images/:id/thumbnail', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    return upsertImageThumbnail(db, s3, config, user, id, request.body as Parameters<typeof upsertImageThumbnail>[5])
  })

  app.get('/api/images/:id/url', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const result = await db.query<{ storage_key: string }>(
      'SELECT storage_key FROM images WHERE user_id = $1 AND id = $2',
      [user.id, id],
    )
    const image = result.rows[0]
    if (!image) return reply.code(404).send({ error: '图片不存在' })
    return { url: await createSignedImageUrl(s3, config, image.storage_key) }
  })

  app.get('/api/images/:id/data', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const result = await db.query<{ storage_key: string; mime_type: string }>(
      'SELECT storage_key, mime_type FROM images WHERE user_id = $1 AND id = $2',
      [user.id, id],
    )
    const image = result.rows[0]
    if (!image) return reply.code(404).send({ error: '图片不存在' })
    const buffer = await getObjectBuffer(s3, config, image.storage_key)
    return reply.type(image.mime_type).send(buffer)
  })

  app.get('/api/images/:id/thumbnail/data', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const result = await db.query<{ storage_key: string; mime_type: string; width: number | null; height: number | null; thumbnail_version: number | null }>(
      'SELECT storage_key, mime_type, width, height, thumbnail_version FROM image_thumbnails WHERE user_id = $1 AND image_id = $2',
      [user.id, id],
    )
    const thumbnail = result.rows[0]
    if (!thumbnail) return reply.code(404).send({ error: '缩略图不存在' })
    const buffer = await getObjectBuffer(s3, config, thumbnail.storage_key)
    reply.header('X-Image-Width', String(thumbnail.width ?? ''))
    reply.header('X-Image-Height', String(thumbnail.height ?? ''))
    reply.header('X-Thumbnail-Version', String(thumbnail.thumbnail_version ?? ''))
    return reply.type(thumbnail.mime_type).send(buffer)
  })

  app.delete('/api/images/:id', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    await deleteImageForUser(db, s3, config, user.id, id)
    return { ok: true }
  })

  app.get('/api/tasks', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const result = await db.query<{ record: TaskRecord }>(
      'SELECT record FROM tasks WHERE user_id = $1 ORDER BY (record->>\'createdAt\')::bigint DESC',
      [user.id],
    )
    return { tasks: result.rows.map((row) => row.record) }
  })

  app.post('/api/tasks', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const incomingTask = request.body as TaskRecord
    const key = taskEventKey(user.id, incomingTask.id)
    if (runningCloudTaskIds.has(key)) return reply.code(409).send({ error: '任务正在运行，请勿重复重试' })
    runningCloudTaskIds.add(key)
    try {
      const current = await getTask(db, user.id, incomingTask.id)
      if (current && (current.status === 'running' || current.falRecoverable || current.customRecoverable)) {
        throw Object.assign(new Error('任务正在运行或等待恢复，请勿重复重试'), { statusCode: 409 })
      }
      if (current && (current.sourceMode === 'agent' || current.agentConversationId || current.agentRoundId)) {
        throw createBadRequestError('Agent 图片任务请新建任务重试')
      }
      const savedSettings = await loadGenerationSettings(db, config, user.id)
      if (!savedSettings) throw createBadRequestError('缺少云端 API 配置')
      const settings = createSettingsForApiProfile(savedSettings, selectTaskApiProfile(savedSettings, incomingTask))
      const task = await applyManagedTaskParams(db, config, {
        ...incomingTask,
        ...(current ? {
          createdAt: current.createdAt,
          startedAt: Date.now(),
          isFavorite: current.isFavorite,
          favoriteCollectionIds: current.favoriteCollectionIds,
        } : {}),
      }, settings)
      await assertTaskImagesBelongToUser(db, user.id, task)
      await assertUserLimits(db, user.id, { creatingTask: !current })
      await putTaskRecord(db, user.id, task)
      publishTaskEvent(user.id, task.id, { type: 'task', task })
      void runTask(db, s3, config, user, task.id).finally(() => runningCloudTaskIds.delete(key))
      return { task }
    } catch (error) {
      runningCloudTaskIds.delete(key)
      throw error
    }
  })

  app.patch('/api/tasks/:id', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const patch = request.body as Partial<TaskRecord>
    const current = await getTask(db, user.id, id)
    if (!current) {
      const task = { ...patch, id }
      if (!isTaskRecordBody(task)) return reply.code(400).send({ error: '任务数据不完整' })
      await assertTaskImagesBelongToUser(db, user.id, task)
      await assertUserLimits(db, user.id, { creatingTask: true })
      await putTaskRecord(db, user.id, task)
      return { task }
    }

    const task = applyTaskPatch(current, { ...patch, id })
    await assertTaskImagesBelongToUser(db, user.id, task)
    await putTaskRecord(db, user.id, task)
    return { task }
  })

  app.get('/api/tasks/:id', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const task = await getTask(db, user.id, id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    return { task }
  })

  app.delete('/api/tasks/:id', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    closeTaskSubscribers(user.id, id)
    await db.query('DELETE FROM tasks WHERE user_id = $1 AND id = $2', [user.id, id])
    return { ok: true }
  })

  app.get('/api/tasks/:id/events', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const { id } = request.params as { id: string }
    const task = await getTask(db, user.id, id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    reply.raw.write(`data: ${JSON.stringify({ type: 'task', task })}\n\n`)

    if (task.status !== 'running') {
      reply.raw.end()
      return
    }

    const key = taskEventKey(user.id, id)
    const subscribers = taskSubscribers.get(key) ?? new Set<FastifyReply>()
    subscribers.add(reply)
    taskSubscribers.set(key, subscribers)
    request.raw.on('close', () => {
      subscribers.delete(reply)
      if (subscribers.size === 0) taskSubscribers.delete(key)
    })
    return
  })

  app.get('/api/agent/conversations', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const result = await db.query<{ conversation: AgentConversation }>(
      'SELECT conversation FROM agent_conversations WHERE user_id = $1 ORDER BY updated_at ASC',
      [user.id],
    )
    return { conversations: result.rows.map((row) => row.conversation) }
  })

  app.put('/api/agent/conversations', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const body = request.body as { conversations?: AgentConversation[] }
    const conversations = Array.isArray(body.conversations) ? body.conversations : []
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM agent_conversations WHERE user_id = $1', [user.id])
      for (const conversation of conversations) {
        await client.query(
          `
            INSERT INTO agent_conversations (id, user_id, conversation, updated_at)
            VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
          `,
          [conversation.id, user.id, conversation, conversation.updatedAt ?? Date.now()],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return { conversations }
  })

  app.post('/api/agent/title', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    const body = request.body as { prompt?: string; inputImageIds?: string[] }
    const { settings, textProfile } = await loadAgentGenerationProfiles(db, config, user.id)
    await assertUpstreamTcpReachable(textProfile)
    const imageDataUrls = await Promise.all((body.inputImageIds ?? []).map((id) =>
      readImageDataUrl(db, s3, config, user.id, id),
    ))
    const title = await callAgentConversationTitleApi({
      settings,
      profile: textProfile,
      prompt: body.prompt ?? '',
      imageDataUrls,
    })
    return { title }
  })

  app.post('/api/agent/responses/stream', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    let activeProfile: ApiProfile | null = null
    const body = request.body as {
      params?: TaskParams
      input?: unknown
      maskImageId?: string | null
      maskDataUrl?: string
    }
    openSse(reply)
    try {
      const { settings, textProfile, imageProfile } = await loadAgentGenerationProfiles(db, config, user.id)
      activeProfile = textProfile
      await assertUpstreamTcpReachable(textProfile)
      const maskDataUrl = body.maskImageId
        ? await readImageDataUrl(db, s3, config, user.id, body.maskImageId)
        : body.maskDataUrl
      const managedParams = await loadManagedGenerationParams(db, config)
      const imageSettings = createSettingsForApiProfile(settings, imageProfile)
      const requestParams = normalizeGenerationParams(
        managedParams ?? body.params ?? DEFAULT_PARAMS,
        imageSettings,
        Boolean(maskDataUrl),
      )
      const result = await callAgentResponsesApi({
        settings,
        profile: textProfile,
        imageProfile,
        params: { ...requestParams, n: 1, transparent_output: false },
        input: body.input,
        maskDataUrl,
        onTextDelta: (delta) => writeSse(reply, { type: 'text_delta', delta }),
        onOutputItems: (outputItems) => writeSse(reply, { type: 'output_items', outputItems }),
        onImageToolStarted: (event) => writeSse(reply, { type: 'image_tool_started', event }),
        onImagePartialImage: (event) => writeSse(reply, { type: 'image_partial_image', event }),
        onImageToolCompleted: (image) => writeSse(reply, { type: 'image_tool_completed', image }),
        // 云端模式需要把内置图片工具的结构化失败也转给前端；
        // 否则前端已创建的 running 任务收不到失败事件，会一直停在加载态。
        onImageToolFailed: (event) => writeSse(reply, { type: 'image_tool_failed', event }),
      })
      writeSse(reply, { type: 'done', result })
    } catch (error) {
      request.log.error({ err: error, baseUrl: activeProfile?.baseUrl, model: activeProfile?.model }, 'cloud agent responses failed')
      writeSse(reply, { type: 'error', error: formatGenerationError(error, activeProfile) })
    } finally {
      reply.raw.end()
    }
  })

  app.post('/api/agent/batch-image/stream', async (request, reply) => {
    const user = await requireAuth(db, request, reply)
    if (!user) return
    let activeProfile: ApiProfile | null = null
    const body = request.body as {
      params?: TaskParams
      batchItemId?: string
      prompt?: string
      referenceImageDataUrls?: string[]
      referenceImageSourceUrls?: (string | null)[]
      referenceIds?: string[]
    }
    openSse(reply)
    try {
      const { settings, imageProfile } = await loadAgentGenerationProfiles(db, config, user.id)
      activeProfile = imageProfile
      await assertUpstreamTcpReachable(imageProfile)
      const imageSettings = createSettingsForApiProfile(settings, imageProfile)
      const managedParams = await loadManagedGenerationParams(db, config)
      const requestParams = normalizeGenerationParams(
        managedParams ?? body.params ?? DEFAULT_PARAMS,
        imageSettings,
        Boolean(body.referenceImageDataUrls?.length || body.referenceIds?.length),
      )
      const params = { ...requestParams, n: 1, transparent_output: false }
      const batchItemId = body.batchItemId ?? ''
      const prompt = body.prompt ?? ''
      const referenceImageDataUrls = body.referenceImageDataUrls ?? []
      let result: BatchImageCallResult

      if (settings.agentApiConfigMode === 'hybrid') {
        writeSse(reply, { type: 'batch_image_started' })
        const apiResult = await callImageApi({
          settings: imageSettings,
          prompt: replaceImageMentionsForApi(prompt, referenceImageDataUrls.length),
          params,
          inputImageDataUrls: referenceImageDataUrls,
          inputImageUrls: referenceImageDataUrls.map((_, index) => {
            const url = body.referenceImageSourceUrls?.[index]
            return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
          }),
          onPartialImage: (partial) => writeSse(reply, {
            type: 'batch_partial_image',
            event: { image: partial.image, partialImageIndex: partial.partialImageIndex ?? partial.requestIndex },
          }),
        })
        const dataUrl = apiResult.images[0]
        const image = dataUrl
          ? {
              dataUrl,
              actualParams: apiResult.actualParamsList?.[0] ?? apiResult.actualParams,
              revisedPrompt: apiResult.revisedPrompts?.[0] ?? prompt,
            }
          : null
        result = {
          batchItemId,
          image,
          error: apiResult.failedRequests?.[0]?.error ?? (image ? null : '接口未返回图片数据'),
          rawResponsePayload: JSON.stringify({
            imageCount: apiResult.images.length,
            actualParams: apiResult.actualParams,
            actualParamsList: apiResult.actualParamsList,
            revisedPrompts: apiResult.revisedPrompts,
            rawImageUrls: apiResult.rawImageUrls,
            failedRequests: apiResult.failedRequests,
          }, null, 2),
        }
        if (image) writeSse(reply, { type: 'batch_image_completed', image })
      } else {
        result = await callBatchImageSingle({
          profile: imageProfile,
          params,
          batchItemId,
          prompt,
          referenceImageDataUrls,
          referenceIds: body.referenceIds,
          allowPromptRewrite: settings.allowPromptRewrite,
          onImageToolStarted: () => writeSse(reply, { type: 'batch_image_started' }),
          onPartialImage: (event) => writeSse(reply, { type: 'batch_partial_image', event }),
          onImageToolCompleted: (image) => writeSse(reply, { type: 'batch_image_completed', image }),
        })
      }
      writeSse(reply, { type: 'done', result })
    } catch (error) {
      request.log.error({ err: error, baseUrl: activeProfile?.baseUrl, model: activeProfile?.model }, 'cloud batch image failed')
      writeSse(reply, { type: 'error', error: formatGenerationError(error, activeProfile) })
    } finally {
      reply.raw.end()
    }
  })
}
