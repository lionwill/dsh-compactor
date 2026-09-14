/**
 * Compression quality monitoring.
 *
 * Every compaction records before/after token counts, elapsed time, detected
 * pattern, and a keyword-retention ratio. `keywordCoverage()` compares the
 * keyword set of the original span against the summary text — the acceptance
 * bar is keyword coverage > 85% (qualityThreshold).
 *
 * @module dsh-compactor/monitor
 */

import type { HarnessMessage } from './types.js'
import type { ConversationPattern } from './patterns.js'

export interface CompressionEvent {
  sessionId: string
  startIdx: number
  endIdx: number
  tokensBefore: number
  tokensAfter: number
  elapsedMs: number
  pattern: ConversationPattern | 'unknown'
  keywordCoverage: number
  archiveId: string
  createdAt: string
}

/** Split text into normalized keyword tokens (CJK-aware). */
export function extractKeywords(text: string, maxKeywords = 64): Set<string> {
  const normalized = text.toLowerCase()
 // ASCII words
  const ascii = normalized.match(/[a-z0-9_]+/g) ?? []
 // CJK bigrams
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? []
  const bigrams: string[] = []
  for (let i = 0; i + 1 < cjk.length; i++) {
    bigrams.push(cjk[i] + cjk[i + 1])
  }
  const words = [...ascii, ...bigrams]
 // drop the most common stop-ish tokens
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'from', 'are', 'was'])
  const unique = new Set<string>()
  for (const w of words) {
    if (w.length < 2 || stop.has(w)) continue
    unique.add(w)
    if (unique.size >= maxKeywords) break
  }
  return unique
}

/**
 * Keyword coverage of `summary` relative to `original`: the fraction of the
 * original's keywords that appear (as substrings) in the summary.
 */
export function keywordCoverage(original: string, summary: string): number {
  const keys = extractKeywords(original)
  if (keys.size === 0) return 1
  let hit = 0
  for (const k of keys) {
    if (summary.includes(k)) hit++
  }
  return hit / keys.size
}

/** Collect keywords from a span of messages into one string for coverage checks. */
export function spanText(messages: HarnessMessage[]): string {
  return messages
    .map((m) => [m.content ?? '', JSON.stringify(m.tool_calls ?? '')].join(' '))
    .join('\n')
}

/** In-memory ring of recent compression events (for /compact stats + dsh-context). */
export class CompressionMonitor {
  private events: CompressionEvent[] = []

 /** Record one compression and return the keyword coverage that was measured. */
  record(event: Omit<CompressionEvent, 'createdAt'>): CompressionEvent {
    const full: CompressionEvent = { ...event, createdAt: new Date().toISOString() }
    this.events.push(full)
    if (this.events.length > 500) this.events.shift()
    return full
  }

 /** All recorded events (newest first). */
  list(): CompressionEvent[] {
    return [...this.events].reverse()
  }

 /** Average keyword coverage over recorded events. */
  averageCoverage(): number {
    if (this.events.length === 0) return 1
    return this.events.reduce((a, e) => a + e.keywordCoverage, 0) / this.events.length
  }

  get count(): number {
    return this.events.length
  }
}
