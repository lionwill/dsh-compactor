/**
 * `/restore`, `/local-compact` and `/su-compact` commands registered through
 * the real dsh `ctx.commands` service (cordis4).
 *
 * `/compact` stays the dsh built-in (`@deepseek-ai/dsh-command-compact`);
 * `/local-compact` is this plugin's OFFLINE rule/regex-only compaction — no
 * API calls, one explicit user confirmation, `/restore` for recovery;
 * `/su-compact` reuses the `/local-compact` judgement but summarises each span
 * with the LLM using a guidance prompt that describes the span's intent.
 *
 * @module dsh-compactor/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { ArchiveStore } from './store.js'
import type { SurfaceSessionLike } from './adapter.js'
import { surfaceToMessages } from './adapter.js'

export interface CommandDeps {
  archive: ArchiveStore
  /** Restore the previous uncompressed state of a session. */
  restore: (session: SurfaceSessionLike) => Promise<{ ok: boolean; message: string }>
  /** Offline local-rules compaction of a session (no API calls). */
  localCompact: (session: SurfaceSessionLike) => Promise<{ ok: boolean; message: string }>
  /** Semantic-understanding compaction: local judgement + LLM guidance summary. */
  suCompact: (session: SurfaceSessionLike) => Promise<{ ok: boolean; message: string }>
}

/** The confirmation prompt shown before /local-compact does anything. */
export const LOCAL_COMPACT_WARNING = [
  '⚠️ /local-compact 是【测试与开发中】的本地压缩功能：',
  '- 只使用固定规则 + 正则判断压缩，不调用任何模型 API；',
  '- 压缩质量通常低于 API 摘要，但能节省一部分 token；',
  '- 可能丢失部分信息（长文本、细节、重试记录会被合并/截断）；',
  '- 压缩原文已写入 append-only 归档，如有问题可执行 `/restore` 恢复。',
  '',
  '确认后请输入：/local-compact confirm',
].join('\n')

function sessionOf(invocation: CommandInvocation): SurfaceSessionLike {
  return invocation.agent.session as unknown as SurfaceSessionLike
}

/** Register the /restore and /local-compact commands on the dsh command surface. */
export function registerCommands(ctx: Context, deps: CommandDeps): void {
  ctx.commands.register({
    name: 'restore',
    description: '恢复 /local-compact、/su-compact 造成的压缩（不含 dsh 内置 /compact）',
    handler: async (invocation: CommandInvocation) => {
      const session = sessionOf(invocation)
      const res = await deps.restore(session)
      return res.ok
        ? { kind: 'success' as const, text: `♻️ ${res.message}` }
        : { kind: 'error' as const, text: res.message }
    },
  })

  ctx.commands.register({
    name: 'local-compact',
    description: '本地规则压缩（测试/开发中）：不调 API，仅固定规则+正则；需确认一次',
    input: { hint: 'confirm（首次调用只会展示风险说明，输入 confirm 后才执行）' },
    handler: async (invocation: CommandInvocation) => {
      const arg = invocation.rawInput.trim().toLowerCase()
      const session = sessionOf(invocation)

      // Step 1: no (or unknown) confirmation token → show the warning, do NOT compress.
      if (arg !== 'confirm' && arg !== 'yes' && arg !== 'y' && arg !== '确认') {
        return { kind: 'success' as const, text: LOCAL_COMPACT_WARNING }
      }

      // Step 2: user confirmed → run offline local compaction.
      const res = await deps.localCompact(session)
      if (!res.ok) return { kind: 'error' as const, text: res.message }
      return {
        kind: 'success' as const,
        text: `🧰 [本地规则压缩 · 测试与开发中]\n${res.message}\n如对结果不满意，执行 /restore 可完整恢复原文。`,
      }
    },
  })

  ctx.commands.register({
    name: 'su-compact',
    description: '语义理解压缩：先做本地规则判断，再把“这段在做什么/为什么重要”的意图喂给 LLM 生成摘要',
    handler: async (invocation: CommandInvocation) => {
      const session = sessionOf(invocation)
      const res = await deps.suCompact(session)
      if (!res.ok) return { kind: 'error' as const, text: res.message }
      return {
        kind: 'success' as const,
        text: `🧠 [语义理解压缩 · su-compact]\n${res.message}\n如对结果不满意，执行 /restore 可完整恢复原文。`,
      }
    },
  })

}

export { surfaceToMessages }
