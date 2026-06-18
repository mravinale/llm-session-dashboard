import { describe, it, expect } from 'vitest'
import {
  mapSummary,
  mapDetail,
  type CodexSummaryContext,
  type CodexDetailContext,
} from './codex-mapper'
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

// --- Detail mapper (Phase 3) ---

function detailCtx(
  overrides: Partial<CodexDetailContext> = {},
): CodexDetailContext {
  return {
    sessionId: '019ed000-0000-7000-8000-000000000001',
    projectPath: '/Users/dev/Repositories/Github/my-codex-app',
    projectName: 'my-codex-app',
    ...overrides,
  }
}

function tokenCountDetail(
  total: Record<string, number>,
  last: Record<string, number>,
  ts: string,
  contextWindow = 258400,
): CodexLine {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: contextWindow,
      },
    },
  }
}

function reasoning(ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      content: null,
      encrypted_content: 'gAAAA...opaque',
    },
  }
}

function functionCallDetail(
  name: string,
  args: string,
  callId: string,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: args, call_id: callId },
  }
}

function customToolCallDetail(
  name: string,
  input: string,
  callId: string,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'custom_tool_call', name, input, call_id: callId },
  }
}

function functionCallOutput(
  callId: string,
  output: string,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output },
  }
}

function turnAborted(reason: string, ts: string): CodexLine {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'turn_aborted', reason, turn_id: 'turn-x' },
  }
}

function spawnAgent(
  agentType: string,
  message: string,
  callId: string,
  ts: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: callId,
      arguments: JSON.stringify({ agent_type: agentType, message }),
    },
  }
}

function waitAgent(targets: string[], ts: string, timeoutMs = 600000): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      call_id: `wait-${ts}`,
      arguments: JSON.stringify({ targets, timeout_ms: timeoutMs }),
    },
  }
}

function updatePlan(
  plan: Array<{ step: string; status: string }>,
  ts: string,
  explanation?: string,
): CodexLine {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'update_plan',
      call_id: `plan-${ts}`,
      arguments: JSON.stringify(
        explanation !== undefined ? { explanation, plan } : { plan },
      ),
    },
  }
}

describe('mapDetail', () => {
  it('produces a normalized, in-contract SessionDetail for a full session', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      userMessage('Add a health-check endpoint', '2026-06-01T10:00:01.600Z'),
      reasoning('2026-06-01T10:00:02.000Z'),
      functionCallDetail(
        'exec_command',
        '{"cmd":"ls src/routes"}',
        'call_a1',
        '2026-06-01T10:00:02.500Z',
      ),
      functionCallOutput('call_a1', 'health.ts\nindex.ts', '2026-06-01T10:00:02.900Z'),
      tokenCountDetail(
        { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80, reasoning_output_tokens: 40 },
        { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80, reasoning_output_tokens: 40 },
        '2026-06-01T10:00:03.000Z',
      ),
      turnContext('gpt-5.5', '2026-06-01T10:00:03.500Z'),
      customToolCallDetail('apply_patch', '*** Begin Patch', 'call_a2', '2026-06-01T10:00:04.000Z'),
      assistantMessage('I added a /health endpoint.', '2026-06-01T10:00:05.000Z'),
      tokenCountDetail(
        { input_tokens: 2600, cached_input_tokens: 900, output_tokens: 350, reasoning_output_tokens: 160 },
        { input_tokens: 1400, cached_input_tokens: 600, output_tokens: 270, reasoning_output_tokens: 120 },
        '2026-06-01T10:00:06.000Z',
      ),
      taskComplete('2026-06-01T10:00:06.500Z'),
    ]

    const detail = mapDetail(lines, detailCtx({ title: 'Health endpoint' }))

    expect(detail.provider).toBe('codex')
    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000001')
    expect(detail.projectName).toBe('my-codex-app')
    expect(detail.branch).toBeNull()
    expect(detail.title).toBe('Health endpoint')
    expect(detail.isInteractive).toBe(true)
    // No spawn_agent/update_plan in this fixture, so agents/tasks are empty;
    // skills always degrade to [] for Codex (4.7).
    expect(detail.agents).toEqual([])
    expect(detail.skills).toEqual([])
    expect(detail.tasks).toEqual([])
  })

  it('takes the LAST cumulative token_count as totalTokens (not summed)', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      tokenCountDetail(
        { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80, reasoning_output_tokens: 40 },
        { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80, reasoning_output_tokens: 40 },
        '2026-06-01T10:00:03.000Z',
      ),
      tokenCountDetail(
        { input_tokens: 2600, cached_input_tokens: 900, output_tokens: 350, reasoning_output_tokens: 160 },
        { input_tokens: 1400, cached_input_tokens: 600, output_tokens: 270, reasoning_output_tokens: 120 },
        '2026-06-01T10:00:06.000Z',
      ),
    ]

    const detail = mapDetail(lines, detailCtx())
    // Last wins: 350, NOT 80+350.
    expect(detail.totalTokens.outputTokens).toBe(350)
    expect(detail.totalTokens.inputTokens).toBe(2600)
    expect(detail.totalTokens.cacheReadInputTokens).toBe(900)
    // Codex has no cache-write metric.
    expect(detail.totalTokens.cacheCreationInputTokens).toBe(0)
    expect(detail.totalTokens.reasoningOutputTokens).toBe(160)
  })

  it('attributes per-turn last_token_usage deltas to the active model', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      // token_count while gpt-5.4 is active.
      tokenCountDetail(
        { input_tokens: 1200, output_tokens: 80, reasoning_output_tokens: 40 },
        { input_tokens: 1200, output_tokens: 80, reasoning_output_tokens: 40 },
        '2026-06-01T10:00:03.000Z',
      ),
      // model switches to gpt-5.5.
      turnContext('gpt-5.5', '2026-06-01T10:00:03.500Z'),
      // token_count while gpt-5.5 is active — delta attributed to gpt-5.5.
      tokenCountDetail(
        { input_tokens: 2600, output_tokens: 350, reasoning_output_tokens: 160 },
        { input_tokens: 1400, output_tokens: 270, reasoning_output_tokens: 120 },
        '2026-06-01T10:00:06.000Z',
      ),
    ]

    const detail = mapDetail(lines, detailCtx())

    expect(detail.models).toEqual(['gpt-5.4', 'gpt-5.5'])
    expect(detail.tokensByModel['gpt-5.4'].outputTokens).toBe(80)
    expect(detail.tokensByModel['gpt-5.4'].inputTokens).toBe(1200)
    expect(detail.tokensByModel['gpt-5.5'].outputTokens).toBe(270)
    expect(detail.tokensByModel['gpt-5.5'].inputTokens).toBe(1400)
  })

  it('groups tool calls into the owning turn and counts toolFrequency', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      userMessage('do the thing', '2026-06-01T10:00:01.600Z'),
      functionCallDetail(
        'exec_command',
        '{"cmd":"ls"}',
        'call_a1',
        '2026-06-01T10:00:02.500Z',
      ),
      customToolCallDetail('apply_patch', '*** Begin Patch', 'call_a2', '2026-06-01T10:00:04.000Z'),
      assistantMessage('done', '2026-06-01T10:00:05.000Z'),
    ]

    const detail = mapDetail(lines, detailCtx())

    // One turn per message (user + assistant), reasoning not separate.
    expect(detail.turns).toHaveLength(2)
    const userTurn = detail.turns[0]
    expect(userTurn.type).toBe('user')
    // Tool calls between the user message and the next message fold into the user turn.
    expect(userTurn.toolCalls.map((t) => t.toolName)).toEqual([
      'exec_command',
      'apply_patch',
    ])
    expect(userTurn.toolCalls[0].toolUseId).toBe('call_a1')
    expect(userTurn.toolCalls[0].input).toEqual({ cmd: 'ls' })
    expect(detail.toolFrequency).toEqual({ exec_command: 1, apply_patch: 1 })
  })

  it('parses function_call arguments, falling back to {} on invalid JSON', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      assistantMessage('working', '2026-06-01T10:00:01.600Z'),
      functionCallDetail('exec_command', 'not-json{', 'call_bad', '2026-06-01T10:00:02.500Z'),
    ]

    const detail = mapDetail(lines, detailCtx())
    expect(detail.turns[0].toolCalls[0].input).toEqual({})
  })

  it('folds reasoning into the assistant turn (no separate reasoning turn)', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      reasoning('2026-06-01T10:00:02.000Z'),
      assistantMessage('here is the answer', '2026-06-01T10:00:05.000Z'),
    ]

    const detail = mapDetail(lines, detailCtx())
    // Only the assistant message becomes a turn — reasoning is folded away.
    expect(detail.turns).toHaveLength(1)
    expect(detail.turns[0].type).toBe('assistant')
    expect(detail.turns[0].message).toBe('here is the answer')
  })

  it('maps developer messages to system turns', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      {
        timestamp: '2026-06-01T10:00:01.600Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'system note' }],
        },
      },
    ]
    const detail = mapDetail(lines, detailCtx())
    expect(detail.turns[0].type).toBe('system')
    expect(detail.turns[0].message).toBe('system note')
  })

  it('builds context window from the REAL model_context_window limit', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      { timestamp: '2026-06-01T10:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', model_context_window: 200000 } },
      turnContext('gpt-5-codex', '2026-06-01T10:00:01.000Z'),
      tokenCountDetail(
        { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 },
        { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 },
        '2026-06-01T10:00:03.000Z',
        272000,
      ),
    ]

    const detail = mapDetail(lines, detailCtx())
    expect(detail.contextWindow).not.toBeNull()
    // token_count.model_context_window wins over task_started, and over the 200K default.
    expect(detail.contextWindow!.contextLimit).toBe(272000)
    // currentContextSize ≈ last input_tokens + cached_input_tokens.
    expect(detail.contextWindow!.currentContextSize).toBe(1200)
    expect(detail.contextWindow!.modelName).toBe('gpt-5-codex')
  })

  it('falls back to task_started.model_context_window when token_count omits it', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      { timestamp: '2026-06-01T10:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', model_context_window: 200000 } },
      turnContext('gpt-5-codex', '2026-06-01T10:00:01.000Z'),
      {
        timestamp: '2026-06-01T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 1000, output_tokens: 50 },
            last_token_usage: { input_tokens: 1000, output_tokens: 50 },
          },
        },
      },
    ]

    const detail = mapDetail(lines, detailCtx())
    expect(detail.contextWindow!.contextLimit).toBe(200000)
  })

  it('builds context window from per-turn occupancy, NOT cumulative total_token_usage', () => {
    // total_token_usage grows large (lifetime), but last_token_usage stays
    // within the window. currentContextSize must track last_token_usage so the
    // session never reports >100% (the 63964% regression).
    const limit = 258400
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
      // Turn 1: small prompt, cumulative already non-trivial.
      tokenCountDetail(
        { input_tokens: 50_000_000, cached_input_tokens: 10_000_000, output_tokens: 1000 },
        { input_tokens: 90_000, cached_input_tokens: 10_000, output_tokens: 800 },
        '2026-06-01T10:00:03.000Z',
        limit,
      ),
      // Turn 2: cumulative balloons to ~165M, but the LAST turn used ~220K.
      tokenCountDetail(
        { input_tokens: 150_000_000, cached_input_tokens: 15_300_000, output_tokens: 5000 },
        { input_tokens: 200_000, cached_input_tokens: 20_000, output_tokens: 2200 },
        '2026-06-01T10:00:06.000Z',
        limit,
      ),
    ]

    const detail = mapDetail(lines, detailCtx())
    const cw = detail.contextWindow
    expect(cw).not.toBeNull()
    // currentContextSize = last turn's input + cached (200K + 20K = 220K),
    // NOT the cumulative 165.3M that produced the 63964% bug.
    expect(cw!.currentContextSize).toBe(220_000)
    expect(cw!.currentContextSize).toBeLessThanOrEqual(cw!.contextLimit)
    // Final snapshot mirrors the per-turn occupancy.
    expect(cw!.snapshots[cw!.snapshots.length - 1].contextSize).toBe(220_000)
    // ~85% of a 258.4K window — sane, not 63964%.
    expect(cw!.usagePercent).toBe(85)
    // totalTokens still reflects cumulative lifetime usage (unchanged).
    expect(detail.totalTokens.inputTokens).toBe(150_000_000)
    expect(detail.totalTokens.cacheReadInputTokens).toBe(15_300_000)
  })

  it('captures turn_aborted as an error', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      userMessage('long task', '2026-06-01T10:00:01.600Z'),
      turnAborted('interrupted', '2026-06-01T10:00:09.000Z'),
    ]

    const detail = mapDetail(lines, detailCtx())
    expect(detail.errors).toHaveLength(1)
    expect(detail.errors[0].type).toBe('turn_aborted')
    expect(detail.errors[0].message).toBe('Turn aborted: interrupted')
    expect(detail.errors[0].timestamp).toBe('2026-06-01T10:00:09.000Z')
  })

  it('captures non-zero exec exit codes from function_call_output', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      assistantMessage('run it', '2026-06-01T10:00:01.600Z'),
      functionCallDetail('exec_command', '{"cmd":"false"}', 'call_e1', '2026-06-01T10:00:02.000Z'),
      functionCallOutput(
        'call_e1',
        'Wall time: 0.0s\nProcess exited with code 2\nOutput:\nboom',
        '2026-06-01T10:00:02.500Z',
      ),
    ]

    const detail = mapDetail(lines, detailCtx())
    const execError = detail.errors.find((e) => e.type === 'exec')
    expect(execError).toBeDefined()
    expect(execError!.message).toBe('Command exited with code 2')
  })

  it('ignores zero exit codes (no error for successful commands)', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      assistantMessage('run it', '2026-06-01T10:00:01.600Z'),
      functionCallOutput('call_ok', 'Process exited with code 0\nOutput:\nfine', '2026-06-01T10:00:02.500Z'),
    ]

    const detail = mapDetail(lines, detailCtx())
    expect(detail.errors.filter((e) => e.type === 'exec')).toHaveLength(0)
  })

  // --- Phase 4: agents (spawn/wait), tasks (update_plan) ---

  describe('agents (spawn_agent / wait_agent)', () => {
    it('maps one spawn_agent → one AgentInvocation with paired duration', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        assistantMessage('delegating', '2026-06-01T10:00:01.600Z'),
        spawnAgent(
          'code-reviewer',
          'Review the diff in src/routes for correctness',
          'call_spawn_1',
          '2026-06-01T10:00:02.000Z',
        ),
        waitAgent(['agent-xyz'], '2026-06-01T10:00:08.000Z'),
        taskComplete('2026-06-01T10:00:09.000Z'),
      ]

      const detail = mapDetail(lines, detailCtx())
      expect(detail.agents).toHaveLength(1)
      const agent = detail.agents[0]
      expect(agent.subagentType).toBe('code-reviewer')
      expect(agent.description).toBe(
        'Review the diff in src/routes for correctness',
      )
      expect(agent.toolUseId).toBe('call_spawn_1')
      expect(agent.timestamp).toBe('2026-06-01T10:00:02.000Z')
      // active turn_context.model.
      expect(agent.model).toBe('gpt-5.5')
      // wait_agent ts − spawn_agent ts = 6000ms.
      expect(agent.durationMs).toBe(6000)
      // wait_agent target surfaces as agentId.
      expect(agent.agentId).toBe('agent-xyz')
      // Codex has no sub-agent JSONL — these stay undefined (NOT fabricated).
      expect(agent.tokens).toBeUndefined()
      expect(agent.totalTokens).toBeUndefined()
      expect(agent.totalToolUseCount).toBeUndefined()
      expect(agent.toolCalls).toBeUndefined()
      expect(agent.skills).toBeUndefined()
    })

    it('leaves durationMs undefined when no wait_agent follows', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        spawnAgent('researcher', 'find the bug', 'call_spawn_2', '2026-06-01T10:00:02.000Z'),
      ]
      const detail = mapDetail(lines, detailCtx())
      expect(detail.agents).toHaveLength(1)
      expect(detail.agents[0].durationMs).toBeUndefined()
      expect(detail.agents[0].agentId).toBeUndefined()
    })

    it('pairs a batch wait_agent across multiple spawns', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        spawnAgent('a', 'task one', 'call_s1', '2026-06-01T10:00:02.000Z'),
        spawnAgent('b', 'task two', 'call_s2', '2026-06-01T10:00:03.000Z'),
        waitAgent(['agent-1', 'agent-2'], '2026-06-01T10:00:10.000Z'),
      ]
      const detail = mapDetail(lines, detailCtx())
      expect(detail.agents).toHaveLength(2)
      // Both spawns pair with the single batch wait at +10s.
      expect(detail.agents[0].durationMs).toBe(8000)
      expect(detail.agents[1].durationMs).toBe(7000)
    })

    it('skips the agent_type / message field on bad JSON args (no throw)', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        {
          timestamp: '2026-06-01T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'spawn_agent',
            call_id: 'call_bad',
            arguments: 'not-json{',
          },
        },
      ]
      const detail = mapDetail(lines, detailCtx())
      expect(detail.agents).toHaveLength(1)
      // Falls back to sensible defaults rather than throwing.
      expect(detail.agents[0].subagentType).toBe('agent')
      expect(detail.agents[0].description).toBe('')
      expect(detail.agents[0].toolUseId).toBe('call_bad')
    })

    it('still counts spawn/wait as tool calls in toolFrequency', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        spawnAgent('a', 'go', 'call_s1', '2026-06-01T10:00:02.000Z'),
        waitAgent(['agent-1'], '2026-06-01T10:00:05.000Z'),
      ]
      const detail = mapDetail(lines, detailCtx())
      expect(detail.toolFrequency).toEqual({ spawn_agent: 1, wait_agent: 1 })
    })
  })

  describe('tasks (update_plan)', () => {
    it('takes only the LATEST update_plan snapshot as the task list', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        updatePlan(
          [
            { step: 'design', status: 'in_progress' },
            { step: 'implement', status: 'pending' },
          ],
          '2026-06-01T10:00:02.000Z',
        ),
        // Re-sent full plan — supersedes the earlier one.
        updatePlan(
          [
            { step: 'design', status: 'completed' },
            { step: 'implement', status: 'in_progress' },
            { step: 'verify', status: 'pending' },
          ],
          '2026-06-01T10:00:08.000Z',
          'progressing',
        ),
      ]

      const detail = mapDetail(lines, detailCtx())
      expect(detail.tasks).toHaveLength(3)
      expect(detail.tasks.map((t) => t.subject)).toEqual([
        'design',
        'implement',
        'verify',
      ])
      // Latest statuses win (not the first snapshot's).
      expect(detail.tasks.map((t) => t.status)).toEqual([
        'completed',
        'in_progress',
        'pending',
      ])
      // Synthesized ids + timestamp of the latest update_plan.
      expect(detail.tasks.map((t) => t.taskId)).toEqual([
        'codex-plan-0',
        'codex-plan-1',
        'codex-plan-2',
      ])
      expect(detail.tasks[0].timestamp).toBe('2026-06-01T10:00:08.000Z')
      // No description/activeForm for Codex plan items.
      expect(detail.tasks[0].description).toBeUndefined()
      expect(detail.tasks[0].activeForm).toBeUndefined()
    })

    it('maps an unknown plan status to pending and skips empty steps', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        updatePlan(
          [
            { step: 'real step', status: 'weird' },
            { step: '   ', status: 'completed' },
          ],
          '2026-06-01T10:00:02.000Z',
        ),
      ]
      const detail = mapDetail(lines, detailCtx())
      // Only the non-empty step survives; unknown status → pending.
      expect(detail.tasks).toHaveLength(1)
      expect(detail.tasks[0].subject).toBe('real step')
      expect(detail.tasks[0].status).toBe('pending')
    })

    it('produces no tasks when update_plan args are bad JSON (no throw)', () => {
      const lines: CodexLine[] = [
        sessionMeta(),
        turnContext('gpt-5.5', '2026-06-01T10:00:01.000Z'),
        {
          timestamp: '2026-06-01T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call_plan_bad',
            arguments: 'not-json{',
          },
        },
      ]
      const detail = mapDetail(lines, detailCtx())
      expect(detail.tasks).toEqual([])
    })
  })

  it('truncates message text to ~500 chars (mirrors Claude extractor)', () => {
    const long = 'x'.repeat(900)
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      userMessage(long, '2026-06-01T10:00:01.600Z'),
    ]
    const detail = mapDetail(lines, detailCtx())
    expect(detail.turns[0].message).toHaveLength(500)
  })

  it('returns empty totals + null context window for a session with no tokens', () => {
    const lines: CodexLine[] = [
      sessionMeta(),
      turnContext('gpt-5.4', '2026-06-01T10:00:01.000Z'),
      userMessage('hi', '2026-06-01T10:00:01.600Z'),
    ]
    const detail = mapDetail(lines, detailCtx())
    expect(detail.totalTokens).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
    expect(detail.contextWindow).toBeNull()
    expect(detail.tokensByModel).toEqual({})
  })

  // Defensive: a malformed/unreadable rollout has every line dropped by the
  // parser's per-line `safeParse`, so `mapDetail` is handed `[]`. It must still
  // return a usable minimal SessionDetail (not throw), mirroring how Claude
  // degrades on a bad file rather than 500-ing the detail page.
  it('returns a minimal, non-throwing SessionDetail when every line was unparseable', () => {
    const detail = mapDetail([], detailCtx())

    expect(detail.sessionId).toBe('019ed000-0000-7000-8000-000000000001')
    expect(detail.provider).toBe('codex')
    expect(detail.projectPath).toBe('/Users/dev/Repositories/Github/my-codex-app')
    expect(detail.projectName).toBe('my-codex-app')
    expect(detail.turns).toEqual([])
    expect(detail.errors).toEqual([])
    expect(detail.agents).toEqual([])
    expect(detail.tasks).toEqual([])
    expect(detail.skills).toEqual([])
    expect(detail.models).toEqual([])
    expect(detail.tokensByModel).toEqual({})
    expect(detail.contextWindow).toBeNull()
    expect(detail.totalTokens).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })
})
