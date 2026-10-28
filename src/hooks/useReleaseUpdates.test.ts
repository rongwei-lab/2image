import { afterEach, describe, expect, it, vi } from 'vitest'

describe('二开更新接口兼容', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('继续支持原有单对象更新接口，并识别二开标签', async () => {
    vi.stubEnv('VITE_APP_RELEASE_API_URL', 'https://updates.example.com/latest.json')
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: '2image-v0.8.3', body: '更新内容', html_url: 'https://updates.example.com/v0.8.3' })))
    vi.stubGlobal('fetch', fetch)
    vi.resetModules()
    const { checkForUpdates, useReleaseUpdates } = await import('./useReleaseUpdates')

    expect(await checkForUpdates(0)).toMatchObject({ tag: '2image-v0.8.3', version: '0.8.3' })
    expect(fetch).toHaveBeenCalledWith('https://updates.example.com/latest.json', expect.any(Object))
    expect(useReleaseUpdates.getState().hasMore).toBe(false)
  })
})
