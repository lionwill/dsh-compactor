/**
 * Message segmentation + boundary alignment.
 *
 * `findCompressibleMessages()` identifies spans of a session that are safe to
 * compress. Boundaries are aligned to tool-call / tool-result pairing points so
 * a compressed segment never splits a tool call from its result.
 *
 * @module dsh-compactor/segmenter
 */

import type { HarnessMessage } from './types.js'
import type { Config } from './config.js'

/** A contiguous span of messages that can be compressed into one summary. */
export interface CompressibleBlock {
  startIdx: number
  endIdx: number
  reason: 'tool_result' | 'long_response' | 'multiple_tools' | 'repetitive'
  length: number
}

/** Threshold (chars) above which a single assistant response is "long". */
export const LONG_RESPONSE_CHARS = 2000

/** A tool message is only compressible when paired with its assistant call. */
export function isPairedWithCall(messages: HarnessMessage[], idx: number): boolean {
  const msg = messages[idx]
  if (!msg || msg.role !== 'tool' || !msg.tool_call_id) return false
 // scan backwards for the assistant message carrying this tool_call_id
  for (let i = idx - 1; i >= 0; i--) {
    const prev = messages[i]
    if (prev.role === 'tool') continue
    if (prev.role === 'assistant' && prev.tool_calls?.some((c) => c.id === msg.tool_call_id)) {
      return true
    }
    return false // crossed a user/system boundary without finding the call
  }
  return false
}

/**
 * Detect whether an assistant message is a repetitive "car wheel" paragraph:
 * a long text where a sentence repeats.
 */
export function isRepetitive(content: string): boolean {
  if (!content || content.length < 400) return false
 // Split after CJK sentence enders (no whitespace required) and after an
 // English period only when followed by whitespace + an uppercase/CJK start,
 // so decimals like "3.14" are not treated as sentence breaks.
  const sentences = content
    .split(/(?<=[。！？!?])|(?<=[.])\s+(?=[A-Z\u4e00-\u9fff])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
  if (sentences.length < 3) return false
  const seen = new Set<string>()
  let repeats = 0
  for (const s of sentences) {
    const key = s.slice(0, 40)
    if (seen.has(key)) repeats++
    seen.add(key)
  }
 // at least two repeated sentences among a long text → repetitive
  return repeats >= 2
}

/**
 * Find compressible blocks in `messages`.
 *
 * The scan stops `config.retainRecentRounds` messages before the end so the
 * most recent working context is never touched.
 */
export function findCompressibleMessages(messages: HarnessMessage[], config: Config): CompressibleBlock[] {
  const blocks: CompressibleBlock[] = []
  const endExclusive = Math.max(1, messages.length - config.retainRecentRounds)

  for (let i = 1; i < endExclusive; i++) {
    const msg = messages[i]
    if (!msg) continue

 // Boundary alignment: only cut at tool-call / tool-result pairing points.
    if (msg.role === 'tool' && isPairedWithCall(messages, i)) {
      blocks.push({ startIdx: i, endIdx: i, reason: 'tool_result', length: (msg.content ?? '').length })
    } else if (msg.role === 'assistant' && (msg.content?.length ?? 0) > LONG_RESPONSE_CHARS) {
      if (isRepetitive(msg.content ?? '')) {
        blocks.push({ startIdx: i, endIdx: i, reason: 'repetitive', length: msg.content!.length })
      } else {
        blocks.push({ startIdx: i, endIdx: i, reason: 'long_response', length: msg.content!.length })
      }
    } else if (msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 3) {
      blocks.push({ startIdx: i, endIdx: i, reason: 'multiple_tools', length: JSON.stringify(msg.tool_calls).length })
    }
  }

  return mergeConsecutive(blocks)
}

/** Merge consecutive blocks to avoid fragmenting compression. */
export function mergeConsecutive(blocks: CompressibleBlock[]): CompressibleBlock[] {
  if (blocks.length === 0) return []
  const merged: CompressibleBlock[] = [blocks[0]]
  for (let i = 1; i < blocks.length; i++) {
    const last = merged[merged.length - 1]
    if (blocks[i].startIdx === last.endIdx + 1) {
      last.endIdx = blocks[i].endIdx
      last.length += blocks[i].length
 // keep the more specific reason label for diagnostics
      if (last.reason === 'tool_result' && blocks[i].reason !== 'tool_result') {
        last.reason = blocks[i].reason
      }
    } else {
      merged.push(blocks[i])
    }
  }
  return merged
}
