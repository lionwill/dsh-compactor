/**
 * Local, rule-based segment summarizer — ZERO API calls, ZERO extra deps.
 *
 * Powers `/local-compact`: deterministic fixed rules + regex to collapse a
 * compressible segment into a compact summary. Quality is below the LLM path
 * but it saves tokens without network. Originals still go to the append-only
 * archive, so `/restore` works the same.
 *
 * Rules live in `local-rules.json` at the package root and may be overridden
 * via `config.localRulesPath` or `$DSH_COMPACTOR_RULES`.
 *
 * @module dsh-compactor/local
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import type { HarnessMessage } from './types.js'
import { detectPattern, type ConversationPattern } from './patterns.js'

export interface WebSearchRule {
  keepTopResults: number
  relevanceField: string
  titleField: string
  urlField: string
  linkField: string
  dropFields: string[]
}
export interface ReadFileRule { headLines: number; tailLines: number }
export interface CodeExecutionRule { maxStdoutLines: number; maxStderrLines: number; errorPattern: string }

export interface LocalRules {
  maxSummaryChars: number
  maxKeptSentences: number
  userLineMaxChars: number
  callArgsMaxChars: number
  fallback: { headChars: number; tailChars: number }
  toolRules: {
    web_search: WebSearchRule
    read_file: ReadFileRule
    code_execution: CodeExecutionRule
  }
  patternRules: {
    research_chain: { mergeUrls: boolean; maxMergedUrls: number }
    code_debug: { attemptPattern: string; keepLast: boolean }
  }
}

/** Built-in defaults (same shape as local-rules.json). */
export const DEFAULT_LOCAL_RULES: LocalRules = {
  maxSummaryChars: 1200,
  maxKeptSentences: 8,
  userLineMaxChars: 200,
  callArgsMaxChars: 80,
  fallback: { headChars: 300, tailChars: 160 },
  toolRules: {
    web_search: {
      keepTopResults: 5,
      relevanceField: 'relevance_score',
      titleField: 'title',
      urlField: 'url',
      linkField: 'link',
      dropFields: ['snippet', 'description'],
    },
    read_file: { headLines: 20, tailLines: 5 },
    code_execution: {
      maxStdoutLines: 30,
      maxStderrLines: 10,
      errorPattern: 'error|exception|failed|failure|traceback|panic|错误|失败|异常|报错',
    },
  },
  patternRules: {
    research_chain: { mergeUrls: true, maxMergedUrls: 8 },
    code_debug: { attemptPattern: '第\\s*\\d+\\s*次|attempt\\s+\\d+|retry|重试|再次', keepLast: true },
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursive merge of `src` onto `target` (arrays/primitives replace). */
export function deepMerge<T extends object>(target: T, src: Record<string, unknown>): T {
  const out = { ...target } as Record<string, unknown>
  for (const [k, v] of Object.entries(src)) {
    const prev = out[k]
    if (isPlainObject(prev) && isPlainObject(v)) out[k] = deepMerge(prev as object, v)
    else out[k] = v
  }
  return out as T
}

/** Candidate package-root rules files, tried in order (works for lib/ and src/). */
function packageRulesCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [
    path.join(here, '..', '..', 'local-rules.json'), // lib/src → package root
    path.join(here, '..', 'local-rules.json'), // src → package root
  ]
}

/**
 * Load rules: built-in defaults ← package local-rules.json ←
 * $DSH_COMPACTOR_RULES ← `configPath` (later wins). A missing optional file is
 * skipped; a provided `configPath` that fails throws (explicit = loud).
 */
export function loadLocalRules(configPath?: string): LocalRules {
  let rules: LocalRules = structuredClone(DEFAULT_LOCAL_RULES)
  const layer = (file: string): boolean => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      if (isPlainObject(parsed)) {
        rules = deepMerge(rules, parsed)
        return true
      }
    } catch (err) {
      if (configPath && file === path.resolve(configPath)) {
        throw new Error(`dsh-compactor: cannot load rules file ${file}: ${(err as Error).message}`)
      }
    }
    return false
  }
  for (const p of packageRulesCandidates()) {
    if (fs.existsSync(p)) { layer(p); break }
  }
  const envPath = process.env.DSH_COMPACTOR_RULES
  if (envPath) layer(path.resolve(envPath))
  if (configPath) layer(path.resolve(configPath))
  return rules
}

// ---------------------------------------------------------------------------
// Deterministic text helpers
// ---------------------------------------------------------------------------

/** CJK-safe sentence splitter (same semantics as segmenter.isRepetitive). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])|(?<=[.])\s+(?=[A-Z\u4e00-\u9fff])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Collapse consecutive duplicate sentences into one with a ×n marker. */
export function dedupeSentences(sentences: string[]): { out: string[]; collapsed: number } {
  const units: { text: string; count: number }[] = []
  let collapsed = 0
  for (const s of sentences) {
    const last = units[units.length - 1]
    if (last !== undefined && last.text === s) {
      last.count += 1
      collapsed++
    } else {
      units.push({ text: s, count: 1 })
    }
  }
  return {
    out: units.map((u) => (u.count > 1 ? `${u.text}（重复×${u.count}）` : u.text)),
    collapsed,
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 8) return text
  return `${text.slice(0, head)}…（中略 ${text.length - head - tail} 字）…${text.slice(text.length - tail)}`
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tool-result rules
// ---------------------------------------------------------------------------

function summarizeWebSearch(content: string, rule: WebSearchRule, urls: Set<string>, mergeUrls: boolean): string {
  const parsed = tryParseJson(content)
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? ((parsed as { items: unknown[] }).items)
      : null
  if (!items) return `web_search（非结构化结果）：${headTail(content, 160, 60)}`
  const scored = items.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>
    const rel = typeof o[rule.relevanceField] === 'number' ? (o[rule.relevanceField] as number) : 1
    return { o, rel }
  })
  scored.sort((a, b) => b.rel - a.rel)
  const kept = scored.slice(0, Math.max(0, rule.keepTopResults))
  const titles = kept
    .map(({ o }) => {
      const title = String(o[rule.titleField] ?? '')
      const url = String(o[rule.urlField] ?? o[rule.linkField] ?? '')
      if (mergeUrls && url) urls.add(url)
      return title ? (mergeUrls ? title : `${title} <${url}>`) : url
    })
    .filter(Boolean)
  return `web_search ${items.length} 条结果，保留 top ${kept.length}：` + titles.join('；')
}

function summarizeReadFile(content: string, rule: ReadFileRule): string {
  const parsed = tryParseJson(content) as { filename?: string; path?: string; content?: string } | null
  const file = parsed?.filename ?? parsed?.path ?? '(file)'
  const body = typeof parsed?.content === 'string' ? parsed.content : content
  const lines = body.split('\n')
  if (lines.length <= rule.headLines + rule.tailLines + 2) {
    return `读取 ${file}（${lines.length} 行）`
  }
  const removed = lines.length - rule.headLines - rule.tailLines
  return `读取 ${file} 共 ${lines.length} 行，前 ${rule.headLines} 行 + 后 ${rule.tailLines} 行（中略 ${removed} 行）:\n${lines.slice(0, rule.headLines).join('\n')}\n…\n${lines.slice(-rule.tailLines).join('\n')}`
}

function summarizeCodeExecution(content: string, rule: CodeExecutionRule): string {
  const parsed = tryParseJson(content) as { exit_code?: number; exitCode?: number; stdout?: string; stderr?: string } | null
  const exit = parsed?.exit_code ?? parsed?.exitCode ?? 0
  const errRe = new RegExp(rule.errorPattern, 'i')
  const stdoutLines = String(parsed?.stdout ?? '').split('\n').filter(Boolean)
  const stderrLines = String(parsed?.stderr ?? '').split('\n').filter(Boolean)
  const stdErr = stdoutLines.filter((l) => errRe.test(l)).slice(0, rule.maxStdoutLines)
  const stderrKeep = (stderrLines.filter((l) => errRe.test(l)).slice(0, rule.maxStderrLines).length > 0
    ? stderrLines.filter((l) => errRe.test(l))
    : stderrLines
  ).slice(0, rule.maxStderrLines)
  const parts = [`code_execution exit=${exit}（stdout ${stdoutLines.length} 行）`]
  if (stdErr.length) parts.push(`错误行:\n${stdErr.join('\n')}`)
  if (stderrKeep.length) parts.push(`stderr:\n${stderrKeep.join('\n')}`)
  if (!stdErr.length && !stderrKeep.length && stdoutLines.length) parts.push(`stdout 尾部:\n${stdoutLines.slice(-3).join('\n')}`)
  return parts.join('\n')
}

function summarizeToolDefault(content: string, fb: LocalRules['fallback'], name: string): string {
  return `${name}: ${headTail(content, fb.headChars, fb.tailChars)}`
}

// ---------------------------------------------------------------------------
// Segment summarizer (pure, deterministic)
// ---------------------------------------------------------------------------

/** Summarize one segment with fixed rules only. Synchronous on purpose. */
export function localSummarizeSegment(segment: HarnessMessage[], _config: Config, rules: LocalRules): string {
  const pattern: ConversationPattern = detectPattern(segment)
  const lines: string[] = []
  const urls = new Set<string>()
  const attemptRe = pattern === 'code_debug' ? new RegExp(rules.patternRules.code_debug.attemptPattern, 'i') : null

  const assistantLines: string[] = []
  const toolLines: string[] = []
  let debugAttempts = 0

  for (const m of segment) {
    if (m.role === 'user') {
      lines.push(`用户：${clip(String(m.content ?? ''), rules.userLineMaxChars)}`)
    } else if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) {
        lines.push(`调用：${call.function.name}(${clip(String(call.function.arguments ?? ''), rules.callArgsMaxChars)})`)
      }
      const text = String(m.content ?? '')
      if (text.trim().length === 0) continue
      if (attemptRe && attemptRe.test(text)) { debugAttempts++; if (rules.patternRules.code_debug.keepLast) continue }
      const { out } = dedupeSentences(splitSentences(text))
      if (out.length > rules.maxKeptSentences) {
        assistantLines.push(...out.slice(0, rules.maxKeptSentences))
        assistantLines.push(`…（共 ${out.length} 句，保留 ${rules.maxKeptSentences} 句）`)
      } else {
        assistantLines.push(...out)
      }
    } else if (m.role === 'tool') {
      const name = m.name ?? 'tool'
      const content = String(m.content ?? '')
      if (name === 'web_search') toolLines.push(summarizeWebSearch(content, rules.toolRules.web_search, urls, pattern === 'research_chain' && rules.patternRules.research_chain.mergeUrls))
      else if (name === 'read_file') toolLines.push(summarizeReadFile(content, rules.toolRules.read_file))
      else if (name === 'code_execution') toolLines.push(summarizeCodeExecution(content, rules.toolRules.code_execution))
      else toolLines.push(summarizeToolDefault(content, rules.fallback, name))
    }
  }

  if (assistantLines.length) lines.push(`助手要点：\n- ${assistantLines.join('\n- ')}`)
  if (debugAttempts > 0) lines.push(`（此前 ${debugAttempts} 次同类调试尝试已合并省略，保留最后一次结论）`)
  if (toolLines.length) lines.push(`工具结果摘要：\n- ${toolLines.join('\n- ')}`)
  if (urls.size > 0) {
    const kept = [...urls].slice(0, rules.patternRules.research_chain.maxMergedUrls)
    lines.push(`关键链接：\n- ${kept.join('\n- ')}`)
    if (urls.size > kept.length) lines.push(`…（共 ${urls.size} 条链接，保留 ${kept.length} 条）`)
  }

  let summary = lines.join('\n')
  if (summary.length > rules.maxSummaryChars) {
    summary = summary.slice(0, rules.maxSummaryChars) + '\n…（本地摘要达到长度上限被截断）'
  }
  return summary
}

/** Bind rules into the compressMessages-compatible summarizer signature. */
export function localSummarizer(rules: LocalRules) {
  return async (segment: HarnessMessage[], config: Config): Promise<string> => localSummarizeSegment(segment, config, rules)
}
