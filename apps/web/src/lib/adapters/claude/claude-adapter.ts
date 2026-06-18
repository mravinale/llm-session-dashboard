import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  getProjectsDir,
  getProjectsDirFor,
  getDataSources,
  extractSessionId,
  extractProjectName,
  decodeProjectDirName,
} from '@/lib/utils/claude-path'
import type { DataSource } from '@/lib/utils/claude-path'
import { scanProjects, scanProjectsFrom } from '@/lib/scanner/project-scanner'
import { isSessionActive } from '@/lib/scanner/active-detector'
import { parseSummary, parseOutputTokens, parseDetail } from '@/lib/parsers/session-parser'
import type { SessionSummary, SessionDetail } from '@/lib/parsers/types'
import type {
  SessionSourceAdapter,
  ProviderSource,
  SessionSummaryWithPath,
} from '@/lib/adapters/adapter'

/**
 * Claude provider adapter (P5/P6 — thin wrapper, no logic change).
 *
 * This adapter delegates entirely to the existing, battle-tested Claude
 * functions and stamps `provider: 'claude'` on every result. The proven WSL
 * `DataSource` enumeration is reused here verbatim; the only new responsibility
 * is mapping `DataSource → ProviderSource` at the boundary and absorbing the
 * former `find-session-file.ts` free function behind `findSessionFile()`.
 */

// In-memory cache: `<sourceId>:<sessionId>` -> { mtime, summary }.
// This is the cache formerly held in `session-scanner.ts`; moving it here keeps
// the single-source scan behavior (and its cache-hit semantics) identical.
const summaryCache = new Map<
  string,
  { mtimeMs: number; summary: SessionSummary }
>()

/** Map a Claude `DataSource` to the provider-neutral `ProviderSource`. */
function toProviderSource(source: DataSource): ProviderSource {
  return {
    provider: 'claude',
    id: source.id,
    label: source.label,
    rootDir: source.claudeDir,
    platform: source.platform,
    available: source.available,
  }
}

async function getSources(): Promise<ProviderSource[]> {
  const sources = await getDataSources()
  return sources.map(toProviderSource)
}

/**
 * Scan summaries for one Claude source.
 *
 * For the primary source this reproduces the legacy single-source
 * `scanAllSessions()` body exactly: it scans via `scanProjects()`, checks
 * active status with the 2-arg `isSessionActive`, and does NOT stamp source
 * fields — preserving today's output byte-for-byte. Non-primary (WSL) sources
 * use `scanProjectsFrom()` and stamp source fields, matching the existing
 * multi-source worker.
 */
async function scanSummaries(
  source: ProviderSource,
): Promise<SessionSummaryWithPath[]> {
  const isPrimary = source.id === 'primary'
  const projects = isPrimary
    ? await scanProjects()
    : await scanProjectsFrom(toDataSource(source))
  const projectsDir = isPrimary
    ? getProjectsDir()
    : getProjectsDirFor(toDataSource(source))
  const projectsDirOverride = isPrimary ? undefined : projectsDir

  const summaries: SessionSummaryWithPath[] = []

  for (const project of projects) {
    for (const file of project.sessionFiles) {
      const sessionId = extractSessionId(file)
      const filePath = path.join(projectsDir, project.dirName, file)

      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat) continue

      const cacheKey = `${source.id}:${sessionId}`
      const cached = summaryCache.get(cacheKey)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        const active = await isSessionActive(
          project.dirName,
          sessionId,
          projectsDirOverride,
        )
        summaries.push(
          stampSource(
            { ...cached.summary, isActive: active },
            source,
            isPrimary,
            filePath,
          ),
        )
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
        const active = await isSessionActive(
          project.dirName,
          sessionId,
          projectsDirOverride,
        )
        summary.isActive = active
        summary.outputTokens = await parseOutputTokens(filePath).catch(
          () => undefined,
        )

        summaryCache.set(cacheKey, { mtimeMs: stat.mtimeMs, summary })
        summaries.push(stampSource(summary, source, isPrimary, filePath))
      }
    }
  }

  return summaries
}

/**
 * Stamp provider + (for non-primary sources) the source fields, and attach the
 * file path. The primary source intentionally omits source fields to match the
 * legacy single-source output.
 */
function stampSource(
  summary: SessionSummary,
  source: ProviderSource,
  isPrimary: boolean,
  filePath: string,
): SessionSummaryWithPath {
  const base: SessionSummary = { ...summary, provider: 'claude' }
  if (!isPrimary) {
    base.sourceId = source.id
    base.sourceLabel = source.label
    base.sourcePlatform = source.platform
  }
  return { ...base, filePath }
}

/** Map a `ProviderSource` back to a Claude `DataSource` for the legacy workers. */
function toDataSource(source: ProviderSource): DataSource {
  return {
    id: source.id,
    label: source.label,
    claudeDir: source.rootDir,
    platform: source.platform,
    available: source.available,
  }
}

async function isActive(
  filePath: string,
  sessionId: string,
  source: ProviderSource,
): Promise<boolean> {
  // Claude's active detection keys off the project dir name + session id + lock
  // dir. The dash-encoded project dir is the parent directory of the JSONL file.
  // (The scanner computes active status inline during the summary pass; this
  // method exists for adapter symmetry and detail-side reuse.)
  const projectsDirOverride =
    source.id === 'primary' ? undefined : getProjectsDirFor(toDataSource(source))
  const dirName = path.basename(path.dirname(filePath))
  return isSessionActive(dirName, sessionId, projectsDirOverride)
}

/**
 * Locate a Claude session JSONL across all available data sources.
 *
 * Absorbed from the former `features/session-detail/find-session-file.ts`
 * (P6/DIP): the logic now lives behind the adapter, and the feature calls the
 * adapter instead of a free function. Returns `{ path }` or `null`.
 */
async function findSessionFile(
  sessionId: string,
  projectPath: string,
): Promise<{ path: string } | null> {
  const sources = await getDataSources()

  for (const source of sources) {
    if (!source.available) continue
    const result = findInSource(sessionId, projectPath, source)
    if (result) return result
  }

  return null
}

function findInSource(
  sessionId: string,
  projectPath: string,
  source: DataSource,
): { path: string } | null {
  const projectsDir = getProjectsDirFor(source)

  let entries: string[]
  try {
    entries = fs.readdirSync(projectsDir) as string[]
  } catch {
    return null
  }

  // Try to find via projectPath match
  for (const dirName of entries) {
    const decoded = decodeProjectDirName(dirName)
    if (decoded === projectPath || dirName === projectPath) {
      const filePath = path.join(projectsDir, dirName, `${sessionId}.jsonl`)
      if (fs.existsSync(filePath)) {
        return { path: filePath }
      }
    }
  }

  // Fallback: search all projects in this source
  for (const dirName of entries) {
    const filePath = path.join(projectsDir, dirName, `${sessionId}.jsonl`)
    if (fs.existsSync(filePath)) {
      return { path: filePath }
    }
  }

  return null
}

async function parseDetailForClaude(
  filePath: string,
  sessionId: string,
  projectPath: string,
  projectName: string,
): Promise<SessionDetail> {
  const detail = await parseDetail(filePath, sessionId, projectPath, projectName)
  detail.provider = 'claude'
  return detail
}

export const claudeAdapter: SessionSourceAdapter = {
  provider: 'claude',
  getSources,
  scanSummaries,
  parseDetail: parseDetailForClaude,
  isActive,
  findSessionFile,
}

export { extractProjectName }
