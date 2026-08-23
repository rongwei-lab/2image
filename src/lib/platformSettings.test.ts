import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { applyPlatformSettingsToAppSettings, normalizePlatformSettings } from './platformSettings'
import { DEFAULT_PARAMS } from '../types'

describe('platform settings', () => {
  it('为旧版平台配置补齐默认 ZIP 下载入口', () => {
    const platform = normalizePlatformSettings({})

    expect(platform.download.zipDownloadRoutes).toEqual(DEFAULT_SETTINGS.zipDownloadRoutes)
  })

  it('保留 PNG 和 WebP 的透明背景参数，关闭 JPEG 透明背景', () => {
    const webp = normalizePlatformSettings({
      params: {
        defaults: {
          ...DEFAULT_PARAMS,
          output_format: 'webp',
          output_compression: 25,
          transparent_output: true,
        },
      },
    })
    const jpeg = normalizePlatformSettings({
      params: {
        defaults: {
          ...DEFAULT_PARAMS,
          output_format: 'jpeg',
          transparent_output: true,
        },
      },
    })

    expect(webp.params.defaults).toMatchObject({
      output_format: 'webp',
      output_compression: 25,
      transparent_output: true,
    })
    expect(jpeg.params.defaults.transparent_output).toBe(false)
  })

  it('用后台下载策略覆盖前台个人设置', () => {
    const localSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      zipDownloadRoutes: ['task-detail-all'],
    })

    const applied = applyPlatformSettingsToAppSettings(localSettings, {
      registration: { requireApproval: true },
      params: {
        managed: false,
        defaults: DEFAULT_PARAMS,
      },
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
