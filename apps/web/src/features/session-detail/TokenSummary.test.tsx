/**
 * Target 3 — TokenSummary component tests.
 *
 * Verifies that:
 * (a) A "Reasoning" line renders when `reasoningOutputTokens > 0` (Codex).
 * (b) The "Reasoning" line is ABSENT when `reasoningOutputTokens` is undefined (Claude).
 * (c) The "Reasoning" line is ABSENT when `reasoningOutputTokens` is 0.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenSummary } from './TokenSummary'
import type { TokenUsage } from '@/lib/parsers/types'

const baseTokens: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadInputTokens: 200,
  cacheCreationInputTokens: 100,
}

describe('TokenSummary', () => {
  it('renders a Reasoning line when reasoningOutputTokens is present and non-zero', () => {
    const tokensWithReasoning: TokenUsage = {
      ...baseTokens,
      reasoningOutputTokens: 160,
    }

    render(<TokenSummary tokens={tokensWithReasoning} />)

    expect(screen.getByText('Reasoning')).toBeDefined()
  })

  it('does NOT render a Reasoning line when reasoningOutputTokens is undefined (Claude)', () => {
    // Claude sessions: reasoningOutputTokens is undefined
    const claudeTokens: TokenUsage = { ...baseTokens }
    // Confirm the field is absent
    expect(claudeTokens.reasoningOutputTokens).toBeUndefined()

    render(<TokenSummary tokens={claudeTokens} />)

    expect(screen.queryByText('Reasoning')).toBeNull()
  })

  it('does NOT render a Reasoning line when reasoningOutputTokens is 0', () => {
    // A zero value is falsy and should be treated the same as absent.
    const tokensZeroReasoning: TokenUsage = {
      ...baseTokens,
      reasoningOutputTokens: 0,
    }

    render(<TokenSummary tokens={tokensZeroReasoning} />)

    expect(screen.queryByText('Reasoning')).toBeNull()
  })

  it('always renders Input, Output, Cache Read, and Cache Create lines', () => {
    render(<TokenSummary tokens={baseTokens} />)

    expect(screen.getByText('Input (non-cached)')).toBeDefined()
    expect(screen.getByText('Output')).toBeDefined()
    expect(screen.getByText('Cache Read')).toBeDefined()
    expect(screen.getByText('Cache Create')).toBeDefined()
  })

  it('renders the Reasoning line between Output and Cache Read for Codex sessions', () => {
    const codexTokens: TokenUsage = {
      ...baseTokens,
      reasoningOutputTokens: 80,
    }

    render(<TokenSummary tokens={codexTokens} />)

    const items = screen
      .getAllByText(/Input|Output|Reasoning|Cache/)
      .map((el) => el.textContent)

    const outputIdx = items.indexOf('Output')
    const reasoningIdx = items.indexOf('Reasoning')
    const cacheReadIdx = items.indexOf('Cache Read')

    // Reasoning must come after Output and before Cache Read.
    expect(outputIdx).toBeGreaterThanOrEqual(0)
    expect(reasoningIdx).toBeGreaterThan(outputIdx)
    expect(cacheReadIdx).toBeGreaterThan(reasoningIdx)
  })
})
