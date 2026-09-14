/**
 * Plugin configuration (cordis4 native — @deepseek-ai/schemastery).
 * Mirrors the schema defined for cordis4 plugins, using the
 * schemastery `z` API used by every dsh plugin.
 * @module dsh-compactor/config
 */

import z from '@deepseek-ai/schemastery'

export interface Config {
 /** Token threshold that triggers compaction. Default 32768. */
  thresholdTokens: number
 /** Target token count after compaction. Default 8192. */
  targetTokens: number
 /** Periodic scan interval in seconds. Default 300. */
  compressInterval: number
 /** Keep the most recent N rounds untouched. Default 3. */
  retainRecentRounds: number
 /** Model used to summarize segments. Default 'deepseek-chat'. */
  summaryModel: string
 /** Enable realtime tool-result pruning. Default true. */
  enablePruning: boolean
 /** Enable LLM summarization. Default true. */
  enableSummary: boolean
 /** Tools exempt from pruning / compaction. Default ['write','edit','task']. */
  exemptTools: string[]
 /** Keyword retention threshold. Default 0.85. */
  qualityThreshold: number
 /** Glob patterns of files / tools exempt from compaction. */
  exemptPatterns: string[]
 /** Directory for the append-only archive (defaults to DSH_DATA_DIR). */
  archiveDir?: string
 /** Path to the local-rules JSON for /local-compact (default: package local-rules.json). */
  localRulesPath?: string
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Config = {
  thresholdTokens: 32768,
  targetTokens: 8192,
  compressInterval: 300,
  retainRecentRounds: 3,
  summaryModel: 'deepseek-chat',
  enablePruning: true,
  enableSummary: true,
  exemptTools: ['write', 'edit', 'task'],
  qualityThreshold: 0.85,
  exemptPatterns: [],
}

/** schemastery schema, consumed by the cordis4 loader when the plugin is configured. */
export const Config: z<Config> = z.object({
  thresholdTokens: z.number().default(DEFAULT_CONFIG.thresholdTokens).description('触发压缩的 token 阈值'),
  targetTokens: z.number().default(DEFAULT_CONFIG.targetTokens).description('压缩目标 token 数'),
  compressInterval: z.number().default(DEFAULT_CONFIG.compressInterval).description('检查间隔（秒）'),
  retainRecentRounds: z.number().default(DEFAULT_CONFIG.retainRecentRounds).description('最近 N 轮不压缩'),
  summaryModel: z.string().default(DEFAULT_CONFIG.summaryModel).description('摘要用模型'),
  enablePruning: z.boolean().default(DEFAULT_CONFIG.enablePruning).description('开启实时剪枝'),
  enableSummary: z.boolean().default(DEFAULT_CONFIG.enableSummary).description('开启 LLM 摘要'),
  exemptTools: z.array(z.string()).default(DEFAULT_CONFIG.exemptTools).description('豁免的工具'),
  qualityThreshold: z.number().default(DEFAULT_CONFIG.qualityThreshold).description('关键词保留率阈值'),
  exemptPatterns: z.array(z.string()).default(DEFAULT_CONFIG.exemptPatterns).description('豁免文件 glob 模式'),
  archiveDir: z.string().default('').description('原文归档目录（默认 DSH_DATA_DIR/archive）'),
  localRulesPath: z.string().default('').description('/local-compact 规则配置文件路径（默认包内 local-rules.json）'),
})

/** Merge user config with defaults (schemastery validates/coerces when available). */
export function resolveConfig(partial: Partial<Config> = {}): Config {
  const merged = { ...DEFAULT_CONFIG, ...partial }
  if (!merged.archiveDir) delete (merged as { archiveDir?: string }).archiveDir
  if (!merged.localRulesPath) delete (merged as { localRulesPath?: string }).localRulesPath
  return merged
}
