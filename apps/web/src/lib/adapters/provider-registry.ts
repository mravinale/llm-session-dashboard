import { z } from 'zod'

/**
 * Single source of truth for provider identity and presentation (P2).
 *
 * This module is intentionally **client-safe**: it imports no `fs`/`os` and
 * carries only presentation facts (id, label, badge classes). Provider I/O
 * (root resolution, availability probing, parsing) lives behind the server-only
 * adapter registry in `adapter.ts`.
 *
 * Adding a new provider is a one-line change here (plus a `lib/adapters/<id>/`
 * folder and one line in the adapter registry).
 */
export interface ProviderDescriptor {
  /** Stable provider id used as a discriminator on domain types. */
  id: string
  /** Human-readable label for badges, filters, and copy. */
  label: string
  /** Tailwind classes for the provider badge. */
  badgeClass: string
}

/**
 * The complete set of known providers.
 *
 * Codex is added in Phase 1. Its badge color is teal/emerald to stay distinct
 * from the platform `SourceBadge` colors (which use gray/blue/amber) and from
 * the Claude brand-terracotta badge.
 */
export const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    badgeClass: 'bg-brand-700/30 text-brand-300 border border-brand-700/40',
  },
  {
    id: 'codex',
    label: 'Codex',
    badgeClass: 'bg-emerald-700/25 text-emerald-300 border border-emerald-700/40',
  },
] as const satisfies readonly ProviderDescriptor[]

/** Union of all known provider ids, e.g. `'claude'`. */
export type ProviderId = (typeof PROVIDERS)[number]['id']

/** All provider ids, for iteration and deriving Zod enums. */
export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [ProviderId, ...ProviderId[]]

/** Zod enum of provider ids, for validating server-fn / route input. */
export const providerIdSchema = z.enum(PROVIDER_IDS)

/** Zod enum including the `'all'` sentinel, for the provider filter. */
export const providerFilterSchema = z.enum(['all', ...PROVIDER_IDS] as [string, ...string[]])

/**
 * Look up presentation metadata (label, badge classes) for a provider id.
 * Falls back to the first provider if an unknown id is passed (defensive).
 */
export function getProviderMeta(id: ProviderId): ProviderDescriptor {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}
