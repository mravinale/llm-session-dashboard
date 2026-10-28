import * as fs from 'node:fs'
import * as readline from 'node:readline'

/**
 * Generic, provider-agnostic JSONL plumbing (P3).
 *
 * These three primitives were previously private to `session-parser.ts`. They
 * carry zero Claude/Codex knowledge — pure text/byte reads and a typed
 * `JSON.parse` wrapper — so they live in `shared/` for reuse by every adapter.
 */

/**
 * Read the first `count` lines of a file without loading the whole file.
 * Keeps memory minimal even for very large session files.
 */
export async function readHeadLines(
  filePath: string,
  count: number,
): Promise<string[]> {
  const lines: string[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    lines.push(line)
    if (lines.length >= count) break
  }

  stream.destroy()
  rl.close()
  return lines
}

/**
 * Read the last `count` lines of a file by reading a bounded tail window
 * (~64KB, enough for any reasonable line length).
 */
export async function readTailLines(
  filePath: string,
  count: number,
): Promise<string[]> {
  const stat = await fs.promises.stat(filePath)
  const readSize = Math.min(stat.size, 65536)
  const buffer = Buffer.alloc(readSize)

  const fd = await fs.promises.open(filePath, 'r')
  try {
    await fd.read(buffer, 0, readSize, Math.max(0, stat.size - readSize))
  } finally {
    await fd.close()
  }

  const text = buffer.toString('utf-8')
  const lines = text.split('\n').filter(Boolean)
  return lines.slice(-count)
}

/**
 * Parse a single JSONL line into a typed value, returning `null` on any
 * parse error. The caller asserts the shape; this is intentionally permissive
 * so malformed lines are skipped rather than thrown.
 */
export function safeParseLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}
