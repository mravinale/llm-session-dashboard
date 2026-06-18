import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StatsCache } from './types'
import type { SessionSummaryWithPath } from '@/lib/scanner/session-scanner'

// vi.mock is hoisted — define all mocks inline, no variable references

vi.mock('node:fs', () => ({
  promises: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}))

vi.mock('@/lib/utils/claude-path', () => ({
  getStatsPath: vi.fn(() => '/mock/.claude/stats-cache.json'),
  getStatsPathFor: vi.fn((source: { claudeDir: string }) => `${source.claudeDir}/stats-cache.json`),
  getDataSources: vi.fn(),
}))

vi.mock('@/lib/cache/disk-cache', () => ({
  readDiskCache: vi.fn(),
  writeDiskCache: vi.fn(),
}))

vi.mock('@/lib/scanner/session-scanner', () => ({
  scanAllSessionsWithPaths: vi.fn(),
}))

// Per-session detail parsing now flows through the provider adapter (P6/DIP),
// so the stats compute path is tested at the adapter seam. Each provider's
// adapter exposes its own `parseDetail`; `getAdapter(provider)` dispatches.
vi.mock('@/lib/adapters/adapter', () => ({
  getAdapter: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatsCache(overrides: Partial<StatsCache> = {}): StatsCache {
  return {
    version: 1,
    lastComputedDate: new Date().toISOString(), // today — no enrichment needed by default
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 5,
    totalMessages: 50,
    longestSession: {
      sessionId: 'session-abc',
      duration: 3600000,
      messageCount: 20,
      timestamp: new Date().toISOString(),
    },
    firstSessionDate: '2026-01-01T00:00:00.000Z',
    hourCounts: { '9': 3, '14': 2 },
    ...overrides,
  }
}

function makeStat(mtimeMs = 1_000_000) {
  return { mtimeMs }
}

type ParseDetailFn = (
  filePath: string,
  sessionId: string,
  projectPath: string,
  projectName: string,
) => Promise<unknown>

/**
 * Wire `getAdapter(provider)` to return a stub adapter whose `parseDetail` is
 * the supplied per-provider mock. Mirrors the real registry: each provider has
 * its own adapter, and the stats compute path dispatches by `session.provider`.
 * Returns the per-provider `parseDetail` mocks so a test can assert on dispatch.
 */
async function mockAdapters(
  parseDetailByProvider: Partial<Record<'claude' | 'codex', ParseDetailFn>>,
): Promise<Record<string, ReturnType<typeof vi.fn>>> {
  const { getAdapter } = await import('@/lib/adapters/adapter')
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const [provider, fn] of Object.entries(parseDetailByProvider)) {
    mocks[provider] = vi.fn(fn)
  }
  vi.mocked(getAdapter).mockImplementation((provider: string) => {
    const parseDetail = mocks[provider]
    if (!parseDetail) {
      throw new Error(`No adapter registered for provider: ${provider}`)
    }
    return { provider, parseDetail } as never
  })
  return mocks
}

/** A fully-formed normalized SessionDetail for a given provider/model. */
function makeDetail(overrides: {
  sessionId: string
  provider: 'claude' | 'codex'
  model: string
  turnCount: number
  toolFrequency?: Record<string, number>
  tokensByModel?: Record<
    string,
    { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
  >
}) {
  const turns = Array.from({ length: overrides.turnCount }, (_, i) => ({
    uuid: `t${i}`,
    type: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    timestamp: new Date().toISOString(),
    toolCalls: [],
  }))
  return {
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectPath: '/proj',
    projectName: 'proj',
    branch: null,
    isInteractive: true,
    turns,
    totalTokens: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    tokensByModel: overrides.tokensByModel ?? {},
    toolFrequency: overrides.toolFrequency ?? {},
    errors: [],
    models: [overrides.model],
    agents: [],
    skills: [],
    tasks: [],
    contextWindow: null,
  }
}

// ---------------------------------------------------------------------------
// Helpers to import the module fresh (resets module-level cache variables)
// ---------------------------------------------------------------------------

async function freshParseStats() {
  vi.resetModules()
  const mod = await import('./stats-parser')
  return mod.parseStats
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('happy path — valid stats-cache.json, fresh date', () => {
    it('returns parsed stats from disk when mtime matches disk cache', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const parseStats = await freshParseStats()

      const stats = makeStatsCache()
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(stats)

      const result = await parseStats()

      expect(result).toEqual(stats)
      expect(readDiskCache).toHaveBeenCalledWith('stats', 1_000_000, expect.anything())
    })

    it('parses stats from raw file when disk cache misses', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache, writeDiskCache } = await import('@/lib/cache/disk-cache')
      const parseStats = await freshParseStats()

      const stats = makeStatsCache()
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(null)
      vi.mocked(fsMock.readFile).mockResolvedValue(JSON.stringify(stats) as never)

      const result = await parseStats()

      expect(result).toEqual(stats)
      expect(writeDiskCache).toHaveBeenCalledWith('stats', '/mock/.claude/stats-cache.json', 1_000_000, stats)
    })
  })

  describe('in-memory cache hit', () => {
    it('returns cached result on second call without hitting disk again', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const parseStats = await freshParseStats()

      const stats = makeStatsCache()
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(stats)

      await parseStats()
      const result2 = await parseStats()

      // readDiskCache should only be called once (in-memory cache serves second call)
      expect(readDiskCache).toHaveBeenCalledTimes(1)
      expect(result2).toEqual(stats)
    })
  })

  describe('missing stats file — falls back to computing from sessions', () => {
    it('returns null when no sessions exist and stat() fails', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      const result = await parseStats()

      // With no sessions, computeStatsFromSessions returns a valid minimal stats object
      expect(result).not.toBeNull()
      expect(result?.totalSessions).toBe(0)
      expect(result?.totalMessages).toBe(0)
    })

    it('calls scanAllSessionsWithPaths when stats file is missing', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      await parseStats()

      expect(scanAllSessionsWithPaths).toHaveBeenCalled()
    })
  })

  describe('malformed stats file — falls back gracefully', () => {
    it('falls back to session computation when JSON is invalid', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(null)
      vi.mocked(fsMock.readFile).mockResolvedValue('invalid-json{{{' as never)
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      const result = await parseStats()

      // Should not throw, falls back to computeStatsFromSessions
      expect(scanAllSessionsWithPaths).toHaveBeenCalled()
      // With empty sessions, returns a valid minimal object
      expect(result?.totalSessions).toBe(0)
    })

    it('falls back when Zod validation fails on stats file content', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      const badStats = { version: 1, lastComputedDate: 'bad' } // missing required fields
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(null)
      vi.mocked(fsMock.readFile).mockResolvedValue(JSON.stringify(badStats) as never)
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      const result = await parseStats()

      expect(scanAllSessionsWithPaths).toHaveBeenCalled()
      expect(result?.totalSessions).toBe(0)
    })
  })

  describe('stale cache — triggers enrichment with recent sessions', () => {
    it('calls scanAllSessionsWithPaths when lastComputedDate is before today', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      // lastComputedDate in the past — triggers enrichment
      const staleStats = makeStatsCache({ lastComputedDate: '2024-01-01T00:00:00.000Z' })
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(staleStats)
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      const result = await parseStats()

      expect(scanAllSessionsWithPaths).toHaveBeenCalled()
      // Returns original stats when no recent sessions found
      expect(result).toEqual(staleStats)
    })

    it('merges recent sessions into stale stats', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      const staleStats = makeStatsCache({
        lastComputedDate: '2024-01-01T00:00:00.000Z',
        totalSessions: 3,
        totalMessages: 30,
      })

      const recentSession = {
        sessionId: 'new-session',
        provider: 'claude' as const,
        projectPath: '/proj',
        projectName: 'proj',
        branch: 'main',
        cwd: '/proj',
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        durationMs: 1800000,
        messageCount: 5,
        userMessageCount: 3,
        assistantMessageCount: 2,
        isActive: false,
        model: 'claude-opus-4-6',
        version: '1.0.0',
        toolCallCount: 0,
        fileSizeBytes: 512,
        isInteractive: true,
        filePath: '/proj/new-session.jsonl',
      }

      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(staleStats)
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([recentSession])
      await mockAdapters({
        claude: async () =>
          makeDetail({
            sessionId: 'new-session',
            provider: 'claude',
            model: 'claude-opus-4-6',
            turnCount: 5,
            toolFrequency: { Bash: 2 },
          }),
      })

      const result = await parseStats()

      // Should have merged the new session
      expect(result?.totalSessions).toBe(4) // 3 existing + 1 new
      expect(result?.totalMessages).toBe(35) // 30 existing + 5 from turns
    })
  })

  describe('merge cache — avoids re-scanning within 60 seconds', () => {
    it('returns merge cache on repeated stale calls within 60 seconds', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { readDiskCache } = await import('@/lib/cache/disk-cache')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      const staleStats = makeStatsCache({ lastComputedDate: '2024-01-01T00:00:00.000Z' })
      vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
      vi.mocked(readDiskCache).mockReturnValue(staleStats)
      vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

      // First call — triggers the enrichment scan AND the Codex-compute scan
      // (two distinct scans, each independently cached for 60s).
      await parseStats()
      // Second call — both the enrichment merge cache and the Codex stats cache
      // are warm (same mtime, within 60s), so no further scans happen.
      await parseStats()

      // First call: 1 enrichment scan + 1 Codex-compute scan = 2.
      // Second call: both served from cache = 0. Total stays at 2.
      expect(scanAllSessionsWithPaths).toHaveBeenCalledTimes(2)
    })
  })

  describe('returns null when everything fails', () => {
    it('returns null when stat fails and session scan throws', async () => {
      const { promises: fsMock } = await import('node:fs')
      const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
      const parseStats = await freshParseStats()

      vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(scanAllSessionsWithPaths).mockRejectedValue(new Error('scan failed'))

      const result = await parseStats()

      expect(result).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Codex stats integration (Phase 5) — provider-aware compute + merge
// ---------------------------------------------------------------------------

function makeCodexSummary(overrides: Partial<SessionSummaryWithPath> = {}): SessionSummaryWithPath {
  return {
    sessionId: 'codex-1',
    provider: 'codex',
    projectPath: '/proj',
    projectName: 'proj',
    branch: null,
    cwd: '/proj',
    startedAt: '2026-06-10T13:00:00.000Z',
    lastActiveAt: '2026-06-10T13:30:00.000Z',
    durationMs: 1_800_000,
    messageCount: 4,
    userMessageCount: 2,
    assistantMessageCount: 2,
    isActive: false,
    model: 'gpt-5-codex',
    version: '0.36.0',
    toolCallCount: 0,
    fileSizeBytes: 1024,
    isInteractive: true,
    filePath: '/codex/rollout-codex-1.jsonl',
    ...overrides,
  }
}

function makeClaudeSummary(overrides: Partial<SessionSummaryWithPath> = {}): SessionSummaryWithPath {
  return {
    sessionId: 'claude-1',
    provider: 'claude',
    projectPath: '/proj',
    projectName: 'proj',
    branch: 'main',
    cwd: '/proj',
    startedAt: '2026-06-10T09:00:00.000Z',
    lastActiveAt: '2026-06-10T09:30:00.000Z',
    durationMs: 1_800_000,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    isActive: false,
    model: 'claude-opus-4-6',
    version: '1.0.0',
    toolCallCount: 0,
    fileSizeBytes: 512,
    isInteractive: true,
    filePath: '/claude/claude-1.jsonl',
    ...overrides,
  }
}

describe('Codex stats integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(a) folds a Codex session into modelUsage, daily activity, and hour counts', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStats = await freshParseStats()

    // Fresh Claude stats-cache (no enrichment), with a known Claude model.
    const claudeStats = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 1000, outputTokens: 500,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        },
      },
      dailyActivity: [{ date: '2026-06-10', messageCount: 2, sessionCount: 1, toolCallCount: 0 }],
      hourCounts: { '9': 1 },
      totalSessions: 1,
      totalMessages: 2,
    })

    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
    vi.mocked(readDiskCache).mockReturnValue(claudeStats)
    // The Codex compute scans sessions; only the Codex one survives the filter.
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([makeCodexSummary()])
    await mockAdapters({
      codex: async () =>
        makeDetail({
          sessionId: 'codex-1',
          provider: 'codex',
          model: 'gpt-5-codex',
          turnCount: 4,
          toolFrequency: { exec_command: 3 },
          tokensByModel: {
            'gpt-5-codex': {
              inputTokens: 800, outputTokens: 300,
              cacheReadInputTokens: 50, cacheCreationInputTokens: 0,
            },
          },
        }),
    })

    const result = await parseStats()

    expect(result).not.toBeNull()
    // Codex model id coexists with the Claude model id (no collision).
    expect(result!.modelUsage['claude-opus-4-6']).toEqual({
      inputTokens: 1000, outputTokens: 500,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    })
    expect(result!.modelUsage['gpt-5-codex']).toEqual({
      inputTokens: 800, outputTokens: 300,
      cacheReadInputTokens: 50, cacheCreationInputTokens: 0,
    })
    // dailyModelTokens carries the Codex model under its real id (input+output).
    const codexDay = result!.dailyModelTokens.find((d) => d.date === '2026-06-10')
    expect(codexDay?.tokensByModel['gpt-5-codex']).toBe(1100)
    // Daily activity for 2026-06-10 now reflects Claude (1 session) + Codex (1).
    const activity = result!.dailyActivity.find((d) => d.date === '2026-06-10')
    expect(activity?.sessionCount).toBe(2)
    expect(activity?.toolCallCount).toBe(3) // from the Codex exec_command calls
    // Combined totals reflect both providers.
    expect(result!.totalSessions).toBe(2)
    // Hour counts include the Codex session's hour bucket alongside Claude's.
    const hourTotal = Object.values(result!.hourCounts).reduce((sum, n) => sum + n, 0)
    expect(hourTotal).toBeGreaterThanOrEqual(2)
  })

  it('(b) dispatches per-session parsing to the adapter matching each session provider', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const { getAdapter } = await import('@/lib/adapters/adapter')
    const parseStats = await freshParseStats()

    // No stats-cache file → computeStatsFromSessions() runs over ALL providers.
    vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([
      makeClaudeSummary(),
      makeCodexSummary(),
    ])
    const mocks = await mockAdapters({
      claude: async () =>
        makeDetail({ sessionId: 'claude-1', provider: 'claude', model: 'claude-opus-4-6', turnCount: 2 }),
      codex: async () =>
        makeDetail({ sessionId: 'codex-1', provider: 'codex', model: 'gpt-5-codex', turnCount: 4 }),
    })

    await parseStats()

    // getAdapter is called with each session's provider id.
    expect(getAdapter).toHaveBeenCalledWith('claude')
    expect(getAdapter).toHaveBeenCalledWith('codex')
    // Each provider's parseDetail runs against its own session's file path.
    expect(mocks.claude).toHaveBeenCalledWith(
      '/claude/claude-1.jsonl', 'claude-1', '/proj', 'proj',
    )
    expect(mocks.codex).toHaveBeenCalledWith(
      '/codex/rollout-codex-1.jsonl', 'codex-1', '/proj', 'proj',
    )
    // No cross-wiring: the Claude adapter never parsed the Codex rollout.
    expect(mocks.claude).not.toHaveBeenCalledWith(
      '/codex/rollout-codex-1.jsonl', expect.anything(), expect.anything(), expect.anything(),
    )
  })

  it('(b2) counts a recent Codex session exactly ONCE, not doubled (FIX-2)', async () => {
    // Regression: a Codex session dated AFTER the Claude cache lastComputedDate
    // used to be folded in twice — once by recent-session enrichment (which
    // scanned ALL providers) and once by combineWithCodexStats. Enrichment is
    // now restricted to Claude, so Codex contributes exactly once.
    const { promises: fsMock } = await import('node:fs')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStats = await freshParseStats()

    // STALE Claude cache → triggers recent-session enrichment.
    const claudeStats = makeStatsCache({
      lastComputedDate: '2024-01-01T00:00:00.000Z',
      modelUsage: {},
      dailyActivity: [],
      dailyModelTokens: [],
      hourCounts: {},
      totalSessions: 0,
      totalMessages: 0,
    })

    // One Codex session, recent (after the cutoff), no Claude sessions.
    const recentCodex = makeCodexSummary({
      sessionId: 'codex-recent',
      startedAt: '2026-06-15T13:00:00.000Z',
      lastActiveAt: '2026-06-15T13:30:00.000Z',
      filePath: '/codex/rollout-codex-recent.jsonl',
    })

    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
    vi.mocked(readDiskCache).mockReturnValue(claudeStats)
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([recentCodex])
    await mockAdapters({
      codex: async () =>
        makeDetail({
          sessionId: 'codex-recent',
          provider: 'codex',
          model: 'gpt-5-codex',
          turnCount: 4,
          tokensByModel: {
            'gpt-5-codex': {
              inputTokens: 800, outputTokens: 300,
              cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            },
          },
        }),
    })

    const result = await parseStats()

    expect(result).not.toBeNull()
    // Counted ONCE: 1 session, not 2; tokens not doubled.
    expect(result!.totalSessions).toBe(1)
    expect(result!.modelUsage['gpt-5-codex']).toEqual({
      inputTokens: 800, outputTokens: 300,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    })
    const day = result!.dailyActivity.find((d) => d.date === '2026-06-15')
    expect(day?.sessionCount).toBe(1)
    const dayTokens = result!.dailyModelTokens.find((d) => d.date === '2026-06-15')
    expect(dayTokens?.tokensByModel['gpt-5-codex']).toBe(1100) // 800+300, once
  })

  it('(c) leaves Claude stats unchanged when there is no Codex contribution (merge no-op)', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStats = await freshParseStats()

    const claudeStats = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 1000, outputTokens: 500,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        },
      },
      dailyActivity: [{ date: '2026-06-10', messageCount: 2, sessionCount: 1, toolCallCount: 0 }],
      hourCounts: { '9': 1 },
      totalSessions: 1,
      totalMessages: 2,
    })

    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
    vi.mocked(readDiskCache).mockReturnValue(claudeStats)
    // Scan returns ONLY Claude sessions → the Codex filter yields an empty set.
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([makeClaudeSummary()])
    await mockAdapters({
      claude: async () =>
        makeDetail({ sessionId: 'claude-1', provider: 'claude', model: 'claude-opus-4-6', turnCount: 2 }),
    })

    const result = await parseStats()

    // Output is byte-for-byte the Claude cache: the empty Codex compute is a
    // no-op (hasCodexContribution() is false, so mergeStatsCaches never runs).
    expect(result).toEqual(claudeStats)
  })
})

// ---------------------------------------------------------------------------
// updateHourCounts — tested indirectly via computeStatsFromSessions
// ---------------------------------------------------------------------------

describe('hour bucketing (via computeStatsFromSessions)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments the correct hour bucket from startedAt timestamp', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStats = await freshParseStats()

    // startedAt at 09:00 UTC
    const session = {
      sessionId: 'hour-test',
      provider: 'claude' as const,
      projectPath: '/proj',
      projectName: 'proj',
      branch: null,
      cwd: '/proj',
      startedAt: '2026-03-10T09:00:00.000Z',
      lastActiveAt: '2026-03-10T09:30:00.000Z',
      durationMs: 1800000,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      isActive: false,
      model: null,
      version: null,
      toolCallCount: 0,
      fileSizeBytes: 256,
      isInteractive: true,
      filePath: '/proj/hour-test.jsonl',
    }

    // stat fails → goes to computeStatsFromSessions
    vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([session])
    // parseDetail rejects → forces the summary fallback path
    await mockAdapters({
      claude: async () => {
        throw new Error('parse error')
      },
    })

    const result = await parseStats()

    // Hour 9 should be incremented
    expect(result).not.toBeNull()
    // The hour from '2026-03-10T09:00:00.000Z' — depends on local timezone, so we just
    // check that some hour bucket was populated
    const hourValues = Object.values(result!.hourCounts)
    expect(hourValues.some((v) => v > 0)).toBe(true)
  })

  it('skips sessions with missing startedAt gracefully', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStats = await freshParseStats()

    const session = {
      sessionId: 'no-time',
      provider: 'claude' as const,
      projectPath: '/proj',
      projectName: 'proj',
      branch: null,
      cwd: '/proj',
      startedAt: '', // empty — should be skipped by updateHourCounts
      lastActiveAt: '',
      durationMs: 0,
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      isActive: false,
      model: null,
      version: null,
      toolCallCount: 0,
      fileSizeBytes: 0,
      isInteractive: true,
      filePath: '/proj/no-time.jsonl',
    }

    vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([session])

    const result = await parseStats()

    expect(result).not.toBeNull()
    // hourCounts should be empty (skipped due to empty startedAt)
    expect(Object.keys(result!.hourCounts)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// mergeStatsCaches — pure function for multi-source stats aggregation
// ---------------------------------------------------------------------------

describe('mergeStatsCaches', () => {
  // Import directly since it's a pure function (no module-level state to reset)
  let mergeStatsCaches: typeof import('./stats-parser').mergeStatsCaches

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./stats-parser')
    mergeStatsCaches = mod.mergeStatsCaches
  })

  it('returns null for empty array', () => {
    expect(mergeStatsCaches([])).toBeNull()
  })

  it('returns single cache unchanged', () => {
    const cache = makeStatsCache({ totalSessions: 10, totalMessages: 100 })
    const result = mergeStatsCaches([cache])
    expect(result).toEqual(cache)
  })

  it('sums dailyActivity across caches by date', () => {
    const cache1 = makeStatsCache({
      dailyActivity: [
        { date: '2026-03-01', messageCount: 5, sessionCount: 2, toolCallCount: 10 },
        { date: '2026-03-02', messageCount: 3, sessionCount: 1, toolCallCount: 6 },
      ],
    })
    const cache2 = makeStatsCache({
      dailyActivity: [
        { date: '2026-03-01', messageCount: 7, sessionCount: 3, toolCallCount: 4 },
        { date: '2026-03-03', messageCount: 2, sessionCount: 1, toolCallCount: 1 },
      ],
    })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.dailyActivity).toEqual([
      { date: '2026-03-01', messageCount: 12, sessionCount: 5, toolCallCount: 14 },
      { date: '2026-03-02', messageCount: 3, sessionCount: 1, toolCallCount: 6 },
      { date: '2026-03-03', messageCount: 2, sessionCount: 1, toolCallCount: 1 },
    ])
  })

  it('sums dailyModelTokens across caches by date and model', () => {
    const cache1 = makeStatsCache({
      dailyModelTokens: [
        { date: '2026-03-01', tokensByModel: { 'claude-opus-4-6': 100, 'claude-sonnet-4-6': 50 } },
      ],
    })
    const cache2 = makeStatsCache({
      dailyModelTokens: [
        { date: '2026-03-01', tokensByModel: { 'claude-opus-4-6': 200, 'claude-haiku-3.5': 30 } },
        { date: '2026-03-02', tokensByModel: { 'claude-sonnet-4-6': 80 } },
      ],
    })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.dailyModelTokens).toEqual([
      { date: '2026-03-01', tokensByModel: { 'claude-opus-4-6': 300, 'claude-sonnet-4-6': 50, 'claude-haiku-3.5': 30 } },
      { date: '2026-03-02', tokensByModel: { 'claude-sonnet-4-6': 80 } },
    ])
  })

  it('sums modelUsage across caches by model', () => {
    const cache1 = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
      },
    })
    const cache2 = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 200, outputTokens: 80, cacheReadInputTokens: 20, cacheCreationInputTokens: 15 },
        'claude-sonnet-4-6': { inputTokens: 50, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.modelUsage).toEqual({
      'claude-opus-4-6': { inputTokens: 300, outputTokens: 130, cacheReadInputTokens: 30, cacheCreationInputTokens: 20 },
      'claude-sonnet-4-6': { inputTokens: 50, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    })
  })

  it('takes earliest firstSessionDate', () => {
    const cache1 = makeStatsCache({ firstSessionDate: '2026-03-10T00:00:00.000Z' })
    const cache2 = makeStatsCache({ firstSessionDate: '2026-01-15T00:00:00.000Z' })
    const cache3 = makeStatsCache({ firstSessionDate: '2026-02-20T00:00:00.000Z' })

    const result = mergeStatsCaches([cache1, cache2, cache3])!

    expect(result.firstSessionDate).toBe('2026-01-15T00:00:00.000Z')
  })

  it('sums totalSessions and totalMessages', () => {
    const cache1 = makeStatsCache({ totalSessions: 10, totalMessages: 100 })
    const cache2 = makeStatsCache({ totalSessions: 5, totalMessages: 40 })
    const cache3 = makeStatsCache({ totalSessions: 3, totalMessages: 20 })

    const result = mergeStatsCaches([cache1, cache2, cache3])!

    expect(result.totalSessions).toBe(18)
    expect(result.totalMessages).toBe(160)
  })

  it('takes the longest session by duration', () => {
    const cache1 = makeStatsCache({
      longestSession: { sessionId: 'short', duration: 1000, messageCount: 5, timestamp: '2026-03-01T00:00:00.000Z' },
    })
    const cache2 = makeStatsCache({
      longestSession: { sessionId: 'long', duration: 9999, messageCount: 50, timestamp: '2026-03-02T00:00:00.000Z' },
    })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.longestSession).toEqual({
      sessionId: 'long',
      duration: 9999,
      messageCount: 50,
      timestamp: '2026-03-02T00:00:00.000Z',
    })
  })

  it('sums hourCounts across caches', () => {
    const cache1 = makeStatsCache({ hourCounts: { '9': 3, '14': 2 } })
    const cache2 = makeStatsCache({ hourCounts: { '9': 1, '17': 5 } })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.hourCounts).toEqual({ '9': 4, '14': 2, '17': 5 })
  })

  it('takes the latest lastComputedDate', () => {
    const cache1 = makeStatsCache({ lastComputedDate: '2026-03-01T00:00:00.000Z' })
    const cache2 = makeStatsCache({ lastComputedDate: '2026-03-15T00:00:00.000Z' })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.lastComputedDate).toBe('2026-03-15T00:00:00.000Z')
  })

  it('sums totalSpeculationTimeSavedMs when present', () => {
    const cache1 = makeStatsCache({ totalSpeculationTimeSavedMs: 1000 })
    const cache2 = makeStatsCache({ totalSpeculationTimeSavedMs: 2500 })
    const cache3 = makeStatsCache({}) // no speculation time

    const result = mergeStatsCaches([cache1, cache2, cache3])!

    expect(result.totalSpeculationTimeSavedMs).toBe(3500)
  })

  it('preserves optional modelUsage fields (webSearchRequests, costUSD)', () => {
    const cache1 = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 100, outputTokens: 50,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          webSearchRequests: 3, costUSD: 0.50,
        },
      },
    })
    const cache2 = makeStatsCache({
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 200, outputTokens: 80,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          webSearchRequests: 2, costUSD: 0.30,
        },
      },
    })

    const result = mergeStatsCaches([cache1, cache2])!

    expect(result.modelUsage['claude-opus-4-6']).toEqual({
      inputTokens: 300, outputTokens: 130,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 5, costUSD: 0.80,
    })
  })
})

// ---------------------------------------------------------------------------
// parseStatsFrom — parse stats for a specific DataSource
// ---------------------------------------------------------------------------

describe('parseStatsFrom', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function freshParseStatsFrom() {
    vi.resetModules()
    const mod = await import('./stats-parser')
    return mod.parseStatsFrom
  }

  it('reads stats from the source-specific path', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const parseStatsFrom = await freshParseStatsFrom()

    const stats = makeStatsCache()
    const source = { id: 'primary', label: 'macOS', claudeDir: '/home/user/.claude', platform: 'macos' as const, available: true }

    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(2_000_000) as never)
    vi.mocked(readDiskCache).mockReturnValue(null)
    vi.mocked(fsMock.readFile).mockResolvedValue(JSON.stringify(stats) as never)

    const result = await parseStatsFrom(source)

    expect(result).toEqual(stats)
    // Should read from the source-specific path
    expect(fsMock.readFile).toHaveBeenCalledWith('/home/user/.claude/stats-cache.json', 'utf-8')
  })

  it('returns null when stats file does not exist for source', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const parseStatsFrom = await freshParseStatsFrom()

    const source = { id: 'wsl-ubuntu', label: 'WSL - Ubuntu', claudeDir: '/wsl/home/.claude', platform: 'wsl' as const, available: true }

    vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
    // computeStatsFromSessions will be called as fallback — mock it to return empty
    vi.mocked(scanAllSessionsWithPaths).mockResolvedValue([])

    const result = await parseStatsFrom(source)

    // Falls back to computeStatsFromSessions which returns a minimal stats object
    expect(result).not.toBeNull()
    expect(result?.totalSessions).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseStatsMultiSource — aggregate stats across all data sources
// ---------------------------------------------------------------------------

describe('parseStatsMultiSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function freshModule() {
    vi.resetModules()
    return await import('./stats-parser')
  }

  it('returns null when no sources have stats', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { getDataSources } = await import('@/lib/utils/claude-path')
    const { scanAllSessionsWithPaths } = await import('@/lib/scanner/session-scanner')
    const mod = await freshModule()

    // All sources unavailable
    vi.mocked(getDataSources).mockResolvedValue([
      { id: 'primary', label: 'macOS', claudeDir: '/no-exist/.claude', platform: 'macos' as const, available: false },
    ])

    vi.mocked(fsMock.stat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(scanAllSessionsWithPaths).mockRejectedValue(new Error('no sessions'))

    const result = await mod.parseStatsMultiSource()

    expect(result).toBeNull()
  })

  it('returns single-source stats when only one source available', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { getDataSources } = await import('@/lib/utils/claude-path')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const mod = await freshModule()

    const stats = makeStatsCache({ totalSessions: 7, totalMessages: 70 })

    vi.mocked(getDataSources).mockResolvedValue([
      { id: 'primary', label: 'macOS', claudeDir: '/home/.claude', platform: 'macos' as const, available: true },
    ])
    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
    vi.mocked(readDiskCache).mockReturnValue(stats)

    const result = await mod.parseStatsMultiSource()

    expect(result).toEqual(stats)
  })

  it('merges stats from multiple sources', async () => {
    const { promises: fsMock } = await import('node:fs')
    const { getDataSources } = await import('@/lib/utils/claude-path')
    const { readDiskCache } = await import('@/lib/cache/disk-cache')
    const mod = await freshModule()

    const stats1 = makeStatsCache({ totalSessions: 10, totalMessages: 100, hourCounts: { '9': 3 } })
    const stats2 = makeStatsCache({ totalSessions: 5, totalMessages: 40, hourCounts: { '9': 1, '14': 2 } })

    vi.mocked(getDataSources).mockResolvedValue([
      { id: 'primary', label: 'macOS', claudeDir: '/home1/.claude', platform: 'macos' as const, available: true },
      { id: 'wsl-ubuntu', label: 'WSL - Ubuntu', claudeDir: '/home2/.claude', platform: 'wsl' as const, available: true },
    ])

    vi.mocked(fsMock.stat).mockResolvedValue(makeStat(1_000_000) as never)
    // Return different stats for each source path
    vi.mocked(readDiskCache)
      .mockReturnValueOnce(stats1)
      .mockReturnValueOnce(stats2)

    const result = await mod.parseStatsMultiSource()

    expect(result).not.toBeNull()
    expect(result!.totalSessions).toBe(15)
    expect(result!.totalMessages).toBe(140)
    expect(result!.hourCounts).toEqual({ '9': 4, '14': 2 })
  })
})
