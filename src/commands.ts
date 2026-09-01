/**
 * `/restore` and `/local-compact` commands registered through the real dsh
 * `ctx.commands` service (cordis4).
 *
 * `/compact` stays the dsh built-in (`@deepseek-ai/dsh-command-compact`);
 * `/local-compact` is this plugin's OFFLINE rule/regex-only compaction — no
 * API calls, one explicit user confirmation, `/restore` for recovery.
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
    description: '恢复上一个未压缩状态（dsh-compactor，含 /compact 与 /local-compact 的压缩）',
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
}

export { surfaceToMessages }
