import { PNG } from 'pngjs'
import { detectKeyColorFromPixels, removeKeyedBackgroundFromPixels } from '../src/lib/transparentImage'
import { bufferToDataUrl, parseImageDataUrl } from './imageData'

export function removeKeyedBackgroundFromDataUrl(dataUrl: string, keyColor?: string): string {
  const parsed = parseImageDataUrl(dataUrl)
  if (parsed.mimeType !== 'image/png') throw new Error('透明背景后处理仅支持 PNG 图片')

  const png = PNG.sync.read(parsed.buffer)
  const pixels = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength)
  const effectiveKeyColor = keyColor || detectKeyColorFromPixels(pixels, png.width, png.height)
  removeKeyedBackgroundFromPixels(pixels, png.width, png.height, effectiveKeyColor)

  // pngjs 写入 Buffer 时会读取同一块 RGBA 内存；保留原图另存，方便后台审计和用户下载。
  const output = PNG.sync.write(png)
  return bufferToDataUrl(output, 'image/png')
}
