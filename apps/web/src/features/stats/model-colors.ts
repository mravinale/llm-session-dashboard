/**
 * Provider-aware color assignment for model-keyed charts (Model Usage donut,
 * Token Trend areas). Pure and deterministic: the same set of model ids always
 * produces the same model -> hex mapping, so a model present in both charts
 * gets the same color.
 *
 * Families:
 * - openai (blue -> violet): ids starting with `gpt`
 * - anthropic (orange -> red around brand terracotta): ids starting with
 *   `opus`, `sonnet`, `haiku`, `fable`, or `claude`
 * - neutral (gray): everything else (`<synthetic>`, `Other`, unknown ids)
 *
 * Within a family, ids are sorted (localeCompare) and assigned ramp colors in
 * order so no two models share a color. When a family has more ids than ramp
 * entries, the ramp is extended by darkening the last color instead of wrapping.
 */

type ModelFamily = 'openai' | 'anthropic' | 'neutral'

// blue-400, blue-500, indigo-500, indigo-400, violet-500, violet-400
const OPENAI_RAMP = [
  '#60a5fa',
  '#3b82f6',
  '#6366f1',
  '#818cf8',
  '#8b5cf6',
  '#a78bfa',
] as const

// orange-400/500/600, brand terracotta, red-500/400/600/700
const ANTHROPIC_RAMP = [
  '#fb923c',
  '#f97316',
  '#ea580c',
  '#d97757',
  '#ef4444',
  '#f87171',
  '#dc2626',
  '#b91c1c',
] as const

// gray-500, gray-400
const NEUTRAL_RAMP = ['#6b7280', '#9ca3af'] as const

const RAMPS: Record<ModelFamily, readonly string[]> = {
  openai: OPENAI_RAMP,
  anthropic: ANTHROPIC_RAMP,
  neutral: NEUTRAL_RAMP,
}

const ANTHROPIC_PREFIXES = ['opus', 'sonnet', 'haiku', 'fable', 'claude']

export function classifyModelFamily(modelId: string): ModelFamily {
  const id = modelId.trim().toLowerCase()
  if (id.startsWith('gpt')) return 'openai'
  if (ANTHROPIC_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return 'anthropic'
  }
  return 'neutral'
}

/**
 * Darken a hex color by `factor` (0..1, higher = darker). Used to extend a
 * ramp deterministically when a family has more models than ramp entries,
 * rather than wrapping (which would repeat colors).
 */
function darken(hex: string, factor: number): string {
  const value = hex.replace('#', '')
  const r = Math.round(parseInt(value.slice(0, 2), 16) * (1 - factor))
  const g = Math.round(parseInt(value.slice(2, 4), 16) * (1 - factor))
  const b = Math.round(parseInt(value.slice(4, 6), 16) * (1 - factor))
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function shadeAt(ramp: readonly string[], index: number): string {
  if (index < ramp.length) return ramp[index]
  // Extend past the ramp by progressively darkening the last entry. Each step
  // past the end darkens by an additional 15%, keeping shades distinct.
  const overflow = index - ramp.length + 1
  return darken(ramp[ramp.length - 1], Math.min(0.6, overflow * 0.15))
}

/**
 * Build a stable model -> hex color map for the given set of model ids.
 * Deterministic: same input set produces the same mapping.
 */
export function getModelColorMap(modelIds: Iterable<string>): Map<string, string> {
  const unique = Array.from(new Set(modelIds))

  const byFamily: Record<ModelFamily, string[]> = {
    openai: [],
    anthropic: [],
    neutral: [],
  }
  for (const id of unique) {
    byFamily[classifyModelFamily(id)].push(id)
  }

  const colorMap = new Map<string, string>()
  for (const family of Object.keys(byFamily) as ModelFamily[]) {
    const ids = byFamily[family].slice().sort((a, b) => a.localeCompare(b))
    const ramp = RAMPS[family]
    ids.forEach((id, i) => {
      colorMap.set(id, shadeAt(ramp, i))
    })
  }

  return colorMap
}
