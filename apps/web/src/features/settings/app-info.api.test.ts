import { describe, it, expect } from 'vitest'
import { buildAppInfo } from './app-info.api'

describe('buildAppInfo', () => {
  const base = {
    version: '0.5.1',
    homeDir: '/Users/dev',
    nodeEnv: 'production',
  }

  it('reports only the Claude root when Codex is absent (back-compat)', () => {
    const info = buildAppInfo({ ...base, providers: ['claude'] })

    expect(info.appPath).toBe('/Users/dev/.claude')
    expect(info.codexPath).toBeUndefined()
    expect(info.providers).toEqual(['claude'])
    expect(info.version).toBe('0.5.1')
    expect(info.nodeEnv).toBe('production')
  })

  it('adds the Codex root when Codex is present', () => {
    const info = buildAppInfo({ ...base, providers: ['claude', 'codex'] })

    expect(info.appPath).toBe('/Users/dev/.claude')
    expect(info.codexPath).toBe('/Users/dev/.codex')
    expect(info.providers).toEqual(['claude', 'codex'])
  })

  it('keeps appPath stable so the footer never breaks without Codex', () => {
    const withCodex = buildAppInfo({ ...base, providers: ['claude', 'codex'] })
    const withoutCodex = buildAppInfo({ ...base, providers: ['claude'] })

    expect(withCodex.appPath).toBe(withoutCodex.appPath)
  })
})
