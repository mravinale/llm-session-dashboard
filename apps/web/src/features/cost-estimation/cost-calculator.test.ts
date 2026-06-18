import { describe, it, expect } from 'vitest'
import { calculateSessionCost, getMergedPricing } from './cost-calculator'
import { DEFAULT_PRICING, DEFAULT_SETTINGS } from '@/features/settings/settings.types'
import type { TokenUsage } from '@/lib/parsers/types'
import type { Settings } from '@/features/settings/settings.types'

describe('calculateSessionCost', () => {
  it('calculates cost for single model with known pricing', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // claude-sonnet-4: input $3/MTok, output $15/MTok
    // 1M input = $3, 0.5M output = $7.50, total = $10.50
    expect(result.totalUSD).toBe(10.5)
    expect(result.byCategory.input).toBe(3.0)
    expect(result.byCategory.output).toBe(7.5)
    expect(result.byCategory.cacheRead).toBe(0)
    expect(result.byCategory.cacheWrite).toBe(0)

    expect(result.byModel['claude-sonnet-4']).toEqual({
      modelId: 'claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      inputCost: 3.0,
      outputCost: 7.5,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 10.5,
      tokens: tokensByModel['claude-sonnet-4'],
    })
  })

  it('calculates cost for multiple models', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'claude-opus-4-6': {
        inputTokens: 500_000,
        outputTokens: 200_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // sonnet-4: 1M input ($3) + 0.5M output ($7.50) = $10.50
    // opus-4-6: 0.5M input ($2.50) + 0.2M output ($5.00) = $7.50
    // total: $18.00
    expect(result.totalUSD).toBe(18.0)
    expect(result.byCategory.input).toBe(5.5)
    expect(result.byCategory.output).toBe(12.5)

    expect(Object.keys(result.byModel)).toHaveLength(2)
    expect(result.byModel['claude-sonnet-4']).toBeDefined()
    expect(result.byModel['claude-opus-4-6']).toBeDefined()
  })

  it('handles zero tokens (empty tokensByModel)', () => {
    const tokensByModel: Record<string, TokenUsage> = {}
    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    expect(result.totalUSD).toBe(0)
    expect(result.byCategory.input).toBe(0)
    expect(result.byCategory.output).toBe(0)
    expect(result.byCategory.cacheRead).toBe(0)
    expect(result.byCategory.cacheWrite).toBe(0)
    expect(Object.keys(result.byModel)).toHaveLength(0)
  })

  it('uses fallback pricing but displays the real id for an unknown model', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'unknown-model-xyz': {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // Falls back to claude-sonnet-4 pricing: $3/MTok input,
    // but the display name must be the real model id, NOT a Claude name.
    expect(result.totalUSD).toBe(3.0)
    expect(result.byModel['unknown-model-xyz']).toEqual({
      modelId: 'unknown-model-xyz',
      displayName: 'unknown-model-xyz', // real id, never inherits fallback's name
      inputCost: 3.0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 3.0,
      tokens: tokensByModel['unknown-model-xyz'],
    })
    expect(result.byModel['unknown-model-xyz'].displayName).not.toBe(
      'Claude Sonnet 4',
    )
  })

  it('normalizes model IDs with date suffixes', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4-20250514': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // Should normalize to claude-sonnet-4 and match pricing
    expect(result.totalUSD).toBe(10.5)
    expect(result.byModel['claude-sonnet-4']).toBeDefined()
    expect(result.byModel['claude-sonnet-4-20250514']).toBeUndefined()
  })

  it('accumulates tokens for same normalized model from different raw IDs', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4-20250514': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'claude-sonnet-4-20250601': {
        inputTokens: 500_000,
        outputTokens: 250_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // Both normalize to claude-sonnet-4 and should accumulate
    // 1.5M input ($4.50) + 0.75M output ($11.25) = $15.75
    expect(result.totalUSD).toBe(15.75)
    expect(result.byModel['claude-sonnet-4']).toEqual({
      modelId: 'claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      inputCost: 4.5,
      outputCost: 11.25,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 15.75,
      tokens: {
        inputTokens: 1_500_000,
        outputTokens: 750_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    })
  })

  it('calculates cache read and cache write costs', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4': {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 2_000_000,
        cacheCreationInputTokens: 500_000,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // claude-sonnet-4: input $3/MTok, cacheRead $0.3/MTok, cacheWrite $3.75/MTok
    // 1M input ($3) + 2M cacheRead ($0.60) + 0.5M cacheWrite ($1.875) = $5.475
    expect(result.totalUSD).toBe(5.475)
    expect(result.byCategory.input).toBe(3.0)
    expect(result.byCategory.output).toBe(0)
    expect(result.byCategory.cacheRead).toBe(0.6)
    expect(result.byCategory.cacheWrite).toBe(1.875)
  })

  it('resolves a Codex model (gpt-5.5) to its name and OpenAI rates, not Claude', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'gpt-5.5': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // gpt-5.5: input $1.25/MTok, output $10/MTok
    // 1M input ($1.25) + 0.5M output ($5.00) = $6.25
    expect(result.totalUSD).toBe(6.25)
    expect(result.byModel['gpt-5.5']).toEqual({
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5', // friendly name, NOT "Claude Sonnet 4"
      inputCost: 1.25,
      outputCost: 5.0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 6.25,
      tokens: tokensByModel['gpt-5.5'],
    })
    expect(result.byModel['gpt-5.5'].displayName).not.toBe('Claude Sonnet 4')
  })

  it('charges zero cache-write cost for OpenAI models (no cache-creation concept)', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'gpt-5.5': {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 2_000_000,
        cacheCreationInputTokens: 1_000_000, // would-be cache-write tokens
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // gpt-5.5: cacheRead $0.125/MTok, cacheWrite $0/MTok
    // 2M cacheRead ($0.25) + 1M cacheWrite ($0.00) = $0.25
    expect(result.byCategory.cacheWrite).toBe(0)
    expect(result.byModel['gpt-5.5'].cacheWriteCost).toBe(0)
    expect(result.byCategory.cacheRead).toBe(0.25)
    expect(result.totalUSD).toBe(0.25)
  })

  it('bills reasoning tokens at the output rate, added to output cost', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'gpt-5.5': {
        inputTokens: 0,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 500_000,
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // gpt-5.5 output $10/MTok: (0.5M output + 0.5M reasoning) = 1M @ $10 = $10
    expect(result.byCategory.output).toBe(10.0)
    expect(result.byModel['gpt-5.5'].outputCost).toBe(10.0)
    expect(result.totalUSD).toBe(10.0)
  })

  it('does not change Claude output cost when reasoning tokens are undefined', () => {
    const tokensByModel: Record<string, TokenUsage> = {
      'claude-sonnet-4': {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        // reasoningOutputTokens intentionally undefined (Claude has none)
      },
    }

    const pricingTable = getMergedPricing(DEFAULT_SETTINGS)
    const result = calculateSessionCost(tokensByModel, pricingTable)

    // Identical to the original Claude cost: 1M input ($3) + 0.5M output ($7.50) = $10.50
    expect(result.totalUSD).toBe(10.5)
    expect(result.byCategory.output).toBe(7.5)
    expect(result.byModel['claude-sonnet-4'].outputCost).toBe(7.5)
    expect(result.byModel['claude-sonnet-4'].displayName).toBe('Claude Sonnet 4')
  })
})

describe('getMergedPricing', () => {
  it('returns default pricing when no overrides', () => {
    const settings: Settings = DEFAULT_SETTINGS
    const result = getMergedPricing(settings)

    expect(Object.keys(result).length).toBe(DEFAULT_PRICING.length)
    expect(result['claude-sonnet-4']).toEqual({
      modelId: 'claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    })
  })

  it('merges partial overrides correctly', () => {
    const settings: Settings = {
      version: 1,
      subscriptionTier: 'pro',
      dataSources: [],
      pricingOverrides: {
        'claude-sonnet-4': {
          inputPerMTok: 5.0,
          outputPerMTok: 20.0,
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.0,
        },
      },
    }

    const result = getMergedPricing(settings)

    // Overridden model
    expect(result['claude-sonnet-4']).toEqual({
      modelId: 'claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      inputPerMTok: 5.0,
      outputPerMTok: 20.0,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.0,
    })

    // Non-overridden model should use defaults
    expect(result['claude-opus-4-6']).toEqual({
      modelId: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6',
      inputPerMTok: 5.0,
      outputPerMTok: 25.0,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    })
  })

  it('handles full overrides for all models', () => {
    const overrides: Settings['pricingOverrides'] = {}
    for (const model of DEFAULT_PRICING) {
      overrides[model.modelId] = {
        inputPerMTok: 10.0,
        outputPerMTok: 50.0,
        cacheReadPerMTok: 1.0,
        cacheWritePerMTok: 12.5,
      }
    }

    const settings: Settings = {
      version: 1,
      subscriptionTier: 'pro',
      pricingOverrides: overrides,
      dataSources: [],
    }

    const result = getMergedPricing(settings)

    // All models should have overridden pricing
    for (const modelId of Object.keys(result)) {
      expect(result[modelId].inputPerMTok).toBe(10.0)
      expect(result[modelId].outputPerMTok).toBe(50.0)
      expect(result[modelId].cacheReadPerMTok).toBe(1.0)
      expect(result[modelId].cacheWritePerMTok).toBe(12.5)
    }
  })
})
