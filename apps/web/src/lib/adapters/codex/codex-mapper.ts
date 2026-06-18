import type {
  SessionDetail,
  SessionError,
  ContextWindowSnapshot,
  ToolCall,
  TokenUsage,
  Turn,
} from '@/lib/parsers/types'
import type { SessionSummary } from '@/lib/parsers/types'
import { buildContextWindowData } from '@/lib/adapters/shared/context-window'
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

/** Context the I/O layer supplies to `mapDetail` (not derivable from lines). */
export interface CodexDetailContext {
  /** Session id (from filename uuid; `session_meta.id` overrides when present). */
  sessionId: string
  /** Absolute project path (Codex `session_meta.cwd`). */
  projectPath: string
  /** Project name (basename of cwd). */
  projectName: string
  /** Title from `session_index.jsonl`, if the index covered this session. */
  title?: string
}

/** Mirror Claude's `extractTextContent`: join text blocks, truncate to 500. */
function extractMessageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown }
    // input_text (user) / output_text (assistant) carry the human-readable text.
    if (
      (b?.type === 'input_text' || b?.type === 'output_text') &&
      typeof b.text === 'string' &&
      b.text
    ) {
      texts.push(b.text)
    }
  }
  return texts.length > 0 ? texts.join('\n').slice(0, 500) : undefined
}

/** Map a `message.role` to a domain `Turn.type`. */
function turnTypeForRole(role: unknown): Turn['type'] | null {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'developer' || role === 'system') return 'system'
  return null
}

/** Build a `ToolCall` from a `function_call` / `custom_tool_call` payload (4.4). */
function toToolCall(payload: CodexPayload): ToolCall | null {
  const p = payload ?? {}
  const name = p['name']
  if (typeof name !== 'string' || !name) return null

  const callId = p['call_id']
  const toolUseId = typeof callId === 'string' ? callId : ''

  let input: Record<string, unknown> = {}
  // function_call carries a JSON `arguments` string; custom_tool_call a raw `input`.
  const args = p['arguments']
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object') {
        input = parsed as Record<string, unknown>
      }
    } catch {
      input = {}
    }
  } else {
    const raw = p['input']
    if (raw && typeof raw === 'object') input = raw as Record<string, unknown>
    else if (typeof raw === 'string') input = { input: raw }
  }

  return { toolName: name, toolUseId, input }
}

/** Sum delta token usage into a per-model accumulator. */
function addUsage(target: TokenUsage, delta: CodexTokenUsage): void {
  target.inputTokens += delta.input_tokens ?? 0
  target.outputTokens += delta.output_tokens ?? 0
  target.cacheReadInputTokens += delta.cached_input_tokens ?? 0
  // Codex has no cache-write metric.
  if (delta.reasoning_output_tokens != null) {
    target.reasoningOutputTokens =
      (target.reasoningOutputTokens ?? 0) + delta.reasoning_output_tokens
  }
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}

/** Best-effort: pull a non-zero exec exit code from a `function_call_output`. */
function parseExitCode(output: unknown): number | null {
  if (typeof output !== 'string') return null
  const match = output.match(/exited with code (\d+)/i)
  if (!match) return null
  const code = Number(match[1])
  return Number.isFinite(code) && code !== 0 ? code : null
}

/**
 * Map a Codex session's full envelope stream into a normalized `SessionDetail`
 * (Sections 4.2–4.9). PURE — no `fs`; the I/O layer feeds validated `CodexLine[]`.
 *
 * Turn grouping: one `Turn` per `response_item.message`; `function_call` /
 * `custom_tool_call` items between this message and the next are folded in as
 * `toolCalls`; `reasoning` items are folded into the owning assistant turn (no
 * separate turn). Tokens are cumulative — `totalTokens` is the LAST
 * `token_count.total_token_usage`; per-model attribution sums `last_token_usage`
 * deltas keyed to the active `turn_context.model`. Agents/skills/tasks degrade
 * to `[]` until Phase 4.
 */
export function mapDetail(
  lines: CodexLine[],
  ctx: CodexDetailContext,
): SessionDetail {
  const turns: Turn[] = []
  const tokensByModel: Record<string, TokenUsage> = {}
  const toolFrequency: Record<string, number> = {}
  const errors: SessionError[] = []
  const snapshots: ContextWindowSnapshot[] = []
  const modelsSet = new Set<string>()

  let activeModel: string | undefined
  let activeTurnId: string | undefined
  let currentTurn: Turn | null = null
  let messageIndex = 0
  let snapshotIndex = 0
  // Track turn_ids already used so multi-message turns get unique uuids.
  const usedTurnIds = new Set<string>()

  // Cumulative totals + the real context limit live on the LAST token_count.
  let lastTotalUsage: CodexTokenUsage | null = null
  let contextLimit: number | undefined
  let taskStartedContextWindow: number | undefined

  for (const line of lines) {
    const payload = line.payload as CodexPayload
    const ts = line.timestamp ?? ''

    switch (line.type) {
      case 'turn_context': {
        const m = payload?.['model']
        if (typeof m === 'string' && m) {
          activeModel = m
          modelsSet.add(m)
        }
        const tid = payload?.['turn_id']
        activeTurnId = typeof tid === 'string' && tid ? tid : undefined
        break
      }

      case 'response_item': {
        const pt = payloadType(line)

        if (pt === 'message') {
          const role = payload?.['role']
          const type = turnTypeForRole(role)
          if (type) {
            const turn: Turn = {
              uuid: synthTurnId(activeTurnId, messageIndex, usedTurnIds),
              type,
              timestamp: ts,
              message: extractMessageText(payload?.['content']),
              model: activeModel,
              toolCalls: [],
            }
            turns.push(turn)
            currentTurn = turn
            messageIndex++
          }
        } else if (pt === 'function_call' || pt === 'custom_tool_call') {
          const tool = toToolCall(payload)
          if (tool) {
            // Tool calls between this message and the next belong to the turn
            // that produced them (the most recent assistant/user turn).
            if (currentTurn) currentTurn.toolCalls.push(tool)
            toolFrequency[tool.toolName] =
              (toolFrequency[tool.toolName] ?? 0) + 1
          }
        } else if (pt === 'function_call_output') {
          const code = parseExitCode(payload?.['output'])
          if (code != null) {
            errors.push({
              timestamp: ts,
              message: `Command exited with code ${code}`,
              type: 'exec',
            })
          }
        }
        // `reasoning` items carry no human-readable text (encrypted) and are
        // intentionally NOT turned into a separate turn — they fold into the
        // owning assistant turn, which is already represented by its message.
        break
      }

      case 'event_msg': {
        const pt = payloadType(line)
        if (pt === 'token_count') {
          const info = asTokenCountInfo(payload)
          if (info) {
            if (info.total_token_usage) lastTotalUsage = info.total_token_usage
            if (typeof info.model_context_window === 'number') {
              contextLimit = info.model_context_window
            }
            // Per-model attribution: sum per-turn deltas to the active model (4.5).
            if (info.last_token_usage && activeModel) {
              const acc = tokensByModel[activeModel] ?? emptyUsage()
              addUsage(acc, info.last_token_usage)
              tokensByModel[activeModel] = acc
            }
            // Context-window snapshot from the per-turn occupancy (4.9). Use
            // `last_token_usage` (the most recent turn's prompt size) — NOT the
            // cumulative `total_token_usage`, which grows lifetime and would
            // report context far larger than the window.
            if (info.last_token_usage) {
              const t = info.last_token_usage
              const contextSize =
                (t.input_tokens ?? 0) + (t.cached_input_tokens ?? 0)
              const last = snapshots[snapshots.length - 1]
              if (!last || last.contextSize !== contextSize) {
                snapshots.push({
                  turnIndex: snapshotIndex,
                  timestamp: ts,
                  contextSize,
                  outputTokens: t.output_tokens ?? 0,
                })
              }
              snapshotIndex++
            }
          }
        } else if (pt === 'task_started') {
          const win = payload?.['model_context_window']
          if (typeof win === 'number') taskStartedContextWindow = win
        } else if (pt === 'turn_aborted') {
          const reason = payload?.['reason']
          errors.push({
            timestamp: ts,
            message:
              typeof reason === 'string' && reason
                ? `Turn aborted: ${reason}`
                : 'Turn aborted',
            type: 'turn_aborted',
          })
        }
        break
      }

      default:
        // Unknown / forward-compat line types contribute nothing here.
        break
    }
  }

  const totalTokens: TokenUsage = lastTotalUsage
    ? {
        inputTokens: lastTotalUsage.input_tokens ?? 0,
        outputTokens: lastTotalUsage.output_tokens ?? 0,
        cacheReadInputTokens: lastTotalUsage.cached_input_tokens ?? 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: lastTotalUsage.reasoning_output_tokens,
      }
    : emptyUsage()

  const models = Array.from(modelsSet)
  const resolvedLimit = contextLimit ?? taskStartedContextWindow
  const modelName = models.length > 0 ? models[0] : 'unknown'
  const contextWindow = buildContextWindowData(
    snapshots,
    modelName,
    resolvedLimit,
  )

  return {
    sessionId: ctx.sessionId,
    provider: 'codex',
    projectPath: ctx.projectPath,
    projectName: ctx.projectName,
    branch: null,
    title: ctx.title,
    isInteractive: true,
    turns,
    totalTokens,
    tokensByModel,
    toolFrequency,
    errors,
    models,
    agents: [],
    skills: [],
    tasks: [],
    contextWindow,
  }
}

/**
 * Stable, unique turn uuid: prefer the active `turn_context.turn_id`, falling
 * back to `codex-<index>`. When a turn_id is reused across messages within the
 * same turn, later occurrences are suffixed so uuids stay unique (timeline keys).
 */
function synthTurnId(
  turnId: string | undefined,
  index: number,
  used: Set<string>,
): string {
  let id = turnId ?? `codex-${index}`
  if (used.has(id)) id = `${id}-${index}`
  used.add(id)
  return id
}
