/**
 * Anti dead-loop guard.
 *
 * Tracks repeated tool calls with near-identical arguments. At ≥3 identical
 * calls an anti-loop reminder is injected into the session context; at ≥5 the
 * call is hard-cancelled. This is the agent-level guard that pairs with
 * compaction to break tool-call loops.
 *
 * @module dsh-compactor/guard
 */

export interface GuardCounts {
  [key: string]: number
}

export interface GuardStats {
  reminders: number
  cancellations: number
  total: number
}

const REMINDER = '停止重复调用 {tool}，改变策略或直接结束'

/** Create a fresh guard with its own call history (injectable for tests). */
export function createGuard() {
  const toolCallHistory = new Map<string, number>()
  const stats: GuardStats = { reminders: 0, cancellations: 0, total: 0 }

 /** Key for a tool call: tool name + normalized JSON args. */
  function key(toolName: string, args: unknown): string {
    let json: string
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    return `${toolName}:${json}`
  }

 /** The reminder text injected when a tool starts repeating. */
  function reminderText(toolName: string): string {
    return REMINDER.replace('{tool}', toolName)
  }

 /**
 * Record a call and decide whether it must be cancelled.
 * @returns an object describing the guard decision.
 */
  function shouldBlockToolCall(toolName: string, args: unknown): { blocked: boolean; count: number; reminder?: string } {
    const k = key(toolName, args)
    const count = (toolCallHistory.get(k) || 0) + 1
    toolCallHistory.set(k, count)
    stats.total++

    if (count >= 3 && count < 5) {
 // ≥3 times: inject a reminder into context
      stats.reminders++
      return { blocked: false, count, reminder: reminderText(toolName) }
    }
    if (count >= 5) {
 // ≥5 times: hard cancel
      stats.cancellations++
      return { blocked: true, count }
    }
    return { blocked: false, count }
  }

 /** Direct history access (used by tests and diagnostics). */
  function history(): GuardCounts {
    const out: GuardCounts = {}
    for (const [k, v] of toolCallHistory) out[k] = v
    return out
  }

  return {
    shouldBlockToolCall,
    history,
    stats,
    reminderText,
  }
}

export type Guard = ReturnType<typeof createGuard>

// Module-level singleton for plain (non-injected) usage, kept for compatibility's
// sketch. Prefer an injected guard created by index.ts.
export const defaultGuard: Guard = createGuard()

/** Re-export for API stability. */
export const shouldBlockToolCall = defaultGuard.shouldBlockToolCall
