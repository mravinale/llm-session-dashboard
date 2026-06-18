import { z } from 'zod'

// --- Zod Schemas ---

export const ModelPricingOverrideSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0),
  cacheWritePerMTok: z.number().min(0),
})

export const SettingsSchema = z.object({
  version: z.literal(1),
  subscriptionTier: z
    .enum(['free', 'pro', 'max-5x', 'max-20x', 'teams', 'enterprise', 'api'])
    .default('pro'),
  pricingOverrides: z
    .record(z.string(), ModelPricingOverrideSchema)
    .default({}),
  dataSources: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        path: z.string(),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  updatedAt: z.string().datetime().optional(),
})

// --- TypeScript Types ---

export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type SubscriptionTierId = Settings['subscriptionTier']

export interface ModelPricing {
  modelId: string
  displayName: string
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

export interface SubscriptionTier {
  id: SubscriptionTierId
  displayName: string
  monthlyUSD: number | null
}

// --- Constants ---

export const DEFAULT_PRICING: ModelPricing[] = [
  {
    modelId: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  {
    modelId: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  {
    modelId: 'claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    inputPerMTok: 15.0,
    outputPerMTok: 75.0,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  {
    modelId: 'claude-opus-4',
    displayName: 'Claude Opus 4',
    inputPerMTok: 15.0,
    outputPerMTok: 75.0,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  {
    modelId: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  {
    modelId: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  {
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  {
    modelId: 'claude-haiku-3-5',
    displayName: 'Claude Haiku 3.5',
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1.0,
  },
  {
    modelId: 'claude-haiku-3',
    displayName: 'Claude Haiku 3',
    inputPerMTok: 0.25,
    outputPerMTok: 1.25,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0.3,
  },
  // --- OpenAI / Codex models ---
  // Estimated OpenAI/Codex pricing — verify against current OpenAI rates; users
  // can override per-model in Settings. Based on the GPT-5 family API pricing
  // structure (input $1.25/MTok, cached-input $0.125/MTok, output $10/MTok).
  // OpenAI does NOT publish cache-WRITE pricing (no cache-creation concept), so
  // cacheWritePerMTok is 0 for all OpenAI rows.
  {
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
  {
    modelId: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
  {
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
  {
    modelId: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
  {
    modelId: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
  {
    modelId: 'gpt-5',
    displayName: 'GPT-5',
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 0,
  },
]

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
  { id: 'free', displayName: 'Free', monthlyUSD: 0 },
  { id: 'pro', displayName: 'Pro', monthlyUSD: 20 },
  { id: 'max-5x', displayName: 'Max 5x', monthlyUSD: 100 },
  { id: 'max-20x', displayName: 'Max 20x', monthlyUSD: 200 },
  { id: 'teams', displayName: 'Teams', monthlyUSD: 150 },
  { id: 'enterprise', displayName: 'Enterprise', monthlyUSD: null },
  { id: 'api', displayName: 'API Only', monthlyUSD: null },
]

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  subscriptionTier: 'pro',
  pricingOverrides: {},
  dataSources: [],
}

// --- Helpers ---

/** Strip date suffix from model IDs: claude-sonnet-4-20250514 -> claude-sonnet-4 */
export function normalizeModelId(raw: string): string {
  return raw.replace(/-\d{8}$/, '')
}
