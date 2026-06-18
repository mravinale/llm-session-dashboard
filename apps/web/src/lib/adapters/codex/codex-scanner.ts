import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  getCodexSessionsDir,
  getCodexSessionIndexPath,
} from '@/lib/adapters/codex/codex-path'
import { parseSummary, parseOutputTokens } from '@/lib/adapters/codex/codex-parser'
import type { SessionSummary } from '@/lib/parsers/types'
import type { ProviderSource, SessionSummaryWithPath } from '@/lib/adapters/adapter'

/**
 * Codex session scanner: walk `sessions/YYYY/MM/DD/rollout-*.jsonl`, parse a
 * lightweight summary per file, and fold in `session_index.jsonl` titles.
 *
 * Each session is ONE file (unlike Claude's project-foldered layout). The mtime
 * cache is this scanner's OWN `Map` keyed `codex:<sessionId>` — deliberately not
 * shared with `session-scanner.ts` (P3: the walks only *look* alike).
 */

// In-memory cache: `codex:<sessionId>` -> { mtime, summary }.
const summaryCache = new Map<
  string,
  { mtimeMs: number; summary: SessionSummary }
>()

// Cached title index, mtime-guarded so we reload only when the file changes.
let titleIndexCache: { mtimeMs: number; map: Map<string, string> } | null = null

/** Extract the uuid session id from a `rollout-<ts>-<uuid>.jsonl` filename. */
function extractCodexSessionId(filename: string): string {
  const base = filename.replace(/\.jsonl$/, '')
  // rollout-2026-06-16T17-28-16-019ed21e-d66a-7ac1-918f-8e4b5fdf4a9c
  // → the uuid is the last 5 dash-separated groups.
  const parts = base.split('-')
  if (parts.length >= 5) {
    return parts.slice(-5).join('-')
  }
  return base
}

/** Recursively collect every `rollout-*.jsonl` under the sessions dir. */
function collectRolloutFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectRolloutFiles(full))
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    ) {
      files.push(full)
    }
  }
  return files
}

/**
 * Load `session_index.jsonl` into a `Map<sessionId, thread_name>`, mtime-guarded
 * and tolerant of a missing/partial file. Returns an empty map if absent.
 */
function loadTitleIndex(home: string): Map<string, string> {
  const indexPath = getCodexSessionIndexPath(home)

  let stat: fs.Stats | null
  try {
    stat = fs.statSync(indexPath)
  } catch {
    titleIndexCache = null
    return new Map()
  }

  if (titleIndexCache && titleIndexCache.mtimeMs === stat.mtimeMs) {
    return titleIndexCache.map
  }

  const map = new Map<string, string>()
  let content: string
  try {
    content = fs.readFileSync(indexPath, 'utf-8')
  } catch {
    return map
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string }
      if (entry.id && typeof entry.thread_name === 'string') {
        map.set(entry.id, entry.thread_name)
      }
    } catch {
      // Skip malformed index lines.
    }
  }

  titleIndexCache = { mtimeMs: stat.mtimeMs, map }
  return map
}

/**
 * Scan all Codex session summaries for one source, with file paths attached.
 * Returns `SessionSummaryWithPath[]` stamped `provider: 'codex'` and the source
 * fields from `ProviderSource`.
 */
export async function scanCodexSummaries(
  source: ProviderSource,
): Promise<SessionSummaryWithPath[]> {
  const sessionsDir = getCodexSessionsDir(source.rootDir)
  const titleIndex = loadTitleIndex(source.rootDir)
  const files = collectRolloutFiles(sessionsDir)

  const summaries: SessionSummaryWithPath[] = []

  for (const filePath of files) {
    const sessionId = extractCodexSessionId(path.basename(filePath))

    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat) continue

    const cacheKey = `codex:${sessionId}`
    const cached = summaryCache.get(cacheKey)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      summaries.push(stamp(cached.summary, source, filePath))
      continue
    }

    const title = titleIndex.get(sessionId)
    const summary = await parseSummary(filePath, sessionId, stat.size, title)
    if (!summary) continue

    summary.outputTokens = await parseOutputTokens(filePath).catch(
      () => undefined,
    )

    summaryCache.set(cacheKey, { mtimeMs: stat.mtimeMs, summary })
    summaries.push(stamp(summary, source, filePath))
  }

  return summaries
}

/**
 * Look up a single session's title (`thread_name`) from `session_index.jsonl`.
 * Reuses the mtime-guarded title index cache. Returns `undefined` when the
 * index is missing or has no entry for this session (the parser falls back to
 * the first user message / cwd basename via the mapper's title chain).
 */
export function lookupCodexTitle(
  home: string,
  sessionId: string,
): string | undefined {
  return loadTitleIndex(home).get(sessionId)
}

function stamp(
  summary: SessionSummary,
  source: ProviderSource,
  filePath: string,
): SessionSummaryWithPath {
  return {
    ...summary,
    provider: 'codex',
    sourceId: source.id,
    sourceLabel: source.label,
    sourcePlatform: source.platform,
    filePath,
  }
}
