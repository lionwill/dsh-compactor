/**
 * Adapter between the real dsh `Session` surface model and the
 * plugin's plain `HarnessMessage[]` model.
 *
 * Real dsh sessions keep an append-only event log; `session.surface.nodes`
 * lists the model-visible event seqs in order. Events are read through either
 * the legacy `session.events[seq]` field or the modern `session.eventAt(seq)`
 * method, so the plugin stays compatible across both surface shapes.
 *
 * Two payload shapes are understood:
 *  - real dsh (0.1.2-alpha.3+): `user/message` carries the `UserMessage`
 *    directly while `assistant/message` / `tool/result` wrap it as
 *    `data.message`; `content` is a `ContentBlock[]` and tool calls are
 *    `{ type: "tool-call" }` blocks;
 *  - the plugin's legacy/OpenAI-style shape: `data.message` with a string
 *    `content` and an explicit `tool_calls[]`.
 *
 * @module dsh-compactor/adapter
 */

import type { HarnessMessage, ToolCall } from './types.js'

/** Minimal structural view the adapter needs from a real dsh Session. */
export interface SurfaceSessionLike {
  id: string
  surface: { nodes: readonly number[] }
  /** Legacy dsh 0.1.2-alpha.4 event map/array. */
  events?: readonly { type: string; data?: Record<string, unknown> }[] | Record<number, { type: string; data?: Record<string, unknown> }>
  /** Modern dsh 0.1.3+ event lookup. */
  eventAt?: (seq: number) => { type: string; data?: Record<string, unknown> } | undefined
}

/** A real `tool/result` message shape (OpenAI-compatible enough for the adapter). */
interface RawToolResultMessage {
  content?: unknown
  source?: { callId?: string; name?: string }
}

/** Look up an event by seq, tolerating legacy and modern dsh layouts. */
function eventAt(
  session: SurfaceSessionLike,
  seq: number,
): { type: string; data?: { message?: unknown } } | undefined {
  if (session.events !== undefined) {
    const events = session.events
    if (Array.isArray(events)) return events[seq]
    return events[seq]
  }
  return session.eventAt?.(seq)
}

/**
 * Flatten a real dsh `ContentBlock[]` (or a legacy plain string) into the flat
 * text the plugin segmenter consumes. Text and reasoning blocks both carry
 * model-visible context; tool-result blocks recurse into their nested content.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (content == null) return ""
  if (Array.isArray(content) === false) return String(content)
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    const type = b["type"]
    if ((type === "text" || type === "reasoning") && typeof b["text"] === "string") {
      parts.push(b["text"] as string)
      continue
    }
    if (type === "tool-result") {
      const inner = contentToText(b["content"])
      if (inner) parts.push(inner)
    }
    // Unknown blocks (image/file/...) carry no flat text to preserve.
  }
  return parts.join("\n")
}

/** Extract tool calls from real `tool-call` content blocks or a legacy `tool_calls[]`. */
function toolCallsOf(message: Record<string, unknown>, seq: number): ToolCall[] | undefined {
  const calls: ToolCall[] = []
  const content = message["content"]
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if (b["type"] !== "tool-call") continue
      calls.push({
        id: typeof b["id"] === "string" ? (b["id"] as string) : `call-${seq}`,
        type: "function",
        function: {
          name: typeof b["name"] === "string" ? (b["name"] as string) : "",
          arguments: typeof b["arguments"] === "string" ? (b["arguments"] as string) : "",
        },
      })
    }
  }
  const legacy = message["tool_calls"]
  if (Array.isArray(legacy)) {
    for (const tc of legacy as unknown[]) {
      const raw = tc as { id?: string; function?: { name?: string; arguments?: string } }
      calls.push({
        id: raw.id ?? `call-${seq}`,
        type: "function",
        function: {
          name: raw.function?.name ?? "",
          arguments: raw.function?.arguments ?? "",
        },
      })
    }
  }
  return calls.length ? calls : undefined
}

/** Map an event seq to a flat HarnessMessage. */
function eventToMessage(
  seq: number,
  event: { type: string; data?: { message?: unknown } },
): HarnessMessage | null {
  const data = event?.data
  if (data === undefined || data === null) return null
  // Real dsh puts a `user/message` payload directly in `data`; assistant and
  // tool events wrap it as `data.message`. Legacy/test hosts always wrap.
  const message = (data.message ?? data) as Record<string, unknown> | undefined
  if (message === undefined || message === null || typeof message !== "object") return null
  // Prefer an explicit role on the payload (write-back projections carry it);
  // otherwise derive it from the event type.
  const explicitRole = message["role"] as HarnessMessage["role"] | undefined
  const derivedRole: HarnessMessage["role"] =
    event.type === "tool/result" ? "tool"
    : event.type === "assistant/message" ? "assistant"
    : "user"
  const role = explicitRole ?? derivedRole
  const metadata = message["metadata"] as Record<string, unknown> | undefined

  if (role === "assistant") {
    const out: HarnessMessage = { role: "assistant", content: contentToText(message["content"]) }
    const toolCalls = toolCallsOf(message, seq)
    if (toolCalls && toolCalls.length) out.tool_calls = toolCalls
    if (metadata) out.metadata = metadata
    return out
  }
  if (role === "tool" || event.type === "tool/result") {
    const raw = message as RawToolResultMessage & { tool_call_id?: unknown; name?: unknown }
    const source = raw.source
    return {
      role: "tool",
      tool_call_id: source?.callId
        ?? (typeof raw["tool_call_id"] === "string" ? (raw["tool_call_id"] as string) : `call-${seq}`),
      name: source?.name ?? (typeof raw["name"] === "string" ? (raw["name"] as string) : ""),
      content: contentToText(raw.content),
    }
  }
  // user / system context
  const out: HarnessMessage = { role, content: contentToText(message["content"]) }
  if (metadata) out.metadata = metadata
  return out
}

/**
 * Project a real dsh session surface into the plugin flat message list.
 * @returns messages in model-visible order (skips non-message events).
 */
export function surfaceToMessages(session: SurfaceSessionLike): HarnessMessage[] {
  const messages: HarnessMessage[] = []
  for (const seq of session.surface.nodes) {
    const event = eventAt(session, seq)
    if (event === undefined) continue
    const message = eventToMessage(seq, event)
    if (message) messages.push(message)
  }
  // Real dsh keeps the tool name on the assistant `tool-call` block, not on
  // the tool result. Backfill it so exemptTools and reports see a real name.
  const callNames = new Map<string, string>()
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const call of m.tool_calls) {
        if (call.id && call.function?.name) callNames.set(call.id, call.function.name)
      }
    } else if (m.role === "tool" && m.tool_call_id && (m.name === undefined || m.name === "")) {
      const name = callNames.get(m.tool_call_id)
      if (typeof name === "string") m.name = name
    }
  }
  return messages
}

/** Token-count convenience for the adapter path. */
export { surfaceToMessages as projectSessionMessages }

/** Whether the session exposes a real dsh `append` + `surface.nodes` surface. */
export function hasSurfaceReplace(session: SurfaceSessionLike): boolean {
  const s = session as unknown as { append?: unknown }
  return typeof s.append === "function" && Array.isArray(session.surface?.nodes)
}

/** Surface-replace intent accepted by a real dsh `Session.append`. */
export interface SurfaceReplaceIntent {
  surfaceOp: { op: "replace"; startSeq: number; endSeq: number }
  sourceEventSeqs: number[]
}

/**
 * Append one synthetic `user/message` that replaces a contiguous surface range.
 * The original events stay in the append-only log (they are shadowed, not
 * deleted); only the model-visible surface folds them into this one node.
 * @returns the appended event seq when the host reports one.
 */
export function appendSurfaceReplacement(
  session: SurfaceSessionLike,
  shadowedSeqs: readonly number[],
  text: string,
  id: string,
  sourcePlugin: string = "dsh-compactor",
): number | undefined {
  const s = session as unknown as {
    append?: (type: string, data: Record<string, unknown>, opts: SurfaceReplaceIntent) => unknown
  }
  if (typeof s.append !== "function" || shadowedSeqs.length === 0) return undefined
  const startSeq = shadowedSeqs[0]
  const endSeq = shadowedSeqs[shadowedSeqs.length - 1]
  if (startSeq === undefined || endSeq === undefined) return undefined
  const event = s.append(
    "user/message",
    {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: sourcePlugin },
    },
    {
      surfaceOp: { op: "replace", startSeq, endSeq },
      sourceEventSeqs: [...shadowedSeqs],
    },
  )
  if (typeof event === "number") return event
  if (event !== null && typeof event === "object" && typeof (event as { seq?: unknown }).seq === "number") {
    return (event as { seq: number }).seq
  }
  return undefined
}

/** One this-plugin compaction replacement found on the live surface. */
export interface PluginSummaryNode {
  /** Surface seq of the plugin-written summary `user/message`. */
  seq: number
  /** Surface seqs the summary replaced (its own `sourceEventSeqs`). */
  shadowedSeqs: number[]
}

/**
 * Find only this plugin compaction replacements. Built-in `/compact`
 * checkpoints use a different `source.plugin`, so they are never returned.
 */
export function findPluginSummaryNodes(session: SurfaceSessionLike): PluginSummaryNode[] {
  const found: PluginSummaryNode[] = []
  for (const seq of session.surface.nodes) {
    const event = eventAt(session, seq) as unknown as
      | { type?: string; data?: unknown; surfaceOp?: unknown; sourceEventSeqs?: unknown }
      | undefined
    if (event === undefined || event.type !== "user/message") continue
    const data = event.data as { source?: { kind?: unknown; plugin?: unknown } } | undefined
    const source = data?.source
    if (source?.kind !== "plugin" || source?.plugin !== "dsh-compactor") continue
    const op = event.surfaceOp as { op?: unknown } | undefined
    if (op?.op !== "replace") continue
    const seqs = Array.isArray(event.sourceEventSeqs)
      ? event.sourceEventSeqs.filter((value): value is number => typeof value === "number")
      : []
    found.push({ seq, shadowedSeqs: seqs })
  }
  return found
}

/** Re-append one original surface event verbatim so the shadowed content returns. */
export function reappendSurfaceEvent(session: SurfaceSessionLike, seq: number): boolean {
  const event = eventAt(session, seq) as unknown as { type?: string; data?: unknown } | undefined
  if (event === undefined || typeof event.type !== "string") return false
  const s = session as unknown as {
    append?: (type: string, data: unknown, opts: { surfaceOp: "append" }) => unknown
  }
  if (typeof s.append !== "function") return false
  s.append(event.type, event.data, { surfaceOp: "append" })
  return true
}
