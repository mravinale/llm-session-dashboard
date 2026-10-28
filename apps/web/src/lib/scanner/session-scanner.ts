import * as fs from 'node:fs'
import * as path from 'node:path'
import { getProjectsDir, getProjectsDirFor, getDataSources, extractSessionId } from '../utils/claude-path'
import type { DataSource } from '../utils/claude-path'
import { scanProjectsFrom } from './project-scanner'
import { isSessionActive } from './active-detector'
import { parseSummary, parseOutputTokens } from '../parsers/session-parser'
import type { SessionSummary } from '../parsers/types'
import { getAdapters, type SessionSummaryWithPath } from '@/lib/adapters/adapter'

export type { SessionSummaryWithPath }

// In-memory cache: sessionId -> { mtime, summary }
const summaryCache = new Map<
  string,
  { mtimeMs: number; summary: SessionSummary }
>()

/**
 * Internal scan: iterate every registered adapter (P5), enumerate its sources,
 * and collect summaries with file paths. Results are deduplicated by
 * `${provider}:${sessionId}` (keeping the newest `lastActiveAt`) and sorted
 * newest-first.
 *
 * With only the Claude adapter registered (Phase 0), this produces the same
 * output as the former single-source scan: the Claude adapter's primary-source
 * scan reproduces the legacy behavior exactly (no source fields stamped).
 */
async function scanSessionsInternal(): Promise<SessionSummaryWithPath[]> {
  const adapters = getAdapters()
  const collected: SessionSummaryWithPath[] = []

  for (const adapter of adapters) {
    const sources = await adapter.getSources()
    for (const source of sources) {
      if (!source.available) continue
      const summaries = await adapter.scanSummaries(source)
      collected.push(...summaries)
    }
  }

  // Deduplicate by provider-scoped session id, keeping the newest lastActiveAt.
  const deduped = new Map<string, SessionSummaryWithPath>()
  for (const summary of collected) {
    const key = `${summary.provider}:${summary.sessionId}`
    const existing = deduped.get(key)
    if (
      !existing ||
      new Date(summary.lastActiveAt).getTime() >
        new Date(existing.lastActiveAt).getTime()
    ) {
      deduped.set(key, summary)
    }
  }

  const results = Array.from(deduped.values())
  results.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
  )

  return results
}

/** Public API: returns SessionSummary[] without filePath -- used by server functions that serialize to client. */
export async function scanAllSessions(): Promise<SessionSummary[]> {
  const results = await scanSessionsInternal()
  // Strip filePath to avoid leaking absolute paths to the client
  return results.map(({ filePath: _filePath, ...summary }) => summary)
}

/** Public API: returns SessionSummaryWithPath[] -- used by server-side stats enrichment. */
export async function scanAllSessionsWithPaths(): Promise<SessionSummaryWithPath[]> {
  return scanSessionsInternal()
}

export async function getActiveSessions(): Promise<SessionSummary[]> {
  const all = await scanAllSessions()
  return all.filter((s) => s.isActive)
}

/**
 * Scan sessions from a single Claude DataSource, setting sourceId and
 * sourceLabel on each result. Retained as the Claude per-source worker for the
 * legacy multi-source path and its tests. For non-primary sources, passes
 * projectsDirOverride to isSessionActive.
 */
export async function scanSessionsFromSource(source: DataSource): Promise<SessionSummary[]> {
  const projects = await scanProjectsFrom(source)
  const summaries: SessionSummary[] = []
  const projectsDirOverride = source.id !== 'primary' ? getProjectsDirFor(source) : undefined

  for (const project of projects) {
    for (const file of project.sessionFiles) {
      const sessionId = extractSessionId(file)
      const projectsDir = source.id === 'primary' ? getProjectsDir() : getProjectsDirFor(source)
      const filePath = path.join(projectsDir, project.dirName, file)

      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat) continue

      const cached = summaryCache.get(`${source.id}:${sessionId}`)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        const active = await isSessionActive(project.dirName, sessionId, projectsDirOverride)
        summaries.push({
          ...cached.summary,
          isActive: active,
          sourceId: source.id,
          sourceLabel: source.label,
          sourcePlatform: source.platform,
        })
        continue
      }

      const summary = await parseSummary(
        filePath,
        sessionId,
        project.decodedPath,
        project.projectName,
        stat.size,
      )

      if (summary) {
        const active = await isSessionActive(project.dirName, sessionId, projectsDirOverride)
        summary.isActive = active
        summary.outputTokens = await parseOutputTokens(filePath).catch(() => undefined)
        summary.sourceId = source.id
        summary.sourceLabel = source.label
        summary.sourcePlatform = source.platform

        summaryCache.set(`${source.id}:${sessionId}`, {
          mtimeMs: stat.mtimeMs,
          summary,
        })
        summaries.push(summary)
      }
    }
  }

  return summaries
}

/**
 * Scan sessions from all available Claude DataSources, merging results sorted by
 * lastActiveAt descending. Deduplicates by sessionId, keeping the entry with the
 * most recent lastActiveAt.
 *
 * @deprecated Superseded by the adapter loop in `scanAllSessions()`. Retained
 * for the existing test suite and for any direct Claude multi-source callers.
 */
export async function scanAllSessionsMultiSource(): Promise<SessionSummary[]> {
  const sources = await getDataSources()
  const allSessions: SessionSummary[] = []

  for (const source of sources) {
    if (!source.available) continue
    const sessions = await scanSessionsFromSource(source)
    allSessions.push(...sessions)
  }

  // Deduplicate by sessionId, keeping the one with newest lastActiveAt
  const deduped = new Map<string, SessionSummary>()
  for (const session of allSessions) {
    const existing = deduped.get(session.sessionId)
    if (!existing || new Date(session.lastActiveAt).getTime() > new Date(existing.lastActiveAt).getTime()) {
      deduped.set(session.sessionId, session)
    }
  }

  const results = Array.from(deduped.values())
  results.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
  )

  return results
}
