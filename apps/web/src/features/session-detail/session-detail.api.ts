import { createServerFn } from '@tanstack/react-start'
import { extractProjectName } from '@/lib/utils/claude-path'
import { getAdapter } from '@/lib/adapters/adapter'

export const getSessionDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { sessionId: string; projectPath: string }) => input)
  .handler(async ({ data }) => {
    // Phase 0: Claude only. Provider routing (P6) is widened in a later phase.
    const adapter = getAdapter('claude')
    const filePath = await adapter.findSessionFile(data.sessionId, data.projectPath)
    if (!filePath) {
      throw new Error(`Session not found: ${data.sessionId}`)
    }

    const projectName = extractProjectName(data.projectPath)
    return adapter.parseDetail(filePath.path, data.sessionId, data.projectPath, projectName)
  })
