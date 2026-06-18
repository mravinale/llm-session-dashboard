import type {
  ContextWindowData,
  ContextWindowSnapshot,
} from '@/lib/parsers/types'

/** Default context-window size when a provider supplies no real limit. */
export const DEFAULT_CONTEXT_LIMIT = 200_000

/**
 * Build the context-window panel data from a series of cumulative-context
 * snapshots (P3 — promoted from `session-parser.ts`).
 *
 * The math is identical across providers; only the `contextLimit` differs:
 * Claude has no per-session limit on disk and passes `DEFAULT_CONTEXT_LIMIT`,
 * while Codex supplies a real `model_context_window` from its token-count lines.
 */
export function buildContextWindowData(
  snapshots: ContextWindowSnapshot[],
  modelName: string,
  contextLimit: number = DEFAULT_CONTEXT_LIMIT,
): ContextWindowData | null {
  if (snapshots.length === 0) return null

  const autocompactBuffer = Math.round(contextLimit * 0.165)
  const systemOverhead = snapshots[0].contextSize
  const currentContextSize = snapshots[snapshots.length - 1].contextSize
  const messagesEstimate = Math.max(0, currentContextSize - systemOverhead)
  const freeSpace = Math.max(0, contextLimit - currentContextSize)
  const usagePercent = Math.round((currentContextSize / contextLimit) * 100)

  return {
    contextLimit,
    modelName,
    systemOverhead,
    currentContextSize,
    messagesEstimate,
    freeSpace,
    autocompactBuffer,
    usagePercent,
    snapshots,
  }
}
