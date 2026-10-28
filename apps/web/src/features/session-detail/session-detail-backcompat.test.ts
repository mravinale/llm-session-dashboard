/**
 * Target 2 — Back-compat detail link without `provider`.
 *
 * `getSessionDetail({ sessionId, projectPath })` with NO `provider` must still
 * resolve a Codex session by probing adapters (Claude then Codex
 * `findSessionFile`) and parse via the right adapter. This covers Risk R8 from
 * the design doc.
 *
 * We cannot call the TanStack Server Function directly from unit tests, so we
 * test the exact routing logic inline (same code that runs in the handler). This
 * is effectively a unit test of the back-compat probe branch.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SessionDetail, TokenUsage } from '@/lib/parsers/types'
import type { SessionSourceAdapter, ProviderSource } from '@/lib/adapters/adapter'

// ---- Minimal SessionDetail fixture ----
function makeDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const emptyTokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  return {
    sessionId: 'codex-sess-001',
    provider: 'codex',
    projectPath: '/Users/dev/codex-project',
    projectName: 'codex-project',
    branch: null,
    isInteractive: true,
    turns: [],
    totalTokens: emptyTokens,
    tokensByModel: {},
    toolFrequency: {},
    errors: [],
    models: ['gpt-5-codex'],
    agents: [],
    skills: [],
    tasks: [],
    contextWindow: null,
    ...overrides,
  }
}

const fakeSource: ProviderSource = {
  provider: 'codex',
  id: 'codex-primary',
  label: 'Codex',
  rootDir: '/tmp/codex',
  platform: 'macos',
  available: true,
}

/**
 * The back-compat probe logic extracted from session-detail.api.ts handler
 * (the "provider absent" branch) so we can test it without the TanStack
 * server-fn wrapper. This is a faithful copy of the routing code:
 *
 *   for (const adapter of getAdapters()) {
 *     const file = await adapter.findSessionFile(sessionId, projectPath)
 *     if (file) { return adapter.parseDetail(file.path, ...) }
 *   }
 *   throw new Error(`Session not found: ${sessionId}`)
 */
async function resolveWithoutProvider(
  adapters: SessionSourceAdapter[],
  sessionId: string,
  projectPath: string,
  projectName: string,
): Promise<SessionDetail> {
  for (const adapter of adapters) {
    const file = await adapter.findSessionFile(sessionId, projectPath)
    if (file) {
      return adapter.parseDetail(file.path, sessionId, projectPath, projectName)
    }
  }
  throw new Error(`Session not found: ${sessionId}`)
}

describe('back-compat detail resolution (provider omitted)', () => {
  const SESSION_ID = 'codex-sess-001'
  const PROJECT_PATH = '/Users/dev/codex-project'
  const PROJECT_NAME = 'codex-project'

  it('resolves a Codex session when provider is omitted (probes Claude first, then Codex)', async () => {
    const codexDetail = makeDetail()
    const rolloutPath = '/tmp/codex/sessions/2026/06/01/rollout-abc.jsonl'

    // Claude adapter: no file found for this session
    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn(),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue(null), // not found
      parseDetail: vi.fn(),
    }

    // Codex adapter: finds the file and parses it
    const codexAdapter: SessionSourceAdapter = {
      provider: 'codex',
      getSources: vi.fn().mockResolvedValue([fakeSource]),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue({ path: rolloutPath }),
      parseDetail: vi.fn().mockResolvedValue(codexDetail),
    }

    const result = await resolveWithoutProvider(
      [claudeAdapter, codexAdapter],
      SESSION_ID,
      PROJECT_PATH,
      PROJECT_NAME,
    )

    // Claude adapter was probed first
    expect(claudeAdapter.findSessionFile).toHaveBeenCalledWith(SESSION_ID, PROJECT_PATH)
    // Codex adapter was probed second and found the file
    expect(codexAdapter.findSessionFile).toHaveBeenCalledWith(SESSION_ID, PROJECT_PATH)
    // The Codex parseDetail was called with the file path and session context
    expect(codexAdapter.parseDetail).toHaveBeenCalledWith(
      rolloutPath,
      SESSION_ID,
      PROJECT_PATH,
      PROJECT_NAME,
    )
    // Result is a valid, properly-typed Codex SessionDetail
    expect(result.provider).toBe('codex')
    expect(result.sessionId).toBe(SESSION_ID)
    expect(result.models).toEqual(['gpt-5-codex'])
    expect(result.skills).toEqual([])
    expect(result.agents).toEqual([])
    expect(result.tasks).toEqual([])
    expect(result.branch).toBeNull()
  })

  it('resolves a Claude session (provider omitted) when Codex is absent', async () => {
    const claudeDetail = makeDetail({
      provider: 'claude',
      sessionId: 'claude-sess-001',
      models: ['claude-sonnet-4'],
      branch: 'main',
    })
    const claudePath = '/Users/user/.claude/projects/-Users-dev-project/claude-sess-001.jsonl'

    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn(),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue({ path: claudePath }),
      parseDetail: vi.fn().mockResolvedValue(claudeDetail),
    }

    const result = await resolveWithoutProvider(
      [claudeAdapter], // Only Claude registered (Codex not available)
      'claude-sess-001',
      PROJECT_PATH,
      PROJECT_NAME,
    )

    expect(claudeAdapter.findSessionFile).toHaveBeenCalledWith('claude-sess-001', PROJECT_PATH)
    expect(claudeAdapter.parseDetail).toHaveBeenCalledWith(
      claudePath,
      'claude-sess-001',
      PROJECT_PATH,
      PROJECT_NAME,
    )
    expect(result.provider).toBe('claude')
    expect(result.sessionId).toBe('claude-sess-001')
  })

  it('throws when no adapter can locate the session (unknown sessionId)', async () => {
    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn(),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue(null),
      parseDetail: vi.fn(),
    }
    const codexAdapter: SessionSourceAdapter = {
      provider: 'codex',
      getSources: vi.fn().mockResolvedValue([fakeSource]),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue(null),
      parseDetail: vi.fn(),
    }

    await expect(
      resolveWithoutProvider(
        [claudeAdapter, codexAdapter],
        'no-such-session',
        PROJECT_PATH,
        PROJECT_NAME,
      ),
    ).rejects.toThrow('Session not found: no-such-session')

    // Both adapters were probed
    expect(claudeAdapter.findSessionFile).toHaveBeenCalledOnce()
    expect(codexAdapter.findSessionFile).toHaveBeenCalledOnce()
    // Neither parseDetail was called
    expect(claudeAdapter.parseDetail).not.toHaveBeenCalled()
    expect(codexAdapter.parseDetail).not.toHaveBeenCalled()
  })

  it('short-circuits to Claude without probing Codex when Claude finds the file', async () => {
    const claudeDetail = makeDetail({ provider: 'claude' })
    const claudePath = '/path/to/claude/session.jsonl'

    const claudeAdapter: SessionSourceAdapter = {
      provider: 'claude',
      getSources: vi.fn(),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn().mockResolvedValue({ path: claudePath }),
      parseDetail: vi.fn().mockResolvedValue(claudeDetail),
    }
    const codexAdapter: SessionSourceAdapter = {
      provider: 'codex',
      getSources: vi.fn().mockResolvedValue([fakeSource]),
      scanSummaries: vi.fn(),
      isActive: vi.fn(),
      findSessionFile: vi.fn(), // should NOT be called
      parseDetail: vi.fn(),
    }

    await resolveWithoutProvider(
      [claudeAdapter, codexAdapter],
      SESSION_ID,
      PROJECT_PATH,
      PROJECT_NAME,
    )

    // Codex adapter should NOT be probed once Claude found the file
    expect(codexAdapter.findSessionFile).not.toHaveBeenCalled()
    expect(codexAdapter.parseDetail).not.toHaveBeenCalled()
  })
})
