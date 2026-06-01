import { createHash } from 'node:crypto'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface ParsedDataUrl {
  id: string
  mimeType: string
  extension: string
  buffer: Buffer
}

const SAFE_CLIENT_IMAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function resolveImageStorageId(parsedId: string, clientId?: unknown): string {
  if (typeof clientId !== 'string') return parsedId
  const normalized = clientId.trim()
  if (!normalized) return parsedId
  if (!SAFE_CLIENT_IMAGE_ID.test(normalized)) throw new Error('图片 ID 格式无效')
  return normalized
}

export function parseImageDataUrl(dataUrl: string, expectedId?: string): ParsedDataUrl {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) throw new Error('图片必须是 base64 data URL')
  const mimeType = match[1].toLowerCase()
  if (!mimeType.startsWith('image/')) throw new Error('只支持图片 data URL')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0) throw new Error('图片内容为空')
  const id = createHash('sha256').update(dataUrl).digest('hex')
  if (expectedId && expectedId !== id) throw new Error('图片 ID 与内容哈希不匹配')
  return {
    id,
    mimeType,
    extension: MIME_EXTENSIONS[mimeType] ?? (mimeType.replace(/^image\//, '') || 'png'),
    buffer,
  }
}

export function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}
