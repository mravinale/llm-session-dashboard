import * as fs from 'node:fs'
import type { ProviderId } from '@/lib/adapters/provider-registry'
import type { SessionSummary, SessionDetail } from '@/lib/parsers/types'
import { claudeAdapter } from '@/lib/adapters/claude/claude-adapter'
import { codexAdapter } from '@/lib/adapters/codex/codex-adapter'
import { getCodexHome } from '@/lib/adapters/codex/codex-path'

/**
 * Extended summary that includes the absolute JSONL file path (server-side only).
 * Defined here (not in the scanner) so adapters can import it without creating
 * an import cycle with `session-scanner.ts`.
 */
export interface SessionSummaryWithPath extends SessionSummary {
  filePath: string
}

/**
 * A normalized, provider-neutral source root on this machine.
 *
 * `DataSource` (Claude's WSL-aware producer) maps onto this at the Claude
 * adapter boundary (`claudeDir → rootDir`). Codex maps `~/.codex → rootDir`.
 */
export interface ProviderSource {
  provider: ProviderId
  /** Stable source id, e.g. 'primary', 'wsl-ubuntu-user', 'codex-primary'. */
  id: string
  /** Display label, e.g. 'macOS', 'WSL - Ubuntu', 'Codex'. */
  label: string
  /** Root directory for this source, e.g. ~/.claude or ~/.codex. */
  rootDir: string
  platform: 'windows' | 'wsl' | 'macos' | 'linux'
  available: boolean
}

/**
 * The provider-adapter seam (P4/P5): one cohesive interface that exposes a
 * single provider's sessions to the generic scanner / detail / stats pipeline.
 *
 * Every object an adapter returns is stamped with its `provider`, so the layers
 * above (server functions, queries, ~90% of the UI) only ever see normalized
 * domain types and never learn which provider produced them.
 */
export interface SessionSourceAdapter {
  /** The provider this adapter serves. */
  provider: ProviderId
  /** Enumerate source roots for this provider on this machine. */
  getSources(): Promise<ProviderSource[]>
  /** Scan lightweight summaries (with file paths) for one source. */
  scanSummaries(source: ProviderSource): Promise<SessionSummaryWithPath[]>
  /** Full streaming parse of a single session into a normalized detail. */
  parseDetail(
    filePath: string,
    sessionId: string,
    projectPath: string,
    projectName: string,
  ): Promise<SessionDetail>
  /** Whether the given session is currently active. */
  isActive(
    filePath: string,
    sessionId: string,
    source: ProviderSource,
  ): Promise<boolean>
  /** Locate the on-disk file for a session id (for detail resolution). */
  findSessionFile(
    sessionId: string,
    projectPath: string,
  ): Promise<{ path: string } | null>
}

// Re-export for convenience so consumers can import the normalized summary type
// from the adapter seam alongside the interface.
export type { SessionSummary, SessionDetail }

/**
 * Registry of concrete adapters (P5 — same concern as the interface, same file).
 *
 * Claude is always registered. Codex is included only when `~/.codex` exists
 * (probed synchronously, mirroring how Claude's `available` flag works), so on
 * machines without Codex the pipeline behaves exactly as before.
 */
export function getAdapters(): SessionSourceAdapter[] {
  const adapters: SessionSourceAdapter[] = [claudeAdapter]
  if (isCodexAvailable()) {
    adapters.push(codexAdapter)
  }
  return adapters
}

/** Synchronous existence probe for the Codex home directory. */
function isCodexAvailable(): boolean {
  try {
    return fs.existsSync(getCodexHome())
  } catch {
    return false
  }
}

/** Resolve the adapter for a given provider id. */
export function getAdapter(provider: ProviderId): SessionSourceAdapter {
  const adapter = getAdapters().find((a) => a.provider === provider)
  if (!adapter) {
    throw new Error(`No adapter registered for provider: ${provider}`)
  }
  return adapter
}
