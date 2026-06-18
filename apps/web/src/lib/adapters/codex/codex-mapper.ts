import type { SessionSummary } from '@/lib/parsers/types'
import type {
  CodexLine,
  CodexSessionMeta,
  CodexTokenCountInfo,
  CodexTokenUsage,
} from '@/lib/adapters/codex/codex-raw.types'

/**
 * PURE Codex → domain mapper (P1). No `fs`/`os` imports — every function takes
 * already-parsed/validated `CodexLine[]` and returns normalized domain types,
 * so the riskiest logic (cumulative-token-last-wins, per-session model, title
 * fallback chain) is unit-testable from in-memory fixtures with zero disk.
 *
 * Phase 1 implements `mapSummary` only; `mapDetail` arrives in Phase 3.
 */

/** Context the I/O layer supplies that is not derivable from the lines alone. */
export interface CodexSummaryContext {
  /** Session id (from filename uuid; `session_meta.id` overrides when present). */
  sessionId: string
  /** Absolute on-disk JSONL size in bytes. */
  fileSizeBytes: number
  /** Title from `session_index.jsonl`, if the index covered this session. */
  title?: string
  /** Project name extractor (basename of cwd) — injected to stay fs-free. */
  extractProjectName: (absolutePath: string) => string
}

/** A `payload` after the envelope passes Zod — a loose record the mapper narrows. */
type CodexPayload = Record<string, unknown> | undefined

function payloadType(line: CodexLine): string | undefined {
  const p = line.payload as CodexPayload
  const t = p?.['type']
  return typeof t === 'string' ? t : undefined
}

function asSessionMeta(payload: CodexPayload): CodexSessionMeta {
  const p = payload ?? {}
  return {
    id: typeof p['id'] === 'string' ? (p['id'] as string) : undefined,
    timestamp:
      typeof p['timestamp'] === 'string' ? (p['timestamp'] as string) : undefined,
    cwd: typeof p['cwd'] === 'string' ? (p['cwd'] as string) : undefined,
    cli_version:
      typeof p['cli_version'] === 'string'
        ? (p['cli_version'] as string)
        : undefined,
    model_provider:
      typeof p['model_provider'] === 'string'
        ? (p['model_provider'] as string)
        : undefined,
    originator:
      typeof p['originator'] === 'string' ? (p['originator'] as string) : undefined,
  }
}

function asTokenCountInfo(payload: CodexPayload): CodexTokenCountInfo | null {
  const info = payload?.['info']
  if (!info || typeof info !== 'object') return null
  return info as CodexTokenCountInfo
}

function firstUserMessageText(lines: CodexLine[]): string | undefined {
  for (const line of lines) {
    const p = line.payload as CodexPayload
    const pt = payloadType(line)

    // `event_msg` user_message → payload.message (string)
    if (line.type === 'event_msg' && pt === 'user_message') {
      const msg = p?.['message']
      if (typeof msg === 'string' && msg.trim()) return truncate(msg, 80)
    }

    // `response_item` message with role 'user' → first input_text block
    if (line.type === 'response_item' && pt === 'message' && p?.['role'] === 'user') {
      const content = p['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          const text = (block as { text?: unknown })?.text
          if (typeof text === 'string' && text.trim()) return truncate(text, 80)
        }
      }
    }
  }
  return undefined
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/**
 * Map a Codex session's head + tail envelope lines into a normalized
 * `SessionSummary` (Section 4.1).
 *
 * `headLines` carries `session_meta` (+ first messages); `tailLines` carries the
 * cumulative token totals and the last `lastActiveAt`. They overlap for short
 * sessions — counts are de-duped by scanning a merged, de-duplicated set.
 */
export function mapSummary(
  headLines: CodexLine[],
  tailLines: CodexLine[],
  ctx: CodexSummaryContext,
): SessionSummary | null {
  // Merge head+tail without double-counting overlapping lines (short sessions).
  const seen = new Set<CodexLine>()
  const allLines: CodexLine[] = []
  for (const line of [...headLines, ...tailLines]) {
    if (!seen.has(line)) {
      seen.add(line)
      allLines.push(line)
    }
  }
  if (allLines.length === 0) return null

  let sessionId = ctx.sessionId
  let cwd: string | null = null
  let version: string | null = null
  let startedAt: string | null = null
  let lastActiveAt: string | null = null

  let model: string | null = null
  let userMessageCount = 0
  let assistantMessageCount = 0
  let totalMessageCount = 0
  let toolCallCount = 0

  // Cumulative token totals live on the LAST token_count — track latest by index.
  let lastTokenUsage: CodexTokenUsage | null = null
  let sessionMetaSeen = false

  for (const line of allLines) {
    const ts = line.timestamp
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!lastActiveAt || ts > lastActiveAt) lastActiveAt = ts
    }

    const payload = line.payload as CodexPayload

    switch (line.type) {
      case 'session_meta': {
        // First session_meta is canonical (it can be re-emitted on resume).
        if (!sessionMetaSeen) {
          const meta = asSessionMeta(payload)
          if (meta.id) sessionId = meta.id
          if (meta.cwd) cwd = meta.cwd
          if (meta.cli_version) version = meta.cli_version
          if (meta.timestamp) {
            if (!startedAt || meta.timestamp < startedAt) startedAt = meta.timestamp
          }
          sessionMetaSeen = true
        }
        break
      }

      case 'turn_context': {
        // Per-session model = most-recent turn_context.model (can vary per turn).
        const m = payload?.['model']
        if (typeof m === 'string' && m) model = m
        break
      }

      case 'response_item': {
        const pt = payloadType(line)
        if (pt === 'message') {
          const role = payload?.['role']
          if (role === 'user') {
            userMessageCount++
            totalMessageCount++
          } else if (role === 'assistant') {
            assistantMessageCount++
            totalMessageCount++
          } else if (role === 'developer' || role === 'system') {
            totalMessageCount++
          }
        } else if (pt === 'function_call' || pt === 'custom_tool_call') {
          toolCallCount++
        }
        break
      }

      case 'event_msg': {
        const pt = payloadType(line)
        if (pt === 'token_count') {
          // Cumulative — keep the latest (lines are already in file order).
          const info = asTokenCountInfo(payload)
          if (info?.total_token_usage) lastTokenUsage = info.total_token_usage
        }
        break
      }

      default:
        // Unknown / forward-compat line types (`compacted`, future types) are
        // tolerated and contribute only to the timestamp window above.
        break
    }
  }

  if (!startedAt) return null

  const resolvedLastActive = lastActiveAt ?? startedAt
  const durationMs =
    new Date(resolvedLastActive).getTime() - new Date(startedAt).getTime()

  const projectPath = cwd ?? ''
  const projectName = cwd ? ctx.extractProjectName(cwd) : ''

  // Title fallback chain: session_index thread_name → first user message → cwd basename.
  const title =
    ctx.title ?? firstUserMessageText(allLines) ?? (projectName || undefined)

  const outputTokens = lastTokenUsage?.output_tokens
  const reasoningOutputTokens = lastTokenUsage?.reasoning_output_tokens

  return {
    sessionId,
    provider: 'codex',
    projectPath,
    projectName,
    branch: null,
    cwd,
    startedAt,
    lastActiveAt: resolvedLastActive,
    durationMs,
    messageCount: totalMessageCount,
    userMessageCount,
    assistantMessageCount,
    isActive: false, // Set by the adapter (mtime + last-event rule).
    toolCallCount,
    model,
    version,
    fileSizeBytes: ctx.fileSizeBytes,
    outputTokens,
    title,
    reasoningOutputTokens,
    isInteractive: true,
  }
}
