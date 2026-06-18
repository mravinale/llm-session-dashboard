import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanCodexSummaries } from './codex-scanner'
import type { ProviderSource } from '@/lib/adapters/adapter'

/**
 * Integration tests for the Codex scanner against on-disk fixtures.
 *
 * The scanner reads from `source.rootDir`, so these tests pass the fixture root
 * directly and never touch the real `~/.codex` or the `CODEX_HOME` env.
 */

const FIXTURE_HOME = path.resolve(__dirname, '../../../../e2e/fixtures/.codex')

const fixtureSource: ProviderSource = {
  provider: 'codex',
  id: 'codex-primary',
  label: 'Codex',
  rootDir: FIXTURE_HOME,
  platform: 'macos',
  available: true,
}

describe('scanCodexSummaries', () => {
  it('walks the YYYY/MM/DD tree and returns one summary per rollout file', async () => {
    const summaries = await scanCodexSummaries(fixtureSource)
    expect(summaries.length).toBe(3)
    for (const s of summaries) {
      expect(s.provider).toBe('codex')
      expect(s.sourceId).toBe('codex-primary')
      expect(s.filePath).toContain('rollout-')
    }
  })

  it('omits sourceLabel/sourcePlatform for the primary source (single badge)', async () => {
    // The primary Codex source must NOT stamp source fields, so SessionCard
    // renders only the ProviderBadge ("Codex") and not a second SourceBadge.
    // This mirrors the Claude adapter's primary-vs-secondary rule.
    const summaries = await scanCodexSummaries(fixtureSource)
    expect(summaries.length).toBeGreaterThan(0)
    for (const s of summaries) {
      expect(s.sourceLabel).toBeUndefined()
      expect(s.sourcePlatform).toBeUndefined()
    }
  })

  it('extracts the uuid session id from the rollout filename / session_meta', async () => {
    const summaries = await scanCodexSummaries(fixtureSource)
    const ids = summaries.map((s) => s.sessionId).sort()
    expect(ids).toEqual([
      '019ed000-0000-7000-8000-000000000001',
      '019ed000-0000-7000-8000-000000000002',
      '019ed000-0000-7000-8000-000000000003',
    ])
  })

  it('populates title from session_index.jsonl when covered', async () => {
    const summaries = await scanCodexSummaries(fixtureSource)
    const completed = summaries.find(
      (s) => s.sessionId === '019ed000-0000-7000-8000-000000000001',
    )
    expect(completed!.title).toBe('Add health-check endpoint')
  })

  it('falls back to first user message text when the index lacks a title', async () => {
    const summaries = await scanCodexSummaries(fixtureSource)
    const active = summaries.find(
      (s) => s.sessionId === '019ed000-0000-7000-8000-000000000002',
    )
    // Session 2 is NOT in session_index.jsonl → first user message wins.
    expect(active!.title).toBe('Refactor the auth middleware')
  })

  it('fills output tokens from the last cumulative token_count', async () => {
    const summaries = await scanCodexSummaries(fixtureSource)
    const completed = summaries.find(
      (s) => s.sessionId === '019ed000-0000-7000-8000-000000000001',
    )
    expect(completed!.outputTokens).toBe(350)
    expect(completed!.reasoningOutputTokens).toBe(160)
  })

  it('serves a cached summary on a second scan (mtime unchanged)', async () => {
    const first = await scanCodexSummaries(fixtureSource)
    const second = await scanCodexSummaries(fixtureSource)
    expect(second.length).toBe(first.length)
    // Same content; cache hit path produces equivalent summaries.
    expect(second.map((s) => s.sessionId).sort()).toEqual(
      first.map((s) => s.sessionId).sort(),
    )
  })
})

/**
 * FIX-1 / FIX-4 regression: the REAL `scanCodexSummaries` must stamp `isActive`
 * (the generic scan loop does not — each adapter owns it, like Claude's) and must
 * NOT clobber a derived `outputTokens` with a redundant second tail read.
 *
 * These run against a temp dir so mtime (freshness) is controllable; the real
 * `~/.codex` is never touched. We do NOT mock `scanCodexSummaries`.
 */
describe('scanCodexSummaries — isActive + outputTokens (real path)', () => {
  let tmpHome: string

  function writeRollout(name: string, lines: string[], ageMs: number): void {
    const dateDir = path.join(tmpHome, 'sessions', '2026', '06', '16')
    fs.mkdirSync(dateDir, { recursive: true })
    const filePath = path.join(dateDir, name)
    fs.writeFileSync(filePath, lines.join('\n') + '\n')
    const when = Date.now() - ageMs
    fs.utimesSync(filePath, when / 1000, when / 1000)
  }

  function tmpSource(): ProviderSource {
    return {
      provider: 'codex',
      id: 'codex-primary',
      label: 'Codex',
      rootDir: tmpHome,
      platform: 'macos',
      available: true,
    }
  }

  const META = (id: string) =>
    JSON.stringify({
      timestamp: '2026-06-16T10:00:00.000Z',
      type: 'session_meta',
      payload: { id, cwd: '/tmp/proj', cli_version: '0.137.0' },
    })
  const TOKEN_COUNT = JSON.stringify({
    timestamp: '2026-06-16T10:00:05.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, output_tokens: 742 },
        model_context_window: 258400,
      },
    },
  })
  const AGENT_MESSAGE = JSON.stringify({
    timestamp: '2026-06-16T10:00:06.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'still working' },
  })
  const TASK_COMPLETE = JSON.stringify({
    timestamp: '2026-06-16T10:00:07.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  })

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scanner-active-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('stamps isActive:true for a fresh, non-terminal session', async () => {
    writeRollout(
      'rollout-2026-06-16T10-00-00-019ed000-0000-7000-8000-00000000aaaa.jsonl',
      [META('019ed000-0000-7000-8000-00000000aaaa'), TOKEN_COUNT, AGENT_MESSAGE],
      1000, // 1s old → fresh
    )
    const summaries = await scanCodexSummaries(tmpSource())
    expect(summaries).toHaveLength(1)
    expect(summaries[0].isActive).toBe(true)
  })

  it('stamps isActive:false for a fresh session ended by task_complete', async () => {
    writeRollout(
      'rollout-2026-06-16T10-00-00-019ed000-0000-7000-8000-00000000bbbb.jsonl',
      [META('019ed000-0000-7000-8000-00000000bbbb'), TOKEN_COUNT, TASK_COMPLETE],
      1000, // fresh, but terminal last event
    )
    const summaries = await scanCodexSummaries(tmpSource())
    expect(summaries).toHaveLength(1)
    expect(summaries[0].isActive).toBe(false)
  })

  it('keeps the tail-derived outputTokens (does not clobber with undefined)', async () => {
    writeRollout(
      'rollout-2026-06-16T10-00-00-019ed000-0000-7000-8000-00000000cccc.jsonl',
      [META('019ed000-0000-7000-8000-00000000cccc'), TOKEN_COUNT, AGENT_MESSAGE],
      1000,
    )
    const summaries = await scanCodexSummaries(tmpSource())
    expect(summaries).toHaveLength(1)
    expect(summaries[0].outputTokens).toBe(742)
  })
})
