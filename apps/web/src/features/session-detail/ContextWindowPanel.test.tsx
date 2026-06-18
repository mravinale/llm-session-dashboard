import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextWindowPanel } from './ContextWindowPanel'
import type { TokenUsage } from '@/lib/parsers/types'

/**
 * FIX-3 regression: the Phase-3 "Reasoning" line was added to the dead
 * `TokenSummary` component, but the detail page renders token breakdowns via
 * `ContextWindowPanel` (TokenBreakdown / TokenFallback). These tests assert the
 * Reasoning line appears here when `reasoningOutputTokens` is truthy (Codex) and
 * is absent when undefined (Claude).
 */

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 200,
    cacheCreationInputTokens: 0,
    ...overrides,
  }
}

describe('ContextWindowPanel token breakdown — Reasoning line', () => {
  describe('TokenFallback (no context window)', () => {
    it('shows the Reasoning line when reasoningOutputTokens > 0 (Codex)', () => {
      render(
        <ContextWindowPanel
          contextWindow={null}
          tokens={tokens({ reasoningOutputTokens: 160 })}
        />,
      )
      expect(screen.getByText('Reasoning')).toBeTruthy()
    })

    it('omits the Reasoning line when reasoningOutputTokens is undefined (Claude)', () => {
      render(<ContextWindowPanel contextWindow={null} tokens={tokens()} />)
      expect(screen.queryByText('Reasoning')).toBeNull()
    })
  })

  describe('TokenBreakdown (with context window, expanded details)', () => {
    const contextWindow = {
      contextLimit: 200000,
      modelName: 'gpt-5-codex',
      systemOverhead: 1000,
      currentContextSize: 5000,
      messagesEstimate: 4000,
      freeSpace: 195000,
      autocompactBuffer: 10000,
      usagePercent: 3,
      snapshots: [],
    }

    it('shows the Reasoning line when reasoningOutputTokens > 0 (Codex)', () => {
      render(
        <ContextWindowPanel
          contextWindow={contextWindow}
          tokens={tokens({ reasoningOutputTokens: 160 })}
        />,
      )
      // Token details are collapsed by default — expand them.
      fireEvent.click(screen.getByText('Token Details'))
      expect(screen.getByText('Reasoning')).toBeTruthy()
    })

    it('omits the Reasoning line when reasoningOutputTokens is undefined (Claude)', () => {
      render(
        <ContextWindowPanel contextWindow={contextWindow} tokens={tokens()} />,
      )
      fireEvent.click(screen.getByText('Token Details'))
      expect(screen.queryByText('Reasoning')).toBeNull()
    })
  })
})
