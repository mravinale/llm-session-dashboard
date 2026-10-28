import { getProviderMeta, type ProviderId } from '@/lib/adapters/provider-registry'

interface ProviderBadgeProps {
  provider: ProviderId
  className?: string
}

/**
 * Small badge identifying which provider produced a session.
 *
 * Label and color are derived from `provider-registry.ts` (P2) — this
 * component hardcodes no provider names or colors. Mirrors `SourceBadge`'s
 * markup/shape so the two badges sit naturally side by side on a card.
 */
export function ProviderBadge({ provider, className }: ProviderBadgeProps) {
  const { label, badgeClass } = getProviderMeta(provider)

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}${className ? ` ${className}` : ''}`}
    >
      {label}
    </span>
  )
}
