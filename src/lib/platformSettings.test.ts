import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { applyPlatformSettingsToAppSettings, normalizePlatformSettings } from './platformSettings'
import { DEFAULT_PARAMS } from '../types'

describe('platform settings', () => {
  it('为旧版平台配置补齐默认 ZIP 下载入口', () => {
    const platform = normalizePlatformSettings({})

    expect(platform.download.zipDownloadRoutes).toEqual(DEFAULT_SETTINGS.zipDownloadRoutes)
  })

  it.each(['xhigh', 'max'] as const)('保留平台配置的 %s 质量档位', (quality) => {
    const platform = normalizePlatformSettings({ params: { defaults: { ...DEFAULT_PARAMS, quality } } })

    expect(platform.params.defaults.quality).toBe(quality)
  })

  it.each([
    ['model-b', 'model-b'],
    ['unlisted-model', 'model-a'],
  ])('托管配置保留模型选择 %s，并限制在后台模型列表中', (selectedModel, expectedModel) => {
    const profile = { ...DEFAULT_SETTINGS.profiles[0], model: 'model-a,model-b', baseUrl: 'https://platform.example/v1' }
    const platform = normalizePlatformSettings({
      api: { managed: true, settings: { ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id } },
    })
    const localSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [{ ...profile, baseUrl: 'https://personal.example/v1', selectedModel }],
      activeProfileId: profile.id,
    })

    const applied = applyPlatformSettingsToAppSettings(localSettings, platform)

    expect(getActiveApiProfile(applied)).toMatchObject({ model: expectedModel, baseUrl: profile.baseUrl })
    expect(applied.profiles[0].model).toBe('model-a, model-b')
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
        agentApiConfigMode: 'off',
        agentTextProfileId: null,
        agentImageProfileId: null,
      },
      download: {
        zipDownloadRoutes: ['agent-round-all'],
      },
    })

    expect(applied.zipDownloadRoutes).toEqual(['agent-round-all'])
  })

  it('归一化并下发后台锁定的 Agent 文本和图像配置', () => {
    const textProfile = {
      ...DEFAULT_SETTINGS.profiles[0],
      id: 'platform-text',
      name: 'Responses 文本',
      apiMode: 'responses' as const,
      model: 'gpt-text',
    }
    const imageProfile = {
      ...DEFAULT_SETTINGS.profiles[0],
      id: 'platform-image',
      name: 'Images 图像',
      model: 'gpt-image-2',
    }
    const platform = normalizePlatformSettings({
      api: {
        managed: true,
        settings: {
          ...DEFAULT_SETTINGS,
          profiles: [textProfile, imageProfile],
          activeProfileId: imageProfile.id,
        },
      },
      agent: {
        lockSettings: true,
        maxToolRounds: 8,
        webSearchEnabled: true,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      },
    })
    const applied = applyPlatformSettingsToAppSettings(DEFAULT_SETTINGS, platform)

    expect(platform.agent).toMatchObject({
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: textProfile.id,
      agentImageProfileId: imageProfile.id,
    })
    expect(applied).toMatchObject({
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: textProfile.id,
      agentImageProfileId: imageProfile.id,
      agentMaxToolRounds: 8,
      agentWebSearch: true,
    })
  })

  it('后台 Agent 配置 ID 无效时自动回退到可用配置', () => {
    const textProfile = {
      ...DEFAULT_SETTINGS.profiles[0],
      id: 'platform-text',
      apiMode: 'responses' as const,
    }
    const platform = normalizePlatformSettings({
      api: {
        managed: true,
        settings: {
          ...DEFAULT_SETTINGS,
          profiles: [textProfile],
          activeProfileId: textProfile.id,
        },
      },
      agent: {
        lockSettings: true,
        agentApiConfigMode: 'native',
        agentTextProfileId: 'missing-text',
        agentImageProfileId: 'missing-image',
      },
    })

    expect(platform.agent.agentTextProfileId).toBe(textProfile.id)
    expect(platform.agent.agentImageProfileId).toBe(textProfile.id)
  })
})
