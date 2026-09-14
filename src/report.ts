/**
 * Compaction result reporting.
 *
 * Both compaction modes (LLM-API summary and offline local rules) produce one
 * {@link CompactionReport}: which spans were pruned, per-scope character/token
 * before-after, the overall compression ratio, the estimated input-token
 * saving, keyword-retention, and a human-readable conclusion rendered for the
 * user by the command layer.
 *
 * @module dsh-compactor/report
 */

import type { HarnessMessage } from './types.js'
import type { ConversationPattern } from './patterns.js'

/** Why one span was considered compressible. */
export type BlockReason = 'tool_result' | 'long_response' | 'multiple_tools' | 'repetitive'

/** One compressed span: what it covered and what it cost. */
export interface BlockReport {
  /** Category of the compressed content. */
  reason: BlockReason
  /** Detected conversation pattern of the span. */
  pattern: ConversationPattern
  /** Human-readable scope label, e.g. `web_search 工具结果 ×2`. */
  scope: string
  /** Number of original messages replaced. */
  messages: number
  charsBefore: number
  charsAfter: number
  tokensBefore: number
  tokensAfter: number
  /** tokensBefore - tokensAfter. */
  tokensSaved: number
  /** tokensSaved / tokensBefore (0..1). */
  ratio: number
  /** Keyword retention of the summary vs. the originals (0..1). */
  keywordCoverage: number
  /** Archive entry id for /restore. */
  archiveId: string
}

/** Full result of one compaction pass. */
export interface CompactionReport {
  ok: boolean
  sessionId: string
  /** Which engine produced the summaries. */
  mode: 'api' | 'local' | 'su'
  tokensBefore: number
  tokensAfter: number
  savedTokens: number
  /** savedTokens / tokensBefore (0..1). */
  ratio: number
  /** Estimated saved input tokens on the NEXT model call (input is charged per turn). */
  savedNextCall: number
  blocks: BlockReport[]
  avgKeywordCoverage: number
  /** True when every block met the configured quality threshold. */
  qualityOk: boolean
  /** Multi-line human-readable conclusion. */
  message: string
}

const REASON_LABEL: Record<BlockReason, string> = {
  tool_result: '工具原始结果',
  long_response: '冗长助手回复',
  multiple_tools: '批量工具调用记录',
  repetitive: '重复段落（车轱辘话）',
}

/** Build a readable scope label describing what a segment contained. */
export function describeScope(messages: HarnessMessage[], reason: BlockReason): string {
  const tools = messages.filter((m) => m.role === 'tool').map((m) => m.name ?? 'tool')
  const toolCounts = new Map<string, number>()
  for (const t of tools) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1)
  const callCount = messages.reduce((a, m) => a + (m.tool_calls?.length ?? 0), 0)
  const chars = messages.reduce((a, m) => a + (m.content?.length ?? 0), 0)
  const parts: string[] = []
  if (toolCounts.size) {
    parts.push([...toolCounts].map(([t, n]) => `${t} ×${n}`).join('、') + ' 的返回内容')
  }
  if (callCount && reason !== 'tool_result') parts.push(`${callCount} 条工具调用参数`)
  const assistant = messages.filter((m) => m.role === 'assistant' && m.content).length
  if (assistant && reason !== 'tool_result') parts.push(`${assistant} 段助手叙述`)
  if (!parts.length) parts.push(`${messages.length} 条消息`)
  return `${REASON_LABEL[reason]}（${parts.join('、')}，原文约 ${chars} 字符）`
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/** Compose the user-facing conclusion text from a report (without the header). */
export function formatCompactionMessage(r: CompactionReport, qualityThreshold: number): string {
  if (!r.ok) return r.blocks.length === 0 ? '没有可压缩的内容（或全部命中豁免规则）' : '压缩未完成'
  const head = `压缩范围共 ${r.blocks.length} 处（${r.tokensBefore} → ${r.tokensAfter} tokens）：`
  const lines = r.blocks.map((b, i) =>
    `  ${i + 1}) ${b.scope}\n     ${pct(b.ratio)} 压缩（${b.tokensBefore} → ${b.tokensAfter} tokens，关键词保留 ${pct(b.keywordCoverage)}）`)
  const tail = [
    `整体压缩比 ${pct(r.ratio)}，本轮上下文减少 ${r.savedTokens} tokens；`,
    `下次模型请求预计少发约 ${r.savedNextCall} 个输入 token（按每轮全量计费估算）。`,
    r.qualityOk
      ? `关键信息保留达标（平均 ${pct(r.avgKeywordCoverage)} ≥ ${pct(qualityThreshold)}）。`
      : `⚠️ 关键信息保留率平均 ${pct(r.avgKeywordCoverage)}，低于建议阈值 ${pct(qualityThreshold)}——若发现丢信息，请执行 /restore 完整还原原文。`,
    '原文已写入 append-only 归档，随时可用 /restore 回退。',
  ]
  return [head, ...lines, ...tail].join('\n')
}
