/**
 * `/su-compact` — Semantic-Understanding compaction.
 *
 * The offline `/local-compact` path decides WHAT is compressible with pure
 * rules (`findCompressibleMessages` + `detectPattern`). `/su-compact` reuses
 * exactly that judgement to locate the spans, then hands the LLM a
 * **guidance** prompt that describes *what each span is doing and why it
 * matters* (intent), not a dead list of rules. The model is asked to keep only
 * the intent, the strategy that actually worked, and the final conclusion.
 *
 * Pipeline:
 *   1. local judgement: `findCompressibleMessages` + `detectPattern` (same as
 *      `/local-compact`) → a span of messages plus its pattern/reason.
 *   2. guidance: `buildSegmentGuidance()` turns that judgement into natural
 *      language — "第 x-y 条消息这段在做什么、用于什么、规则意图、要保留什么".
 *   3. LLM summary: the guidance + the raw span go to the model; the reply is
 *      the compacted skeleton (intent + working strategy + conclusion).
 *   4. reporting: reuses `compressMessages` / `formatCompactionMessage`, so the
 *      on-screen result looks exactly like `/local-compact` but with the LLM
 *      quality bar.
 *
 * @module dsh-compactor/su
 */

import type { Config } from './config.js'
import type { HarnessMessage } from './types.js'
import type { CompressibleBlock } from './segmenter.js'
import type { ConversationPattern } from './patterns.js'
import { detectPattern, patternLabel } from './patterns.js'
import type { LocalRules } from './local.js'
import { defaultTransport, localSummarize, type SegmentSummarizer, type SummaryTransport } from './summarizer.js'

/** Tool families used to describe what a span does (intent, not rules). */
const RESEARCH_TOOLS = new Set(['web_search', 'search', 'browse', 'fetch', 'url_fetch', 'read_url'])
const DEBUG_TOOLS = new Set(['code_execution', 'execute_code', 'bash', 'run', 'terminal', 'debug', 'test'])
const FILE_TOOLS = new Set(['read_file', 'write', 'edit', 'glob', 'grep'])

function toolNamesIn(segment: HarnessMessage[]): string[] {
  const names: string[] = []
  for (const msg of segment) {
    if (msg.role === 'tool' && msg.name) names.push(msg.name)
    for (const call of msg.tool_calls ?? []) names.push(call.function.name)
  }
  return names
}

/** Count occurrences of each tool name in a span. */
function toolCounts(segment: HarnessMessage[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const name of toolNamesIn(segment)) map.set(name, (map.get(name) ?? 0) + 1)
  return map
}

/** Human sentence describing the dominant intent of a span's tools. */
function describeIntent(segment: HarnessMessage[], pattern: ConversationPattern, counts: Map<string, number>): string {
  const research = [...counts.keys()].filter((n) => RESEARCH_TOOLS.has(n)).length
  const debug = [...counts.keys()].filter((n) => DEBUG_TOOLS.has(n)).length
  const file = [...counts.keys()].filter((n) => FILE_TOOLS.has(n)).length
  const parts: string[] = []
  if (pattern === 'research_chain') {
    parts.push('在反复检索/浏览外部信息，形成调研结论')
    if (research) parts.push(`涉及 ${research} 种检索类工具`)
  } else if (pattern === 'code_debug') {
    parts.push('在反复尝试/执行命令排查并修复问题')
    if (debug) parts.push(`涉及 ${debug} 种执行/调试类工具`)
  } else if (file > 0) {
    parts.push('在读写/检索文件内容')
  } else if (research > 0) {
    parts.push('在查询外部信息')
  } else if (debug > 0) {
    parts.push('在执行命令/排查问题')
  } else {
    parts.push('在展开一段推理与讨论')
  }
  return parts.join('；')
}

/** Count user questions / assistant conclusions to describe span shape. */
function describeShape(segment: HarnessMessage[]): { users: number; assistants: number; tools: number; calls: number } {
  let users = 0
  let assistants = 0
  let tools = 0
  let calls = 0
  for (const m of segment) {
    if (m.role === 'user') users++
    else if (m.role === 'assistant') {
      assistants++
      calls += m.tool_calls?.length ?? 0
    } else if (m.role === 'tool') tools++
  }
  return { users, assistants, tools, calls }
}

/**
 * Build a wider context window around a compressible block. Used only for
 * pattern/judgement detection so a single tool-result inside a long debug or
 * research chain is still described by its surrounding intent — the raw span
 * sent to the LLM stays exactly the block's own messages.
 */
export function buildContextWindow(
  messages: HarnessMessage[],
  block: CompressibleBlock,
  lookback = 16,
  lookahead = 4,
): HarnessMessage[] {
  const start = Math.max(0, block.startIdx - lookback)
  const end = Math.min(messages.length, block.endIdx + 1 + lookahead)
  return messages.slice(start, end)
}

/**
 * Turn a local-compaction judgement into a natural-language guidance for the
 * LLM. It describes *what the span does and why it matters* (intent) plus the
 * *reason/pattern* the local rules found — it never dumps a raw rule list.
 *
 * `context` (the full session messages) is optional but recommended: it lets
 * the judgement see the surrounding debug/research chain rather than only the
 * isolated span.
 *
 * @param segment - the exact messages in this span.
 * @param block - the local judgement (position + reason) for this span.
 * @param config - plugin config (exemptTools etc.).
 * @param rules - local rules (used only to inform the intent phrasing, not as a literal checklist).
 * @param context - full session messages (optional; enables context-aware intent).
 */
export function buildSegmentGuidance(
  segment: HarnessMessage[],
  block: CompressibleBlock,
  config: Config,
  rules: LocalRules,
  context?: HarnessMessage[],
): string {
  const judgementSpan = context ? buildContextWindow(context, block) : segment
  const pattern = detectPattern(judgementSpan)
  const counts = toolCounts(judgementSpan)
  const intent = describeIntent(judgementSpan, pattern, counts)
  const shape = describeShape(segment)
  // "第 x-y 条消息" in 1-based user-facing numbering.
  const from = block.startIdx + 1
  const to = block.endIdx + 1

  const toolsLine = [...counts.entries()].map(([n, c]) => `${n}×${c}`).join('、')

  // Per-pattern *intent* (why we compress / what must survive) — not dead rules.
  let keepIntent: string
  switch (pattern) {
    case 'research_chain':
      keepIntent = '调研的目标问题、关键事实/数字、结论性判断，以及最终采用/否决的链接与依据；中间的重复检索过程不需要。'
      break
    case 'code_debug':
      keepIntent = '要修复的目标、真正生效的修复方案与命令、最终结论与原因分析；中间多次失败尝试的重复过程不需要。'
      break
    default:
      keepIntent = '对话的意图、关键决策、重要事实/数字与最终结论；重复叙述和无关细节不需要。'
  }

  const lines = [
    `【片段位置】这是会话中的第 ${from}-${to} 条消息，共 ${shape.users} 条用户输入、${shape.assistants} 条助手消息、${shape.tools} 条工具结果。`,
    `【这段在做什么】${intent}。`,
    toolsLine ? `【用到的工具】${toolsLine}。` : '',
    `【判断】本地规则判定该片段为「${patternLabel(pattern)}」${block.reason === 'repetitive' ? '（存在重复段落）' : block.reason === 'tool_result' ? '（以工具结果为主）' : block.reason === 'multiple_tools' ? '（包含批量工具调用）' : '（以长回复为主）'}。`,
    `【压缩意图】${keepIntent}`,
  ].filter(Boolean)

  return lines.join('\n')
}

/**
 * Build the full user prompt for the `/su-compact` LLM call: the guidance +
 * the raw span. Instructs the model to keep only intent + working strategy +
 * final conclusion (never a bare rule dump).
 */
export function buildSuPrompt(segment: HarnessMessage[], guidance: string): string {
  return [
    '你是 dsh 的语义理解压缩器。下面给你一段待压缩的对话片段，以及本地规则对它的判断（判断只用于帮助你理解这段在做什么，不要机械照搬）。',
    '',
    '请输出一段精炼的中文摘要，只保留：',
    '1) 这段的意图（在做什么、目标是什么）；',
    '2) 成功执行的策略（真正有效的方法/命令/依据，含关键路径、数字、链接）；',
    '3) 最终结论。',
    '',
    '要求：',
    '- 丢弃重复的工具调用参数、失败尝试过程、无关细节；',
    '- 用通顺的叙述表达意图，而不是罗列规则或工具名清单；',
    '- 保留关键的文件路径、命令、错误串、数字、函数签名、URL；',
    '- 若片段本身信息不足以支撑某部分，写“（无）”。',
    '',
    `--- 本地判断 ---\n${guidance}`,
    '',
    `--- 待压缩片段 ---\n${JSON.stringify(segment)}`,
  ].join('\n')
}

/** Build the API request body for `/su-compact`. */
export function buildSuSummaryRequest(segment: HarnessMessage[], config: Config, guidance: string): unknown {
  return {
    model: config.summaryModel,
    messages: [{ role: 'user', content: buildSuPrompt(segment, guidance) }],
    temperature: 0.1,
    max_tokens: 1024,
  }
}

/**
 * Summarize one span for `/su-compact`: build guidance from the local
 * judgement, then call the LLM (or fall back to the offline local extractive
 * path when no key/transport). Never throws — always returns a usable summary.
 *
 * @param context - full session messages (optional; enables context-aware intent).
 */
export async function suSummarizeSegment(
  segment: HarnessMessage[],
  config: Config,
  block: CompressibleBlock,
  rules: LocalRules,
  transport?: SummaryTransport,
  context?: HarnessMessage[],
): Promise<string> {
  const guidance = buildSegmentGuidance(segment, block, config, rules, context)
  // No model available → local extractive fallback (still guidance-aware label).
  const useTransport = transport ?? (process.env.DEEPSEEK_API_KEY ? defaultTransport : undefined)
  if (!config.enableSummary || !useTransport) return localSummarize(segment)

  try {
    const body = buildSuSummaryRequest(segment, config, guidance)
    const { content } = await useTransport(body)
    if (!content || !content.trim()) return localSummarize(segment)
    return content.trim()
  } catch (err) {
    // Never let a summarizer failure break the session; fall back locally.
    console.error('[dsh-compactor/su] summary failed, using local fallback:', (err as Error).message)
    return localSummarize(segment)
  }
}

/**
 * Return a `SegmentSummarizer` (the signature `compressMessages` expects) for
 * `/su-compact`. It needs the local rules for judgement and optionally a
 * transport for tests.
 */
export function suSummarizer(rules: LocalRules, transport?: SummaryTransport): SegmentSummarizer {
  return async (segment: HarnessMessage[], config: Config, block?: CompressibleBlock, context?: HarnessMessage[]) => {
    const b = block ?? { startIdx: 0, endIdx: segment.length - 1, reason: 'tool_result', length: segment.length }
    return suSummarizeSegment(segment, config, b, rules, transport, context)
  }
}
