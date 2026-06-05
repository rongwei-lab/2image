import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { applyPlatformSettingsToAppSettings, normalizePlatformSettings } from './platformSettings'

describe('platform settings', () => {
  it('为旧版平台配置补齐默认 ZIP 下载入口', () => {
    const platform = normalizePlatformSettings({})

    expect(platform.download.zipDownloadRoutes).toEqual(DEFAULT_SETTINGS.zipDownloadRoutes)
  })

  it('用后台下载策略覆盖前台个人设置', () => {
    const localSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      zipDownloadRoutes: ['task-detail-all'],
    })

    const applied = applyPlatformSettingsToAppSettings(localSettings, {
      registration: { requireApproval: true },
      api: {
        managed: false,
        allowUserProfiles: true,
        settings: DEFAULT_SETTINGS,
      },
      agent: {
        lockSettings: false,
        maxToolRounds: DEFAULT_SETTINGS.agentMaxToolRounds,
        webSearchEnabled: false,
      },
      download: {
        zipDownloadRoutes: ['agent-round-all'],
      },
    })

    expect(applied.zipDownloadRoutes).toEqual(['agent-round-all'])
  })
})
