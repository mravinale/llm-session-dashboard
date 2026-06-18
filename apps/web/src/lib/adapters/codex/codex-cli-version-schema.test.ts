/**
 * Target 4 — cli_version schema drift.
 *
 * Both an OLD-format rollout (session_meta with instructions:null, no
 * base_instructions, cli_version 0.36.0) and a NEW-format rollout
 * (base_instructions object, cli_version 0.140.x) must parse to a valid
 * SessionSummary AND SessionDetail without throwing.
 *
 * Coverage:
 * - mapSummary OLD schema (already in codex-mapper.test.ts, re-verified here)
 * - mapDetail OLD schema — NEW test
 * - mapDetail NEW schema — NEW test
 * - Full I/O roundtrip via codex-parser.parseDetail against the on-disk fixtures
 *   for both schema versions (sessions 1 = new, 3 = old)
 */

import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import { mapSummary, mapDetail } from './codex-mapper'
import { parseSummary, parseDetail } from './codex-parser'
import type { CodexLine } from './codex-raw.types'
import type { CodexSummaryContext } from './codex-mapper'

// ---- Shared helpers ----

const FIXTURE_DIR = path.resolve(__dirname, '../../../../e2e/fixtures/.codex/sessions/2026/06/01')

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? ''
}

function summaryCtx(overrides: Partial<CodexSummaryContext> = {}): CodexSummaryContext {
  return {
    sessionId: 'sess-from-filename',
    fileSizeBytes: 4096,
    extractProjectName: basename,
    ...overrides,
  }
}

// ---- OLD schema lines (cli_version 0.36.0, instructions:null, no base_instructions) ----

const OLD_META: CodexLine = {
  timestamp: '2026-06-01T09:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: '019ed000-0000-7000-8000-000000000003',
    timestamp: '2026-06-01T09:00:00.000Z',
    cwd: '/Users/dev/Repositories/Github/legacy-codex',
    originator: 'codex_cli',
    cli_version: '0.36.0',
    instructions: null,
    // NO base_instructions
  },
}

const OLD_TURN_CTX: CodexLine = {
  timestamp: '2026-06-01T09:00:01.000Z',
  type: 'turn_context',
  payload: { turn_id: 'turn-1', model: 'gpt-5-codex' },
}

const OLD_USER_MSG: CodexLine = {
  timestamp: '2026-06-01T09:00:01.500Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Explain the build pipeline' }],
  },
}

const OLD_FUNCTION_CALL: CodexLine = {
  timestamp: '2026-06-01T09:00:02.500Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: '{"cmd":"cat package.json"}',
    call_id: 'call_c1',
  },
}

const OLD_TOKEN_COUNT: CodexLine = {
  timestamp: '2026-06-01T09:00:03.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 120 },
      // OLD schema: no last_token_usage field → contextWindow will be null (no snapshots)
      model_context_window: 128000,
    },
  },
}

const OLD_ASSISTANT_MSG: CodexLine = {
  timestamp: '2026-06-01T09:00:04.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The build runs tsc then vite build.' }],
  },
}

// ---- NEW schema lines (cli_version 0.140.0-alpha.2, base_instructions object) ----

const NEW_META: CodexLine = {
  timestamp: '2026-06-01T10:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: '019ed000-0000-7000-8000-000000000001',
    timestamp: '2026-06-01T10:00:00.000Z',
    cwd: '/Users/dev/Repositories/Github/my-codex-app',
    originator: 'codex_cli',
    cli_version: '0.137.0-alpha.4',
    source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: 'You are Codex.' },
  },
}

const NEW_TURN_CTX_1: CodexLine = {
  timestamp: '2026-06-01T10:00:01.000Z',
  type: 'turn_context',
  payload: { turn_id: 'turn-1', cwd: '/Users/dev/Repositories/Github/my-codex-app', model: 'gpt-5.4' },
}

const NEW_USER_MSG: CodexLine = {
  timestamp: '2026-06-01T10:00:01.600Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Add a health-check endpoint to the API' }],
  },
}

const NEW_FUNCTION_CALL: CodexLine = {
  timestamp: '2026-06-01T10:00:02.500Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: '{"cmd":"ls src/routes"}',
    call_id: 'call_a1',
  },
}

const NEW_TOKEN_COUNT_1: CodexLine = {
  timestamp: '2026-06-01T10:00:03.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 300,
        output_tokens: 80,
        reasoning_output_tokens: 40,
      },
      // Include last_token_usage so a context-window snapshot is captured
      last_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 300,
        output_tokens: 80,
        reasoning_output_tokens: 40,
      },
      model_context_window: 258400,
    },
  },
}

const NEW_ASSISTANT_MSG: CodexLine = {
  timestamp: '2026-06-01T10:00:05.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'I added a /health endpoint.' }],
  },
}

const NEW_TOKEN_COUNT_2: CodexLine = {
  timestamp: '2026-06-01T10:00:06.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 2600,
        cached_input_tokens: 900,
        output_tokens: 350,
        reasoning_output_tokens: 160,
      },
      last_token_usage: {
        input_tokens: 1400,
        cached_input_tokens: 600,
        output_tokens: 270,
        reasoning_output_tokens: 120,
      },
      model_context_window: 258400,
    },
  },
}

const NEW_TASK_COMPLETE: CodexLine = {
  timestamp: '2026-06-01T10:00:06.500Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn-2' },
}

// ===== Tests =====

describe('cli_version schema drift — mapSummary', () => {
  it('OLD schema (0.36.0, instructions:null, no base_instructions) parses to a valid SessionSummary', () => {
    const summary = mapSummary(
      [OLD_META, OLD_TURN_CTX, OLD_USER_MSG],
      [OLD_TOKEN_COUNT],
      summaryCtx(),
    )

    expect(summary).not.toBeNull()
    expect(summary!.version).toBe('0.36.0')
    expect(summary!.model).toBe('gpt-5-codex')
    expect(summary!.projectPath).toBe('/Users/dev/Repositories/Github/legacy-codex')
    expect(summary!.projectName).toBe('legacy-codex')
    expect(summary!.provider).toBe('codex')
    expect(summary!.branch).toBeNull()
    expect(summary!.outputTokens).toBe(120)
    // No reasoning_output_tokens in old schema
    expect(summary!.reasoningOutputTokens).toBeUndefined()
  })

  it('NEW schema (0.137.x, base_instructions object) parses to a valid SessionSummary', () => {
    const summary = mapSummary(
      [NEW_META, NEW_TURN_CTX_1, NEW_USER_MSG],
      [NEW_TOKEN_COUNT_2],
      summaryCtx(),
    )

    expect(summary).not.toBeNull()
    expect(summary!.version).toBe('0.137.0-alpha.4')
    expect(summary!.model).toBe('gpt-5.4')
    expect(summary!.provider).toBe('codex')
    expect(summary!.outputTokens).toBe(350)
    expect(summary!.reasoningOutputTokens).toBe(160)
  })
})

describe('cli_version schema drift — mapDetail', () => {
  it('OLD schema (0.36.0) parses to a valid SessionDetail without throwing', () => {
    const lines: CodexLine[] = [
      OLD_META,
      OLD_TURN_CTX,
      OLD_USER_MSG,
      OLD_FUNCTION_CALL,
      OLD_TOKEN_COUNT,
      OLD_ASSISTANT_MSG,
    ]

    const detail = mapDetail(lines, {
      sessionId: '019ed000-0000-7000-8000-000000000003',
      projectPath: '/Users/dev/Repositories/Github/legacy-codex',
      projectName: 'legacy-codex',
    })

    // Required fields
    expect(detail.provider).toBe('codex')
    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000003')
    expect(detail.projectPath).toBe('/Users/dev/Repositories/Github/legacy-codex')
    expect(detail.projectName).toBe('legacy-codex')
    expect(detail.branch).toBeNull()
    expect(detail.isInteractive).toBe(true)

    // Turns
    expect(detail.turns).toHaveLength(2)
    expect(detail.turns[0].type).toBe('user')
    expect(detail.turns[0].message).toBe('Explain the build pipeline')
    expect(detail.turns[1].type).toBe('assistant')
    expect(detail.turns[1].message).toBe('The build runs tsc then vite build.')

    // Tool call attached to user turn
    expect(detail.turns[0].toolCalls).toHaveLength(1)
    expect(detail.turns[0].toolCalls[0].toolName).toBe('exec_command')

    // Tokens from last token_count (old schema has no reasoning_output_tokens)
    expect(detail.totalTokens.inputTokens).toBe(500)
    expect(detail.totalTokens.outputTokens).toBe(120)
    expect(detail.totalTokens.cacheCreationInputTokens).toBe(0)
    expect(detail.totalTokens.reasoningOutputTokens).toBeUndefined()

    // OLD schema has NO last_token_usage → no snapshots → contextWindow is null.
    // This is correct/expected: the panel gracefully hides when data is absent.
    expect(detail.contextWindow).toBeNull()

    // Graceful degradations (in-contract)
    expect(detail.skills).toEqual([])
    expect(detail.agents).toEqual([])
    expect(detail.tasks).toEqual([])
    expect(detail.errors).toEqual([])
    expect(detail.models).toEqual(['gpt-5-codex'])
    expect(detail.toolFrequency).toEqual({ exec_command: 1 })
  })

  it('NEW schema (0.137.x, base_instructions) parses to a valid SessionDetail without throwing', () => {
    const lines: CodexLine[] = [
      NEW_META,
      NEW_TURN_CTX_1,
      NEW_USER_MSG,
      NEW_FUNCTION_CALL,
      NEW_TOKEN_COUNT_1,
      NEW_ASSISTANT_MSG,
      NEW_TOKEN_COUNT_2,
      NEW_TASK_COMPLETE,
    ]

    const detail = mapDetail(lines, {
      sessionId: '019ed000-0000-7000-8000-000000000001',
      projectPath: '/Users/dev/Repositories/Github/my-codex-app',
      projectName: 'my-codex-app',
      title: 'Add health-check endpoint',
    })

    expect(detail.provider).toBe('codex')
    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000001')
    expect(detail.title).toBe('Add health-check endpoint')
    expect(detail.branch).toBeNull()

    // Turns: user + assistant
    expect(detail.turns).toHaveLength(2)
    expect(detail.turns[0].type).toBe('user')
    expect(detail.turns[1].type).toBe('assistant')

    // Cumulative last token_count wins (2600/350/160 not 1200/80/40)
    expect(detail.totalTokens.inputTokens).toBe(2600)
    expect(detail.totalTokens.outputTokens).toBe(350)
    expect(detail.totalTokens.cacheReadInputTokens).toBe(900)
    expect(detail.totalTokens.cacheCreationInputTokens).toBe(0)
    expect(detail.totalTokens.reasoningOutputTokens).toBe(160)

    expect(detail.contextWindow!.contextLimit).toBe(258400)
    expect(detail.models).toEqual(['gpt-5.4'])
    expect(detail.skills).toEqual([])
    expect(detail.toolFrequency).toEqual({ exec_command: 1 })
  })
})

describe('cli_version schema drift — full I/O roundtrip via codex-parser', () => {
  it('OLD schema fixture (session 3, cli_version 0.36.0) parses to a valid SessionDetail via parseDetail', async () => {
    const filePath = path.join(
      FIXTURE_DIR,
      'rollout-2026-06-01T09-00-00-019ed000-0000-7000-8000-000000000003.jsonl',
    )

    const detail = await parseDetail(
      filePath,
      '019ed000-0000-7000-8000-000000000003',
      '/Users/dev/Repositories/Github/legacy-codex',
      'legacy-codex',
    )

    expect(detail.provider).toBe('codex')
    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000003')
    expect(detail.projectName).toBe('legacy-codex')
    expect(detail.turns.length).toBeGreaterThan(0)
    expect(detail.totalTokens.outputTokens).toBe(120)
    expect(detail.totalTokens.reasoningOutputTokens).toBeUndefined()
    // Old fixture has no last_token_usage → contextWindow is null (expected)
    expect(detail.contextWindow).toBeNull()
    // Required domain fields must be present and correctly typed
    expect(Array.isArray(detail.skills)).toBe(true)
    expect(Array.isArray(detail.agents)).toBe(true)
    expect(Array.isArray(detail.tasks)).toBe(true)
    expect(Array.isArray(detail.errors)).toBe(true)
    expect(typeof detail.tokensByModel).toBe('object')
    expect(typeof detail.toolFrequency).toBe('object')
  })

  it('NEW schema fixture (session 1, cli_version 0.137.x) parses to a valid SessionDetail via parseDetail', async () => {
    const filePath = path.join(
      FIXTURE_DIR,
      'rollout-2026-06-01T10-00-00-019ed000-0000-7000-8000-000000000001.jsonl',
    )

    const detail = await parseDetail(
      filePath,
      '019ed000-0000-7000-8000-000000000001',
      '/Users/dev/Repositories/Github/my-codex-app',
      'my-codex-app',
    )

    expect(detail.provider).toBe('codex')
    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000001')
    expect(detail.projectName).toBe('my-codex-app')
    expect(detail.turns.length).toBeGreaterThan(0)
    // Cumulative last token_count: output=350, reasoning=160
    expect(detail.totalTokens.outputTokens).toBe(350)
    expect(detail.totalTokens.reasoningOutputTokens).toBe(160)
    expect(detail.contextWindow!.contextLimit).toBe(258400)
    expect(Array.isArray(detail.skills)).toBe(true)
    expect(Array.isArray(detail.agents)).toBe(true)
    expect(Array.isArray(detail.tasks)).toBe(true)
  })

  it('OLD schema fixture (session 3) parseSummary also succeeds', async () => {
    const filePath = path.join(
      FIXTURE_DIR,
      'rollout-2026-06-01T09-00-00-019ed000-0000-7000-8000-000000000003.jsonl',
    )
    const { size } = await import('node:fs').then((fs) =>
      fs.promises.stat(filePath),
    )

    const summary = await parseSummary(
      filePath,
      '019ed000-0000-7000-8000-000000000003',
      size,
      // title from session_index (confirmed in scanner test)
      'Explain build pipeline',
    )

    expect(summary).not.toBeNull()
    expect(summary!.version).toBe('0.36.0')
    expect(summary!.provider).toBe('codex')
    expect(summary!.model).toBe('gpt-5-codex')
    expect(summary!.outputTokens).toBe(120)
    expect(summary!.reasoningOutputTokens).toBeUndefined()
  })
})
