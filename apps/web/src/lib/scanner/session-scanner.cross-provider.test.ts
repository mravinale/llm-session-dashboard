import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '../parsers/types'
import type {
  ProviderSource,
  SessionSourceAdapter,
  SessionSummaryWithPath,
} from '@/lib/adapters/adapter'
import type { ProviderId } from '@/lib/adapters/provider-registry'

// Mock the adapter registry so we can drive `scanAllSessions` with two
// providers that intentionally collide on `sessionId`. This isolates the
// scanner's provider-scoped dedup contract (`${provider}:${sessionId}`) from
// the real Claude/Codex I/O.
vi.mock('@/lib/adapters/adapter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/adapters/adapter')>(
    '@/lib/adapters/adapter',
  )
  return { ...actual, getAdapters: vi.fn() }
})

function makeSummary(
  provider: ProviderId,
  overrides: Partial<SessionSummaryWithPath> = {},
): SessionSummaryWithPath {
  return {
    sessionId: 'shared-id',
    provider,
    projectPath: '/Users/dev/app',
    projectName: 'app',
    branch: null,
    cwd: '/Users/dev/app',
    startedAt: '2026-06-01T10:00:00.000Z',
    lastActiveAt: '2026-06-01T11:00:00.000Z',
    durationMs: 3_600_000,
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    isActive: false,
    toolCallCount: 0,
    model: provider === 'codex' ? 'gpt-5.5' : 'claude-opus-4-6',
    version: '1.0.0',
    fileSizeBytes: 1024,
    isInteractive: true,
    filePath: `/tmp/${provider}.jsonl`,
    ...overrides,
  }
}

const SOURCE: ProviderSource = {
  provider: 'claude',
  id: 'src',
  label: 'src',
  rootDir: '/root',
  platform: 'macos',
  available: true,
}

function makeAdapter(
  provider: ProviderId,
  summaries: SessionSummaryWithPath[],
): SessionSourceAdapter {
  return {
    provider,
    getSources: async () => [{ ...SOURCE, provider }],
    scanSummaries: async () => summaries,
    parseDetail: vi.fn(),
    isActive: vi.fn(),
    findSessionFile: vi.fn(),
  }
}

describe('session-scanner — cross-provider', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function importWithAdapters(adapters: SessionSourceAdapter[]) {
    const adapterModule = await import('@/lib/adapters/adapter')
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue(
      adapters,
    )
    const scanner = await import('./session-scanner')
    return scanner
  }

  it('keeps a Claude and a Codex session with the same id (dedup is provider-scoped)', async () => {
    const claude = makeAdapter('claude', [makeSummary('claude')])
    const codex = makeAdapter('codex', [makeSummary('codex')])
    const { scanAllSessions } = await importWithAdapters([claude, codex])

    const result = await scanAllSessions()

    expect(result).toHaveLength(2)
    const providers = result.map((s: SessionSummary) => s.provider).sort()
    expect(providers).toEqual(['claude', 'codex'])
    // Both carry the same sessionId — they did NOT collide.
    expect(new Set(result.map((s: SessionSummary) => s.sessionId))).toEqual(
      new Set(['shared-id']),
    )
  })

  it('still dedups within a single provider (same provider + id collapses)', async () => {
    const older = makeSummary('codex', {
      lastActiveAt: '2026-06-01T10:00:00.000Z',
    })
    const newer = makeSummary('codex', {
      lastActiveAt: '2026-06-01T12:00:00.000Z',
      messageCount: 99,
    })
    const codex = makeAdapter('codex', [older, newer])
    const { scanAllSessions } = await importWithAdapters([codex])

    const result = await scanAllSessions()

    expect(result).toHaveLength(1)
    // The newest lastActiveAt wins.
    expect(result[0].messageCount).toBe(99)
  })
})
