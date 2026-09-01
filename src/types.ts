/**
 * Shared data types for the dsh-compactor plugin.
 *
 * The plugin talks to the DeepSeek Harness through a small, versioned surface
 * (a cordis `harness` service). These types describe that surface in a way the
 * plugin can consume regardless of the exact dsh session implementation.
 *
 * @module dsh-compactor/types
 */

/** A single message inside a harness session surface. */
export interface HarnessMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
 /** Text payload (used for user / assistant / system messages). */
  content?: string
 /** Tool name for `role === 'tool'` messages. */
  name?: string
 /** Tool call blocks on assistant messages (OpenAI-compatible shape). */
  tool_calls?: ToolCall[]
 /** Link an assistant tool call to its `tool` result message. */
  tool_call_id?: string
 /** Plugin-local bookkeeping (compressed marker, archive id,...). */
  metadata?: Record<string, unknown>
}

/** A tool invocation emitted by the assistant. */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** A session the plugin can compact / prune / monitor. */
export interface HarnessSession {
  id: string
  messages: HarnessMessage[]
 /** Optional user-facing sink (host-provided, optional). */
  send?: (text: string) => void | Promise<void>
}

/** The harness surface the plugin injects (`inject = ['harness']`). */
export interface HarnessContext {
  sessions: Map<string, HarnessSession> | Record<string, HarnessSession>
 /** Optional custom token estimator provided by the harness. */
  estimateTokens?: (messages: HarnessMessage[]) => number
}

/** Payload of the plugin-internal `compactor/tool/prune` event. */
export interface ToolExecutePayload {
  toolName: string
  args?: unknown
  result: any
  session?: HarnessSession
}

/** Payload of the `harness/tool/before-execute` event. */
export interface ToolBeforeExecutePayload {
  toolName: string
  args: unknown
  session: HarnessSession
 /** Set to `true` by a guard to cancel the call. */
  cancelled?: boolean
}

/** Payload of the `harness/session/message` event. */
export interface SessionMessagePayload {
  session: HarnessSession
  message: HarnessMessage
}
