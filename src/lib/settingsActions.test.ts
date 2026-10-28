import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { prepareSettingsForCommit } from './settingsActions'

describe('云端 API 设置保存', () => {
  it.each([
    ['', true, ''],
    ['  new-key  ', undefined, 'new-key'],
  ])('编辑其他设置时保留已保存密钥标记，新密钥去除首尾空白（%s）', (apiKey, hasStoredApiKey, expectedKey) => {
    const profile = { ...DEFAULT_SETTINGS.profiles[0], apiKey, hasStoredApiKey: true }
    const saved = prepareSettingsForCommit({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    expect(saved.profiles[0].apiKey).toBe(expectedKey)
    expect(saved.profiles[0].hasStoredApiKey).toBe(hasStoredApiKey)
  })
})
