import * as fs from 'node:fs'
import { ACTIVE_THRESHOLD_MS } from '@/lib/scanner/active-detector'
import { readLastEventType } from '@/lib/adapters/codex/codex-parser'

/**
 * Single source of truth for the Codex active rule (used by BOTH the adapter's
 * `isActive` and the scanner's per-summary `isActive` stamping).
 *
 * Codex has no lock directory, so a session is active when:
 *   1. its rollout file was modified recently (mtime within `ACTIVE_THRESHOLD_MS`), AND
 *   2. its last event is NOT a terminal `event_msg` / `task_complete`.
 *
 * ~21/22 real sessions end with `task_complete`, making this reliable (R6).
 */
export async function isCodexSessionActive(filePath: string): Promise<boolean> {
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
