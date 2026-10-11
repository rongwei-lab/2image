import type { AgentApiConfigMode, AppSettings, PlatformSettings, TaskParams } from '../types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS, isAgentTextApiProfile, normalizeAgentMaxToolRounds, normalizeSettings, normalizeZipDownloadRoutes } from './apiProfiles'
import { normalizeImageSize } from './size'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripProfileApiKeys(settings: AppSettings): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    apiKey: '',
    profiles: normalized.profiles.map((profile) => ({ ...profile, apiKey: '' })),
  })
}

function normalizePlatformTaskParams(input: unknown): TaskParams {
  const record = isRecord(input) ? input : {}
  const outputFormat = record.output_format === 'jpeg' || record.output_format === 'webp' || record.output_format === 'png'
    ? record.output_format
    : DEFAULT_PARAMS.output_format
  const outputCompression = typeof record.output_compression === 'number' && Number.isFinite(record.output_compression)
    ? Math.min(100, Math.max(0, Math.trunc(record.output_compression)))
    : DEFAULT_PARAMS.output_compression

  return {
    size: typeof record.size === 'string' ? normalizeImageSize(record.size) || DEFAULT_PARAMS.size : DEFAULT_PARAMS.size,
    quality: record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' || record.quality === 'auto' || record.quality === 'xhigh' || record.quality === 'max'
      ? record.quality
      : DEFAULT_PARAMS.quality,
    output_format: outputFormat,
    output_compression: outputFormat === 'png' ? null : outputCompression,
    moderation: record.moderation === 'low' || record.moderation === 'auto' ? record.moderation : DEFAULT_PARAMS.moderation,
    n: Math.min(10, Math.max(1, Math.trunc(Number(record.n) || DEFAULT_PARAMS.n))),
    transparent_output: outputFormat === 'png' || outputFormat === 'webp' ? Boolean(record.transparent_output) : false,
  }
}

function normalizePlatformAgentApiConfigMode(value: unknown, fallback: AgentApiConfigMode = 'off'): AgentApiConfigMode {
  return value === 'native' || value === 'hybrid' ? value : fallback
}

function normalizePlatformAgentProfileIds(input: unknown, settings: AppSettings) {
  const record = isRecord(input) ? input : {}
  const textProfileId = typeof record.agentTextProfileId === 'string'
    ? record.agentTextProfileId
    : settings.agentTextProfileId
  const imageProfileId = typeof record.agentImageProfileId === 'string'
    ? record.agentImageProfileId
    : settings.agentImageProfileId
  const firstTextProfile = settings.profiles.find(isAgentTextApiProfile)
  const normalizedTextProfileId: string | null = typeof textProfileId === 'string' && settings.profiles.some((profile) => profile.id === textProfileId && isAgentTextApiProfile(profile))
    ? textProfileId
    : firstTextProfile?.id ?? null
  const normalizedImageProfileId: string | null = typeof imageProfileId === 'string' && settings.profiles.some((profile) => profile.id === imageProfileId)
    ? imageProfileId
    : settings.activeProfileId

  return {
    agentTextProfileId: normalizedTextProfileId,
    agentImageProfileId: normalizedImageProfileId,
  }
}

export function normalizePlatformSettings(input: unknown): PlatformSettings {
  const record = isRecord(input) ? input : {}
  const registrationRecord = isRecord(record.registration) ? record.registration : {}
  const paramsRecord = isRecord(record.params) ? record.params : {}
  const apiRecord = isRecord(record.api) ? record.api : {}
  const agentRecord = isRecord(record.agent) ? record.agent : {}
  const downloadRecord = isRecord(record.download) ? record.download : {}
  const apiSettings = normalizeSettings(apiRecord.settings ?? DEFAULT_SETTINGS)
  const legacyAgentMode = normalizePlatformAgentApiConfigMode(apiSettings.agentApiConfigMode)
  const agentProfileIds = normalizePlatformAgentProfileIds(agentRecord, apiSettings)

  return {
    registration: {
      requireApproval: typeof registrationRecord.requireApproval === 'boolean' ? registrationRecord.requireApproval : true,
    },
    params: {
      managed: Boolean(paramsRecord.managed),
      defaults: normalizePlatformTaskParams(paramsRecord.defaults ?? DEFAULT_PARAMS),
    },
    api: {
      managed: Boolean(apiRecord.managed),
      allowUserProfiles: typeof apiRecord.allowUserProfiles === 'boolean' ? apiRecord.allowUserProfiles : true,
      settings: apiSettings,
    },
    agent: {
      lockSettings: Boolean(agentRecord.lockSettings),
      maxToolRounds: normalizeAgentMaxToolRounds(agentRecord.maxToolRounds, DEFAULT_AGENT_MAX_TOOL_ROUNDS),
      webSearchEnabled: typeof agentRecord.webSearchEnabled === 'boolean' ? agentRecord.webSearchEnabled : false,
      agentApiConfigMode: normalizePlatformAgentApiConfigMode(agentRecord.agentApiConfigMode, legacyAgentMode),
      ...agentProfileIds,
    },
    download: {
      zipDownloadRoutes: normalizeZipDownloadRoutes(downloadRecord.zipDownloadRoutes),
    },
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  }
}

export function sanitizePlatformSettingsForClient(input: unknown): PlatformSettings {
  const platform = normalizePlatformSettings(input)
  return {
    ...platform,
    api: {
      ...platform.api,
      settings: stripProfileApiKeys(platform.api.settings),
    },
  }
}

export function applyPlatformSettingsToAppSettings(settings: AppSettings, platformInput: PlatformSettings | null | undefined): AppSettings {
  const platform = platformInput ? normalizePlatformSettings(platformInput) : null
  let next = normalizeSettings(settings)
  if (!platform) return next

  if (platform.api.managed) {
    const platformApiSettings = normalizeSettings(platform.api.settings)
    const activeProfileId = platformApiSettings.profiles.some((profile) => profile.id === next.activeProfileId)
      ? next.activeProfileId
      : platformApiSettings.activeProfileId
    next = normalizeSettings({
      ...next,
      customProviders: platformApiSettings.customProviders,
      providerOrder: platformApiSettings.providerOrder,
      profiles: platformApiSettings.profiles.map((profile) => ({
        ...profile,
        selectedModel: next.profiles.find((item) => item.id === profile.id)?.selectedModel ?? profile.selectedModel,
      })),
      activeProfileId,
    })
  }

  if (platform.agent.lockSettings) {
    const platformAgentMode = platform.agent.agentApiConfigMode
    const canUsePlatformAgentProfiles = platform.api.managed
    const agentTextProfileId = canUsePlatformAgentProfiles || next.profiles.some((profile) => profile.id === platform.agent.agentTextProfileId && isAgentTextApiProfile(profile))
      ? platform.agent.agentTextProfileId
      : next.agentTextProfileId
    const agentImageProfileId = canUsePlatformAgentProfiles || next.profiles.some((profile) => profile.id === platform.agent.agentImageProfileId)
      ? platform.agent.agentImageProfileId
      : next.agentImageProfileId
    next = normalizeSettings({
      ...next,
      agentMaxToolRounds: platform.agent.maxToolRounds,
      agentWebSearch: platform.agent.webSearchEnabled,
      agentApiConfigMode: platformAgentMode,
      agentTextProfileId,
      agentImageProfileId,
    })
  } else {
    next = normalizeSettings({
      ...next,
      agentMaxToolRounds: Math.min(next.agentMaxToolRounds, platform.agent.maxToolRounds),
      agentWebSearch: platform.agent.webSearchEnabled ? next.agentWebSearch : false,
    })
  }

  // 下载入口属于平台体验策略，统一从后台下发，避免同一部署下不同设备行为不一致。
  next = normalizeSettings({
    ...next,
    zipDownloadRoutes: platform.download.zipDownloadRoutes,
  })

  return next
}

export function getPlatformManagedTaskParams(platformInput: PlatformSettings | null | undefined): TaskParams | null {
  const platform = platformInput ? normalizePlatformSettings(platformInput) : null
  if (!platform?.params.managed) return null
  return { ...platform.params.defaults }
}
