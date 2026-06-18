import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { extractProjectName } from '@/lib/utils/claude-path'
import { getAdapters, getAdapter } from '@/lib/adapters/adapter'
import { providerIdSchema } from '@/lib/adapters/provider-registry'

/**
 * Detail input (P6/DIP): `provider` is optional for back-compat with old
 * bookmarked links that predate the provider dimension. When present, we
 * dispatch straight to that provider's adapter; when absent, we probe adapters
 * in registry order (Claude, then Codex) via `findSessionFile`.
 */
const getSessionDetailInput = z.object({
  sessionId: z.string(),
  projectPath: z.string(),
  provider: providerIdSchema.optional(),
})

export const getSessionDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: z.infer<typeof getSessionDetailInput>) =>
    getSessionDetailInput.parse(input),
  )
  .handler(async ({ data }) => {
    const projectName = extractProjectName(data.projectPath)

    // Explicit provider → route directly through its adapter (no concrete
    // provider parser named above the registry).
    if (data.provider) {
      const adapter = getAdapter(data.provider)
      const file = await adapter.findSessionFile(data.sessionId, data.projectPath)
      if (!file) {
        throw new Error(`Session not found: ${data.sessionId}`)
      }
      return adapter.parseDetail(
        file.path,
        data.sessionId,
        data.projectPath,
        projectName,
      )
    }

    // Back-compat (Risk R8): probe adapters in order until one locates the file.
    for (const adapter of getAdapters()) {
      const file = await adapter.findSessionFile(data.sessionId, data.projectPath)
      if (file) {
        return adapter.parseDetail(
          file.path,
          data.sessionId,
          data.projectPath,
          projectName,
        )
      }
    }

    throw new Error(`Session not found: ${data.sessionId}`)
  })
