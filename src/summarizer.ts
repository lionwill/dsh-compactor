/**
 * LLM-backed segment summarization.
 *
 * `summarizeSegment()` asks a chat model (default `deepseek-chat`,
 * temperature 0.1) to collapse a segment into its skeleton: user questions,
 * key decisions, important facts/numbers, final conclusions — dropping
 * duplicate calls, irrelevant detail and retry records.
 *
 * The transport is injectable so tests can run fully offline (the sandbox has
 * no API key). When no key is present and no transport is injected, a local
 * extractive fallback keeps the plugin usable and deterministic.
 *
 * @module dsh-compactor/summarizer
 */

import type { Config } from './config.js'
import type { HarnessMessage } from './types.js'
import { detectPattern, patternLabel } from './patterns.js'

/** A summary transport maps a request body to the model's text reply. */
export type SummaryTransport = (body: unknown) => Promise<{ content: string }>

/** Summarizes a segment of messages into a single compact string. */
export type SegmentSummarizer = (segment: HarnessMessage[], config: Config) => Promise<string>

export const SUMMARY_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

const SUMMARY_PROMPT = `请总结以下对话片段要点，保留：用户问题、关键决策、重要事实/数字、最终结论。
删除：重复调用、无关细节、重试记录。
输出为结构化 JSON 数组。`

/** Default transport: real DeepSeek chat completions API. */
export const defaultTransport: SummaryTransport = async (body: unknown) => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('dsh-compactor: DEEPSEEK_API_KEY is not set')
  const res = await fetch(SUMMARY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`dsh-compactor: summary API ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return { content: data.choices?.[0]?.message?.content ?? '' }
}

/** Local extractive fallback: keeps user questions and the longest assistant reasoning, drops tool noise. */
export function localSummarize(segment: HarnessMessage[]): string {
  const userQ = segment.filter((m) => m.role === 'user').map((m) => m.content ?? '').filter(Boolean)
  const assistant = segment.filter((m) => m.role === 'assistant' && m.content)
  const final = assistant[assistant.length - 1]
  const lines: string[] = []
  if (userQ.length) lines.push('用户问题：' + userQ.join(' | '))
  const pattern = patternLabel(detectPattern(segment))
  lines.push(`片段类型：${pattern}`)
  if (final?.content) {
    const tail = final.content.length > 800 ? final.content.slice(0, 800) + '…' : final.content
    lines.push('最终结论：' + tail)
  } else if (assistant.length) {
    const text = (assistant[assistant.length - 1]?.content ?? '').slice(0, 500)
    lines.push('最终结论：' + text)
  }
  return lines.join('\n')
}

/** Serialize a segment into the compact prompt payload the API expects. */
export function buildSummaryRequest(segment: HarnessMessage[], config: Config): unknown {
  return {
    model: config.summaryModel,
    messages: [{
      role: 'user',
      content: `${SUMMARY_PROMPT}\n\n${JSON.stringify(segment)}`,
    }],
    temperature: 0.1,
    max_tokens: 1024,
  }
}

/**
 * Summarize a message segment into a single compact text block.
 *
 * Uses the injected transport when provided; otherwise the DeepSeek API when a
 * key is present; otherwise the local extractive fallback.
 */
export async function summarizeSegment(
  segment: HarnessMessage[],
  config: Config,
  transport?: SummaryTransport,
): Promise<string> {
  if (!config.enableSummary) return localSummarize(segment)
  const useTransport = transport ?? (process.env.DEEPSEEK_API_KEY ? defaultTransport : undefined)
  if (!useTransport) return localSummarize(segment)

  try {
    const body = buildSummaryRequest(segment, config)
    const { content } = await useTransport(body)
    if (!content || !content.trim()) return localSummarize(segment)
    return content.trim()
  } catch (err) {
 // Never let a summarizer failure break the session; fall back locally.
    console.error('[dsh-compactor] summary failed, using local fallback:', (err as Error).message)
    return localSummarize(segment)
  }
}
