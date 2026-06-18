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
  /**
   * Builds the shell command that resumes a session for this provider.
   * Kept here (not in the card) so the per-provider syntax is single-sourced.
   * Codex verified against the installed CLI: `codex resume [SESSION_ID]` (Q1).
   */
  resumeCommand: (sessionId: string) => string
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
    resumeCommand: (sessionId: string) => `claude --resume ${sessionId}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    badgeClass: 'bg-emerald-700/25 text-emerald-300 border border-emerald-700/40',
    resumeCommand: (sessionId: string) => `codex resume ${sessionId}`,
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

/** Filter value: a provider id or the `'all'` sentinel. */
export type ProviderFilter = 'all' | ProviderId

/**
 * Look up presentation metadata (label, badge classes) for a provider id.
 * Falls back to the first provider if an unknown id is passed (defensive).
 */
export function getProviderMeta(id: ProviderId): ProviderDescriptor {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * Builds the provider-aware resume command for a session, e.g.
 * `claude --resume <id>` (Claude) or `codex resume <id>` (Codex).
 */
export function getResumeCommand(provider: ProviderId, sessionId: string): string {
  return getProviderMeta(provider).resumeCommand(sessionId)
}

/**
 * Human-readable phrase for the set of providers present, used in page copy.
 * e.g. `['claude']` -> "Claude" ; `['claude','codex']` -> "Claude & Codex".
 * Falls back to "Claude" when nothing is present (keeps prior Claude-only copy).
 */
export function describeProviders(present: readonly ProviderId[]): string {
  const labels = PROVIDER_IDS.filter((id) => present.includes(id)).map(
    (id) => getProviderMeta(id).label,
  )
  if (labels.length === 0) return getProviderMeta(PROVIDER_IDS[0]).label
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`
}
