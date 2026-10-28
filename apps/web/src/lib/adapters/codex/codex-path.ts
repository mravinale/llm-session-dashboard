import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { detectCurrentPlatform } from '@/lib/utils/claude-path'
import type { ProviderSource } from '@/lib/adapters/adapter'

/**
 * Single source of truth for all `~/.codex` paths (mirrors `claude-path.ts`).
 *
 * Unlike Claude, Codex stores the absolute project `cwd` inside each rollout's
 * `session_meta` payload — so there is NO dash-encoded directory name to decode.
 * Sessions live under `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 */

function resolveCodexHome(): string {
  if (process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME)
  }
  return path.join(os.homedir(), '.codex')
}

const CODEX_DIR = resolveCodexHome()

/** Absolute path to the Codex home (`CODEX_HOME` env or `~/.codex`). */
export function getCodexHome(): string {
  return CODEX_DIR
}

/** `<home>/sessions` — the root of the date-foldered rollout tree. */
export function getCodexSessionsDir(home: string = CODEX_DIR): string {
  return path.join(home, 'sessions')
}

/** `<home>/session_index.jsonl` — partial map of session id → thread_name. */
export function getCodexSessionIndexPath(home: string = CODEX_DIR): string {
  return path.join(home, 'session_index.jsonl')
}

/** `<home>/config.toml` — Codex CLI configuration (fallback model source). */
export function getCodexConfigPath(home: string = CODEX_DIR): string {
  return path.join(home, 'config.toml')
}

/**
 * Enumerate Codex source roots on this machine.
 *
 * Phase 1 returns only the primary source when `~/.codex` exists. WSL parity is
 * deferred to Phase 7. The returned source mirrors the Claude primary source's
 * `id: 'primary'` is intentionally NOT reused — Codex uses `'codex-primary'` so
 * provider-scoped dedup and source labels never collide with Claude.
 */
export async function getCodexSources(): Promise<ProviderSource[]> {
  const home = getCodexHome()
  const platform = await detectCurrentPlatform()

  let available = false
  try {
    await fs.access(home)
    available = true
  } catch {
    available = false
  }

  if (!available) return []

  // TODO(codex): WSL parity — enumerate per-distro `~/.codex` roots (mirroring
  // Claude's WSL multi-distro detection). Deferred; primary source only for now.
  return [
    {
      provider: 'codex',
      id: 'codex-primary',
      label: 'Codex',
      rootDir: home,
      platform,
      available,
    },
  ]
}
