/**
 * Target 5 — Cross-provider dedup and collision prevention.
 *
 * (a) A `cwd` shared by Claude and Codex merges into ONE Project Analytics row.
 *     → Already covered in project-analytics.api.test.ts (line 329). Verified
 *       only, no duplication of existing tests.
 *
 * (b) A Claude and a Codex session sharing the SAME `sessionId` string must NOT
 *     collide in the scanner's dedup map. The dedup key is `${provider}:${sessionId}`,
 *     so both sessions must appear in the result.
 *
 * We mock the adapter registry to produce controlled summaries without touching
 * any real filesystem or ~/.codex / ~/.claude paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '../parsers/types'
import type {
  SessionSummaryWithPath,
  SessionSourceAdapter,
  ProviderSource,
} from '../adapters/adapter'

// Mock the adapter registry so we can inject controlled adapters
vi.mock('@/lib/adapters/adapter', () => ({
  getAdapters: vi.fn(),
  getAdapter: vi.fn(),
}))

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'shared-uuid-abc123',
    provider: 'claude',
    projectPath: '/Users/dev/shared-project',
    projectName: 'shared-project',
    branch: null,
    cwd: '/Users/dev/shared-project',
    startedAt: '2026-06-01T10:00:00.000Z',
    lastActiveAt: '2026-06-01T10:05:00.000Z',
    durationMs: 300_000,
    messageCount: 5,
    userMessageCount: 2,
    assistantMessageCount: 3,
    isActive: false,
    toolCallCount: 2,
    model: 'claude-sonnet-4',
    version: '1.0.0',
    fileSizeBytes: 2048,
    isInteractive: true,
    ...overrides,
  }
}

function makeWithPath(s: SessionSummary, filePath: string): SessionSummaryWithPath {
  return { ...s, filePath }
}

const claudeSource: ProviderSource = {
  provider: 'claude',
  id: 'primary',
  label: 'macOS',
  rootDir: '/Users/user/.claude',
  platform: 'macos',
  available: true,
}

const codexSource: ProviderSource = {
  provider: 'codex',
  id: 'codex-primary',
  label: 'Codex',
  rootDir: '/Users/user/.codex',
  platform: 'macos',
  available: true,
}

describe('cross-provider dedup — provider:sessionId key prevents collision', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function importScanner() {
    const scanner = await import('./session-scanner')
    const adapterModule = await import('@/lib/adapters/adapter')
    return { scanAllSessions: scanner.scanAllSessions, adapterModule }
  }

  it('Claude and Codex sessions with the SAME sessionId both appear (no dedup collision)', async () => {
    const SHARED_SESSION_ID = 'shared-uuid-abc123'

    // Claude session with the shared ID
    const claudeSummary = makeSummary({
      provider: 'claude',
      sessionId: SHARED_SESSION_ID,
      model: 'claude-sonnet-4',
      lastActiveAt: '2026-06-01T10:05:00.000Z',
    })

    // Codex session with the SAME uuid string
    const codexSummary = makeSummary({
      provider: 'codex',
      sessionId: SHARED_SESSION_ID,
      model: 'gpt-5.5',
      branch: null,
      lastActiveAt: '2026-06-01T11:00:00.000Z',
    })

    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn().mockResolvedValue([claudeSource]),
      scanSummaries: vi.fn().mockResolvedValue([
        makeWithPath(claudeSummary, '/Users/user/.claude/projects/-Users-dev/shared-uuid-abc123.jsonl'),
      ]),
      parseDetail: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(),
    }

    const codexAdapter: SessionSourceAdapter = {
      provider: 'codex',
      getSources: vi.fn().mockResolvedValue([codexSource]),
      scanSummaries: vi.fn().mockResolvedValue([
        makeWithPath(codexSummary, '/Users/user/.codex/sessions/2026/06/01/rollout-shared-uuid-abc123.jsonl'),
      ]),
      parseDetail: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(),
    }

    const { scanAllSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([
      claudeAdapter,
      codexAdapter,
    ])

    const result = await scanAllSessions()

    // Both sessions must survive — the dedup key is `provider:sessionId`, NOT just `sessionId`
    expect(result).toHaveLength(2)

    const claudeResult = result.find((s) => s.provider === 'claude')
    const codexResult = result.find((s) => s.provider === 'codex')

    expect(claudeResult).toBeDefined()
    expect(codexResult).toBeDefined()

    // Both share the same sessionId but different providers
    expect(claudeResult!.sessionId).toBe(SHARED_SESSION_ID)
    expect(codexResult!.sessionId).toBe(SHARED_SESSION_ID)

    // Each session retains its own model
    expect(claudeResult!.model).toBe('claude-sonnet-4')
    expect(codexResult!.model).toBe('gpt-5.5')

    // Results are sorted newest-first (Codex session is newer)
    expect(result[0].provider).toBe('codex')
    expect(result[1].provider).toBe('claude')
  })

  it('TWO Claude sessions with the same sessionId ARE deduped (keep newest)', async () => {
    // This tests that within-provider dedup still works (only the newer wins)
    const SHARED_SESSION_ID = 'dup-claude-id-xyz'

    const claudeOlder = makeSummary({
      provider: 'claude',
      sessionId: SHARED_SESSION_ID,
      lastActiveAt: '2026-06-01T09:00:00.000Z',
      model: 'claude-sonnet-4',
    })
    const claudeNewer = makeSummary({
      provider: 'claude',
      sessionId: SHARED_SESSION_ID,
      lastActiveAt: '2026-06-01T11:00:00.000Z',
      model: 'claude-opus-4-6',
    })

    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn().mockResolvedValue([claudeSource]),
      // Adapter returns both (e.g. from two WSL sources or two project dirs)
      scanSummaries: vi.fn().mockResolvedValue([
        makeWithPath(claudeOlder, '/path/to/old.jsonl'),
        makeWithPath(claudeNewer, '/path/to/new.jsonl'),
      ]),
      parseDetail: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(),
    }

    const { scanAllSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([claudeAdapter])

    const result = await scanAllSessions()

    // Only one entry — same provider + same sessionId → deduped
    expect(result).toHaveLength(1)
    // Keeps the NEWER one
    expect(result[0].lastActiveAt).toBe('2026-06-01T11:00:00.000Z')
    expect(result[0].model).toBe('claude-opus-4-6')
  })

  it('result filePath is stripped from scanAllSessions output (never leaks to client)', async () => {
    const summary = makeSummary({ provider: 'codex' })
    const codexAdapter: SessionSourceAdapter = {
      provider: 'codex',
      getSources: vi.fn().mockResolvedValue([codexSource]),
      scanSummaries: vi.fn().mockResolvedValue([
        makeWithPath(summary, '/absolute/path/that/should/not/leak.jsonl'),
      ]),
      parseDetail: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(),
    }

    const { scanAllSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([codexAdapter])

    const result = await scanAllSessions()

    expect(result).toHaveLength(1)
    // The public `scanAllSessions()` must strip filePath (it is server-internal only)
    expect(result[0]).not.toHaveProperty('filePath')
  })
})
