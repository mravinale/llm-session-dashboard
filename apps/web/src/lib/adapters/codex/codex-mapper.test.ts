import { describe, it, expect } from 'vitest'
import { mapSummary, type CodexSummaryContext } from './codex-mapper'
import type { CodexLine } from './codex-raw.types'

/**
 * Pure, in-memory tests for the Codex summary mapper (the P1 payoff — no disk).
 * Each test feeds hand-built `CodexLine[]` and asserts the normalized summary.
 */

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function ctx(overrides: Partial<CodexSummaryContext> = {}): CodexSummaryContext {
  return {
    sessionId: 'sess-from-filename',
    fileSizeBytes: 4096,
    extractProjectName: basename,
    ...overrides,
  }
}

function sessionMeta(overrides: Record<string, unknown> = {}): CodexLine {
  return {
    timestamp: '2026-06-01T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '019ed000-0000-7000-8000-000000000001',
      timestamp: '2026-06-01T10:00:00.000Z',
      cwd: '/Users/dev/Repositories/Github/my-codex-app',
      cli_version: '0.137.0-alpha.4',
      model_provider: 'openai',
      ...overrides,
    },
  }
}

function turnContext(model: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'turn_context',
    payload: { turn_id: `turn-${model}`, model },
  }
}

function tokenCount(
  total: Record<string, number>,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, model_context_window: 258400 },
    },
  }
}

function userMessage(text: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  }
}

function assistantMessage(text: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  }
}

function functionCall(name: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: '{}', call_id: 'c1' },
  }
}

function customToolCall(name: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'custom_tool_call', name, input: 'x', call_id: 'c2' },
  }
}

function taskComplete(ts: string): CodexLine {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete' } }
}

describe('mapSummary', () => {
  it('maps core fields from session_meta (cwd is absolute, no dash-decode)', () => {
    const head = [sessionMeta(), turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z')]
    const tail = [taskComplete('2026-06-01T10:00:06.500Z')]

    const summary = mapSummary(head, tail, ctx())
    expect(summary).not.toBeNull()
    expect(summary!.sessionId).toBe('019ed000-0000-7000-8000-000000000001')
    expect(summary!.provider).toBe('codex')
    expect(summary!.projectPath).toBe(
      '/Users/dev/Repositories/Github/my-codex-app',
    )
    expect(summary!.projectName).toBe('my-codex-app')
    expect(summary!.cwd).toBe('/Users/dev/Repositories/Github/my-codex-app')
    expect(summary!.branch).toBeNull()
    expect(summary!.version).toBe('0.137.0-alpha.4')
    expect(summary!.startedAt).toBe('2026-06-01T10:00:00.000Z')
    expect(summary!.lastActiveAt).toBe('2026-06-01T10:00:06.500Z')
    expect(summary!.durationMs).toBe(6500)
    expect(summary!.isInteractive).toBe(true)
    expect(summary!.isActive).toBe(false)
  })

  it('takes the LAST cumulative token_count, not the sum', () => {
    const head = [sessionMeta()]
    const tail = [
      tokenCount(
        { input_tokens: 1200, output_tokens: 80, reasoning_output_tokens: 40 },
        '2026-06-01T10:00:03.000Z',
      ),
      tokenCount(
        {
          input_tokens: 2600,
          cached_input_tokens: 900,
          output_tokens: 350,
          reasoning_output_tokens: 160,
        },
        '2026-06-01T10:00:06.000Z',
      ),
    ]

    const summary = mapSummary(head, tail, ctx())
    // Last wins: 350, NOT 80+350=430.
    expect(summary!.outputTokens).toBe(350)
    expect(summary!.reasoningOutputTokens).toBe(160)
  })

  it('uses most-recent turn_context.model as the session model', () => {
    const head = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      turnContext('gpt-5.5', '2026-06-01T10:00:03.500Z'),
    ]
    const summary = mapSummary(head, [], ctx())
    expect(summary!.model).toBe('gpt-5.5')
  })

  it('counts messages and tool calls across message + tool types', () => {
    const head = [
      sessionMeta(),
      userMessage('do the thing', '2026-06-01T10:00:01.500Z'),
      functionCall('exec_command', '2026-06-01T10:00:02.500Z'),
      customToolCall('apply_patch', '2026-06-01T10:00:04.000Z'),
      assistantMessage('done', '2026-06-01T10:00:05.000Z'),
    ]
    const summary = mapSummary(head, [], ctx())
    expect(summary!.userMessageCount).toBe(1)
    expect(summary!.assistantMessageCount).toBe(1)
    expect(summary!.messageCount).toBe(2)
    expect(summary!.toolCallCount).toBe(2)
  })

  it('does not double-count lines shared between head and tail', () => {
    const meta = sessionMeta()
    const msg = userMessage('hi', '2026-06-01T10:00:01.500Z')
    const tc = taskComplete('2026-06-01T10:00:06.500Z')
    // Same object references in both head and tail (short session).
    const summary = mapSummary([meta, msg, tc], [meta, msg, tc], ctx())
    expect(summary!.userMessageCount).toBe(1)
    expect(summary!.messageCount).toBe(1)
  })

  describe('title fallback chain', () => {
    it('prefers session_index title (ctx.title)', () => {
      const head = [
        sessionMeta(),
        userMessage('first user text', '2026-06-01T10:00:01.500Z'),
      ]
      const summary = mapSummary(head, [], ctx({ title: 'Indexed Title' }))
      expect(summary!.title).toBe('Indexed Title')
    })

    it('falls back to first user message text when no index title', () => {
      const head = [
        sessionMeta(),
        userMessage('Add a health-check endpoint', '2026-06-01T10:00:01.500Z'),
      ]
      const summary = mapSummary(head, [], ctx())
      expect(summary!.title).toBe('Add a health-check endpoint')
    })

    it('falls back to event_msg user_message text', () => {
      const head: CodexLine[] = [
        sessionMeta(),
        {
          timestamp: '2026-06-01T10:00:01.500Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'From event message' },
        },
      ]
      const summary = mapSummary(head, [], ctx())
      expect(summary!.title).toBe('From event message')
    })

    it('falls back to cwd basename when no messages', () => {
      const summary = mapSummary([sessionMeta()], [], ctx())
      expect(summary!.title).toBe('my-codex-app')
    })
  })

  describe('schema tolerance', () => {
    it('parses an old-schema session_meta (instructions:null, no base_instructions)', () => {
      const head = [
        sessionMeta({ cli_version: '0.36.0', instructions: null }),
        turnContext('gpt-5-codex', '2026-06-01T09:00:01.000Z'),
      ]
      const summary = mapSummary(head, [], ctx())
      expect(summary!.version).toBe('0.36.0')
      expect(summary!.model).toBe('gpt-5-codex')
    })

    it('parses a new-schema session_meta with base_instructions object', () => {
      const head = [
        sessionMeta({ base_instructions: { text: 'You are Codex.' } }),
      ]
      const summary = mapSummary(head, [], ctx())
      expect(summary!.version).toBe('0.137.0-alpha.4')
    })

    it('tolerates unknown line types (forward-compat)', () => {
      const head: CodexLine[] = [
        sessionMeta(),
        {
          timestamp: '2026-06-01T10:00:02.000Z',
          type: 'compacted',
          payload: { type: 'context_compacted' },
        },
        {
          timestamp: '2026-06-01T10:00:09.000Z',
          type: 'some_future_type',
          payload: { whatever: true },
        },
      ]
      const summary = mapSummary(head, [], ctx())
      expect(summary).not.toBeNull()
      // Unknown lines still extend the timestamp window.
      expect(summary!.lastActiveAt).toBe('2026-06-01T10:00:09.000Z')
    })

    it('omits reasoning tokens when absent (old schema)', () => {
      const head = [sessionMeta()]
      const tail = [
        tokenCount(
          { input_tokens: 500, output_tokens: 120 },
          '2026-06-01T09:00:03.000Z',
        ),
      ]
      const summary = mapSummary(head, tail, ctx())
      expect(summary!.outputTokens).toBe(120)
      expect(summary!.reasoningOutputTokens).toBeUndefined()
    })
  })

  it('first session_meta is canonical when re-emitted', () => {
    const head = [
      sessionMeta({ id: 'first-id', cwd: '/a/first-project' }),
      sessionMeta({ id: 'second-id', cwd: '/b/second-project' }),
    ]
    const summary = mapSummary(head, [], ctx())
    expect(summary!.sessionId).toBe('first-id')
    expect(summary!.projectPath).toBe('/a/first-project')
  })

  it('returns null when there are no parseable lines', () => {
    expect(mapSummary([], [], ctx())).toBeNull()
  })

  it('returns null when no timestamp can be derived', () => {
    const line: CodexLine = { type: 'session_meta', payload: {} }
    expect(mapSummary([line], [], ctx())).toBeNull()
  })
})
