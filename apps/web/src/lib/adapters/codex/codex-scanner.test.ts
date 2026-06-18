import { describe, it, expect } from 'vitest'
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
