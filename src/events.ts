/**
 * cordis4 event declarations for the dsh-compactor plugin.
 * @module dsh-compactor/events
 */

import type { ToolExecutePayload } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
 /** Plugin-internal prune event emitted on `session/event` tool/result. */
    'compactor/tool/prune'(payload: ToolExecutePayload): any
  }
}

export {}
