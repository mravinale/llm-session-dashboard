import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { scanAllSessions, getActiveSessions } from '@/lib/scanner/session-scanner'
import type { SessionSummary } from '@/lib/parsers/types'
import {
  providerFilterSchema,
  PROVIDER_IDS,
  type ProviderId,
} from '@/lib/adapters/provider-registry'

export const getSessionList = createServerFn({ method: 'GET' }).handler(
  async () => {
    return scanAllSessions()
  },
)

export const getActiveSessionList = createServerFn({ method: 'GET' }).handler(
  async () => {
    return getActiveSessions()
  },
)

const paginatedSessionsInputSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(5).max(100),
  search: z.string(),
  status: z.enum(['all', 'active', 'completed']),
  project: z.string(),
  // Reuses the single derived enum from the registry (P2) — no duplicate literal.
  provider: providerFilterSchema.default('all'),
  sort: z.enum(['lastActive', 'started', 'duration', 'messages']).default('lastActive'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})

// `provider` is optional at the call site (Zod defaults it to 'all'); existing
// callers/tests need no change.
type PaginatedSessionsInput = Omit<
  z.infer<typeof paginatedSessionsInputSchema>,
  'provider'
> & { provider?: z.infer<typeof providerFilterSchema> }

export interface PaginatedSessionsResult {
  sessions: SessionSummary[]
  totalCount: number
  totalPages: number
  page: number
  pageSize: number
  projects: string[]
  /** Distinct providers present in the full (unfiltered) session set. */
  providers: ProviderId[]
}

/**
 * Pure business logic for paginating and filtering sessions.
 * Exported for testing purposes.
 */
export async function paginateAndFilterSessions(
  allSessions: SessionSummary[],
  input: PaginatedSessionsInput,
): Promise<PaginatedSessionsResult> {
  const {
    page,
    pageSize,
    search,
    status,
    project,
    provider = 'all',
    sort = 'lastActive',
    sortDir = 'desc',
  } = input

  // Extract distinct project names from full unfiltered set
  const projects = Array.from(
    new Set(allSessions.map((s) => s.projectName)),
  ).sort()

  // Distinct providers present, in registry order (stable for the filter UI).
  const presentProviders = new Set(allSessions.map((s) => s.provider))
  const providers = PROVIDER_IDS.filter((id) => presentProviders.has(id))

  // Apply filters
  let filtered = allSessions

  // Search filter: case-insensitive substring on projectName/branch/sessionId/cwd
  if (search) {
    const q = search.toLowerCase()
    filtered = filtered.filter(
      (s) =>
        s.projectName.toLowerCase().includes(q) ||
        s.branch?.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        s.cwd?.toLowerCase().includes(q),
    )
  }

  // Status filter
  if (status === 'active') {
    filtered = filtered.filter((s) => s.isActive)
  } else if (status === 'completed') {
    filtered = filtered.filter((s) => !s.isActive)
  }

  // Project filter: exact match
  if (project) {
    filtered = filtered.filter((s) => s.projectName === project)
  }

  // Provider filter: exact match when not the 'all' sentinel
  if (provider !== 'all') {
    filtered = filtered.filter((s) => s.provider === provider)
  }

  // Sort after filtering
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0
    switch (sort) {
      case 'lastActive':
        cmp = a.lastActiveAt.localeCompare(b.lastActiveAt)
        break
      case 'started':
        cmp = a.startedAt.localeCompare(b.startedAt)
        break
      case 'duration':
        cmp = a.durationMs - b.durationMs
        break
      case 'messages':
        cmp = a.messageCount - b.messageCount
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const totalCount = sorted.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  // Clamp page to valid range
  const clampedPage = Math.min(Math.max(1, page), totalPages)

  // Slice to page
  const start = (clampedPage - 1) * pageSize
  const end = start + pageSize
  const sessions = sorted.slice(start, end)

  return {
    sessions,
    totalCount,
    totalPages,
    page: clampedPage,
    pageSize,
    projects,
    providers,
  }
}

export const getPaginatedSessions = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown) => paginatedSessionsInputSchema.parse(input))
  .handler(async ({ data }): Promise<PaginatedSessionsResult> => {
    const allSessions = await scanAllSessions()
    return paginateAndFilterSessions(allSessions, data)
  })
