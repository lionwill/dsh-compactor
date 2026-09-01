# dsh-compactor

> Language: **English** ｜ [中文（GitHub default）](./README.md)

Context Compaction plugin for DeepSeek Harness (`dsh`). Built natively on cordis4 (ESM), targeting dsh 0.1.2-alpha.3+.

## How it works

In long sessions, the model input consists of the entire message history: user prompts, assistant replies, tool calls and raw tool results. Tool results (search hits, file contents, command output) usually dominate the context, yet most of their detail is useless for later reasoning; repeated tool calls and "car-wheel" looping replies keep inflating the context and can even trigger dead loops.

This plugin operates in three layers **without ever mutating the dsh append-only session log**:

1. **Realtime layer**: as tool results (`tool/result`) enter the event stream they are pruned by fixed policies (search keeps title/link/short snippet; files keep a preview; command output keeps exit code and key lines).
2. **Batched layer**: after each completed assistant turn the plugin estimates the session's token size; once the threshold (default 32768) is exceeded, compressible spans (tool results, verbose replies, repetitive paragraphs, bulk call records) are replaced by a single summary message. Boundaries align with tool-call ↔ tool-result pairs, and the most recent N rounds are never touched.
3. **Archive layer**: replaced originals are first written to an append-only JSONL archive; `/restore` can fully roll back at any time.

An **anti dead-loop guard** observes the `tool/call` stream: when the same tool is called with identical arguments ≥3 times an anti-loop reminder is injected as context; at ≥5 calls a cancellation decision is recorded (`cancelledCount`) plus an in-session notice, for the host toolRuntime to consume.

### Two summarization engines

| Engine | Trigger | Dependencies | Notes |
|--------|---------|--------------|-------|
| API summary | automatic threshold / `ctx.compactor.compactSession()` | `DEEPSEEK_API_KEY` | Calls `deepseek-chat` (temperature 0.1) for skeleton-preserving summaries; falls back to an offline extractive mode automatically when no key is set |
| **Local rules compaction** | `/local-compact` command / `ctx.compactor.localCompactSession()` | **None** (zero network, zero extra deps) | Fixed rules + regex: collapse repeated sentences, keep top-K search hits, head/tail file lines, error-only command output, merged debug attempts, hard summary cap. Requires a one-time user confirmation |

**Both engines emit a structured result report to the user**: every compressed scope listed individually (e.g. "raw tool results — web_search ×2, ~4600 chars original"), per-span and overall compression ratio, tokens before → after, the estimated input-token saving on the next request, whether keyword retention meets the quality bar, and a reminder that `/restore` can undo everything. Automatic compaction writes the same report to dsh logs (`ctx.logger.info`).

## Working model

- All event wiring uses the real dsh interfaces: `session/event` (dispatched by `tool/result` / `assistant/message` / `tool/call`), service injection via `static inject = ['sessions', 'commands']`, config schema via `@deepseek-ai/schemastery`, periodic scans managed by `ctx.effect` lifecycle.
- `/compact` is **not re-registered** (dsh 0.1.2-alpha.3 ships `@deepseek-ai/dsh-command-compact`); this plugin adds `/local-compact` and `/restore`.
- The plugin exposes `ctx.compactor`: `project()` / `compactSession()` / `localCompactSession()` / `restore()` / `prune()`.

### Commands

| Command | Effect |
|---------|--------|
| `/local-compact` | First call only prints the risk notice and asks for confirmation — **nothing is compressed** |
| `/local-compact confirm` | After confirmation, runs offline rules compaction and prints the report (`confirm` / `yes` / `确认` all accepted) |
| `/restore` | Restores the pre-compression originals from the archive (works for both engines) |

### Installation

```bash
# From GitHub (npm runs the `prepare` hook, which compiles automatically)
dsh plugin add "github:<owner>/dsh-compactor#v0.4.0"
# Local development
dsh plugin add "dsh-compactor@file:/path/to/dsh-compactor"
```

## Configuration

`cordis.patch.yml`:

```yaml
plugins:
  dsh-compactor:
    thresholdTokens: 32768   # token threshold that triggers compaction
    targetTokens: 8192       # compaction target token count (reference)
    compressInterval: 300    # periodic scan interval (seconds)
    retainRecentRounds: 3    # most recent N messages are never compressed
    summaryModel: deepseek-chat
    enablePruning: true      # realtime tool-result pruning
    enableSummary: true      # API summarization (auto offline fallback without a key)
    exemptTools: [write, edit, task]   # tools never touched by pruning/guard/local compaction
    qualityThreshold: 0.85   # keyword-retention warning threshold
    # localRulesPath: /path/to/my-rules.json  # optional: custom local-rules file
```

The API engine needs a key: `export DEEPSEEK_API_KEY=sk-...` (without it the API path falls back to the offline extractive summarizer automatically).

### Local rules file (`local-rules.json`)

All rules/regex for `/local-compact` live in `local-rules.json` at the package root. Loading order (deep merge, later wins):
built-in defaults ← package `local-rules.json` ← env `DSH_COMPACTOR_RULES=<path>` ← config `localRulesPath` (a read failure on the explicit path raises).

```jsonc
{
  "maxSummaryChars": 1200,    // hard cap for local summaries (truncated with a marker)
  "maxKeptSentences": 8,      // max sentences kept from verbose replies (dedupe first)
  "userLineMaxChars": 200,    // user question lines kept up to this size (skeleton priority)
  "callArgsMaxChars": 80,     // truncation for tool-call argument lines
  "fallback": { "headChars": 300, "tailChars": 160 },
  "toolRules": {
    "web_search":     { "keepTopResults": 5, "relevanceField": "relevance_score", "titleField": "title", "urlField": "url", "linkField": "link", "dropFields": ["snippet", "description"] },
    "read_file":      { "headLines": 20, "tailLines": 5 },
    "code_execution": { "maxStdoutLines": 30, "maxStderrLines": 10, "errorPattern": "error|exception|failed|traceback|panic|错误|失败|异常|报错" }
  },
  "patternRules": {
    "research_chain": { "mergeUrls": true, "maxMergedUrls": 8 },
    "code_debug":     { "attemptPattern": "第\\s*\\d+\\s*次|attempt\\s+\\d+|retry|重试|再次", "keepLast": true }
  }
}
```

## Possible risks

- **Information loss**: compaction keeps the skeleton and drops detail — snippets, mid-sections of long outputs, and merged repetitive/debug spans will not survive verbatim. Later reasoning that depends on those details may degrade. `/local-compact` is a **test-and-development** rule implementation; its quality is generally below the API engine.
- **Summary quality floor**: when keyword retention falls below `qualityThreshold`, the report flags ⚠️ explicitly — review the result or simply `/restore`.
- **Token estimates are heuristic**: thresholds and report numbers use a CJK-aware estimate (<10% average error vs. gpt-tokenizer) and may differ from billed tokens.
- **Guard cancellation is advisory**: the plugin records the cancellation decision and injects a notice; actually interrupting the tool execution requires the host toolRuntime to consume that decision.
- **Permissions**: plugins run with dsh host privileges. Install only from trusted sources and pin versions.

## Things users should know

- The first `/local-compact` run only asks for confirmation and touches no data. If the result is unsatisfactory, run `/restore` to recover the originals **completely**.
- `/restore` only undoes compressions made **by this plugin** (API summaries and `/local-compact`). Rollback of the dsh built-in `/compact` follows dsh's own semantics.
- Archives default to `$DSH_DATA_DIR/archive/` (or `./.dsh-compactor-archive/` if unset). Ensure the directory is writable and never hand-edit archive files (append-only).
- Tools in `exemptTools` (defaults: `write` / `edit` / `task`) are never pruned, guarded or locally compacted. Do not remove them if your workflow depends on their results.
- Rule file changes take effect without restarting the session: `/local-compact` reloads on every run.
- This plugin does not register `/compact`; it coexists with dsh's built-in compaction command.

## Directory layout

```
dsh-compactor/
├── package.json            # npm manifest (ESM; cordis/schemastery are peerDependencies provided by the dsh host)
├── tsconfig.json           # NodeNext ESM build config (prepare hook compiles on git install)
├── local-rules.json        # /local-compact rules & regex config (standalone file, overridable)
├── cordis.patch.yml        # sample plugin configuration (merged into dsh config)
├── LICENSE                 # MIT
├── README.md               # Chinese documentation (shown first on the GitHub homepage)
├── README.en.md            # this file (English)
└── src/
    ├── index.ts       # Compactor Service: event wiring, compaction pipeline, periodic scan, guard, reporting
    ├── config.ts      # schemastery config schema and defaults
    ├── report.ts      # compaction result report (scopes / ratio / estimated savings / retention / conclusion)
    ├── adapter.ts     # dsh Session (surface.nodes + events) ↔ flat message projection
    ├── estimator.ts   # token estimation (CJK-aware heuristic, injectable real tokenizer)
    ├── segmenter.ts   # compressible-span detection with tool-call↔tool-result boundary alignment, block merging
    ├── pruner.ts      # realtime tool-result pruning policies (web_search/read_file/code_execution/default)
    ├── summarizer.ts  # API summarization call (injectable transport) + offline extractive fallback
    ├── local.ts       # /local-compact rules engine (deterministic, zero network) + rules loading
    ├── patterns.ts    # span pattern detection (research_chain/code_debug/normal_conversation)
    ├── store.ts       # append-only original archive (JSONL, source for /restore)
    ├── monitor.ts     # compaction event monitoring and keyword-retention stats
    ├── guard.ts       # dead-loop guard (identical-call counter: ≥3 reminder / ≥5 cancellation)
    ├── commands.ts    # /restore and /local-compact (two-step confirmation) registration
    ├── events.ts      # cordis4 event type declarations
    └── types.ts       # shared types
```
