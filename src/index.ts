/**
 * dsh-compactor — Context Compaction plugin for DeepSeek Harness.
 *
 * cordis4-native (ESM) Service plugin with three layers:
 *  1. Realtime: prune tool results before they re-enter the model, wired to
 *     the real `session/event` (`tool/result`) surface.
 *  2. Batched: after each `assistant/message`, summarize compressible spans
 *     once the session exceeds `thresholdTokens`.
 *  3. Archive: originals go to an append-only store so `/restore` works.
 *
 * Plus the anti dead-loop guard. `/compact` is left to the built-in
 * `@deepseek-ai/dsh-command-compact`; this plugin adds `/local-compact`,
 * `/su-compact` and `/restore`.
 *
 * @module dsh-compactor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigType } from './config.js'
import { estimateTokens } from './estimator.js'
import { findCompressibleMessages, type CompressibleBlock } from './segmenter.js'
import { pruneToolResult } from './pruner.js'
import { summarizeSegment, type SegmentSummarizer } from './summarizer.js'
import { suSummarizer } from './su.js'
import { loadLocalRules, localSummarizer, type LocalRules } from './local.js'
import { detectPattern } from './patterns.js'
import { ArchiveStore } from './store.js'
import { CompressionMonitor, keywordCoverage, spanText } from './monitor.js'
import { createGuard, type Guard } from './guard.js'
import { appendSurfaceReplacement, findPluginSummaryNodes, hasSurfaceReplace, reappendSurfaceEvent, surfaceToMessages, type SurfaceSessionLike } from './adapter.js'
import { registerCommands } from './commands.js'
import { describeScope, formatCompactionMessage, type BlockReport, type CompactionReport } from './report.js'
import type { HarnessMessage } from './types.js'

export { Config }

declare module '@deepseek-ai/cordis' {
  interface Context {
    compactor: Compactor
  }
}

export interface CompactionDeps {
  /** Override the summarizer (tests inject a fake; default = DeepSeek API or local fallback). */
  summarize?: SegmentSummarizer
  /** Fresh guard factory (tests isolate history). */
  guard?: Guard
  /** Override local rules for /local-compact (default: resolved from config/env/package). */
  localRules?: LocalRules
}

/** One compressed block, emitted as the pass walks blocks from last to first. */
export interface CompressedBlockInfo {
  block: CompressibleBlock
  segment: HarnessMessage[]
  summaryMessage: HarnessMessage
}

/** Options for a compaction pass. */
export interface CompressOptions {
  /** Skip a block entirely (e.g. exempt tools). */
  skipBlock?: (segment: HarnessMessage[]) => boolean
  /** Extra metadata stamped on each summary message (e.g. `{ local: true }`). */
  extraMeta?: Record<string, unknown>
  /** Which engine produced the summaries (reported to the user). */
  mode?: 'api' | 'local' | 'su'
  /** Called for each compressed block after its summary is built (order: last to first). */
  onBlock?: (info: CompressedBlockInfo) => void
}

/** One compression pass over a session's projected messages. */
export async function compressMessages(
  messages: HarnessMessage[],
  config: ConfigType,
  summarize: SegmentSummarizer,
  archive: ArchiveStore,
  monitor: CompressionMonitor,
  sessionId: string,
  opts: CompressOptions = {},
): Promise<CompactionReport> {
  const tokensBefore = estimateTokens(messages)
  const mode = opts.mode ?? 'api'
  const empty = (why: string): CompactionReport => ({
    ok: false, sessionId, mode, tokensBefore, tokensAfter: tokensBefore,
    savedTokens: 0, ratio: 0, savedNextCall: 0, blocks: [], avgKeywordCoverage: 1,
    qualityOk: true, message: why,
  })

  const blocks = findCompressibleMessages(messages, config)
  if (blocks.length === 0) return empty('没有可压缩的内容')

  const reports: BlockReport[] = []
  let savedTokens = 0
  let totalCoverage = 0
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b]
    const segment = messages.slice(block.startIdx, block.endIdx + 1)
    if (opts.skipBlock?.(segment)) continue
    const pattern = detectPattern(segment)
    const start = Date.now()

    const summary = await summarize(segment, config, block, messages)
    const entry = archive.append({
      sessionId,
      startIdx: block.startIdx,
      endIdx: block.endIdx,
      reason: block.reason,
      messages: segment,
      tokensBefore: estimateTokens(segment),
    })

    const summaryMessage: HarnessMessage = {
      role: 'system',
      content: `【压缩摘要 · ${pattern}】${summary}`,
      metadata: { compressed: true, archiveId: entry.id, originalLength: segment.length, reason: block.reason, ...(opts.extraMeta ?? {}) },
    }
    messages.splice(block.startIdx, segment.length, summaryMessage)
    opts.onBlock?.({ block, segment, summaryMessage })

    const spanTokensBefore = estimateTokens(segment)
    const tokensAfterSpan = estimateTokens([summaryMessage])
    savedTokens += spanTokensBefore - tokensAfterSpan
    const coverage = keywordCoverage(spanText(segment), summary)
    totalCoverage += coverage
    reports.push({
      reason: block.reason,
      pattern,
      scope: describeScope(segment, block.reason),
      messages: segment.length,
      charsBefore: segment.reduce((a, m) => a + (m.content?.length ?? 0), 0),
      charsAfter: summaryMessage.content?.length ?? 0,
      tokensBefore: spanTokensBefore,
      tokensAfter: tokensAfterSpan,
      tokensSaved: spanTokensBefore - tokensAfterSpan,
      ratio: spanTokensBefore > 0 ? (spanTokensBefore - tokensAfterSpan) / spanTokensBefore : 0,
      keywordCoverage: coverage,
      archiveId: entry.id,
    })
    monitor.record({
      sessionId,
      startIdx: block.startIdx,
      endIdx: block.endIdx,
      tokensBefore: entry.tokensBefore,
      tokensAfter: tokensAfterSpan,
      elapsedMs: Date.now() - start,
      pattern,
      keywordCoverage: coverage,
      archiveId: entry.id,
    })
  }

  if (reports.length === 0) return empty('没有可压缩的内容（其余块均被豁免/跳过）')

  const after = estimateTokens(messages)
  reports.reverse() // process order was end→start; present original order
  const avgKeywordCoverage = totalCoverage / reports.length
  const report: CompactionReport = {
    ok: true,
    sessionId,
    mode,
    tokensBefore,
    tokensAfter: after,
    savedTokens,
    ratio: tokensBefore > 0 ? savedTokens / tokensBefore : 0,
    savedNextCall: savedTokens, // each turn re-sends the history; saving ≈ removed tokens
    blocks: reports,
    avgKeywordCoverage,
    qualityOk: avgKeywordCoverage >= config.qualityThreshold,
    message: '',
  }
  report.message = formatCompactionMessage(report, config.qualityThreshold)
  return report
}

/** Restore every compressed span of a session from the archive. */
export async function restoreMessages(
  messages: HarnessMessage[],
  archive: ArchiveStore,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  const summaryIdx: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system' && m.content?.startsWith('【压缩摘要') && m.metadata?.compressed) {
      summaryIdx.push(i)
    }
  }
  if (summaryIdx.length === 0) return { ok: false, message: '没有可恢复的压缩摘要' }

  let restored = 0
  for (const idx of summaryIdx) {
    const summary = messages[idx]
    const archiveId = summary.metadata?.archiveId as string | undefined
    const entry = archiveId ? archive.get(archiveId) : null
    if (!entry) continue
    messages.splice(idx, 1, ...entry.messages)
    restored++
  }
  if (restored === 0) return { ok: false, message: '存档中找不到对应的原文' }
  return { ok: true, message: `已恢复 ${restored} 段原始消息` }
}

/**
 * The plugin Service. Exposed as `ctx.compactor`; wired to the real dsh event
 * surface (`session/event`) for realtime pruning and batched compaction.
 */
export class Compactor extends Service {
  static inject = ['sessions', 'commands']

  readonly config: ConfigType
  readonly archive: ArchiveStore
  readonly monitor = new CompressionMonitor()
  readonly guard: Guard
  /** Rules for the offline /local-compact path. */
  readonly localRules: LocalRules
  /** How many tool calls the guard hard-cancelled. */
  cancelledCount = 0
  /** Monotonic suffix keeping injected anti-loop message ids unique. */
  private injectSeq = 0
  private readonly summarize: SegmentSummarizer

  constructor(ctx: Context, rawConfig: Partial<ConfigType> = {}, deps: CompactionDeps = {}) {
    super(ctx, 'compactor')
    this.config = resolveConfig(rawConfig)
    this.archive = new ArchiveStore(this.config.archiveDir)
    this.guard = deps.guard ?? createGuard()
    this.summarize = deps.summarize ?? ((segment, cfg) => summarizeSegment(segment, cfg))
    this.localRules = deps.localRules ?? loadLocalRules(this.config.localRulesPath)

    if (this.config.enablePruning) {
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'tool/result') return
        const raw = event.data?.message as { content?: unknown; source?: { name?: string } } | undefined
        const toolName = raw?.source?.name ?? 'tool'
        if (this.config.exemptTools.includes(toolName)) return
        // Prune in place via a best-effort rewrite hook: the durable pruner
        // service (`ctx.toolResultPruner`) is the canonical path in dsh; here
        // we keep the same policy available for hosts without it.
        this.ctx.emit('compactor/tool/prune', { toolName, result: raw })
      })
    }

    // Anti dead-loop guard: observe the durable `tool/call` stream,
    // inject an anti-loop reminder (as injected context) at ≥3 identical
    // calls, and flag cancellation at ≥5. Cancellation enforcement belongs to
    // the host that dispatches the call (dsh's toolRuntime); this plugin
    // records the decision on the event payload for hosts that consult it.
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'tool/call') return
      const data = event.data as { name?: string; arguments?: string }
      const toolName = data?.name ?? ''
      if (this.config.exemptTools.includes(toolName)) return
      let args: unknown = data?.arguments ?? {}
      try {
        args = JSON.parse(String(data?.arguments ?? '{}'))
      } catch {
        /* keep raw string as the identity */
      }
      const decision = this.guard.shouldBlockToolCall(toolName, args)
      if (decision.reminder) this.injectContext(session as unknown as SurfaceSessionLike, `【anti-loop】${decision.reminder}`)
      if (decision.blocked) {
        this.cancelledCount++
        this.injectContext(
          session as unknown as SurfaceSessionLike,
          `【anti-loop】已取消第 ${decision.count} 次重复调用 ${toolName}（参数与之前相同）`,
        )
      }
    })

    // Batched compaction after each completed assistant turn.
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'assistant/message') return
      const messages = surfaceToMessages(session as unknown as SurfaceSessionLike)
      if (estimateTokens(messages) > this.config.thresholdTokens) {
        // Asynchronous, non-blocking; announce the result through dsh logs.
        void this.compactSession(session as unknown as SurfaceSessionLike).then((res) => {
          if (res.ok) this.ctx.logger.info(`[dsh-compactor] ${res.message}`)
        })
      }
    })

    // Periodic scan: cordis4 `ctx.effect` + a plain interval, cleared on disposal.
    ctx.effect(() => {
      const timer = setInterval(() => {
        const sessions = this.ctx.sessions.list() as unknown as SurfaceSessionLike[]
        for (const session of sessions) {
          void this.scanSession(session)
        }
      }, this.config.compressInterval * 1000)
      return () => clearInterval(timer)
    })

    registerCommands(ctx, {
      archive: this.archive,
      restore: (session) => this.restore(session),
      localCompact: (session) => this.localCompactSession(session),
      suCompact: (session) => this.suCompactSession(session),
    })
  }

  /**
   * Inject one synthetic anti-loop context message. Real dsh requires the
   * `user/message` payload to be the message itself plus a `surfaceOp`
   * placement; the legacy mock accepts the same call and reads either shape.
   */
  private injectContext(session: SurfaceSessionLike, text: string): void {
    const s = session as unknown as {
      append?: (
        type: string,
        data: Record<string, unknown>,
        opts?: { surfaceOp: "append" },
      ) => unknown
    }
    // dsh rejects a re-entrant append while a session event is publishing, so
    // defer past this append before adding the synthetic context message.
    queueMicrotask(() => {
      this.injectSeq += 1
      try {
        s.append?.(
          "user/message",
          {
            id: `dsh-compactor-antiloop-${Date.now()}-${this.injectSeq}`,
            role: "user",
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "dsh-compactor" },
          },
          { surfaceOp: "append" },
        )
      } catch (error) {
        this.ctx.logger.warn(`[dsh-compactor] anti-loop inject failed: ${String(error)}`)
      }
    })
  }

  /**
   * Apply a completed compaction pass to the session surface. Test/embedded
   * hosts expose `applyProjection`; a real dsh Session instead receives one
   * durable `surfaceOp: { op: "replace" }` user message per compressed block.
   */
  private applyCompaction(
    session: SurfaceSessionLike,
    nodeSeqs: readonly number[],
    applied: readonly CompressedBlockInfo[],
    projected: HarnessMessage[],
  ): void {
    const applyProjection = (session as { applyProjection?: (m: HarnessMessage[]) => void }).applyProjection
    if (applyProjection) {
      applyProjection(projected)
      return
    }
    if (hasSurfaceReplace(session) === false) return
    for (const { block, summaryMessage } of applied) {
      const shadowedSeqs = nodeSeqs.slice(block.startIdx, block.endIdx + 1)
      if (shadowedSeqs.length === 0) continue
      this.injectSeq += 1
      try {
        appendSurfaceReplacement(
          session,
          shadowedSeqs,
          summaryMessage.content ?? "",
          `dsh-compactor-summary-${Date.now()}-${this.injectSeq}`,
        )
      } catch (error) {
        this.ctx.logger.warn(`[dsh-compactor] surface replace failed: ${String(error)}`)
      }
    }
  }

  /** Project a dsh session to the plugin's message model. */
  project(session: SurfaceSessionLike): HarnessMessage[] {
    return surfaceToMessages(session)
  }

  /** Compact one session via the configured summarizer (API or injected). Returns the full report and applies the projection. */
  async compactSession(session: SurfaceSessionLike): Promise<CompactionReport> {
    const messages = surfaceToMessages(session)
    const res = await compressMessages(messages, this.config, this.summarize, this.archive, this.monitor, session.id, { mode: 'api' })
    if (res.ok) {
      const apply = (session as { applyProjection?: (m: HarnessMessage[]) => void }).applyProjection
      if (apply) apply(messages)
    }
    return res
  }

  /**
   * `/local-compact` backend: offline rule/regex compression, NO API call.
   * Blocks whose tool results are exempt (`exemptTools`) are skipped.
   */
  async localCompactSession(session: SurfaceSessionLike): Promise<CompactionReport> {
    const messages = surfaceToMessages(session)
    const nodeSeqs = [...session.surface.nodes]
    const applied: CompressedBlockInfo[] = []
    const res = await compressMessages(
      messages,
      this.config,
      localSummarizer(this.localRules),
      this.archive,
      this.monitor,
      session.id,
      {
        mode: "local",
        skipBlock: (segment) =>
          segment.some((m) => m.role === "tool" && m.name && this.config.exemptTools.includes(m.name)),
        extraMeta: { local: true },
        onBlock: (info) => applied.push(info),
      },
    )
    if (res.ok && applied.length) this.applyCompaction(session, nodeSeqs, applied, messages)
    return res
  }

  /**
   * `/su-compact` backend: local judgement + LLM semantic summary.
   * Reuses the exact `/local-compact` judgement (`findCompressibleMessages` +
   * `detectPattern` + exempt-tool skip) to locate spans, but summarises each
   * span with the LLM using a guidance prompt that describes the span's
   * intent (what it does / why it matters), not a raw rule list. Reporting and
   * archive/restore reuse `compressMessages` / `formatCompactionMessage`.
   */
  async suCompactSession(session: SurfaceSessionLike): Promise<CompactionReport> {
    const messages = surfaceToMessages(session)
    const nodeSeqs = [...session.surface.nodes]
    const applied: CompressedBlockInfo[] = []
    const res = await compressMessages(
      messages,
      this.config,
      suSummarizer(this.localRules),
      this.archive,
      this.monitor,
      session.id,
      {
        mode: "su",
        skipBlock: (segment) =>
          segment.some((m) => m.role === "tool" && m.name && this.config.exemptTools.includes(m.name)),
        extraMeta: { su: true },
        onBlock: (info) => applied.push(info),
      },
    )
    if (res.ok && applied.length) this.applyCompaction(session, nodeSeqs, applied, messages)
    return res
  }

  /** Timer-scan entry: compact only sessions far above threshold. */
  async scanSession(session: SurfaceSessionLike): Promise<void> {
    const messages = surfaceToMessages(session)
    if (estimateTokens(messages) > this.config.thresholdTokens * 1.5) {
      await this.compactSession(session)
    }
  }

  /** Restore the previous uncompressed state of a session. */
  async restore(session: SurfaceSessionLike): Promise<{ ok: boolean; message: string }> {
    const applyProjection = (session as { applyProjection?: (m: HarnessMessage[]) => void }).applyProjection
    if (applyProjection) {
      const messages = surfaceToMessages(session)
      const res = await restoreMessages(messages, this.archive, session.id)
      if (res.ok) applyProjection(messages)
      return res
    }
    if (hasSurfaceReplace(session) === false) {
      return { ok: false, message: "当前宿主不支持 /restore" }
    }
    const summaries = findPluginSummaryNodes(session)
    if (summaries.length === 0) {
      return {
        ok: false,
        message: "没有可恢复的压缩摘要（/restore 只恢复 /local-compact、/su-compact 造成的压缩，不含 dsh 内置 /compact）",
      }
    }
    let replugged = 0
    for (const summary of summaries) {
      for (const seq of summary.shadowedSeqs) {
        if (reappendSurfaceEvent(session, seq)) replugged += 1
      }
      this.injectSeq += 1
      appendSurfaceReplacement(
        session,
        [summary.seq],
        "【已恢复】/local-compact 或 /su-compact 的压缩已撤销，原文已重新注入会话。",
        `dsh-compactor-restore-${Date.now()}-${this.injectSeq}`,
        "dsh-compactor-restore",
      )
    }
    return { ok: true, message: `已恢复 ${summaries.length} 处压缩，重新注入 ${replugged} 条原始消息` }
  }

  /** Prune a single tool result (testable, policy-based). */
  prune(toolName: string, result: unknown): unknown {
    if (this.config.exemptTools.includes(toolName)) return result
    return pruneToolResult(toolName, result)
  }
}

export default Compactor

// Re-exports used by tests and external tools.
export { estimateTokens } from './estimator.js'
export { findCompressibleMessages, mergeConsecutive } from './segmenter.js'
export { pruneToolResult } from './pruner.js'
export { summarizeSegment } from './summarizer.js'
export { detectPattern } from './patterns.js'
export { keywordCoverage, CompressionMonitor } from './monitor.js'
export { ArchiveStore } from './store.js'
export { createGuard } from './guard.js'
export { surfaceToMessages } from './adapter.js'
export { localSummarizeSegment, loadLocalRules, DEFAULT_LOCAL_RULES, type LocalRules } from './local.js'
