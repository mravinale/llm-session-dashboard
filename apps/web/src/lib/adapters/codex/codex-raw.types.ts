import { z } from 'zod'

/**
 * Zod schemas for the Codex rollout JSONL envelope and the payload unions the
 * summary path needs (Section 4.0 / REFERENCE B).
 *
 * Every schema is intentionally **permissive**: unknown keys pass through and
 * the payload is a loose record, so schema drift across `cli_version` never
 * throws. Callers use `safeParseLine` (per line) so a malformed line is skipped
 * rather than failing the whole file.
 */

/** Token usage block — both `total_token_usage` (cumulative) and `last_token_usage`. */
export const codexTokenUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    reasoning_output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough()

export type CodexTokenUsage = z.infer<typeof codexTokenUsageSchema>

/** `event_msg` payload with `type === 'token_count'`. */
export const codexTokenCountInfoSchema = z
  .object({
    total_token_usage: codexTokenUsageSchema.optional(),
    last_token_usage: codexTokenUsageSchema.optional(),
    model_context_window: z.number().optional(),
  })
  .passthrough()

/** One `message.content[]` block (`input_text` / `output_text`). */
export const codexContentBlockSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough()

/**
 * The envelope. `payload` is a loose record because its shape varies by `type`
 * and `payload.type`; the mapper narrows it via `switch` after this validates
 * the outer wrapper (timestamp + type present).
 */
export const codexLineSchema = z
  .object({
    timestamp: z.string().optional(),
    type: z.string(),
    // payload shape varies by `type`; the mapper narrows it after validation.
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

/** A validated Codex rollout line (outer envelope only). */
export type CodexLine = z.infer<typeof codexLineSchema>

/** Narrowed view of a `session_meta` payload (first one is canonical). */
export interface CodexSessionMeta {
  id?: string
  timestamp?: string
  cwd?: string
  cli_version?: string
  model_provider?: string
  originator?: string
}

/** Narrowed view of a `token_count` info block. */
export interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsage
  last_token_usage?: CodexTokenUsage
  model_context_window?: number
}
