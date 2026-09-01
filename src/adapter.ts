/**
 * Adapter between the real dsh 0.1.2-alpha.3 `Session` surface model and the
 * plugin's plain `HarnessMessage[]` model.
 *
 * Real dsh sessions keep an append-only event log; `session.surface.nodes`
 * lists the model-visible event seqs in order, and `session.events[seq]`
 * carries the event (`user/message`, `assistant/message`, `tool/result`,...)
 * with its `data.message`.
 *
 * This module projects that surface into a flat message list the
 * plugin segmenter/pruner can consume, and writes a summary back by appending
 * a `user/message`-style synthetic event (the plugin does not mutate the log
 * in place; it relies on the durable compaction seam when available).
 *
 * @module dsh-compactor/adapter
 */

import type { HarnessMessage, ToolCall } from './types.js'

/** Minimal structural view the adapter needs from a real dsh Session. */
export interface SurfaceSessionLike {
  id: string
  surface: { nodes: readonly number[] }
  events: readonly { type: string; data?: Record<string, unknown> }[] | Record<number, { type: string; data?: Record<string, unknown> }>
}

/** A real `tool/result` message shape (OpenAI-compatible enough for the adapter). */
interface RawToolResultMessage {
  content?: unknown
  source?: { callId?: string; name?: string }
}

/** Look up an event by seq, tolerating both array and record layouts. */
function eventAt(
  session: SurfaceSessionLike,
  seq: number,
): { type: string; data?: { message?: unknown } } | undefined {
  const events = session.events
  if (Array.isArray(events)) return events[seq]
  return events[seq]
}

/** Map an event seq to a flat HarnessMessage. */
function eventToMessage(
  seq: number,
  event: { type: string; data?: { message?: unknown } },
): HarnessMessage | null {
  const data = event?.data
  if (!data) return null
  const message = data.message as Record<string, unknown> | undefined
  if (!message) return null
 // Prefer an explicit role on the payload (write-back projections carry it);
 // otherwise derive it from the event type.
  const explicitRole = message.role as HarnessMessage['role'] | undefined
  const derivedRole: HarnessMessage['role'] =
    event.type === 'tool/result' ? 'tool'
    : event.type === 'assistant/message' ? 'assistant'
    : 'user'
  const role = explicitRole ?? derivedRole
  const metadata = message.metadata as Record<string, unknown> | undefined

  if (role === 'assistant') {
    const content = String(message.content ?? '')
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as unknown[]).map((tc) => {
          const raw = tc as { id?: string; function?: { name?: string; arguments?: string } }
          const call: ToolCall = {
            id: raw.id ?? `call-${seq}`,
            type: 'function',
            function: {
              name: raw.function?.name ?? '',
              arguments: raw.function?.arguments ?? '',
            },
          }
          return call
        })
      : undefined
    const out: HarnessMessage = { role: 'assistant', content }
    if (toolCalls && toolCalls.length) out.tool_calls = toolCalls
    if (metadata) out.metadata = metadata
    return out
  }
  if (role === 'tool' || event.type === 'tool/result') {
    const raw = message as RawToolResultMessage
    let content: string
    const rawContent = raw.content
    if (typeof rawContent === 'string') content = rawContent
    else content = JSON.stringify(rawContent ?? {})
    return {
      role: 'tool',
      tool_call_id: raw.source?.callId ?? `call-${seq}`,
      name: raw.source?.name ?? '',
      content,
    }
  }
 // user / system context
  const out: HarnessMessage = { role, content: String(message.content ?? '') }
  if (metadata) out.metadata = metadata
  return out
}

/**
 * Project a real dsh session surface into the plugin's flat message list.
 * @returns messages in model-visible order (skips non-message events).
 */
export function surfaceToMessages(session: SurfaceSessionLike): HarnessMessage[] {
  const messages: HarnessMessage[] = []
  for (const seq of session.surface.nodes) {
    const event = eventAt(session, seq)
    if (!event) continue
    const message = eventToMessage(seq, event)
    if (message) messages.push(message)
  }
  return messages
}

/** Token-count convenience for the adapter path. */
export { surfaceToMessages as projectSessionMessages }
