import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCloudData, deleteCloudImage, getCurrentUser } from './cloudApi'

describe('cloudApi request headers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('无请求体的 DELETE 不发送 JSON Content-Type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await deleteCloudImage('image-1')

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toEqual({})
  })

  it('带请求体的请求会发送 JSON Content-Type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await clearCloudData({ clearConfig: true, clearTasks: true })

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('GET 请求禁用浏览器缓存，避免复用旧登录状态', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await getCurrentUser()

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).cache).toBe('no-store')
  })
})
