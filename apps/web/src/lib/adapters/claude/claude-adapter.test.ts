import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import type { DataSource } from '@/lib/utils/claude-path'
import type { ProviderSource } from '@/lib/adapters/adapter'
import type { SessionSummary, SessionDetail } from '@/lib/parsers/types'

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  promises: { stat: vi.fn() },
}))

vi.mock('@/lib/utils/claude-path', () => ({
  getDataSources: vi.fn(),
  getProjectsDir: vi.fn(() => '/home/user/.claude/projects'),
  getProjectsDirFor: vi.fn((source: DataSource) => path.join(source.claudeDir, 'projects')),
  decodeProjectDirName: vi.fn((dirName: string) =>
    dirName.replace(/^-/, '/').replace(/-/g, '/'),
  ),
  extractProjectName: vi.fn((p: string) => p.split('/').pop() ?? p),
  extractSessionId: vi.fn((filename: string) => filename.replace(/\.jsonl$/, '')),
}))

vi.mock('@/lib/scanner/project-scanner', () => ({
  scanProjects: vi.fn(),
  scanProjectsFrom: vi.fn(),
}))

vi.mock('@/lib/scanner/active-detector', () => ({
  isSessionActive: vi.fn(),
}))

vi.mock('@/lib/parsers/session-parser', () => ({
  parseSummary: vi.fn(),
  parseOutputTokens: vi.fn().mockResolvedValue(0),
  parseDetail: vi.fn(),
}))

import * as fs from 'node:fs'
import { claudeAdapter } from './claude-adapter'
import { getDataSources } from '@/lib/utils/claude-path'
import { scanProjects } from '@/lib/scanner/project-scanner'
import { isSessionActive } from '@/lib/scanner/active-detector'
import { parseSummary, parseDetail } from '@/lib/parsers/session-parser'

const mockReaddirSync = fs.readdirSync as ReturnType<typeof vi.fn>
const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>
const mockStat = fs.promises.stat as ReturnType<typeof vi.fn>
const mockGetDataSources = getDataSources as ReturnType<typeof vi.fn>
const mockScanProjects = scanProjects as ReturnType<typeof vi.fn>
const mockIsSessionActive = isSessionActive as ReturnType<typeof vi.fn>
const mockParseSummary = parseSummary as ReturnType<typeof vi.fn>
const mockParseDetail = parseDetail as ReturnType<typeof vi.fn>

function makeDataSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: 'primary',
    label: 'macOS',
    claudeDir: '/home/user/.claude',
    platform: 'macos',
    available: true,
    ...overrides,
  }
}

function makeProviderSource(overrides: Partial<ProviderSource> = {}): ProviderSource {
  return {
    provider: 'claude',
    id: 'primary',
    label: 'macOS',
    rootDir: '/home/user/.claude',
    platform: 'macos',
    available: true,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-abc',
    provider: 'claude',
    projectPath: '/Users/user/myproject',
    projectName: 'myproject',
    branch: 'main',
    cwd: '/Users/user/myproject',
    startedAt: '2026-01-01T10:00:00.000Z',
    lastActiveAt: '2026-01-01T11:00:00.000Z',
    durationMs: 3600000,
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    isActive: false,
    toolCallCount: 0,
    model: 'claude-opus-4-6',
    version: '1.0.0',
    fileSizeBytes: 1024,
    isInteractive: true,
    ...overrides,
  }
}

describe('claudeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes provider claude', () => {
    expect(claudeAdapter.provider).toBe('claude')
  })

  describe('getSources', () => {
    it('maps DataSource[] to ProviderSource[] with rootDir = claudeDir', async () => {
      mockGetDataSources.mockResolvedValue([makeDataSource()])

      const sources = await claudeAdapter.getSources()

      expect(sources).toEqual([
        {
          provider: 'claude',
          id: 'primary',
          label: 'macOS',
          rootDir: '/home/user/.claude',
          platform: 'macos',
          available: true,
        },
      ])
    })
  })

  describe('scanSummaries', () => {
    it('stamps provider claude and does NOT set source fields for primary', async () => {
      mockScanProjects.mockResolvedValue([
        {
          dirName: '-Users-user-myproject',
          decodedPath: '/Users/user/myproject',
          projectName: 'myproject',
          sessionFiles: ['session-abc.jsonl'],
        },
      ])
      mockStat.mockResolvedValue({ mtimeMs: 1000, size: 1024 })
      mockParseSummary.mockResolvedValue(makeSummary())
      mockIsSessionActive.mockResolvedValue(false)

      const result = await claudeAdapter.scanSummaries(makeProviderSource())

      expect(result).toHaveLength(1)
      expect(result[0].provider).toBe('claude')
      expect(result[0].sourceId).toBeUndefined()
      expect(result[0].sourceLabel).toBeUndefined()
      expect(result[0]).toHaveProperty('filePath')
      // Primary source uses the 2-arg active check (override undefined)
      expect(mockIsSessionActive).toHaveBeenCalledWith(
        '-Users-user-myproject',
        'session-abc',
        undefined,
      )
    })
  })

  describe('parseDetail', () => {
    it('stamps provider claude on the detail', async () => {
      const detail: SessionDetail = {
        sessionId: 'session-abc',
        provider: 'claude',
        projectPath: '/Users/user/myproject',
        projectName: 'myproject',
        branch: null,
        isInteractive: true,
        turns: [],
        totalTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        tokensByModel: {},
        toolFrequency: {},
        errors: [],
        models: [],
        agents: [],
        skills: [],
        tasks: [],
        contextWindow: null,
      }
      mockParseDetail.mockResolvedValue(detail)

      const result = await claudeAdapter.parseDetail(
        '/path/session-abc.jsonl',
        'session-abc',
        '/Users/user/myproject',
        'myproject',
      )

      expect(result.provider).toBe('claude')
      expect(mockParseDetail).toHaveBeenCalledWith(
        '/path/session-abc.jsonl',
        'session-abc',
        '/Users/user/myproject',
        'myproject',
      )
    })
  })

  describe('findSessionFile', () => {
    it('finds session file in primary source via project path match', async () => {
      mockGetDataSources.mockResolvedValue([makeDataSource()])
      mockReaddirSync.mockReturnValue(['-Users-user-myproject'])
      mockExistsSync.mockImplementation((p: string) => {
        return p === '/home/user/.claude/projects/-Users-user-myproject/session-123.jsonl'
      })

      const result = await claudeAdapter.findSessionFile('session-123', '/Users/user/myproject')

      expect(result).toEqual({
        path: '/home/user/.claude/projects/-Users-user-myproject/session-123.jsonl',
      })
    })

    it('finds session file via fallback scan of all projects', async () => {
      mockGetDataSources.mockResolvedValue([makeDataSource()])
      mockReaddirSync.mockReturnValue(['-Users-user-other', '-Users-user-myproject'])
      mockExistsSync.mockImplementation((p: string) => {
        return p === '/home/user/.claude/projects/-Users-user-myproject/session-123.jsonl'
      })

      const result = await claudeAdapter.findSessionFile('session-123', '/Users/user/nonexistent')

      expect(result).toEqual({
        path: '/home/user/.claude/projects/-Users-user-myproject/session-123.jsonl',
      })
    })

    it('finds session file in a secondary source when not in primary', async () => {
      const primary = makeDataSource()
      const secondary = makeDataSource({
        id: 'wsl-ubuntu',
        label: 'WSL-Ubuntu',
        claudeDir: '/mnt/wsl/ubuntu/.claude',
        platform: 'wsl',
      })
      mockGetDataSources.mockResolvedValue([primary, secondary])
      mockReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/user/.claude/projects') return ['-Users-user-other']
        if (p === '/mnt/wsl/ubuntu/.claude/projects') return ['-home-user-project']
        return []
      })
      mockExistsSync.mockImplementation((p: string) => {
        return p === '/mnt/wsl/ubuntu/.claude/projects/-home-user-project/session-456.jsonl'
      })

      const result = await claudeAdapter.findSessionFile('session-456', '/Users/user/nonexistent')

      expect(result).toEqual({
        path: '/mnt/wsl/ubuntu/.claude/projects/-home-user-project/session-456.jsonl',
      })
    })

    it('returns null when session not found in any source', async () => {
      mockGetDataSources.mockResolvedValue([makeDataSource()])
      mockReaddirSync.mockReturnValue(['-Users-user-project'])
      mockExistsSync.mockReturnValue(false)

      const result = await claudeAdapter.findSessionFile('nonexistent-id', '/Users/user/project')

      expect(result).toBeNull()
    })

    it('skips unavailable sources', async () => {
      const primary = makeDataSource({ available: false })
      const secondary = makeDataSource({
        id: 'secondary',
        claudeDir: '/other/.claude',
        available: true,
      })
      mockGetDataSources.mockResolvedValue([primary, secondary])
      mockReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/user/.claude/projects') {
          throw new Error('should not be called for unavailable source')
        }
        if (p === '/other/.claude/projects') return ['-other-project']
        return []
      })
      mockExistsSync.mockImplementation((p: string) => {
        return p === '/other/.claude/projects/-other-project/session-789.jsonl'
      })

      const result = await claudeAdapter.findSessionFile('session-789', '/other/project')

      expect(result).toEqual({
        path: '/other/.claude/projects/-other-project/session-789.jsonl',
      })
    })

    it('handles readdir failure gracefully for a source', async () => {
      mockGetDataSources.mockResolvedValue([makeDataSource()])
      mockReaddirSync.mockImplementation(() => {
        throw new Error('ENOENT')
      })

      const result = await claudeAdapter.findSessionFile('session-123', '/Users/user/project')

      expect(result).toBeNull()
    })
  })
})
