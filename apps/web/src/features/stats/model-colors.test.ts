import { describe, it, expect } from 'vitest'
import { classifyModelFamily, getModelColorMap } from './model-colors'

const OPENAI_RAMP = ['#60a5fa', '#3b82f6', '#6366f1', '#818cf8', '#8b5cf6', '#a78bfa']
const ANTHROPIC_RAMP = [
  '#fb923c',
  '#f97316',
  '#ea580c',
  '#d97757',
  '#ef4444',
  '#f87171',
  '#dc2626',
  '#b91c1c',
]
const NEUTRAL_RAMP = ['#6b7280', '#9ca3af']

// The ~12 models seen in real data, plus the synthetic placeholder.
const REALISTIC_MODELS = [
  'gpt-5-codex',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
  'opus-4-6',
  'opus-4-7',
  'opus-4-8',
  'sonnet-4',
  'sonnet-4-5',
  'sonnet-4-6',
  'haiku-4-5',
  'fable-5',
  '<synthetic>',
]

describe('classifyModelFamily', () => {
  it('classifies gpt-* models as openai (case-insensitive)', () => {
    for (const id of ['gpt-5.5', 'gpt-5-codex', 'gpt-5.2-codex', 'GPT-5.4']) {
      expect(classifyModelFamily(id)).toBe('openai')
    }
  })

  it('classifies opus/sonnet/haiku/fable/claude as anthropic (case-insensitive)', () => {
    for (const id of [
      'opus-4-8',
      'sonnet-4-6',
      'haiku-4-5',
      'fable-5',
      'claude-3-5-sonnet',
      'OPUS-4-8',
    ]) {
      expect(classifyModelFamily(id)).toBe('anthropic')
    }
  })

  it('classifies synthetic/unknown as neutral', () => {
    for (const id of ['<synthetic>', '\x3Csynthetic>', 'mystery-model', 'Other']) {
      expect(classifyModelFamily(id)).toBe('neutral')
    }
  })
})

describe('getModelColorMap', () => {
  it('maps gpt-* models into the blue->violet (openai) ramp', () => {
    const map = getModelColorMap([
      'gpt-5-codex',
      'gpt-5.2-codex',
      'gpt-5.4',
      'gpt-5.5',
    ])
    for (const id of map.keys()) {
      expect(OPENAI_RAMP).toContain(map.get(id))
    }
  })

  it('maps Claude-family models into the orange->red (anthropic) ramp', () => {
    const map = getModelColorMap([
      'opus-4-8',
      'sonnet-4-6',
      'haiku-4-5',
      'fable-5',
    ])
    for (const id of map.keys()) {
      expect(ANTHROPIC_RAMP).toContain(map.get(id))
    }
  })

  it('maps synthetic/unknown into the neutral ramp', () => {
    const map = getModelColorMap(['<synthetic>', 'mystery-model'])
    expect(NEUTRAL_RAMP).toContain(map.get('<synthetic>'))
    expect(NEUTRAL_RAMP).toContain(map.get('mystery-model'))
  })

  it('assigns no duplicate color within a family for a realistic set', () => {
    const map = getModelColorMap(REALISTIC_MODELS)

    const colorsByFamily: Record<string, string[]> = {
      openai: [],
      anthropic: [],
      neutral: [],
    }
    for (const id of REALISTIC_MODELS) {
      colorsByFamily[classifyModelFamily(id)].push(map.get(id)!)
    }

    for (const family of Object.keys(colorsByFamily)) {
      const colors = colorsByFamily[family]
      expect(new Set(colors).size).toBe(colors.length)
    }
  })

  it('keeps blue-violet and orange-red families fully distinct across the whole set', () => {
    const map = getModelColorMap(REALISTIC_MODELS)
    const allColors = REALISTIC_MODELS.map((id) => map.get(id)!)
    // Every model in the realistic set gets a unique color (cross-family too).
    expect(new Set(allColors).size).toBe(allColors.length)
  })

  it('extends a ramp by darkening (no modulo wrap) when a family overflows', () => {
    // 10 gpt models > 6-entry openai ramp: still no duplicates.
    const manyGpt = Array.from({ length: 10 }, (_, i) => `gpt-overflow-${i}`)
    const map = getModelColorMap(manyGpt)
    const colors = manyGpt.map((id) => map.get(id)!)
    expect(new Set(colors).size).toBe(colors.length)
    // First entry is unchanged (sorted-first id gets ramp[0]).
    expect(colors).toContain(OPENAI_RAMP[0])
  })

  it('is deterministic: same input set produces the same mapping', () => {
    const a = getModelColorMap(REALISTIC_MODELS)
    const b = getModelColorMap([...REALISTIC_MODELS].reverse())
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b))
  })
})
