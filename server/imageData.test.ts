import { describe, expect, it } from 'vitest'
import { parseImageDataUrl, resolveImageStorageId } from './imageData'

describe('图片 data URL 解析', () => {
  it('没有客户端 ID 时使用服务端内容哈希', () => {
    const parsed = parseImageDataUrl('data:image/png;base64,aGVsbG8=')

    expect(resolveImageStorageId(parsed.id)).toBe(parsed.id)
  })

  it('允许沿用安全的客户端图片 ID 以兼容云端同步', () => {
    const parsed = parseImageDataUrl('data:image/png;base64,aGVsbG8=')

    expect(resolveImageStorageId(parsed.id, 'legacy-image_01')).toBe('legacy-image_01')
  })

  it('拒绝会污染对象路径的客户端图片 ID', () => {
    const parsed = parseImageDataUrl('data:image/png;base64,aGVsbG8=')

    expect(() => resolveImageStorageId(parsed.id, '../bad')).toThrow('图片 ID 格式无效')
  })
})
