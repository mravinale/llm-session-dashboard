import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { SessionList } from '@/features/sessions/SessionList'
import { paginatedSessionListQuery } from '@/features/sessions/sessions.queries'
import { providerFilterSchema } from '@/lib/adapters/provider-registry'

const sessionsSearchSchema = z.object({
  page: z.number().int().min(1).default(1).catch(1),
  pageSize: z.number().int().min(5).max(100).default(5).catch(5),
  search: z.string().default('').catch(''),
  status: z.enum(['all', 'active', 'completed']).default('all').catch('all'),
  project: z.string().default('').catch(''),
  provider: providerFilterSchema.default('all').catch('all'),
  sort: z
    .enum(['lastActive', 'started', 'duration', 'messages'])
    .default('lastActive')
    .catch('lastActive'),
  sortDir: z.enum(['asc', 'desc']).default('desc').catch('desc'),
})

export type SessionsSearch = z.infer<typeof sessionsSearchSchema>

export const Route = createFileRoute('/_dashboard/sessions/')({
  validateSearch: sessionsSearchSchema,
  component: SessionsPage,
})

function SessionsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-100">Sessions</h1>
      <SessionsSubtitle />
      <div className="mt-6">
        <SessionList />
      </div>
    </div>
  )
}

/**
 * Provider-aware subtitle. Reuses the same paginated query the list issues
 * (identical key — React Query dedupes, no extra fetch) to learn which
 * providers are actually present. Falls back to the Claude-only copy until
 * data loads or when no Codex sessions exist.
 */
function SessionsSubtitle() {
  const search = Route.useSearch()
  const { data } = useQuery(paginatedSessionListQuery(search))
  const hasCodex = (data?.providers ?? []).includes('codex')
  const label = hasCodex ? 'Claude Code & Codex sessions' : 'Claude Code sessions'
  return <p className="mt-1 text-sm text-gray-400">{label}</p>
}
