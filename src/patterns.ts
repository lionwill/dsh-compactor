/**
 * Conversation pattern detection.
 *
 * `detectPattern()` classifies a segment so the summarizer can use the right
 * prompt ("research chain" merges searches; "code debug" merges fix attempts;
 * ordinary conversation gets a plain summary).
 *
 * @module dsh-compactor/patterns
 */

import type { HarnessMessage } from './types.js'

export type ConversationPattern = 'research_chain' | 'code_debug' | 'normal_conversation'

/** Tools that signal a research chain. */
const RESEARCH_TOOLS = new Set(['web_search', 'search', 'browse', 'fetch', 'url_fetch', 'read_url'])

/** Tools that signal a debugging chain. */
const DEBUG_TOOLS = new Set(['code_execution', 'execute_code', 'bash', 'run', 'terminal', 'debug', 'test'])

function toolNamesIn(segment: HarnessMessage[]): string[] {
  const names: string[] = []
  for (const msg of segment) {
    if (msg.role === 'tool' && msg.name) names.push(msg.name)
    for (const call of msg.tool_calls ?? []) names.push(call.function.name)
  }
  return names
}

/** Count tool calls in the segment. */
export function countToolCalls(segment: HarnessMessage[]): number {
  return toolNamesIn(segment).length
}

/**
 * Classify a message segment into one of the three compaction patterns.
 * - `research_chain`: at least 2 research-ish tool calls → "调研摘要".
 * - `code_debug`: at least 2 debugging-ish tool calls (or retry attempts) → "调试过程摘要".
 * - `normal_conversation`: anything else → 常规摘要.
 */
export function detectPattern(segment: HarnessMessage[]): ConversationPattern {
  let research = 0
  let debug = 0
  for (const name of toolNamesIn(segment)) {
    if (RESEARCH_TOOLS.has(name)) research++
    if (DEBUG_TOOLS.has(name)) debug++
  }
  if (research >= 2 && research >= debug) return 'research_chain'
  if (debug >= 2) return 'code_debug'
  return 'normal_conversation'
}

/** Human-readable summary label per pattern (used by the summary messages). */
export function patternLabel(pattern: ConversationPattern): string {
  switch (pattern) {
    case 'research_chain':
      return '调研摘要'
    case 'code_debug':
      return '调试过程摘要'
    default:
      return '对话摘要'
  }
}
