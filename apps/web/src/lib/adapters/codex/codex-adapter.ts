import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  getCodexSources,
  getCodexSessionsDir,
} from '@/lib/adapters/codex/codex-path'
import { scanCodexSummaries } from '@/lib/adapters/codex/codex-scanner'
import { isCodexSessionActive } from '@/lib/adapters/codex/codex-active'
import { parseDetail as parseCodexDetail } from '@/lib/adapters/codex/codex-parser'
import type { SessionDetail } from '@/lib/parsers/types'
import type {
  SessionSourceAdapter,
  ProviderSource,
  SessionSummaryWithPath,
} from '@/lib/adapters/adapter'

/**
 * Codex provider adapter (Phase 3 — detail parity).
 *
 * The summary read path (`getSources` → `scanSummaries`), active detection,
 * detail parsing, and session-file location are all implemented. Detail
 * mapping is delegated to the PURE `codex-mapper` via `codex-parser`.
 */

async function getSources(): Promise<ProviderSource[]> {
  return getCodexSources()
}

async function scanSummaries(
  source: ProviderSource,
): Promise<SessionSummaryWithPath[]> {
  return scanCodexSummaries(source)
}

/**
 * Whether a Codex session is currently active. Delegates to the shared
 * `isCodexSessionActive` rule so the adapter and the scanner's per-summary
 * stamping (`scanCodexSummaries`) share ONE implementation.
 */
async function isActive(filePath: string): Promise<boolean> {
  return isCodexSessionActive(filePath)
}

async function parseDetail(
  filePath: string,
  sessionId: string,
  projectPath: string,
  projectName: string,
): Promise<SessionDetail> {
  return parseCodexDetail(filePath, sessionId, projectPath, projectName)
}

/** Recursively find the first `rollout-*<sessionId>*.jsonl` under a dir. */
function findRolloutBySessionId(dir: string, sessionId: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findRolloutBySessionId(full, sessionId)
      if (found) return found
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl') &&
      entry.name.includes(sessionId)
    ) {
      return full
    }
  }
  return null
}

/**
 * Locate the Codex rollout file for a session id. The `rollout-<ts>-<uuid>`
 * filename embeds the session uuid, so we walk each available Codex source's
 * `sessions/**` tree for a filename containing the id. `projectPath` is unused
 * (Codex files are date-foldered, not project-foldered) but kept for the
 * interface signature.
 */
async function findSessionFile(
  sessionId: string,
): Promise<{ path: string } | null> {
  const sources = await getCodexSources()
  for (const source of sources) {
    if (!source.available) continue
    const sessionsDir = getCodexSessionsDir(source.rootDir)
    const found = findRolloutBySessionId(sessionsDir, sessionId)
    if (found) return { path: found }
  }
  return null
}

export const codexAdapter: SessionSourceAdapter = {
  provider: 'codex',
  getSources,
  scanSummaries,
  parseDetail,
  isActive,
  findSessionFile,
}
