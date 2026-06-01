import type { AppSettings, PlatformSettings } from '../types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS } from '../types'
import { DEFAULT_SETTINGS, normalizeAgentMaxToolRounds, normalizeSettings } from './apiProfiles'

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

export function normalizePlatformSettings(input: unknown): PlatformSettings {
  const record = isRecord(input) ? input : {}
  const registrationRecord = isRecord(record.registration) ? record.registration : {}
  const apiRecord = isRecord(record.api) ? record.api : {}
  const agentRecord = isRecord(record.agent) ? record.agent : {}

  return {
    registration: {
      requireApproval: typeof registrationRecord.requireApproval === 'boolean' ? registrationRecord.requireApproval : true,
    },
    api: {
      managed: Boolean(apiRecord.managed),
      allowUserProfiles: typeof apiRecord.allowUserProfiles === 'boolean' ? apiRecord.allowUserProfiles : true,
      settings: normalizeSettings(apiRecord.settings ?? DEFAULT_SETTINGS),
    },
    agent: {
      lockSettings: Boolean(agentRecord.lockSettings),
      maxToolRounds: normalizeAgentMaxToolRounds(agentRecord.maxToolRounds, DEFAULT_AGENT_MAX_TOOL_ROUNDS),
      webSearchEnabled: typeof agentRecord.webSearchEnabled === 'boolean' ? agentRecord.webSearchEnabled : false,
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
      profiles: platformApiSettings.profiles,
      activeProfileId,
    })
  }

  if (platform.agent.lockSettings) {
    next = normalizeSettings({
      ...next,
      agentMaxToolRounds: platform.agent.maxToolRounds,
      agentWebSearch: platform.agent.webSearchEnabled,
    })
  } else {
    next = normalizeSettings({
      ...next,
      agentMaxToolRounds: Math.min(next.agentMaxToolRounds, platform.agent.maxToolRounds),
      agentWebSearch: platform.agent.webSearchEnabled ? next.agentWebSearch : false,
    })
  }

  return next
}
