/**
 * Realtime tool-result pruning.
 *
 * `pruneToolResult()` is a dispatcher that keeps only the key fields of each
 * tool result before it is fed back to the model. This directly attacks the
 * "tool result bloat" half of the compaction problem (see realtime
 * layer). Rendered faithfully from the
 *
 * @module dsh-compactor/pruner
 */

/** Keep web search results with a relevance score > 0.3 and title + url + 200-char snippet. */
export function pruneWebSearch(result: any): any {
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : []
  return items
    .map((item: any) => ({
      title: item?.title ?? '',
      url: item?.url ?? item?.link ?? '',
      snippet: (item?.snippet ?? item?.description ?? '').slice(0, 200),
      relevance: typeof item?.relevance_score === 'number' ? item.relevance_score : 1,
    }))
    .filter((item: any) => item.relevance > 0.3)
}

/** Keep only filename + size + modified + first 4000 chars preview. */
export function pruneReadFile(result: any): any {
  const content = typeof result?.content === 'string' ? result.content : ''
  return {
    filename: result?.filename ?? result?.path ?? '',
    size: result?.size ?? content.length,
    modified: result?.modified ?? null,
    preview: content.slice(0, 4000) + (content.length > 4000 ? '...' : ''),
  }
}

/** Keep only exit_code + first 1500 chars of stdout + first 250 chars of stderr. */
export function pruneCodeExecution(result: any): any {
  return {
    exit_code: result?.exit_code ?? result?.exitCode ?? 0,
    stdout: (result?.stdout ?? '').slice(0, 1500),
    stderr: (result?.stderr ?? '').slice(0, 250),
  }
}

/** Default: stringify and truncate to 6000 chars. */
export function pruneDefault(result: any): string {
  let text: string
  try {
    text = JSON.stringify(result)
  } catch {
    text = String(result)
  }
  return text.slice(0, 6000)
}

/**
 * Dispatch a tool result to its pruner.
 * @param toolName - name of the executed tool.
 * @param result - raw tool result.
 * @returns the pruned result (object for known tools, string for default).
 */
export function pruneToolResult(toolName: string, result: any): any {
  switch (toolName) {
    case 'web_search':
      return pruneWebSearch(result)
    case 'read_file':
      return pruneReadFile(result)
    case 'code_execution':
      return pruneCodeExecution(result)
    default:
      return pruneDefault(result)
  }
}
