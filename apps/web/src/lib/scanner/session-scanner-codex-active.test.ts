/**
 * Target 1 — Active Codex session detection flowing through getActiveSessions().
 *
 * The `codexAdapter.isActive` unit tests (codex-adapter.test.ts) cover the four
 * boolean edge cases in isolation. THIS test verifies that an active Codex
 * `SessionSummary` (isActive:true) flows all the way through `getActiveSessions()`
 * — the same 3-second-refetch path used by the active sessions panel — exactly
 * as a Claude session does.
 *
 * We mock the adapter registry so the test is purely in-memory and never touches
 * the real filesystem or ~/.codex.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '../parsers/types'
import type { SessionSummaryWithPath, SessionSourceAdapter, ProviderSource } from '../adapters/adapter'

// Mock the adapter registry so we can inject controlled adapters (both Claude
// and Codex variants) without touching the real ~/.codex or ~/.claude paths.
vi.mock('@/lib/adapters/adapter', () => ({
  getAdapters: vi.fn(),
  getAdapter: vi.fn(),
}))

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'test-session-001',
    provider: 'codex',
    projectPath: '/Users/dev/my-codex-project',
    projectName: 'my-codex-project',
    branch: null,
    cwd: '/Users/dev/my-codex-project',
    startedAt: '2026-06-01T11:00:00.000Z',
    lastActiveAt: '2026-06-01T11:00:03.500Z',
    durationMs: 3500,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    isActive: false,
    toolCallCount: 1,
    model: 'gpt-5-codex',
    version: '0.140.0-alpha.2',
    fileSizeBytes: 2048,
    isInteractive: true,
    ...overrides,
  }
}

function makeWithPath(
  summary: SessionSummary,
  filePath = '/tmp/codex/sessions/2026/06/01/rollout-active.jsonl',
): SessionSummaryWithPath {
  return { ...summary, filePath }
}

const fakeCodexSource: ProviderSource = {
  provider: 'codex',
  id: 'codex-primary',
  label: 'Codex',
  rootDir: '/tmp/codex',
  platform: 'macos',
  available: true,
}

function makeCodexAdapter(
  summaries: SessionSummaryWithPath[],
): SessionSourceAdapter {
  return {
    provider: 'codex',
    getSources: vi.fn().mockResolvedValue([fakeCodexSource]),
    scanSummaries: vi.fn().mockResolvedValue(summaries),
    parseDetail: vi.fn(),
    isActive: vi.fn(),
    findSessionFile: vi.fn(),
  }
}

describe('getActiveSessions — Codex active session flows through the query path', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function importScanner() {
    const scanner = await import('./session-scanner')
    const adapterModule = await import('@/lib/adapters/adapter')
    return { getActiveSessions: scanner.getActiveSessions, adapterModule }
  }

  it('returns an active Codex session in getActiveSessions()', async () => {
    const activeSummary = makeSummary({ isActive: true })
    const adapter = makeCodexAdapter([makeWithPath(activeSummary)])

    const { getActiveSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([adapter])

    const result = await getActiveSessions()

    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe('codex')
    expect(result[0].isActive).toBe(true)
    expect(result[0].sessionId).toBe('test-session-001')
  })

  it('excludes an inactive Codex session (isActive:false) from getActiveSessions()', async () => {
    const inactiveSummary = makeSummary({ isActive: false })
    const adapter = makeCodexAdapter([makeWithPath(inactiveSummary)])

    const { getActiveSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([adapter])

    const result = await getActiveSessions()
    expect(result).toHaveLength(0)
  })

  it('returns active Codex session alongside an active Claude session', async () => {
    const activeCodex = makeSummary({
      provider: 'codex',
      sessionId: 'codex-active-001',
      isActive: true,
      lastActiveAt: '2026-06-01T12:00:00.000Z',
    })
    const activeClaude = makeSummary({
      provider: 'claude',
      sessionId: 'claude-active-001',
      isActive: true,
      lastActiveAt: '2026-06-01T11:00:00.000Z',
      branch: 'main',
    })

    const claudeSource: ProviderSource = {
      provider: 'claude',
      id: 'primary',
      label: 'macOS',
      rootDir: '/Users/user/.claude',
      platform: 'macos',
      available: true,
    }

    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn().mockResolvedValue([claudeSource]),
      scanSummaries: vi.fn().mockResolvedValue([makeWithPath(activeClaude, '/Users/user/.claude/projects/-Users-dev/session.jsonl')]),
      parseDetail: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(),
    }

    const codexAdapter = makeCodexAdapter([makeWithPath(activeCodex)])

    const { getActiveSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([claudeAdapter, codexAdapter])

    const result = await getActiveSessions()

    expect(result).toHaveLength(2)
    expect(result.every((s) => s.isActive)).toBe(true)
    const providers = result.map((s) => s.provider).sort()
    expect(providers).toEqual(['claude', 'codex'])
  })

  it('Codex summary has isActive:false stripped from result when task_complete was last event', async () => {
    // The adapter already sets isActive=false during scanSummaries (after calling
    // codexAdapter.isActive). Here we confirm that summaries with isActive:false
    // never appear in getActiveSessions regardless of provider.
    const completedCodex = makeSummary({
      provider: 'codex',
      sessionId: 'codex-complete-001',
      isActive: false, // task_complete was the last event
    })
    const adapter = makeCodexAdapter([makeWithPath(completedCodex)])

    const { getActiveSessions, adapterModule } = await importScanner()
    ;(adapterModule.getAdapters as ReturnType<typeof vi.fn>).mockReturnValue([adapter])

    const result = await getActiveSessions()
    expect(result).toHaveLength(0)
  })
})
