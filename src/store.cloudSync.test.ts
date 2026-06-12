import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS } from './lib/apiProfiles'

const cloudApiMocks = vi.hoisted(() => ({
  saveCloudSettings: vi.fn(async (snapshot: unknown) => snapshot),
}))

vi.mock('./lib/cloudApi', () => ({
  callCloudAgentConversationTitleApi: vi.fn(),
  callCloudAgentResponsesApi: vi.fn(),
  callCloudBatchImageSingle: vi.fn(),
  clearCloudData: vi.fn(),
  createCloudTask: vi.fn(),
  deleteCloudImage: vi.fn(),
  deleteCloudTask: vi.fn(),
  getCloudAgentConversations: vi.fn(async () => []),
  getCloudImageDataUrl: vi.fn(),
  getCloudImageThumbnail: vi.fn(),
  getCloudSettings: vi.fn(async () => null),
  getCloudTasks: vi.fn(async () => []),
  getCurrentUser: vi.fn(async () => null),
  getPlatformSettings: vi.fn(async () => null),
  loginCloud: vi.fn(),
  logoutCloud: vi.fn(),
  patchCloudTask: vi.fn(),
  saveCloudAgentConversations: vi.fn(),
  saveCloudSettings: cloudApiMocks.saveCloudSettings,
  subscribeCloudTask: vi.fn(),
  uploadCloudImage: vi.fn(),
  uploadCloudImageThumbnail: vi.fn(),
}))

import { useStore } from './store'

describe('cloud settings sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cloudApiMocks.saveCloudSettings.mockClear()
    useStore.setState({
      cloudUser: { id: 'admin-user', email: 'admin@example.com', isAdmin: true },
      cloudAuthChecked: true,
      cloudSyncing: false,
      settings: { ...DEFAULT_SETTINGS },
      params: { ...DEFAULT_PARAMS },
      promptStylePresetId: '',
      appMode: 'gallery',
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentConversations: [],
      activeAgentConversationId: null,
      agentSidebarCollapsed: false,
      agentAssetTab: 'outputs',
      agentAssetPanelCollapsed: false,
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      showToast: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useStore.setState({ cloudUser: null, cloudSyncing: false })
  })

  it('does not start another save only because cloudSyncing changes', async () => {
    useStore.setState({ prompt: '云端同步去重测试' })

    await vi.advanceTimersByTimeAsync(900)
    expect(cloudApiMocks.saveCloudSettings).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(cloudApiMocks.saveCloudSettings).toHaveBeenCalledTimes(1)
  })

  it('does not keep saving when server returns normalized settings snapshot', async () => {
    cloudApiMocks.saveCloudSettings.mockImplementationOnce(async (snapshot: unknown) => ({
      ...(snapshot as Record<string, unknown>),
      prompt: '服务端规范化后的提示词',
    }))

    useStore.setState({ prompt: '本地待同步提示词' })

    await vi.advanceTimersByTimeAsync(900)
    expect(cloudApiMocks.saveCloudSettings).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(cloudApiMocks.saveCloudSettings).toHaveBeenCalledTimes(1)
  })
})
