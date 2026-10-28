import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProviderBadge } from './ProviderBadge'
import { getProviderMeta } from '@/lib/adapters/provider-registry'

describe('ProviderBadge', () => {
  it('renders the Claude label from the registry', () => {
    render(<ProviderBadge provider="claude" />)
    expect(screen.getByText('Claude')).toBeTruthy()
  })

  it('renders the Codex label from the registry', () => {
    render(<ProviderBadge provider="codex" />)
    expect(screen.getByText('Codex')).toBeTruthy()
  })

  it('applies the registry badge classes (no hardcoded colors)', () => {
    render(<ProviderBadge provider="codex" />)
    const badge = screen.getByText('Codex')
    const codexClass = getProviderMeta('codex').badgeClass
    // Every class the registry defines for Codex must be applied.
    for (const cls of codexClass.split(' ')) {
      expect(badge.className).toContain(cls)
    }
  })

  it('appends an extra className when provided', () => {
    render(<ProviderBadge provider="claude" className="ml-2" />)
    expect(screen.getByText('Claude').className).toContain('ml-2')
  })

  it("Codex color is visually distinct from Claude's", () => {
    expect(getProviderMeta('codex').badgeClass).not.toBe(
      getProviderMeta('claude').badgeClass,
    )
  })
})
