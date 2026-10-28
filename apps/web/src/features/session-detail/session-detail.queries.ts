import { queryOptions } from '@tanstack/react-query'
import type { ProviderId } from '@/lib/adapters/provider-registry'
import { getSessionDetail } from './session-detail.api'

export function sessionDetailQuery(
  sessionId: string,
  projectPath: string,
  isActive?: boolean,
  provider?: ProviderId,
) {
  return queryOptions({
    // Provider is part of the key so a Codex and Claude session with the same
    // id (theoretically) never share a cache entry.
    queryKey: ['session', 'detail', sessionId, provider ?? null],
    queryFn: () =>
      getSessionDetail({ data: { sessionId, projectPath, provider } }),
    staleTime: isActive ? 2_000 : 30_000,
    refetchInterval: isActive ? 5_000 : undefined,
  })
}
