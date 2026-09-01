/**
 * Token estimation.
 *
 * `estimateTokens()` approximates the token count of a message or a message
 * list. The approximation is `chars / 4` (a commonly used heuristic for
 * English-ish text) with a small fixed per-message overhead, which satisfies
 * the <10% error bar for typical harness messages. An optional
 * tokenizer can be injected for a tighter estimate.
 *
 * @module dsh-compactor/estimator
 */

import type { HarnessMessage } from './types.js'

/** Per-message structural overhead in tokens (role labels, delimiters,...). */
export const PER_MESSAGE_OVERHEAD = 4

/** Characters per token heuristic for non-CJK text (char/4). */
export const CHARS_PER_TOKEN = 4

/** Token weight of a CJK character (measured against gpt-tokenizer ≈ 0.7). */
export const CJK_TOKEN_WEIGHT = 0.7

/** CJK-ish Unicode ranges that cost roughly one token per character in BPE models. */
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf]/

export interface TokenEstimatorOptions {
 /** Override the chars-per-token ratio. Default 4. */
  charsPerToken?: number
 /** Optional real tokenizer (e.g. gpt-tokenizer `encode`) for a tighter count. */
  tokenize?: (text: string) => number
}

/** Count the tokens of a single text blob (CJK-aware, default heuristic). */
export function estimateTextTokens(text: string, options: TokenEstimatorOptions = {}): number {
  const charsPerToken = options.charsPerToken ?? CHARS_PER_TOKEN
  if (options.tokenize) return options.tokenize(text)
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  const tokens = Math.round(cjk * CJK_TOKEN_WEIGHT) + Math.ceil(other / charsPerToken)
  return Math.max(1, tokens)
}

/** Count the tokens of one message (content + tool-call JSON). */
export function estimateMessageTokens(msg: HarnessMessage, options: TokenEstimatorOptions = {}): number {
  let tokens = PER_MESSAGE_OVERHEAD
  if (msg.content) tokens += estimateTextTokens(msg.content, options)
  if (msg.tool_calls) {
    tokens += estimateTextTokens(JSON.stringify(msg.tool_calls), options)
  }
  if (msg.name) tokens += estimateTextTokens(msg.name, options)
  return tokens
}

/**
 * Estimate the token count of a message list (or a single text string).
 * @returns estimated token count.
 */
export function estimateTokens(
  input: string | HarnessMessage[],
  options: TokenEstimatorOptions = {},
): number {
  if (typeof input === 'string') return estimateTextTokens(input, options)
  let total = 0
  for (const msg of input) total += estimateMessageTokens(msg, options)
  return total
}

/** Convenience alias used by the index.ts sketch. */
export { estimateTokens as estimateSessionTokens }
