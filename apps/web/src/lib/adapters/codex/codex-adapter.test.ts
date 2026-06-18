import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProviderSource } from '@/lib/adapters/adapter'

// Control which Codex source roots `findSessionFile` walks (the real
// `getCodexHome()` is frozen at module load, so we mock the source enumeration
// to point at a temp dir). `getCodexSessionsDir` keeps its real implementation.
const codexSourcesMock = vi.hoisted(() => ({
  getCodexSources: vi.fn<() => Promise<ProviderSource[]>>(),
}))

vi.mock('@/lib/adapters/codex/codex-path', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/adapters/codex/codex-path')>()
  return { ...actual, getCodexSources: codexSourcesMock.getCodexSources }
})

// eslint-disable-next-line import/first -- must follow the vi.mock above
import { codexAdapter } from './codex-adapter'

/**
 * Adapter tests focus on `isActive` (Codex has no lock dir, so freshness +
 * last-event rule define activity). Files are written to a temp dir so mtime is
 * controllable; the real `~/.codex` is never read.
 */

const META_LINE = JSON.stringify({
  timestamp: '2026-06-01T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'x', cwd: '/tmp/proj', cli_version: '0.137.0' },
})
const TASK_COMPLETE_LINE = JSON.stringify({
  timestamp: '2026-06-01T10:00:06.500Z',
  type: 'event_msg',
  payload: { type: 'task_complete' },
})
const AGENT_MESSAGE_LINE = JSON.stringify({
  timestamp: '2026-06-01T10:00:06.500Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'still working' },
})

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeRollout(name: string, lines: string[], ageMs: number): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
  const when = Date.now() - ageMs
  fs.utimesSync(filePath, when / 1000, when / 1000)
  return filePath
}

describe('codexAdapter', () => {
  it('reports the codex provider', () => {
    expect(codexAdapter.provider).toBe('codex')
  })

  describe('isActive', () => {
    it('is ACTIVE when fresh and last event is NOT task_complete', async () => {
      const file = writeRollout(
        'rollout-active.jsonl',
        [META_LINE, AGENT_MESSAGE_LINE],
        1000, // 1s old → fresh
      )
      expect(await codexAdapter.isActive(file, 'x', fakeSource())).toBe(true)
    })

    it('is INACTIVE when fresh but last event is task_complete', async () => {
      const file = writeRollout(
        'rollout-complete.jsonl',
        [META_LINE, TASK_COMPLETE_LINE],
        1000, // fresh
      )
      expect(await codexAdapter.isActive(file, 'x', fakeSource())).toBe(false)
    })

    it('is INACTIVE when stale even without task_complete', async () => {
      const file = writeRollout(
        'rollout-stale.jsonl',
        [META_LINE, AGENT_MESSAGE_LINE],
        5 * 60_000, // 5 min old → stale
      )
      expect(await codexAdapter.isActive(file, 'x', fakeSource())).toBe(false)
    })

    it('is INACTIVE for a missing file', async () => {
      const missing = path.join(tmpDir, 'does-not-exist.jsonl')
      expect(await codexAdapter.isActive(missing, 'x', fakeSource())).toBe(false)
    })
  })

  describe('parseDetail', () => {
    it('parses a rollout file into a normalized SessionDetail', async () => {
      const lines = [
        META_LINE,
        JSON.stringify({
          timestamp: '2026-06-01T10:00:01.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5-codex' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T10:00:01.600Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        }),
        AGENT_MESSAGE_LINE,
      ]
      const file = writeRollout('rollout-detail.jsonl', lines, 1000)

      const detail = await codexAdapter.parseDetail(
        file,
        'x',
        '/tmp/proj',
        'proj',
      )
      expect(detail.provider).toBe('codex')
      expect(detail.sessionId).toBe('x')
      expect(detail.projectName).toBe('proj')
      expect(detail.models).toEqual(['gpt-5-codex'])
      expect(detail.turns.map((t) => t.type)).toEqual(['user'])
      // Phase 3 degrades these.
      expect(detail.agents).toEqual([])
      expect(detail.skills).toEqual([])
      expect(detail.tasks).toEqual([])
    })
  })

  describe('findSessionFile', () => {
    const SESSION_ID = '019ed21e-d66a-7ac1-918f-8e4b5fdf4a9c'

    beforeEach(() => {
      // Build a sessions/YYYY/MM/DD tree under the temp dir and serve it as the
      // sole Codex source (mock — the real frozen home is bypassed).
      const dateDir = path.join(tmpDir, 'sessions', '2026', '06', '16')
      fs.mkdirSync(dateDir, { recursive: true })
      fs.writeFileSync(
        path.join(dateDir, `rollout-2026-06-16T17-28-16-${SESSION_ID}.jsonl`),
        META_LINE + '\n',
      )
      codexSourcesMock.getCodexSources.mockResolvedValue([fakeSource()])
    })

    afterEach(() => {
      codexSourcesMock.getCodexSources.mockReset()
    })

    it('locates the rollout file by session id', async () => {
      const result = await codexAdapter.findSessionFile(SESSION_ID, '/tmp/proj')
      expect(result).not.toBeNull()
      expect(result!.path).toContain(SESSION_ID)
      expect(result!.path).toMatch(/rollout-.*\.jsonl$/)
    })

    it('returns null for an unknown session id', async () => {
      const result = await codexAdapter.findSessionFile('no-such-id', '/tmp/proj')
      expect(result).toBeNull()
    })
  })
})

function fakeSource() {
  return {
    provider: 'codex' as const,
    id: 'codex-primary',
    label: 'Codex',
    rootDir: tmpDir,
    platform: 'macos' as const,
    available: true,
  }
}
