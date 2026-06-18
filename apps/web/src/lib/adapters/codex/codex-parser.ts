import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { readHeadLines, readTailLines } from '@/lib/adapters/shared/jsonl-io'
import { extractProjectName } from '@/lib/utils/claude-path'
import {
  codexLineSchema,
  type CodexLine,
} from '@/lib/adapters/codex/codex-raw.types'
import { mapSummary, mapDetail } from '@/lib/adapters/codex/codex-mapper'
import { getCodexHome } from '@/lib/adapters/codex/codex-path'
import { lookupCodexTitle } from '@/lib/adapters/codex/codex-scanner'
import type { SessionSummary, SessionDetail } from '@/lib/parsers/types'

/**
 * Codex I/O layer (P1): owns `fs`/readline/head-tail and feeds validated
 * `CodexLine[]` into the pure `codex-mapper`. No domain mapping happens here.
 */

/** Head lines cover `session_meta` (re-emitted up to ~10×) + first messages. */
const HEAD_LINES = 40

/**
 * Tail window is LARGER than Claude's 15: Codex token totals (cumulative
 * `token_count`) and `lastActiveAt` live on the last lines, and token_count
 * lines are interleaved with messages, so we read a generous tail.
 */
const TAIL_LINES = 80

/** Parse one JSONL line into a validated envelope, or `null` on failure. */
function parseLine(line: string): CodexLine | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const result = codexLineSchema.safeParse(raw)
  return result.success ? result.data : null
}

function parseLines(lines: string[]): CodexLine[] {
  const parsed: CodexLine[] = []
  for (const line of lines) {
    if (!line) continue
    const envelope = parseLine(line)
    if (envelope) parsed.push(envelope)
  }
  return parsed
}

/**
 * Lightweight summary parse: read head + a large tail, validate per line,
 * delegate to `mapSummary`. `outputTokens` is filled in by the mapper from the
 * last `token_count` in the tail window (no separate read needed for summaries).
 */
export async function parseSummary(
  filePath: string,
  sessionId: string,
  fileSizeBytes: number,
  title?: string,
): Promise<SessionSummary | null> {
  const [headStrings, tailStrings] = await Promise.all([
    readHeadLines(filePath, HEAD_LINES),
    readTailLines(filePath, TAIL_LINES),
  ])

  const headLines = parseLines(headStrings)
  const tailLines = parseLines(tailStrings)

  return mapSummary(headLines, tailLines, {
    sessionId,
    fileSizeBytes,
    title,
    extractProjectName,
  })
}

/**
 * Full streaming detail parse (Phase 3): a single `readline` pass over the
 * rollout file (no whole-file load), validating each line and collecting the
 * envelopes, then delegating to the PURE `mapDetail`. The session title is
 * loaded from the scanner's `session_index` helper and passed via ctx.
 */
export async function parseDetail(
  filePath: string,
  sessionId: string,
  projectPath: string,
  projectName: string,
): Promise<SessionDetail> {
  const lines: CodexLine[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const raw of rl) {
      if (!raw) continue
      const envelope = parseLine(raw)
      if (envelope) lines.push(envelope)
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  const title = lookupCodexTitle(getCodexHome(), sessionId)

  return mapDetail(lines, {
    sessionId,
    projectPath,
    projectName,
    title,
  })
}

/**
 * Cheap, tail-only read of the last cumulative `output_tokens` (for the
 * sessions list / project-analytics columns). Returns `undefined` if no
 * `token_count` is present in the tail window.
 */
export async function parseOutputTokens(
  filePath: string,
): Promise<number | undefined> {
  const tailStrings = await readTailLines(filePath, TAIL_LINES)
  const tailLines = parseLines(tailStrings)

  let outputTokens: number | undefined
  for (const line of tailLines) {
    if (line.type !== 'event_msg') continue
    const payload = line.payload as Record<string, unknown> | undefined
    if (payload?.['type'] !== 'token_count') continue
    const info = payload['info'] as
      | { total_token_usage?: { output_tokens?: number } }
      | undefined
    const value = info?.total_token_usage?.output_tokens
    if (typeof value === 'number') outputTokens = value
  }
  return outputTokens
}

/**
 * Return the type/payload.type of the LAST parsed envelope in the tail. Used by
 * the adapter's `isActive` to detect a terminal `event_msg`/`task_complete`.
 */
export async function readLastEventType(
  filePath: string,
): Promise<{ type: string; payloadType?: string } | null> {
  const tailStrings = await readTailLines(filePath, 5)
  const tailLines = parseLines(tailStrings)
  if (tailLines.length === 0) return null
  const last = tailLines[tailLines.length - 1]
  const payload = last.payload as Record<string, unknown> | undefined
  const pt = payload?.['type']
  return {
    type: last.type,
    payloadType: typeof pt === 'string' ? pt : undefined,
  }
}
