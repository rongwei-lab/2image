export type PromptStylePresetId =
  | ''
  | 'cinematic'
  | 'commerce'
  | 'sticker'
  | 'toy'
  | 'icon'
  | 'poster'
  | 'anime'
  | 'wallpaper'

export interface PromptStylePreset {
  id: Exclude<PromptStylePresetId, ''>
  label: string
  value: string
}

export const PROMPT_STYLE_PRESETS: PromptStylePreset[] = [
  {
    id: 'cinematic',
    label: '电影感写实',
    value: 'Cinematic realistic photography, natural light, subtle film grain, rich but controlled color grading, soft shadows, professional composition, high detail.',
  },
  {
    id: 'commerce',
    label: '电商主图',
    value: 'Clean commercial product photography, premium studio lighting, crisp edges, realistic materials, neutral background, catalog-ready composition, high detail.',
  },
  {
    id: 'sticker',
    label: '透明贴纸',
    value: 'Cute sticker illustration, bold clean outline, simple readable shapes, vibrant colors, playful expression, isolated subject, transparent-background friendly.',
  },
  {
    id: 'toy',
    label: '3D 潮玩',
    value: 'Premium 3D designer toy style, soft rounded forms, glossy vinyl material, studio render lighting, collectible figure presentation, charming details.',
  },
  {
    id: 'icon',
    label: '扁平图标',
    value: 'Modern flat vector icon style, geometric shapes, simple silhouette, balanced negative space, clean edges, limited color palette, app-icon ready.',
  },
  {
    id: 'poster',
    label: '复古海报',
    value: 'Vintage editorial poster style, bold typography space, textured print grain, strong focal composition, retro color palette, dramatic visual hierarchy.',
  },
  {
    id: 'anime',
    label: '动漫插画',
    value: 'Polished anime illustration style, expressive character design, clean line art, soft cel shading, luminous color accents, detailed atmosphere.',
  },
  {
    id: 'wallpaper',
    label: '极简壁纸',
    value: 'Minimal premium wallpaper style, spacious composition, refined lighting, elegant color contrast, calm background depth, suitable for desktop or mobile wallpaper.',
  },
]

const PROMPT_STYLE_PRESET_IDS = new Set(PROMPT_STYLE_PRESETS.map((preset) => preset.id))

export function normalizePromptStylePresetId(value: unknown): PromptStylePresetId {
  return typeof value === 'string' && PROMPT_STYLE_PRESET_IDS.has(value as PromptStylePreset['id'])
    ? value as PromptStylePreset['id']
    : ''
}

export function getPromptStylePreset(id: unknown): PromptStylePreset | null {
  const normalizedId = normalizePromptStylePresetId(id)
  if (!normalizedId) return null
  return PROMPT_STYLE_PRESETS.find((preset) => preset.id === normalizedId) ?? null
}

export function applyPromptStylePreset(prompt: string, presetId: unknown): string {
  const preset = getPromptStylePreset(presetId)
  const normalizedPrompt = prompt.trim()
  if (!preset) return normalizedPrompt

  // 风格作为独立段落追加，保留用户原始提示词，便于任务卡片和审计仍能展示真实输入。
  return `${normalizedPrompt}\n\nStyle preset: ${preset.value}`
}
