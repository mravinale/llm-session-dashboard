import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerFn } from '@tanstack/react-start'
import { getAdapters } from '@/lib/adapters/adapter'
import type { ProviderId } from '@/lib/adapters/provider-registry'

export interface AppInfo {
  version: string
  /** Claude data root (kept for back-compat with existing footer copy). */
  appPath: string
  /** Codex data root, present only when `~/.codex` exists on this machine. */
  codexPath?: string
  /** Providers actually available on this machine, in registry order. */
  providers: ProviderId[]
  nodeEnv: string
}

function readVersionFromPackageJson(): string {
  // Try multiple candidate paths relative to the compiled server file
  // (dist/server/assets/app-info.api-*.js), walking up to the package root.
  const candidates = [
    new URL('../../../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
  ]

  for (const candidate of candidates) {
    try {
      const pkgPath = fileURLToPath(candidate)
      const raw = fs.readFileSync(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // Try next candidate
    }
  }

  // Final fallback: process.cwd() (works during local dev)
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    if (pkg.version) return pkg.version
  } catch {
    // Fall back to unknown
  }

  return 'unknown'
}

/**
 * Pure assembly of {@link AppInfo} from already-resolved inputs. Exported for
 * unit testing; the server function below feeds it real fs/os/registry values.
 *
 * `codexPath` is included only when `providers` contains `'codex'` (the
 * registry only lists Codex when `~/.codex` exists), so the footer reflects
 * exactly the Claude root when Codex is absent.
 */
export function buildAppInfo(input: {
  version: string
  homeDir: string
  providers: ProviderId[]
  nodeEnv: string
}): AppInfo {
  const hasCodex = input.providers.includes('codex')
  return {
    version: input.version,
    appPath: path.join(input.homeDir, '.claude'),
    ...(hasCodex ? { codexPath: path.join(input.homeDir, '.codex') } : {}),
    providers: input.providers,
    nodeEnv: input.nodeEnv,
  }
}

export const getAppInfo = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AppInfo> => {
    // The adapter registry only includes Codex when `~/.codex` exists, so
    // deriving from it keeps the footer accurate without a second fs probe.
    return buildAppInfo({
      version: readVersionFromPackageJson(),
      homeDir: os.homedir(),
      providers: getAdapters().map((a) => a.provider),
      nodeEnv: process.env.NODE_ENV ?? 'development',
    })
  },
)
