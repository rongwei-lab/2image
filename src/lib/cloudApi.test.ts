import { afterEach, describe, expect, it, vi } from 'vitest'
import { callCloudBatchImageSingle, clearCloudData, deleteCloudImage, getCurrentUser } from './cloudApi'
import { DEFAULT_PARAMS } from '../types'

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

  it('云端 Hybrid 生图同时传递参考图数据和原始链接', async () => {
    const result = { batchItemId: 'item-1', image: null, error: null }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify({ type: 'done', result })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await callCloudBatchImageSingle({
      params: DEFAULT_PARAMS,
      batchItemId: 'item-1',
      prompt: '生成图片',
      referenceImageDataUrls: ['data:image/png;base64,YQ=='],
      referenceImageSourceUrls: ['https://images.example.com/input.png'],
    })

    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
      referenceImageDataUrls: ['data:image/png;base64,YQ=='],
      referenceImageSourceUrls: ['https://images.example.com/input.png'],
    })
  })
})
