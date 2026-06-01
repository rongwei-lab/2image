import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function getKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function encryptText(text: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getKey(secret), iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.')
}

export function decryptText(payload: string | null | undefined, secret: string): string {
  if (!payload) return ''
  const [ivText, tagText, encryptedText] = payload.split('.')
  if (!ivText || !tagText || !encryptedText) throw new Error('加密字段格式错误')
  const decipher = createDecipheriv(ALGORITHM, getKey(secret), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
