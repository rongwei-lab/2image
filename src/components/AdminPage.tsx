import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  batchCloudAdminUsers,
  changeCloudPassword,
  createCloudAdminUser,
  clearCloudAdminUserData,
  deleteCloudAdminUser,
  getCloudAdminAuditLogs,
  getCloudAdminGenerationAudits,
  getCloudAdminOverview,
  getCloudAdminPlatformSettings,
  getCloudAdminSystem,
  getCloudAdminUserDetail,
  getCloudAdminUsers,
  regenerateCloudAdminGenerationTask,
  reviewCloudAdminRegistration,
  revokeCloudAdminUserSessions,
  scanCloudAdminOrphans,
  testCloudAdminPlatformSettings,
  updateCloudAdminUser,
  updateCloudAdminPlatformSettings,
  type CloudAdminAuditLog,
  type CloudAdminGenerationAudit,
  type CloudAdminGenerationAuditImage,
  type CloudAdminOrphanScan,
  type CloudAdminOverview,
  type CloudPlatformSettings,
  type CloudPlatformTestResult,
  type CloudAdminSystemSnapshot,
  type CloudAdminUser,
  type CloudAdminUserDetail,
} from '../lib/cloudApi'
import { DEFAULT_SETTINGS, normalizeSettings, normalizeStreamPartialImages } from '../lib/apiProfiles'
import { applyPlatformSettingsToAppSettings } from '../lib/platformSettings'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS } from '../types'
import { useStore } from '../store'
import { CloseIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons'

type AdminStatusFilter = 'all' | 'pending' | 'enabled' | 'disabled' | 'rejected'
type AdminRoleFilter = 'all' | 'admin' | 'user'
type GenerationSourceFilter = 'all' | 'gallery' | 'agent'
type AdminTab = 'users' | 'generations' | 'audit' | 'config' | 'ops' | 'monitor' | 'account'
type GenerationAuditOverviewKind = 'gallery' | 'agent'

type GenerationAuditOverviewItem = {
  key: string
  kind: GenerationAuditOverviewKind
  title: string
  subtitle: string
  audits: CloudAdminGenerationAudit[]
  previewImages: CloudAdminGenerationAuditImage[]
  latestAt: number
  status: CloudAdminGenerationAudit['task']['status']
}

type AuditDetailEntry = {
  key: string
  label: string
  value: unknown
  displayValue: string
  isComplex: boolean
}

const adminTabs: Array<{ value: AdminTab; label: string }> = [
  { value: 'users', label: '用户' },
  { value: 'generations', label: '生成审计' },
  { value: 'audit', label: '操作日志' },
  { value: 'config', label: '配置' },
  { value: 'ops', label: '运维' },
  { value: 'monitor', label: '监控' },
  { value: 'account', label: '账号' },
]

const statusFilters: Array<{ value: AdminStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'enabled', label: '启用' },
  { value: 'disabled', label: '禁用' },
  { value: 'rejected', label: '已拒绝' },
]

const roleFilters: Array<{ value: AdminRoleFilter; label: string }> = [
  { value: 'all', label: '全部角色' },
  { value: 'admin', label: '管理员' },
  { value: 'user', label: '普通用户' },
]

const generationSourceFilters: Array<{ value: GenerationSourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'gallery', label: '画廊' },
  { value: 'agent', label: 'Agent' },
]

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDate(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function getAuditActionLabel(action: string) {
  const labels: Record<string, string> = {
    'user.create': '创建用户',
    'user.update': '更新用户',
    'user.clear_data': '清空用户数据',
    'user.revoke_sessions': '清理会话',
    'user.delete': '删除用户',
    'user.batch_disable': '批量禁用',
    'user.batch_enable': '批量启用',
    'user.batch_clear_data': '批量清空数据',
    'user.registration_request': '注册申请',
    'user.registration_auto_approve': '注册自动通过',
    'user.registration_approve': '通过注册',
    'user.registration_reject': '拒绝注册',
    'maintenance.delete_orphans': '清理孤立对象',
    'platform.update': '更新平台配置',
  }
  return labels[action] ?? action
}

const auditDetailLabels: Record<string, string> = {
  activeProfileId: '当前配置',
  agentLocked: 'Agent 锁定',
  allowUserProfiles: '允许个人配置',
  apiManaged: 'API 托管',
  count: '数量',
  deletedUserId: '删除用户 ID',
  email: '邮箱',
  ids: 'ID 列表',
  isAdmin: '管理员',
  reapplied: '重新申请',
  maxToolRounds: '最大工具轮次',
  storageQuotaBytes: '存储额度',
  taskQuotaCount: '任务额度',
  webSearchEnabled: '联网搜索',
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatAuditDetailValue(key: string, value: unknown) {
  if (value == null) return key === 'storageQuotaBytes' || key === 'taskQuotaCount' ? '不限' : '未设置'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return key === 'storageQuotaBytes' ? formatBytes(value) : String(value)
  if (typeof value === 'string') return value.trim() || '-'
  if (Array.isArray(value)) return value.length ? `${value.length} 项` : '空列表'
  if (isPlainRecord(value)) return `${Object.keys(value).length} 项`
  return String(value)
}

function getAuditDetailEntries(details: Record<string, unknown> | null | undefined): AuditDetailEntry[] {
  return Object.entries(details ?? {}).map(([key, value]) => ({
    key,
    label: auditDetailLabels[key] ?? key,
    value,
    displayValue: formatAuditDetailValue(key, value),
    isComplex: Array.isArray(value) || isPlainRecord(value),
  }))
}

function getPlatformTestStatusMeta(status: CloudPlatformTestResult['checks'][number]['status']) {
  switch (status) {
    case 'success':
      return { label: '通过', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' }
    case 'warning':
      return { label: '警告', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' }
    case 'skipped':
      return { label: '跳过', className: 'bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300' }
    case 'error':
    default:
      return { label: '失败', className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' }
  }
}

function openWorkbench() {
  window.history.pushState(null, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function createFallbackPlatformSettings(): CloudPlatformSettings {
  return {
    registration: {
      requireApproval: true,
    },
    api: {
      managed: false,
      allowUserProfiles: true,
      settings: normalizeSettings(DEFAULT_SETTINGS),
    },
    agent: {
      lockSettings: false,
      maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
      webSearchEnabled: false,
    },
    updatedAt: null,
  }
}

function syncPlatformSettingsToWorkbench(platformSettings: CloudPlatformSettings) {
  useStore.setState((state) => ({
    platformSettings,
    settings: applyPlatformSettingsToAppSettings(state.settings, platformSettings),
  }))
}

function getUserRegistrationStatus(user: CloudAdminUser) {
  return user.registrationStatus ?? 'approved'
}

function isUserPendingApproval(user: CloudAdminUser) {
  return getUserRegistrationStatus(user) === 'pending'
}

function isUserRejected(user: CloudAdminUser) {
  return getUserRegistrationStatus(user) === 'rejected'
}

function getUserStatusMeta(user: CloudAdminUser) {
  if (isUserPendingApproval(user)) {
    return { label: '待审批', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' }
  }
  if (isUserRejected(user)) {
    return { label: '已拒绝', className: 'bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300' }
  }
  if (user.disabledAt) {
    return { label: '已禁用', className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' }
  }
  return { label: '启用', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' }
}

function getTaskStatusMeta(status: CloudAdminGenerationAudit['task']['status']) {
  switch (status) {
    case 'done':
      return { label: '完成', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' }
    case 'running':
      return { label: '生成中', className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' }
    case 'error':
    default:
      return { label: '失败', className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' }
  }
}

function getImageRoleLabel(role: CloudAdminGenerationAuditImage['role']) {
  const labels: Record<CloudAdminGenerationAuditImage['role'], string> = {
    input: '输入',
    mask: '遮罩',
    output: '输出',
    partial: '中间',
  }
  return labels[role]
}

function isAgentAudit(audit: CloudAdminGenerationAudit) {
  return audit.task.sourceMode === 'agent' || Boolean(audit.task.agentConversationId || audit.agentContext)
}

function getShortId(value: string | null | undefined) {
  if (!value) return ''
  return value.length <= 8 ? value : value.slice(0, 8)
}

function getAgentTitle(audit: CloudAdminGenerationAudit) {
  const title = audit.agentContext?.title?.trim()
  if (title) return title
  const id = audit.agentContext?.conversationId ?? audit.task.agentConversationId
  return id ? `未命名 Agent ${getShortId(id)}` : '未归属 Agent'
}

function getRoundLabel(audit: CloudAdminGenerationAudit) {
  const index = audit.agentContext?.roundIndex
  if (typeof index === 'number') return `第 ${index} 轮`
  const roundId = audit.agentContext?.roundId ?? audit.task.agentRoundId
  return roundId ? `轮次 ${getShortId(roundId)}` : null
}

function getToolActionLabel(action: string | null | undefined) {
  const labels: Record<string, string> = {
    generate: '生成',
    edit: '编辑',
    auto: '自动',
  }
  return action ? labels[action] ?? action : null
}

function filterGenerationAuditsBySource(audits: CloudAdminGenerationAudit[], filter: GenerationSourceFilter) {
  if (filter === 'all') return audits
  return audits.filter((audit) => (filter === 'agent' ? isAgentAudit(audit) : !isAgentAudit(audit)))
}

function getAuditTime(audit: CloudAdminGenerationAudit) {
  return audit.task.createdAt || new Date(audit.updatedAt).getTime() || 0
}

function getAuditOutputImages(audit: CloudAdminGenerationAudit) {
  return audit.images.filter((image) => image.role === 'output' || image.role === 'partial')
}

function getAuditPreviewImages(audit: CloudAdminGenerationAudit) {
  const outputImages = getAuditOutputImages(audit)
  if (outputImages.length) return outputImages
  return audit.images.filter((image) => image.role === 'input' || image.role === 'mask')
}

function getAuditGroupStatus(audits: CloudAdminGenerationAudit[]): CloudAdminGenerationAudit['task']['status'] {
  if (audits.some((audit) => audit.task.status === 'running')) return 'running'
  if (audits.some((audit) => audit.task.status === 'error')) return 'error'
  return 'done'
}

function getAuditGroupImageCount(audits: CloudAdminGenerationAudit[]) {
  const ids = new Set<string>()
  for (const audit of audits) {
    for (const image of getAuditOutputImages(audit)) ids.add(`${image.role}:${image.id}`)
  }
  return ids.size
}

function buildGenerationAuditOverviewItems(audits: CloudAdminGenerationAudit[], showUser: boolean): GenerationAuditOverviewItem[] {
  const items: GenerationAuditOverviewItem[] = []
  const agentGroups = new Map<string, CloudAdminGenerationAudit[]>()

  for (const audit of audits) {
    if (!isAgentAudit(audit)) {
      const latestAt = getAuditTime(audit)
      items.push({
        key: `gallery:${audit.user.id}:${audit.task.id}`,
        kind: 'gallery',
        title: audit.task.prompt || '（无提示词）',
        subtitle: `${showUser ? `${audit.user.email} · ` : ''}${formatDate(new Date(latestAt).toISOString())}`,
        audits: [audit],
        previewImages: getAuditPreviewImages(audit).slice(0, 4),
        latestAt,
        status: audit.task.status,
      })
      continue
    }

    const conversationId = audit.agentContext?.conversationId ?? audit.task.agentConversationId ?? 'unknown'
    const key = `agent:${showUser ? `${audit.user.id}:` : ''}${conversationId}`
    const group = agentGroups.get(key)
    if (group) group.push(audit)
    else agentGroups.set(key, [audit])
  }

  for (const [key, group] of agentGroups) {
    const latestAudit = [...group].sort((a, b) => getAuditTime(b) - getAuditTime(a))[0]!
    const latestAt = getAuditTime(latestAudit)
    const conversationId = latestAudit.agentContext?.conversationId ?? latestAudit.task.agentConversationId
    const previewImages = group.flatMap(getAuditPreviewImages).slice(0, 4)
    items.push({
      key,
      kind: 'agent',
      title: getAgentTitle(latestAudit),
      subtitle: `${showUser ? `${latestAudit.user.email} · ` : ''}${conversationId ? `对话 ${getShortId(conversationId)}` : '未绑定对话'}`,
      audits: group.sort((a, b) => getAuditTime(b) - getAuditTime(a)),
      previewImages,
      latestAt,
      status: getAuditGroupStatus(group),
    })
  }

  return items.sort((a, b) => b.latestAt - a.latestAt)
}

function formatDuration(ms: number | null) {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function AuditDetailSummary({ details }: { details: Record<string, unknown> }) {
  const entries = getAuditDetailEntries(details)
  if (!entries.length) {
    return <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">无详情</div>
  }

  const visibleEntries = entries.slice(0, 4)
  const remainingCount = entries.length - visibleEntries.length

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visibleEntries.map((entry) => (
        <span key={entry.key} className="inline-flex max-w-full items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
          <span className="shrink-0 text-gray-400 dark:text-gray-500">{entry.label}</span>
          <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-200">{entry.displayValue}</span>
        </span>
      ))}
      {remainingCount > 0 && (
        <span className="rounded-md bg-gray-100 px-2 py-1 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
          +{remainingCount} 项
        </span>
      )}
    </div>
  )
}

function AuditDetailValue({ entry }: { entry: AuditDetailEntry }) {
  if (!entry.isComplex) {
    return <div className="mt-1 break-words text-sm font-medium text-gray-900 dark:text-gray-100">{entry.displayValue}</div>
  }

  return (
    <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-relaxed text-gray-100">
      {formatJson(entry.value)}
    </pre>
  )
}

function AuditLogRow({ log, onOpen }: { log: CloudAdminAuditLog; onOpen: () => void }) {
  return (
    <div className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[160px_minmax(0,1fr)_210px]">
      <div className="min-w-0">
        <div className="font-medium text-gray-900 dark:text-gray-100">{getAuditActionLabel(log.action)}</div>
        <div className="mt-1 truncate text-[11px] text-gray-400 dark:text-gray-500">{log.action}</div>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="min-w-0">
            操作人：
            <span className="font-medium text-gray-700 dark:text-gray-200">{log.actorEmail ?? '-'}</span>
          </span>
          <span className="min-w-0">
            目标：
            <span className="font-medium text-gray-700 dark:text-gray-200">{log.targetEmail ?? '-'}</span>
          </span>
        </div>
        <AuditDetailSummary details={log.details ?? {}} />
      </div>
      <div className="flex items-center justify-between gap-2 md:justify-end">
        <div className="text-xs text-gray-500 dark:text-gray-400 md:text-right">{formatDate(log.createdAt)}</div>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
        >
          查看
        </button>
      </div>
    </div>
  )
}

function AuditLogDetailModal({ log, onClose }: { log: CloudAdminAuditLog; onClose: () => void }) {
  const entries = getAuditDetailEntries(log.details)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭日志详情" onClick={onClose} />
      <section className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-white/[0.1] dark:bg-gray-950">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{getAuditActionLabel(log.action)}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{log.action} · {formatDate(log.createdAt)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            aria-label="关闭"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto px-4 py-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              ['操作人', log.actorEmail ?? '-'],
              ['目标用户', log.targetEmail ?? '-'],
              ['IP', log.ip ?? '-'],
              ['时间', formatDate(log.createdAt)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.04]">
                <div className="text-gray-400 dark:text-gray-500">{label}</div>
                <div className="mt-1 break-words font-medium text-gray-800 dark:text-gray-100">{value}</div>
              </div>
            ))}
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-900 dark:text-gray-100">详情字段</h4>
            {entries.length > 0 ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {entries.map((entry) => (
                  <div key={entry.key} className="rounded-lg border border-gray-200 p-3 dark:border-white/[0.08]">
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">{entry.label}</div>
                    <AuditDetailValue entry={entry} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-500 dark:border-white/[0.08]">
                这条日志没有附加详情
              </div>
            )}
          </div>

          <details className="rounded-lg bg-gray-50 text-xs dark:bg-white/[0.04]">
            <summary className="cursor-pointer px-3 py-2 font-medium text-gray-700 dark:text-gray-200">原始 JSON</summary>
            <pre className="max-h-64 overflow-auto border-t border-gray-200 p-3 text-gray-700 dark:border-white/[0.08] dark:text-gray-200">
              {formatJson(log.details)}
            </pre>
          </details>

          <details className="rounded-lg bg-gray-50 text-xs dark:bg-white/[0.04]">
            <summary className="cursor-pointer px-3 py-2 font-medium text-gray-700 dark:text-gray-200">请求环境</summary>
            <div className="space-y-2 border-t border-gray-200 p-3 dark:border-white/[0.08]">
              <div className="break-words text-gray-600 dark:text-gray-300">IP：{log.ip ?? '-'}</div>
              <div className="break-words text-gray-600 dark:text-gray-300">User-Agent：{log.userAgent ?? '-'}</div>
            </div>
          </details>
        </div>
      </section>
    </div>
  )
}

function AuditImageThumb({ image }: { image: CloudAdminGenerationAuditImage }) {
  const [src, setSrc] = useState(image.thumbnailUrl)

  useEffect(() => {
    setSrc(image.thumbnailUrl)
  }, [image.thumbnailUrl])

  if (image.missing) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-gray-200 text-[11px] text-gray-400 dark:border-white/[0.08] sm:h-[4.5rem] sm:w-[4.5rem]">
        已丢失
      </div>
    )
  }

  return (
    <a
      href={image.imageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block h-16 w-16 shrink-0 overflow-hidden rounded-md border border-gray-200 bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] sm:h-[4.5rem] sm:w-[4.5rem]"
      title={`${getImageRoleLabel(image.role)} · ${formatBytes(image.byteSize)}`}
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
        onError={() => {
          if (src !== image.imageUrl) setSrc(image.imageUrl)
        }}
      />
      <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-none text-white">
        {getImageRoleLabel(image.role)}
      </span>
    </a>
  )
}

function AuditImageGroup({ title, emptyText, images }: { title: string; emptyText: string; images: CloudAdminGenerationAuditImage[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-normal text-gray-500 dark:text-gray-400">{title}</h4>
        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{images.length}</span>
      </div>
      {images.length ? (
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
          {images.map((image) => <AuditImageThumb key={`${image.role}:${image.id}`} image={image} />)}
        </div>
      ) : (
        <div className="flex h-16 items-center rounded-md border border-dashed border-gray-200 px-3 text-xs text-gray-400 dark:border-white/[0.08]">
          {emptyText}
        </div>
      )}
    </div>
  )
}

function GenerationAuditCard({
  audit,
  showUser = true,
  regenerating,
  onRegenerate,
}: {
  audit: CloudAdminGenerationAudit
  showUser?: boolean
  regenerating?: boolean
  onRegenerate?: (audit: CloudAdminGenerationAudit) => void
}) {
  const { task } = audit
  const status = getTaskStatusMeta(task.status)
  const sourceIsAgent = isAgentAudit(audit)
  const roundLabel = getRoundLabel(audit)
  const toolActionLabel = getToolActionLabel(audit.agentContext?.toolAction ?? task.agentToolAction)
  const requestImages = audit.images.filter((image) => image.role === 'input' || image.role === 'mask')
  const outputImages = audit.images.filter((image) => image.role === 'output' || image.role === 'partial')
  const requestPayload = {
    prompt: task.prompt,
    params: task.params,
    apiProvider: task.apiProvider,
    apiProfileName: task.apiProfileName,
    apiMode: task.apiMode,
    apiModel: task.apiModel,
    sourceMode: task.sourceMode ?? 'gallery',
    agentContext: audit.agentContext ?? null,
    inputImageIds: task.inputImageIds,
    maskImageId: task.maskImageId ?? null,
  }
  const responsePayload = {
    outputImages: task.outputImages,
    streamPartialImageIds: task.streamPartialImageIds ?? [],
    actualParams: task.actualParams ?? null,
    actualParamsByImage: task.actualParamsByImage ?? null,
    revisedPromptByImage: task.revisedPromptByImage ?? null,
    rawImageUrls: task.rawImageUrls ?? [],
    rawResponsePayload: task.rawResponsePayload ?? null,
    error: task.error,
  }

  return (
    <article className="rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-sm shadow-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-black/20 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 pb-3 dark:border-white/[0.06]">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
            {showUser && <span className="max-w-[220px] truncate text-gray-500 dark:text-gray-400">{audit.user.email}</span>}
            <span className="text-gray-400">{formatDate(new Date(task.createdAt).toISOString())}</span>
            <span className="text-gray-400">耗时 {formatDuration(task.elapsed)}</span>
          </div>
          <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm font-medium leading-6 text-gray-900 dark:text-gray-100" title={task.prompt || task.id}>
            {task.prompt || task.id}
          </p>
        </div>
        <div className="flex max-w-full flex-col items-start gap-2 sm:items-end">
          <div className="flex max-w-full flex-wrap gap-1.5 text-[11px] text-gray-500 sm:justify-end">
            <span className={`rounded px-2 py-1 ${sourceIsAgent ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'}`}>
              {sourceIsAgent ? 'Agent' : '画廊'}
            </span>
            {sourceIsAgent && roundLabel && <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{roundLabel}</span>}
            {sourceIsAgent && toolActionLabel && <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{toolActionLabel}</span>}
            <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{task.apiProvider ?? 'unknown'}</span>
            <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{task.apiMode ?? '-'}</span>
            <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{task.apiModel ?? '-'}</span>
          </div>
          {sourceIsAgent && task.status !== 'running' && onRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate(audit)}
              disabled={regenerating}
              className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-400/30 dark:text-blue-200 dark:hover:bg-blue-500/10"
            >
              {regenerating ? '重生成中...' : '原任务重生成'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(160px,0.75fr)_minmax(260px,1.25fr)]">
        <AuditImageGroup title="请求图片" emptyText="无输入图" images={requestImages} />
        <AuditImageGroup title="生成图片" emptyText="暂无生成图片" images={outputImages} />
      </div>

      <details className="mt-3 rounded-md bg-gray-50 text-xs dark:bg-gray-950/50">
        <summary className="cursor-pointer px-3 py-2 font-medium text-gray-600 dark:text-gray-300">请求与响应详情</summary>
        <div className="grid gap-3 px-3 pb-3 lg:grid-cols-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-3 text-gray-600 dark:bg-black/20 dark:text-gray-300">{formatJson(requestPayload)}</pre>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-3 text-gray-600 dark:bg-black/20 dark:text-gray-300">{formatJson(responsePayload)}</pre>
        </div>
      </details>
    </article>
  )
}

function GenerationPreviewPane({ item }: { item: GenerationAuditOverviewItem }) {
  const firstImage = item.previewImages.find((image) => !image.missing)
  if (!firstImage) {
    const status = getTaskStatusMeta(item.status)
    return (
      <div className="flex h-full min-h-[8.5rem] items-center justify-center bg-gray-100 dark:bg-black/20">
        <div className="text-center">
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
          <div className="mt-2 text-xs text-gray-400">无预览图</div>
        </div>
      </div>
    )
  }

  if (item.kind === 'agent' && item.previewImages.length > 1) {
    return (
      <div className="grid h-full min-h-[8.5rem] grid-cols-2 grid-rows-2 gap-px bg-gray-200 dark:bg-white/[0.08]">
        {item.previewImages.slice(0, 4).map((image) => (
          <img key={`${image.role}:${image.id}`} src={image.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ))}
      </div>
    )
  }

  return (
    <div className="h-full min-h-[8.5rem] bg-gray-100 dark:bg-black/20">
      <img src={firstImage.thumbnailUrl} alt="" className="h-full w-full object-cover" />
    </div>
  )
}

function GenerationOverviewCard({
  item,
  selected,
  loading,
  onOpen,
}: {
  item: GenerationAuditOverviewItem
  selected: boolean
  loading: boolean
  onOpen: () => void
}) {
  const status = getTaskStatusMeta(item.status)
  const firstAudit = item.audits[0]
  const model = firstAudit?.task.apiModel ?? '-'
  const outputCount = getAuditGroupImageCount(item.audits)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`group grid min-h-[10rem] overflow-hidden rounded-lg border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-white/[0.04] md:grid-cols-[42%_minmax(0,1fr)] ${selected ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-gray-200 dark:border-white/[0.08]'}`}
    >
      <div className="relative h-full">
        <GenerationPreviewPane item={item} />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
          <span className={`rounded bg-black/65 px-2 py-1 text-[11px] font-medium text-white ${item.kind === 'agent' ? 'bg-violet-600/85' : ''}`}>
            {item.kind === 'agent' ? 'Agent' : '画廊'}
          </span>
          <span className="rounded bg-black/65 px-2 py-1 text-[11px] font-medium text-white">
            {item.kind === 'agent' ? `${item.audits.length} 次` : formatDuration(firstAudit?.task.elapsed ?? null)}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
          <span className="shrink-0 text-xs text-gray-400">{formatDate(new Date(item.latestAt).toISOString())}</span>
        </div>
        <h3 className="mt-3 line-clamp-3 min-h-[4.5rem] text-base font-semibold leading-6 text-gray-900 dark:text-gray-100">
          {item.kind === 'agent' ? `Agent：${item.title}` : item.title}
        </h3>
        <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{item.subtitle}</p>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-3 text-[11px] text-gray-500">
          <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">{model}</span>
          <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">输出 {outputCount}</span>
          {item.kind === 'agent' && <span className="rounded bg-gray-100 px-2 py-1 dark:bg-white/[0.06]">点击查看完整 Agent</span>}
          {loading && <span className="rounded bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">加载中</span>}
        </div>
      </div>
    </button>
  )
}

function GenerationAuditDetailModal({
  item,
  showUser,
  loading,
  regeneratingTaskId,
  onRegenerate,
  onClose,
}: {
  item: GenerationAuditOverviewItem
  showUser: boolean
  loading: boolean
  regeneratingTaskId?: string | null
  onRegenerate?: (audit: CloudAdminGenerationAudit) => void
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭审计详情" onClick={onClose} />
      <section className="relative flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-white/[0.1] dark:bg-gray-950">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.kind === 'agent' ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'}`}>
                {item.kind === 'agent' ? 'Agent' : '画廊'}
              </span>
              <h3 className="truncate text-sm font-semibold">{item.kind === 'agent' ? `Agent：${item.title}` : item.title}</h3>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {item.subtitle} · {item.audits.length} 次请求 · {getAuditGroupImageCount(item.audits)} 张输出
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            关闭
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">
          {loading && <div className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">正在加载完整 Agent 审计...</div>}
          <div className="space-y-3">
            {item.audits.map((audit) => (
              <GenerationAuditCard
                key={`${audit.user.id}:${audit.task.id}`}
                audit={audit}
                showUser={showUser}
                regenerating={regeneratingTaskId === audit.task.id}
                onRegenerate={onRegenerate}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function GenerationAuditOverviewGrid({ audits, showUser = true, onError }: { audits: CloudAdminGenerationAudit[]; showUser?: boolean; onError?: (message: string) => void }) {
  const items = useMemo(() => buildGenerationAuditOverviewItems(audits, showUser), [audits, showUser])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [expandedAudits, setExpandedAudits] = useState<Record<string, CloudAdminGenerationAudit[]>>({})
  const [regeneratingTaskId, setRegeneratingTaskId] = useState<string | null>(null)

  useEffect(() => {
    if (selectedKey && !items.some((item) => item.key === selectedKey)) setSelectedKey(null)
  }, [items, selectedKey])

  const openItem = async (item: GenerationAuditOverviewItem) => {
    setSelectedKey(item.key)
    if (item.kind !== 'agent' || expandedAudits[item.key]) return

    const audit = item.audits[0]
    const conversationId = audit?.agentContext?.conversationId ?? audit?.task.agentConversationId
    if (!audit || !conversationId) return
    setLoadingKey(item.key)
    try {
      const fullAudits = await getCloudAdminGenerationAudits({
        userId: audit.user.id,
        agentConversationId: conversationId,
        limit: 1000,
      })
      setExpandedAudits((current) => ({ ...current, [item.key]: fullAudits }))
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingKey((current) => (current === item.key ? null : current))
    }
  }

  const regenerateAudit = async (audit: CloudAdminGenerationAudit) => {
    if (regeneratingTaskId) return
    setRegeneratingTaskId(audit.task.id)
    try {
      const regenerated = await regenerateCloudAdminGenerationTask({
        userId: audit.user.id,
        taskId: audit.task.id,
      })
      setExpandedAudits((current) => {
        if (!selectedKey || !current[selectedKey]) return current
        return {
          ...current,
          [selectedKey]: current[selectedKey].map((item) =>
            item.task.id === regenerated.task.id && item.user.id === regenerated.user.id ? regenerated : item,
          ),
        }
      })
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      setRegeneratingTaskId(null)
    }
  }

  const selectedBaseItem = items.find((item) => item.key === selectedKey) ?? null
  const selectedItem = selectedBaseItem && expandedAudits[selectedBaseItem.key]
    ? { ...selectedBaseItem, audits: expandedAudits[selectedBaseItem.key], status: getAuditGroupStatus(expandedAudits[selectedBaseItem.key]) }
    : selectedBaseItem

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {items.map((item) => (
          <GenerationOverviewCard
            key={item.key}
            item={item}
            selected={selectedKey === item.key}
            loading={loadingKey === item.key}
            onOpen={() => void openItem(item)}
          />
        ))}
      </div>
      {selectedItem && (
        <GenerationAuditDetailModal
          item={selectedItem}
          showUser={showUser}
          loading={loadingKey === selectedItem.key}
          regeneratingTaskId={regeneratingTaskId}
          onRegenerate={(audit) => void regenerateAudit(audit)}
          onClose={() => setSelectedKey(null)}
        />
      )}
    </div>
  )
}

export default function AdminPage() {
  const cloudUser = useStore((state) => state.cloudUser)
  const cloudAuthChecked = useStore((state) => state.cloudAuthChecked)
  const showToast = useStore((state) => state.showToast)
  const setConfirmDialog = useStore((state) => state.setConfirmDialog)
  const setShowLogin = useStore((state) => state.setShowLogin)
  const [overview, setOverview] = useState<CloudAdminOverview | null>(null)
  const [users, setUsers] = useState<CloudAdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newIsAdmin, setNewIsAdmin] = useState(false)
  const [rowPasswords, setRowPasswords] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<AdminStatusFilter>('all')
  const [roleFilter, setRoleFilter] = useState<AdminRoleFilter>('all')
  const [busyUserIds, setBusyUserIds] = useState<Record<string, boolean>>({})
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [selectedUserIds, setSelectedUserIds] = useState<Record<string, boolean>>({})
  const [userDetail, setUserDetail] = useState<CloudAdminUserDetail | null>(null)
  const [detailQuota, setDetailQuota] = useState({ storageQuotaGiB: '', taskQuotaCount: '' })
  const [auditLogs, setAuditLogs] = useState<CloudAdminAuditLog[]>([])
  const [selectedAuditLog, setSelectedAuditLog] = useState<CloudAdminAuditLog | null>(null)
  const [generationAudits, setGenerationAudits] = useState<CloudAdminGenerationAudit[]>([])
  const [generationAuditUserId, setGenerationAuditUserId] = useState('')
  const [generationSourceFilter, setGenerationSourceFilter] = useState<GenerationSourceFilter>('all')
  const [systemSnapshot, setSystemSnapshot] = useState<CloudAdminSystemSnapshot | null>(null)
  const [orphanScan, setOrphanScan] = useState<CloudAdminOrphanScan | null>(null)
  const [opsBusy, setOpsBusy] = useState(false)
  const [accountPasswords, setAccountPasswords] = useState({ currentPassword: '', newPassword: '' })
  const [platformSettings, setPlatformSettings] = useState<CloudPlatformSettings | null>(null)
  const [platformDraft, setPlatformDraft] = useState<CloudPlatformSettings | null>(null)
  const [platformCustomProvidersJson, setPlatformCustomProvidersJson] = useState('[]')
  const [platformSaving, setPlatformSaving] = useState(false)
  const [platformTesting, setPlatformTesting] = useState(false)
  const [platformTestResult, setPlatformTestResult] = useState<CloudPlatformTestResult | null>(null)

  const canManage = Boolean(cloudUser?.isAdmin)

  const loadAdminData = useCallback(async () => {
    if (!canManage) return
    setLoading(true)
    try {
      const [nextOverview, nextUsers] = await Promise.all([
        getCloudAdminOverview(),
        getCloudAdminUsers(),
      ])
      setOverview(nextOverview)
      setUsers(nextUsers)
      setSelectedUserIds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => nextUsers.some((user) => user.id === id))))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
    }
  }, [canManage, showToast])

  useEffect(() => {
    void loadAdminData()
  }, [loadAdminData])

  const loadAuditLogs = useCallback(async () => {
    if (!canManage) return
    try {
      setAuditLogs(await getCloudAdminAuditLogs(120))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [canManage, showToast])

  const loadGenerationAudits = useCallback(async () => {
    if (!canManage) return
    try {
      setGenerationAudits(await getCloudAdminGenerationAudits({
        userId: generationAuditUserId || undefined,
        limit: 120,
      }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [canManage, generationAuditUserId, showToast])

  const loadSystemSnapshot = useCallback(async () => {
    if (!canManage) return
    try {
      setSystemSnapshot(await getCloudAdminSystem())
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [canManage, showToast])

  const loadPlatformSettings = useCallback(async () => {
    if (!canManage) return
    try {
      const next = await getCloudAdminPlatformSettings()
      setPlatformSettings(next)
      setPlatformDraft(next)
      syncPlatformSettingsToWorkbench(next)
      setPlatformCustomProvidersJson(JSON.stringify(next.api.settings.customProviders, null, 2))
      setPlatformTestResult(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [canManage, showToast])

  useEffect(() => {
    if (activeTab === 'generations') void loadGenerationAudits()
    if (activeTab === 'audit') void loadAuditLogs()
    if (activeTab === 'config') void loadPlatformSettings()
    if (activeTab === 'monitor' || activeTab === 'ops') void loadSystemSnapshot()
  }, [activeTab, loadAuditLogs, loadGenerationAudits, loadPlatformSettings, loadSystemSnapshot])

  const stats = useMemo(() => [
    { label: '用户', value: String(overview?.userCount ?? 0) },
    { label: '待审批', value: String(overview?.pendingRegistrationCount ?? users.filter(isUserPendingApproval).length) },
    { label: '禁用', value: String(overview?.disabledUserCount ?? 0) },
    { label: '任务', value: String(overview?.taskCount ?? 0) },
    { label: '图片', value: String(overview?.imageCount ?? 0) },
    { label: '存储', value: formatBytes(overview?.storageBytes ?? 0) },
  ], [overview, users])

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return users.filter((user) => {
      if (keyword && !user.email.toLowerCase().includes(keyword)) return false
      if (statusFilter === 'pending' && !isUserPendingApproval(user)) return false
      if (statusFilter === 'rejected' && !isUserRejected(user)) return false
      if (statusFilter === 'enabled' && (user.disabledAt || getUserRegistrationStatus(user) !== 'approved')) return false
      if (statusFilter === 'disabled' && (!user.disabledAt || getUserRegistrationStatus(user) !== 'approved')) return false
      if (roleFilter === 'admin' && !user.isAdmin) return false
      if (roleFilter === 'user' && user.isAdmin) return false
      return true
    })
  }, [query, roleFilter, statusFilter, users])

  const pendingRegistrationUsers = useMemo(
    () => users.filter(isUserPendingApproval).sort((a, b) => new Date(a.registrationRequestedAt ?? a.createdAt).getTime() - new Date(b.registrationRequestedAt ?? b.createdAt).getTime()),
    [users],
  )

  const filteredGenerationAudits = useMemo(
    () => filterGenerationAuditsBySource(generationAudits, generationSourceFilter),
    [generationAudits, generationSourceFilter],
  )

  const selectedIds = useMemo(() => Object.entries(selectedUserIds).filter(([, selected]) => selected).map(([id]) => id), [selectedUserIds])
  const selectableFilteredUsers = filteredUsers.filter((user) => user.id !== cloudUser?.id)
  const platformApiSettings = useMemo(() => (
    platformDraft ? normalizeSettings(platformDraft.api.settings) : null
  ), [platformDraft])
  const platformActiveProfile = useMemo(() => {
    if (!platformApiSettings) return null
    return platformApiSettings.profiles.find((profile) => profile.id === platformApiSettings.activeProfileId) ?? platformApiSettings.profiles[0] ?? null
  }, [platformApiSettings])
  const platformProviderOptions = useMemo(() => {
    const customOptions = platformApiSettings?.customProviders.map((provider) => ({ value: provider.id, label: provider.name })) ?? []
    return [
      { value: 'openai', label: 'OpenAI' },
      { value: 'fal', label: 'fal.ai' },
      ...customOptions,
    ]
  }, [platformApiSettings])

  const runUserAction = async (id: string, action: () => Promise<void>) => {
    setBusyUserIds((current) => ({ ...current, [id]: true }))
    try {
      await action()
    } finally {
      setBusyUserIds((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }

  const createUser = async () => {
    if (!newEmail.trim() || !newPassword) {
      showToast('请输入邮箱和密码', 'error')
      return
    }
    if (newPassword.length < 8) {
      showToast('密码至少需要 8 位', 'error')
      return
    }
    try {
      await createCloudAdminUser({
        email: newEmail.trim(),
        password: newPassword,
        isAdmin: newIsAdmin,
      })
      setNewEmail('')
      setNewPassword('')
      setNewIsAdmin(false)
      showToast('用户已创建', 'success')
      await loadAdminData()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const loadUserDetail = async (user: CloudAdminUser) => {
    try {
      const detail = await getCloudAdminUserDetail(user.id)
      setUserDetail(detail)
      setDetailQuota({
        storageQuotaGiB: detail.user.storageQuotaBytes ? String(Math.round(detail.user.storageQuotaBytes / 1024 / 1024 / 1024)) : '',
        taskQuotaCount: detail.user.taskQuotaCount ? String(detail.user.taskQuotaCount) : '',
      })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const saveDetailQuota = async () => {
    if (!userDetail) return
    const storageQuotaGiB = detailQuota.storageQuotaGiB.trim()
    const taskQuotaCount = detailQuota.taskQuotaCount.trim()
    const storageQuotaBytes = storageQuotaGiB ? Number(storageQuotaGiB) * 1024 * 1024 * 1024 : null
    const taskQuota = taskQuotaCount ? Number(taskQuotaCount) : null
    if ((storageQuotaBytes != null && (!Number.isFinite(storageQuotaBytes) || storageQuotaBytes < 0)) || (taskQuota != null && (!Number.isFinite(taskQuota) || taskQuota < 0))) {
      showToast('配额必须是非负数字', 'error')
      return
    }
    await runUserAction(userDetail.user.id, async () => {
      try {
        await updateCloudAdminUser(userDetail.user.id, {
          storageQuotaBytes,
          taskQuotaCount: taskQuota,
        })
        showToast('配额已更新', 'success')
        await Promise.all([loadAdminData(), loadUserDetail(userDetail.user)])
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  }

  const runBatchAction = async (action: 'disable' | 'enable' | 'clearData') => {
    if (!selectedIds.length) {
      showToast('请选择用户', 'error')
      return
    }
    const actionLabel = action === 'disable' ? '禁用' : action === 'enable' ? '启用' : '清空数据'
    setConfirmDialog({
      title: `批量${actionLabel}`,
      message: `确定对 ${selectedIds.length} 个用户执行「${actionLabel}」吗？`,
      confirmText: actionLabel,
      tone: action === 'clearData' ? 'danger' : 'warning',
      action: () => {
        void batchCloudAdminUsers({ ids: selectedIds, action })
          .then(async () => {
            showToast(`已批量${actionLabel}`, 'success')
            setSelectedUserIds({})
            await loadAdminData()
          })
          .catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'))
      },
    })
  }

  const updateUser = async (id: string, patch: { password?: string; isAdmin?: boolean; disabled?: boolean }) => {
    if (typeof patch.password === 'string') {
      if (!patch.password) {
        showToast('请输入新密码', 'error')
        return
      }
      if (patch.password.length < 8) {
        showToast('密码至少需要 8 位', 'error')
        return
      }
    }
    await runUserAction(id, async () => {
      try {
        await updateCloudAdminUser(id, patch)
        if (patch.password) setRowPasswords((current) => ({ ...current, [id]: '' }))
        showToast(patch.password ? '用户已更新，旧会话已失效' : '用户已更新', 'success')
        await loadAdminData()
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  }

  const reviewRegistration = async (user: CloudAdminUser, action: 'approve' | 'reject') => {
    await runUserAction(user.id, async () => {
      try {
        await reviewCloudAdminRegistration(user.id, action)
        showToast(action === 'approve' ? '注册申请已通过' : '注册申请已拒绝', 'success')
        await Promise.all([loadAdminData(), activeTab === 'audit' ? loadAuditLogs() : Promise.resolve()])
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  }

  const confirmRejectRegistration = (user: CloudAdminUser) => {
    setConfirmDialog({
      title: '拒绝注册申请',
      message: `确定拒绝 ${user.email} 的注册申请吗？该邮箱之后可以重新提交申请。`,
      confirmText: '拒绝',
      tone: 'warning',
      action: () => {
        void reviewRegistration(user, 'reject')
      },
    })
  }

  const confirmClearUserData = (user: CloudAdminUser) => {
    setConfirmDialog({
      title: '清空用户数据',
      message: `确定清空 ${user.email} 的任务、图片、Agent 对话、配置和 API Key 吗？账号本身会保留。`,
      confirmText: '清空数据',
      tone: 'warning',
      action: () => {
        void runUserAction(user.id, async () => {
          try {
            await clearCloudAdminUserData(user.id)
            await loadAdminData()
            showToast('用户数据已清空', 'success')
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error')
          }
        })
      },
    })
  }

  const confirmRevokeUserSessions = (user: CloudAdminUser) => {
    setConfirmDialog({
      title: '清理用户会话',
      message: `确定让 ${user.email} 的所有已登录设备失效吗？该用户下次操作需要重新登录。`,
      confirmText: '清理会话',
      tone: 'warning',
      action: () => {
        void runUserAction(user.id, async () => {
          try {
            await revokeCloudAdminUserSessions(user.id)
            await loadAdminData()
            showToast('用户会话已清理', 'success')
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error')
          }
        })
      },
    })
  }

  const confirmDeleteUser = (user: CloudAdminUser) => {
    setConfirmDialog({
      title: '删除用户',
      message: `确定删除 ${user.email} 吗？该用户的云端数据和账号都会被删除。`,
      confirmText: '删除用户',
      tone: 'danger',
      action: () => {
        void runUserAction(user.id, async () => {
          try {
            await deleteCloudAdminUser(user.id)
            await loadAdminData()
            showToast('用户已删除', 'success')
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error')
          }
        })
      },
    })
  }

  const runOrphanScan = async (deleteObjects: boolean) => {
    setOpsBusy(true)
    try {
      const result = await scanCloudAdminOrphans(deleteObjects)
      setOrphanScan(result)
      await Promise.all([loadSystemSnapshot(), loadAuditLogs()])
      showToast(deleteObjects ? `已清理 ${result.orphanCount} 个孤立对象` : `扫描完成：${result.orphanCount} 个孤立对象`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setOpsBusy(false)
    }
  }

  const updatePlatformDraft = (updater: (current: CloudPlatformSettings) => CloudPlatformSettings) => {
    setPlatformDraft((current) => updater(current ?? platformSettings ?? createFallbackPlatformSettings()))
  }

  const updatePlatformApiSettings = (patch: Record<string, unknown>) => {
    updatePlatformDraft((current) => ({
      ...current,
      api: {
        ...current.api,
        settings: normalizeSettings({
          ...current.api.settings,
          ...patch,
        }),
      },
    }))
  }

  const updatePlatformActiveProfile = (patch: Record<string, unknown>) => {
    updatePlatformDraft((current) => {
      const settings = normalizeSettings(current.api.settings)
      const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0]
      if (!activeProfile) return current
      const profiles = settings.profiles.map((profile) =>
        profile.id === activeProfile.id
          ? { ...profile, ...patch }
          : profile,
      )
      return {
        ...current,
        api: {
          ...current.api,
          settings: normalizeSettings({
            ...settings,
            profiles,
            activeProfileId: activeProfile.id,
          }),
        },
      }
    })
  }

  const buildPlatformDraftForSubmit = (): CloudPlatformSettings | null => {
    const draft = platformDraft ?? createFallbackPlatformSettings()
    let customProviders: unknown
    try {
      customProviders = JSON.parse(platformCustomProvidersJson.trim() || '[]')
      if (!Array.isArray(customProviders)) {
        showToast('自定义服务商 JSON 必须是数组', 'error')
        return null
      }
    } catch {
      showToast('自定义服务商 JSON 格式无效', 'error')
      return null
    }

    const nextSettings = normalizeSettings({
      ...draft.api.settings,
      customProviders,
    })
    const nextDraft = {
      ...draft,
      api: {
        ...draft.api,
        settings: nextSettings,
      },
      agent: {
        ...draft.agent,
        maxToolRounds: Math.min(50, Math.max(1, Math.trunc(Number(draft.agent.maxToolRounds) || DEFAULT_AGENT_MAX_TOOL_ROUNDS))),
      },
    }
    return nextDraft
  }

  const savePlatformSettings = async () => {
    const nextDraft = buildPlatformDraftForSubmit()
    if (!nextDraft) return
    setPlatformSaving(true)
    try {
      const saved = await updateCloudAdminPlatformSettings(nextDraft)
      setPlatformSettings(saved)
      setPlatformDraft(saved)
      syncPlatformSettingsToWorkbench(saved)
      setPlatformCustomProvidersJson(JSON.stringify(saved.api.settings.customProviders, null, 2))
      setPlatformTestResult(null)
      showToast('平台配置已保存', 'success')
      await Promise.all([loadAuditLogs(), loadPlatformSettings()])
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setPlatformSaving(false)
    }
  }

  const testPlatformSettings = async () => {
    const nextDraft = buildPlatformDraftForSubmit()
    if (!nextDraft) return
    setPlatformTesting(true)
    setPlatformTestResult(null)
    try {
      const result = await testCloudAdminPlatformSettings(nextDraft)
      setPlatformTestResult(result)
      showToast(result.ok ? '平台配置测试通过' : '平台配置测试失败', result.ok ? 'success' : 'error')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setPlatformTesting(false)
    }
  }

  const changePassword = async () => {
    if (!accountPasswords.currentPassword || !accountPasswords.newPassword) {
      showToast('请输入当前密码和新密码', 'error')
      return
    }
    if (accountPasswords.newPassword.length < 8) {
      showToast('新密码至少需要 8 位', 'error')
      return
    }
    try {
      await changeCloudPassword(accountPasswords)
      setAccountPasswords({ currentPassword: '', newPassword: '' })
      showToast('密码已修改，其他设备会话已失效', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const toggleSelectedUser = (id: string, selected: boolean) => {
    setSelectedUserIds((current) => {
      const next = { ...current }
      if (selected) next[id] = true
      else delete next[id]
      return next
    })
  }

  const setAllFilteredSelected = (selected: boolean) => {
    setSelectedUserIds((current) => {
      const next = { ...current }
      for (const user of selectableFilteredUsers) {
        if (selected) next[user.id] = true
        else delete next[user.id]
      }
      return next
    })
  }

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/90">
        <div className="safe-area-x mx-auto flex max-w-7xl items-center justify-between py-3">
          <div>
            <h1 className="text-lg font-semibold">管理后台</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">用户、数据和系统用量</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadAdminData()}
              disabled={!canManage || loading}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
            >
              <RefreshIcon className="h-4 w-4" />
              刷新
            </button>
            <button
              type="button"
              onClick={openWorkbench}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              <CloseIcon className="h-4 w-4" />
              返回工作台
            </button>
          </div>
        </div>
      </header>

      <div className="safe-area-x mx-auto max-w-7xl py-5">
        {!cloudAuthChecked && (
          <section className="rounded-lg border border-gray-200 bg-white p-6 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <h2 className="text-base font-semibold">正在检查登录状态</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">请稍候，后台正在确认当前云端会话。</p>
          </section>
        )}

        {cloudAuthChecked && !cloudUser && (
          <section className="rounded-lg border border-gray-200 bg-white p-6 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <h2 className="text-base font-semibold">需要登录</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">请使用管理员账号登录云端工作台。</p>
            <button
              type="button"
              onClick={() => setShowLogin(true)}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              登录
            </button>
          </section>
        )}

        {cloudUser && !canManage && (
          <section className="rounded-lg border border-gray-200 bg-white p-6 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <h2 className="text-base font-semibold">无管理员权限</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">当前账号：{cloudUser.email}</p>
          </section>
        )}

        {canManage && (
          <div className="space-y-5">
            <section className="flex flex-wrap gap-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
              {adminTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActiveTab(tab.value)}
                  className={`rounded-md px-4 py-2 text-sm transition-colors ${activeTab === tab.value ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
                >
                  {tab.label}
                </button>
              ))}
            </section>

            {activeTab === 'users' && (
              <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
	              {stats.map((item) => (
	                <div key={item.label} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
	                  <div className="text-xs text-gray-500 dark:text-gray-400">{item.label}</div>
	                  <div className="mt-2 text-2xl font-semibold">{item.value}</div>
	                </div>
	              ))}
	            </section>

	            {pendingRegistrationUsers.length > 0 && (
	              <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-500/20 dark:bg-amber-500/10">
	                <div className="flex flex-wrap items-center justify-between gap-3">
	                  <div>
	                    <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-100">注册审批</h2>
	                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">新用户提交申请后，需要管理员通过才可登录云端工作台。</p>
	                  </div>
	                  <button
	                    type="button"
	                    onClick={() => setStatusFilter('pending')}
	                    className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-white/[0.06] dark:text-amber-100 dark:hover:bg-white/[0.1]"
	                  >
	                    查看全部
	                  </button>
	                </div>
	                <div className="mt-3 grid gap-3 lg:grid-cols-2">
	                  {pendingRegistrationUsers.slice(0, 6).map((user) => {
	                    const isBusy = Boolean(busyUserIds[user.id])
	                    return (
	                      <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-3 py-3 dark:border-amber-500/20 dark:bg-gray-950/40">
	                        <div className="min-w-0">
	                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{user.email}</div>
	                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">申请：{formatDate(user.registrationRequestedAt ?? user.createdAt)}</div>
	                        </div>
	                        <div className="flex gap-2">
	                          <button
	                            type="button"
	                            disabled={isBusy}
	                            onClick={() => void reviewRegistration(user, 'approve')}
	                            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
	                          >
	                            通过
	                          </button>
	                          <button
	                            type="button"
	                            disabled={isBusy}
	                            onClick={() => confirmRejectRegistration(user)}
	                            className="rounded-lg border border-amber-200 px-3 py-2 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:text-amber-200 dark:hover:bg-amber-500/10"
	                          >
	                            拒绝
	                          </button>
	                        </div>
	                      </div>
	                    )
	                  })}
	                </div>
	              </section>
	            )}

	            <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <h2 className="text-sm font-semibold">新增用户</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto_auto]">
                <input
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="邮箱"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950"
                />
                <input
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  type="password"
                  placeholder="初始密码"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950"
                />
                <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-white/[0.1]">
                  <input
                    type="checkbox"
                    checked={newIsAdmin}
                    onChange={(event) => setNewIsAdmin(event.target.checked)}
                  />
                  管理员
                </label>
                <button
                  type="button"
                  onClick={() => void createUser()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <PlusIcon className="h-4 w-4" />
                  创建
                </button>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.04]">
              <div className="space-y-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">用户列表</h2>
                  <span className="text-xs text-gray-500">
                    {loading ? '加载中...' : `${filteredUsers.length}/${users.length} 个用户`}
                  </span>
                </div>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索邮箱"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950"
                  />
                  <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
                    {statusFilters.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setStatusFilter(item.value)}
                        className={`rounded-md px-3 py-1.5 text-xs transition-colors ${statusFilter === item.value ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
                    {roleFilters.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setRoleFilter(item.value)}
                        className={`rounded-md px-3 py-1.5 text-xs transition-colors ${roleFilter === item.value ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <input
                      type="checkbox"
                      checked={selectableFilteredUsers.length > 0 && selectableFilteredUsers.every((user) => selectedUserIds[user.id])}
                      onChange={(event) => setAllFilteredSelected(event.target.checked)}
                    />
                    选择当前筛选用户
                  </label>
                  <span className="text-xs text-gray-400">已选 {selectedIds.length} 个</span>
                  <button
                    type="button"
                    disabled={!selectedIds.length}
                    onClick={() => void runBatchAction('disable')}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  >
                    批量禁用
                  </button>
                  <button
                    type="button"
                    disabled={!selectedIds.length}
                    onClick={() => void runBatchAction('enable')}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  >
                    批量启用
                  </button>
                  <button
                    type="button"
                    disabled={!selectedIds.length}
                    onClick={() => void runBatchAction('clearData')}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                  >
                    批量清空数据
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                    <tr>
                      <th className="w-10 px-4 py-3 font-medium"></th>
                      <th className="px-4 py-3 font-medium">用户</th>
                      <th className="px-4 py-3 font-medium">状态</th>
                      <th className="px-4 py-3 font-medium">用量</th>
                      <th className="px-4 py-3 font-medium">重置密码</th>
                      <th className="px-4 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-white/[0.06]">
	                    {filteredUsers.map((user) => {
	                      const isSelf = user.id === cloudUser?.id
	                      const isBusy = Boolean(busyUserIds[user.id])
	                      const statusMeta = getUserStatusMeta(user)
	                      return (
                        <tr key={user.id} className="align-top">
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              disabled={isSelf}
                              checked={Boolean(selectedUserIds[user.id])}
                              onChange={(event) => toggleSelectedUser(user.id, event.target.checked)}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium">{user.email}</div>
                            <div className="mt-1 text-xs text-gray-500">创建：{formatDate(user.createdAt)}</div>
                            <div className="mt-1 text-xs text-gray-500">会话：{user.sessionCount}</div>
                          </td>
	                          <td className="px-4 py-3">
	                            <div className="flex flex-wrap gap-1.5">
	                              {user.isAdmin && <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">管理员</span>}
	                              <span className={`rounded px-2 py-1 text-xs ${statusMeta.className}`}>{statusMeta.label}</span>
	                            </div>
	                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
                            <div>任务：{user.taskCount}，运行中：{user.runningTaskCount}</div>
                            <div className="mt-1">图片：{user.imageCount}，存储：{formatBytes(user.storageBytes)}</div>
                            <div className="mt-1">Agent 对话：{user.conversationCount}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex min-w-[220px] gap-2">
	                              <input
	                                value={rowPasswords[user.id] ?? ''}
	                                onChange={(event) => setRowPasswords((current) => ({ ...current, [user.id]: event.target.value }))}
	                                type="password"
	                                placeholder="新密码"
	                                disabled={isUserPendingApproval(user) || isUserRejected(user)}
	                                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950"
	                              />
	                              <button
	                                type="button"
	                                onClick={() => void updateUser(user.id, { password: rowPasswords[user.id] ?? '' })}
	                                disabled={isBusy || isUserPendingApproval(user) || isUserRejected(user)}
	                                className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
	                              >
                                保存
                              </button>
                            </div>
                          </td>
	                          <td className="px-4 py-3">
	                            <div className="flex min-w-[280px] flex-wrap gap-2">
	                              {isUserPendingApproval(user) && (
	                                <>
	                                  <button
	                                    type="button"
	                                    disabled={isBusy}
	                                    onClick={() => void reviewRegistration(user, 'approve')}
	                                    className="rounded-lg border border-emerald-200 px-3 py-2 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
	                                  >
	                                    通过
	                                  </button>
	                                  <button
	                                    type="button"
	                                    disabled={isBusy}
	                                    onClick={() => confirmRejectRegistration(user)}
	                                    className="rounded-lg border border-amber-200 px-3 py-2 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10"
	                                  >
	                                    拒绝
	                                  </button>
	                                </>
	                              )}
	                              <button
	                                type="button"
	                                onClick={() => void loadUserDetail(user)}
                                className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                              >
                                详情
                              </button>
	                              <button
	                                type="button"
	                                disabled={isSelf || isBusy || isUserPendingApproval(user) || isUserRejected(user)}
	                                onClick={() => void updateUser(user.id, { disabled: !user.disabledAt })}
                                className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                              >
                                {user.disabledAt ? '启用' : '禁用'}
                              </button>
	                              <button
	                                type="button"
	                                disabled={isSelf || isBusy || isUserPendingApproval(user) || isUserRejected(user)}
	                                onClick={() => void updateUser(user.id, { isAdmin: !user.isAdmin })}
                                className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                              >
                                {user.isAdmin ? '移除管理员' : '设为管理员'}
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => confirmClearUserData(user)}
                                className="rounded-lg border border-amber-200 px-3 py-2 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10"
                              >
                                清空数据
                              </button>
                              <button
                                type="button"
                                disabled={isSelf || isBusy || user.sessionCount === 0}
                                onClick={() => confirmRevokeUserSessions(user)}
                                className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                              >
                                清理会话
                              </button>
                              <button
                                type="button"
                                disabled={isSelf || isBusy}
                                onClick={() => confirmDeleteUser(user)}
                                className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {!filteredUsers.length && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                          没有匹配的用户
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            {userDetail && (
              <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">用户详情</h2>
                    <p className="mt-1 text-xs text-gray-500">{userDetail.user.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUserDetail(null)}
                    className="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                  >
                    关闭
                  </button>
                </div>

                <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50/70 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]">
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
                    <label className="block text-xs font-medium text-gray-500">
                      存储配额 GiB
                      <input
                        value={detailQuota.storageQuotaGiB}
                        onChange={(event) => setDetailQuota((current) => ({ ...current, storageQuotaGiB: event.target.value }))}
                        placeholder="不限制"
                        className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                      />
                    </label>
                    <label className="block text-xs font-medium text-gray-500">
                      任务数量配额
                      <input
                        value={detailQuota.taskQuotaCount}
                        onChange={(event) => setDetailQuota((current) => ({ ...current, taskQuotaCount: event.target.value }))}
                        placeholder="不限制"
                        className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveDetailQuota()}
                      className="inline-flex h-10 items-center justify-center rounded-lg bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700 lg:min-w-[7rem]"
                    >
                      保存配额
                    </button>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold text-gray-500">生成请求审计</h3>
                    <span className="text-xs text-gray-400">最近 {userDetail.generationAudits?.length ?? 0} 次</span>
                  </div>
                  {(userDetail.generationAudits ?? []).length
                    ? <GenerationAuditOverviewGrid audits={userDetail.generationAudits ?? []} showUser={false} onError={(message) => showToast(message, 'error')} />
                    : <div className="rounded-lg border border-gray-100 p-4 text-xs text-gray-500 dark:border-white/[0.06]">暂无生成请求</div>}
                </div>
              </section>
            )}
              </>
            )}

            {activeTab === 'config' && (
              <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">平台配置</h2>
                    <p className="mt-1 text-xs text-gray-500">集中管理默认 API 配置、服务商映射和 Agent 策略。</p>
                    {platformSettings?.updatedAt && <p className="mt-1 text-xs text-gray-400">上次更新：{formatDate(platformSettings.updatedAt)}</p>}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void loadPlatformSettings()}
                      disabled={platformTesting}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                    >
                      重新载入
                    </button>
                    <button
                      type="button"
                      disabled={platformTesting || platformSaving || !platformDraft}
                      onClick={() => void testPlatformSettings()}
                      className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-500/30 dark:text-blue-300 dark:hover:bg-blue-500/10"
                    >
                      {platformTesting ? '测试中...' : '测试连接'}
                    </button>
                    <button
                      type="button"
                      disabled={platformSaving || !platformDraft}
                      onClick={() => void savePlatformSettings()}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {platformSaving ? '保存中...' : '保存平台配置'}
                    </button>
                  </div>
                </div>

                {platformTestResult && (
                  <div className={`rounded-lg border p-4 ${
                    platformTestResult.ok
                      ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-500/10'
                      : 'border-red-200 bg-red-50/70 dark:border-red-500/20 dark:bg-red-500/10'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">
                          {platformTestResult.ok ? '测试通过' : '测试未通过'}
                        </h3>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                          {platformTestResult.profile.name} · {platformTestResult.profile.baseUrl || '未填写 API URL'} · {formatDate(platformTestResult.testedAt)}
                        </p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs font-medium ${
                        platformTestResult.profile.hasApiKey
                          ? 'bg-white/80 text-gray-700 dark:bg-white/[0.08] dark:text-gray-200'
                          : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200'
                      }`}>
                        {platformTestResult.profile.hasApiKey ? 'Key 已参与测试' : '缺少 Key'}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {platformTestResult.checks.map((check) => {
                        const meta = getPlatformTestStatusMeta(check.status)
                        return (
                          <div key={check.id} className="rounded-lg border border-white/70 bg-white/80 p-3 text-xs dark:border-white/[0.06] dark:bg-gray-950/50">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 font-medium ${meta.className}`}>{meta.label}</span>
                              <span className="font-semibold text-gray-900 dark:text-gray-100">{check.label}</span>
                              {check.elapsedMs !== undefined && <span className="text-gray-400">{check.elapsedMs} ms</span>}
                            </div>
                            <p className="mt-1 break-words text-gray-600 dark:text-gray-300">{check.detail}</p>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {!platformDraft || !platformActiveProfile ? (
                  <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500 dark:bg-white/[0.03]">正在加载平台配置...</div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
                    <div className="space-y-4">
                      <div className="rounded-lg border border-gray-100 p-4 dark:border-white/[0.06]">
                        <div className="flex flex-wrap gap-4">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={platformDraft.registration.requireApproval}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                registration: { ...current.registration, requireApproval: event.target.checked },
                              }))}
                            />
                            新用户注册需要审批
                          </label>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">
                          关闭后，新用户提交注册会直接通过并可登录；已处于待审批状态的用户仍需在用户管理中处理。
                        </p>
                      </div>

                      <div className="rounded-lg border border-gray-100 p-4 dark:border-white/[0.06]">
                        <div className="flex flex-wrap gap-4">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={platformDraft.api.managed}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                api: { ...current.api, managed: event.target.checked },
                              }))}
                            />
                            后台接管 API 配置
                          </label>
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={platformDraft.api.allowUserProfiles}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                api: { ...current.api, allowUserProfiles: event.target.checked },
                              }))}
                            />
                            允许用户保留个人配置
                          </label>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">开启接管后，用户生成任务会使用后台配置；API Key 会加密保存在后端，前端只显示已保存状态。</p>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="block text-xs text-gray-500">
                          配置名称
                          <input
                            value={platformActiveProfile.name}
                            onChange={(event) => updatePlatformActiveProfile({ name: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          />
                        </label>
                        <label className="block text-xs text-gray-500">
                          服务商
                          <select
                            value={platformActiveProfile.provider}
                            onChange={(event) => updatePlatformActiveProfile({ provider: event.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          >
                            {platformProviderOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block text-xs text-gray-500">
                          API URL
                          <input
                            value={platformActiveProfile.baseUrl}
                            onChange={(event) => updatePlatformActiveProfile({ baseUrl: event.target.value })}
                            placeholder="https://api.openai.com/v1"
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          />
                        </label>
                        <label className="block text-xs text-gray-500">
                          模型 ID
                          <input
                            value={platformActiveProfile.model}
                            onChange={(event) => updatePlatformActiveProfile({ model: event.target.value })}
                            placeholder="gpt-image-2"
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          />
                        </label>
                        <label className="block text-xs text-gray-500">
                          API Key
                          <input
                            value={platformActiveProfile.apiKey}
                            onChange={(event) => updatePlatformActiveProfile({ apiKey: event.target.value })}
                            type="password"
                            placeholder={platformActiveProfile.hasStoredApiKey ? '云端已保存，留空沿用' : 'sk-...'}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          />
                          {platformActiveProfile.hasStoredApiKey && !platformActiveProfile.apiKey && (
                            <button
                              type="button"
                              onClick={() => updatePlatformActiveProfile({ apiKey: '', hasStoredApiKey: false })}
                              className="mt-2 rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                            >
                              清除已保存 Key
                            </button>
                          )}
                        </label>
                        {platformActiveProfile.provider === 'openai' && (
                          <label className="block text-xs text-gray-500">
                            API 接口
                            <select
                              value={platformActiveProfile.apiMode}
                              onChange={(event) => updatePlatformActiveProfile({ apiMode: event.target.value })}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                            >
                              <option value="images">Images API</option>
                              <option value="responses">Responses API</option>
                            </select>
                          </label>
                        )}
                        <label className="block text-xs text-gray-500">
                          请求超时（秒）
                          <input
                            value={platformActiveProfile.timeout}
                            onChange={(event) => updatePlatformActiveProfile({ timeout: Math.max(10, Math.min(600, Number(event.target.value) || 600)) })}
                            type="number"
                            min={10}
                            max={600}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          />
                        </label>
                        <label className="block text-xs text-gray-500">
                          中间步骤图像数
                          <select
                            value={normalizeStreamPartialImages(platformActiveProfile.streamPartialImages)}
                            onChange={(event) => updatePlatformActiveProfile({ streamPartialImages: normalizeStreamPartialImages(event.target.value) })}
                            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                          >
                            <option value={0}>0，不请求</option>
                            <option value={1}>1 张</option>
                            <option value={2}>2 张</option>
                            <option value={3}>3 张</option>
                          </select>
                        </label>
                      </div>

                      <div className="flex flex-wrap gap-4 rounded-lg border border-gray-100 p-4 text-sm dark:border-white/[0.06]">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={platformActiveProfile.apiProxy}
                            onChange={(event) => updatePlatformActiveProfile({ apiProxy: event.target.checked })}
                          />
                          API 代理
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(platformActiveProfile.streamImages)}
                            onChange={(event) => updatePlatformActiveProfile({ streamImages: event.target.checked })}
                          />
                          流式传输
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(platformActiveProfile.responseFormatB64Json)}
                            onChange={(event) => updatePlatformActiveProfile({ responseFormatB64Json: event.target.checked })}
                          />
                          返回 Base64
                        </label>
                        {platformActiveProfile.provider === 'openai' && (
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={platformActiveProfile.codexCli}
                              onChange={(event) => updatePlatformActiveProfile({ codexCli: event.target.checked })}
                            />
                            Codex CLI 兼容
                          </label>
                        )}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-lg border border-gray-100 p-4 dark:border-white/[0.06]">
                        <h3 className="text-xs font-semibold text-gray-500">Agent 策略</h3>
                        <div className="mt-3 space-y-3">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={platformDraft.agent.lockSettings}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                agent: { ...current.agent, lockSettings: event.target.checked },
                              }))}
                            />
                            强制使用后台 Agent 设置
                          </label>
                          <label className="block text-xs text-gray-500">
                            最大工具调用轮数
                            <input
                              value={platformDraft.agent.maxToolRounds}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                agent: { ...current.agent, maxToolRounds: Number(event.target.value) || DEFAULT_AGENT_MAX_TOOL_ROUNDS },
                              }))}
                              type="number"
                              min={1}
                              max={50}
                              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                            />
                          </label>
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={platformDraft.agent.webSearchEnabled}
                              onChange={(event) => updatePlatformDraft((current) => ({
                                ...current,
                                agent: { ...current.agent, webSearchEnabled: event.target.checked },
                              }))}
                            />
                            允许网络搜索
                          </label>
                        </div>
                      </div>

                      <label className="block rounded-lg border border-gray-100 p-4 dark:border-white/[0.06]">
                        <span className="text-xs font-semibold text-gray-500">自定义服务商 JSON</span>
                        <textarea
                          value={platformCustomProvidersJson}
                          onChange={(event) => setPlatformCustomProvidersJson(event.target.value)}
                          spellCheck={false}
                          className="mt-2 h-64 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-900 dark:border-white/[0.1] dark:bg-gray-950 dark:text-gray-100"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </section>
            )}

            {activeTab === 'generations' && (
              <section className="space-y-4">
                <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">生成审计</h2>
                      <p className="mt-1 text-xs text-gray-500">按任务审计每次生成请求、输入图、遮罩图、输出图和响应详情。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={generationAuditUserId}
                        onChange={(event) => setGenerationAuditUserId(event.target.value)}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none dark:border-white/[0.1] dark:bg-gray-950"
                      >
                        <option value="">全部用户</option>
                        {users.map((user) => (
                          <option key={user.id} value={user.id}>{user.email}</option>
                        ))}
                      </select>
                      <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
                        {generationSourceFilters.map((item) => (
                          <button
                            key={item.value}
                            type="button"
                            onClick={() => setGenerationSourceFilter(item.value)}
                            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${generationSourceFilter === item.value ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.12] dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadGenerationAudits()}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                      >
                        <RefreshIcon className="h-3.5 w-3.5" />
                        刷新
                      </button>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  {filteredGenerationAudits.length > 0 && <GenerationAuditOverviewGrid audits={filteredGenerationAudits} onError={(message) => showToast(message, 'error')} />}
                  {!filteredGenerationAudits.length && (
                    <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.04]">
                      暂无匹配的生成审计记录
                    </div>
                  )}
                </div>
              </section>
            )}

            {activeTab === 'audit' && (
              <section className="rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
                  <h2 className="text-sm font-semibold">审计日志</h2>
                  <button
                    type="button"
                    onClick={() => void loadAuditLogs()}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  >
                    <RefreshIcon className="h-3.5 w-3.5" />
                    刷新
                  </button>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                  {auditLogs.map((log) => (
                    <AuditLogRow key={log.id} log={log} onOpen={() => setSelectedAuditLog(log)} />
                  ))}
                  {!auditLogs.length && <div className="px-4 py-8 text-center text-sm text-gray-500">暂无审计日志</div>}
                </div>
                {selectedAuditLog && <AuditLogDetailModal log={selectedAuditLog} onClose={() => setSelectedAuditLog(null)} />}
              </section>
            )}

            {activeTab === 'ops' && (
              <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div>
                  <h2 className="text-sm font-semibold">数据运维</h2>
                  <p className="mt-1 text-xs text-gray-500">扫描 MinIO 中没有数据库记录引用的孤立对象，确认后可清理。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={opsBusy}
                    onClick={() => void runOrphanScan(false)}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  >
                    扫描孤立对象
                  </button>
                  <button
                    type="button"
                    disabled={opsBusy || !orphanScan?.orphanCount}
                    onClick={() => void runOrphanScan(true)}
                    className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                  >
                    清理孤立对象
                  </button>
                </div>
                {orphanScan && (
                  <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-white/[0.03]">
                    <div>孤立对象：{orphanScan.orphanCount} 个{orphanScan.deleted ? '，已清理' : ''}</div>
                    {orphanScan.orphanKeys.length > 0 && (
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-gray-500">{orphanScan.orphanKeys.join('\n')}</pre>
                    )}
                  </div>
                )}
              </section>
            )}

            {activeTab === 'monitor' && (
              <section className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                    <div className="text-xs text-gray-500">数据库用户</div>
                    <div className="mt-2 text-2xl font-semibold">{systemSnapshot?.database.userCount ?? overview?.userCount ?? 0}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                    <div className="text-xs text-gray-500">数据库任务</div>
                    <div className="mt-2 text-2xl font-semibold">{systemSnapshot?.database.taskCount ?? overview?.taskCount ?? 0}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                    <div className="text-xs text-gray-500">对象数量</div>
                    <div className="mt-2 text-2xl font-semibold">{systemSnapshot?.storage.objectCount ?? '-'}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                    <div className="text-xs text-gray-500">审计日志</div>
                    <div className="mt-2 text-2xl font-semibold">{systemSnapshot?.database.auditLogCount ?? auditLogs.length}</div>
                  </div>
                </div>
                <button type="button" onClick={() => void loadSystemSnapshot()} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm hover:bg-gray-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:hover:bg-white/[0.06]">刷新监控</button>
              </section>
            )}

            {activeTab === 'account' && (
              <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <h2 className="text-sm font-semibold">我的账号</h2>
                <p className="mt-1 text-xs text-gray-500">当前账号：{cloudUser?.email}</p>
                <div className="mt-4 grid gap-3 md:grid-cols-[220px_220px_auto]">
                  <input
                    value={accountPasswords.currentPassword}
                    onChange={(event) => setAccountPasswords((current) => ({ ...current, currentPassword: event.target.value }))}
                    type="password"
                    placeholder="当前密码"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-white/[0.1] dark:bg-gray-950"
                  />
                  <input
                    value={accountPasswords.newPassword}
                    onChange={(event) => setAccountPasswords((current) => ({ ...current, newPassword: event.target.value }))}
                    type="password"
                    placeholder="新密码"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-white/[0.1] dark:bg-gray-950"
                  />
                  <button type="button" onClick={() => void changePassword()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">修改密码</button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
