import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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

  describe('Phase 3 stubs', () => {
    it('parseDetail throws until Phase 3', async () => {
      await expect(
        codexAdapter.parseDetail('/p', 'x', '/proj', 'proj'),
      ).rejects.toThrow(/Phase 3/)
    })

    it('findSessionFile throws until Phase 3', async () => {
      await expect(codexAdapter.findSessionFile('x', '/proj')).rejects.toThrow(
        /Phase 3/,
      )
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
