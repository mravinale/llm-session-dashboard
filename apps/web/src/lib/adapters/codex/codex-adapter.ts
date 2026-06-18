import * as fs from 'node:fs'
import { ACTIVE_THRESHOLD_MS } from '@/lib/scanner/active-detector'
import { getCodexSources } from '@/lib/adapters/codex/codex-path'
import { scanCodexSummaries } from '@/lib/adapters/codex/codex-scanner'
import { readLastEventType } from '@/lib/adapters/codex/codex-parser'
import type { SessionDetail } from '@/lib/parsers/types'
import type {
  SessionSourceAdapter,
  ProviderSource,
  SessionSummaryWithPath,
} from '@/lib/adapters/adapter'

/**
 * Codex provider adapter (Phase 1 — summaries only).
 *
 * `parseDetail` / `findSessionFile` are clean throw stubs until Phase 3: they
 * satisfy the interface without fabricating data. The summary read path
 * (`getSources` → `scanSummaries`) and active detection are fully implemented.
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
 * Codex has no lock directory, so activity is: the file was modified recently
 * (mtime within `ACTIVE_THRESHOLD_MS`, reused from `active-detector.ts`) AND the
 * session's last event is NOT a terminal `event_msg`/`task_complete`.
 *
 * ~21/22 real sessions end with `task_complete`, making this reliable (R6).
 */
async function isActive(filePath: string): Promise<boolean> {
  const stat = await fs.promises.stat(filePath).catch(() => null)
  if (!stat) return false

  const age = Date.now() - stat.mtimeMs
  if (age > ACTIVE_THRESHOLD_MS) return false

  const last = await readLastEventType(filePath).catch(() => null)
  if (last && last.type === 'event_msg' && last.payloadType === 'task_complete') {
    return false
  }
  return true
}

async function parseDetail(): Promise<SessionDetail> {
  throw new Error('Codex parseDetail not implemented until Phase 3')
}

async function findSessionFile(): Promise<{ path: string } | null> {
  throw new Error('Codex findSessionFile not implemented until Phase 3')
}

export const codexAdapter: SessionSourceAdapter = {
  provider: 'codex',
  getSources,
  scanSummaries,
  parseDetail,
  isActive,
  findSessionFile,
}
