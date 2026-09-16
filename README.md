# dsh-compactor

> 语言 / Language：**中文（GitHub 默认展示）** ｜ [English](./README.en.md)

DeepSeek Harness（`dsh`）的上下文压缩（Context Compaction）插件。 cordis4 原生（ESM），面向 dsh 0.1.2-alpha.3+（已在 dsh 0.1.2-alpha.4、dsh 0.1.3-alpha.1 与 dsh 0.1.5-rc.2 全量实测兼容）。

## 插件原理

长会话中，模型的输入由全部历史消息组成：用户问题、助手回复、工具调用与工具原始结果。工具结果（搜索结果、文件内容、命令输出）往往占上下文的绝大部分，且大部分细节对后续推理无价值；此外重复的工具调用与"车轱辘话"式回复会持续膨胀上下文并诱发循环。

本插件在**不破坏 dsh append-only 会话日志**的前提下做三层处理：

1. **实时层**：工具结果（`tool/result`）进入事件流时按固定策略剪枝（搜索只留标题/链接/短摘要，文件只留预览，命令输出只留退出码与关键行）。
2. **批处理层**：每轮助手回复完成后估算会话 token 量，超过阈值（默认 32768）时，把可压缩片段（工具结果、冗长回复、重复段落、批量调用记录）替换为一条摘要消息；压缩边界自动对齐 tool-call ↔ tool-result 配对点，最近 N 轮永不触碰。
3. **归档层**：被替换的原文先写入 append-only 归档（JSONL），`/restore` 可随时完整还原。

另有**死循环护栏**：观测 `tool/call` 事件流，同一工具以相同参数被调用 ≥3 次注入 anti-loop 提醒上下文，≥5 次记入取消判定（`cancelledCount`）并留下取消说明，供宿主 toolRuntime 消费。

### 两种摘要引擎

| 引擎 | 触发 | 依赖 | 说明 |
|------|------|------|------|
| API 摘要 | 自动阈值 / `ctx.compactor.compactSession()` | `DEEPSEEK_API_KEY` | 调用 `deepseek-chat`（temperature 0.1）做骨架化摘要；无 Key 时自动降级为本地抽取式兜底 |
| **本地规则压缩** | `/local-compact` 命令 / `ctx.compactor.localCompactSession()` | **无**（零网络、零新增依赖） | 固定规则 + 正则：重复句折叠、搜索留 top-K、文件留头尾行、命令只留错误行、调试尝试合并、摘要长度硬上限。需用户确认一次后执行 |

**两种压缩完成后都会向用户输出结构化结果告知**：逐条列出压缩范围（如"工具原始结果（web_search ×2，原文约 4600 字符）"）、每处与整体的压缩比、before→after token、预计下次请求少发的输入 token、关键信息保留率是否达标，并提示可用 `/restore` 回退。自动压缩的结果同样写入 dsh 日志（`ctx.logger.info`）。

## 工作方式

- 事件接线全部使用真实 dsh 接口：`session/event`（按 `tool/result` / `assistant/message` / `tool/call` 分派）、服务注入 `static inject = ['sessions', 'commands']`、配置 schema 用 `@deepseek-ai/schemastery`、定时扫描由 `ctx.effect` 托管生命周期。
- `/compact` **不重复注册**（dsh 0.1.2-alpha.3 起内置 `@deepseek-ai/dsh-command-compact`，已在 0.1.2-alpha.4、0.1.3-alpha.1 与 0.1.5-rc.2 实测可注册）；本插件提供 `/local-compact`、`/su-compact` 与 `/restore`。
  > ⚠️ 纯 `dsh-web-app` profile 默认在 host 平面**禁用** `command-compact`（`disabled: true`），打斜杠看不到 `/compact`。本插件的 bundle patch 会**显式重新启用** `compaction-basic`、`command-compact`、`tool-result-pruner`（在 web-app 之后应用），因此装了这个插件后 `/compact`、`/local-compact`、`/su-compact` 都能调出（已在 dsh 0.1.2-alpha.4、dsh 0.1.3-alpha.1 与 dsh 0.1.5-rc.2 的 web profile 实测：`compact`、`local-compact`、`restore`、`su-compact` 四个命令均在命令面注册）。
- 插件对外暴露 `ctx.compactor`：`project()` / `compactSession()` / `localCompactSession()` / `suCompactSession()` / `restore()` / `prune()`。

### 命令

| 命令 | 作用 |
|------|------|
| `/local-compact` | 首次调用只输出风险说明与确认方式，**不压缩** |
| `/local-compact confirm` | 用户确认后执行本地规则压缩并输出压缩报告（`confirm`/`yes`/`确认` 均可） |
| `/su-compact` | **语义理解压缩**：先做本地规则判断，再把「这段在做什么/为什么重要」的意图喂给 LLM，保留意图+成功策略+最终结论（需 `DEEPSEEK_API_KEY`，无 Key 时自动降级本地抽取） |
| `/restore` | 只恢复 `/local-compact`、`/su-compact` 造成的压缩（不含 dsh 内置 `/compact`）；真实 dsh 上把被遮蔽的原文重新注入会话尾部 |

### 安装

```bash
# 方式 A（推荐，最稳）：本地目录 file: 安装（不涉及 git 构建脚本）
git clone https://github.com/lionwill/dsh-compactor.git
cd dsh-compactor
npm install && npm run build          # lib/ 是构建产物（git 忽略），file: 安装不会自动构建
dsh plugin add "dsh-compactor@file:$PWD"

# 方式 B：从 GitHub 安装（pnpm 会 checkout 后跑 prepare 构建，需 allowBuilds，见下）
dsh plugin add "github:lionwill/dsh-compactor"          # 默认 main 分支
# 若要用固定版本 tag，需先在仓库打上 tag 后再用：
dsh plugin add "github:lionwill/dsh-compactor#v0.4.1"
```

**常见错误排查**

- **`link:github.com/lionwill/dsh-compactor` / `non-existent directory` / `declares no dsh.bundle`**
  → 命令漏了 `github:` 前缀。`dsh plugin add github.com/lionwill/dsh-compactor` 会被 pnpm 当成
  **本地相对路径**（`link:github.com/...`）；该目录不存在，dsh 读不到 `package.json`，于是报
  "declares no dsh.bundle"（**不是**仓库缺该字段）。正确写法：`dsh plugin add "github:lionwill/dsh-compactor"`。
- **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**
  → pnpm ≥10 默认拦截 git 依赖的 `prepare`（编译）脚本。错误信息会打印一个**精确的 `allowBuilds` key**，
  把它原样加进 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 后重跑：
  ```yaml
  allowBuilds:
    "dsh-compactor@git+https://github.com/lionwill/dsh-compactor#<commit>": true
  ```
  key 与 commit 绑定（仓库更新后按最新错误信息替换）；也可写 `dangerouslyAllowAllBuilds: true`
  一次性放开所有依赖构建脚本（有安全取舍）。**裸包名 `dsh-compactor: true` 对 git 依赖不生效（已实测）**。
  最省事是用上面的方式 A（`file:` 本地已构建目录，不涉及 git 构建脚本）。
- **`Could not resolve v0.4.1 to a commit`**
  → 仓库还没打 `v0.4.1` tag；用不带 tag 的 `github:lionwill/dsh-compactor`，或先打 tag。
- **dsh bundle 说明**：本插件 `package.json` 声明了 `dsh.bundle.patch`（指向 `cordis.patch.yml`）。
  dsh 0.1.2-alpha.3+ 只把声明了 `dsh.bundle` 的依赖加入 `dsh.profile.bundles` 作为 profile 层激活。
  `declares no dsh.bundle` 若是因上面两条引起，修好即可。

## 配置方式

`cordis.patch.yml`（dsh bundle patch，YAML 数组，插件包内置已正确配置；用户如需覆盖按 `id` 覆盖即可）：

```yaml
- insert:
    - id: dsh-compactor
      name: dsh-compactor
      config:
        thresholdTokens: 32768   # 触发压缩的 token 阈值
        targetTokens: 8192       # 压缩目标 token 数（参考值）
        compressInterval: 300    # 定时扫描间隔（秒）
        retainRecentRounds: 3    # 最近 N 条消息永不压缩
        summaryModel: deepseek-chat
        enablePruning: true      # 实时层剪枝
        enableSummary: true      # API 摘要（无 Key 时自动降级本地兜底）
        exemptTools: [write, edit, task]   # 豁免工具（剪枝/护栏/本地压缩均跳过）
        qualityThreshold: 0.85   # 关键信息保留率告警阈值
        # localRulesPath: /path/to/my-rules.json  # 可选：本地规则文件路径
```

API 摘要需要密钥：`export DEEPSEEK_API_KEY=sk-...`（不设置则 API 路径自动使用本地抽取式兜底）。

### `/local-compact` 规则文件（`local-rules.json`）

规则/正则全部集中在包根 `local-rules.json`，加载优先级（深合并，后者覆盖前者）：
内置默认 ← 包根 `local-rules.json` ← 环境变量 `DSH_COMPACTOR_RULES=<路径>` ← 配置 `localRulesPath`（显式路径读取失败会报错）。

```jsonc
{
  "maxSummaryChars": 1200,    // 本地摘要硬上限（超出截断并标注）
  "maxKeptSentences": 8,      // 长回复最多保留句数（先去重再截断）
  "userLineMaxChars": 200,    // 用户问题行保留上限（骨架优先保留）
  "callArgsMaxChars": 80,     // 工具调用参数行截断
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

## 可能的风险

- **信息丢失**：压缩是"保留骨架、丢弃细节"的过程。snippet、长输出中段、被合并的重复/调试段落在摘要中不会完整保留；若后续推理依赖这些细节，结果质量可能下降。`/local-compact` 为**测试与开发中的规则实现**，质量通常低于 API 摘要。
- **摘要质量下限**：关键词保留率低于 `qualityThreshold` 时报告会给出 ⚠️ 明示；此时建议核对或直接 `/restore`。
- **token 估算为启发式**：阈值与报告中的 token 数为 CJK-aware 估算（对标 gpt-tokenizer 平均误差 <10%），与真实计费 token 存在偏差。
- **护栏取消是"建议式"**：插件记录取消判定并注入说明；真正中断工具执行需宿主 toolRuntime 消费该判定。
- **权限**：插件以 dsh 宿主权限运行，仅从 GitHub 安装可信来源并 pin 版本。

## 需要用户注意的事项

- `/local-compact` 第一次执行只会要求确认、不会动数据；确认后如不满意，立即执行 `/restore` 可**完整**还原原文。
- `/restore` 只恢复本插件 `/local-compact`、`/su-compact` 造成的压缩；dsh 内置 `/compact` 的 checkpoint（`source.plugin="compact"`）不会被触及。
- 归档写入目录默认为 `$DSH_DATA_DIR/archive/`（无该变量时为 `./.dsh-compactor-archive/`）；请确保目录可写，且不要手工编辑归档文件（append-only）。
- `exemptTools` 中的工具（默认 `write`/`edit`/`task`）不会被剪枝、护栏和本地压缩触碰；如工作流依赖其结果，请勿移除。
- 修改规则文件后无需重启会话：每次执行 `/local-compact` 都会重新读取。
- 本插件**不注册** `/compact`——它是 dsh 内置命令（`@deepseek-ai/dsh-command-compact`），本插件只通过 bundle patch 显式重新启用它，因此不会与 dsh 内置压缩命令产生重复注册。**注意：“不冲突”仅针对 dsh 内置**：若你同时安装的另一个插件也注册 `/compact`（例如第三方 `dsh-compact`），命令面会出现重复注册冲突、`/compact` 会失效。实测中卸载那个与 dsh 内置重复注册 `/compact` 的第三方插件后，本插件 + 内置 `/compact` 即可直接使用；只需保留一个提供 `/compact` 的插件即可。

## 目录结构

```
dsh-compactor/
├── package.json            # npm 包定义（ESM；cordis/schemastery 为 peerDependencies，由 dsh 宿主提供）
├── tsconfig.json           # NodeNext ESM 编译配置（prepare 钩子自动构建）
├── local-rules.json        # /local-compact 规则与正则配置（独立文件，可覆盖）
├── cordis.patch.yml        # 插件配置样例（合并进 dsh 配置）
├── LICENSE / README.md / README.en.md   # 许可与文档（中文默认展示，英文版见 README.en.md）
└── src/
    ├── index.ts       # Compactor Service：事件接线、压缩管线、定时扫描、护栏、结果上报
    ├── config.ts      # schemastery 配置 schema 与默认值
    ├── report.ts      # 压缩结果报告（压缩范围/压缩比/预计节省/保留率/结论文案）
    ├── adapter.ts     # dsh Session（surface.nodes + events）↔ 扁平消息投影
    ├── estimator.ts   # token 估算（CJK-aware 启发式，可注入真实 tokenizer）
    ├── segmenter.ts   # 可压缩片段识别与 tool-call↔tool-result 边界对齐、连续块合并
    ├── pruner.ts      # 实时层工具结果剪枝策略（web_search/read_file/code_execution/默认）
    ├── summarizer.ts  # API 摘要调用（可注入 transport）+ 本地抽取式兜底
    ├── local.ts       # /local-compact 本地规则引擎（确定性、零网络）+ 规则文件加载
    ├── patterns.ts    # 片段模式识别（research_chain/code_debug/normal_conversation）
    ├── store.ts       # append-only 原文归档（JSONL，/restore 数据源）
    ├── monitor.ts     # 压缩事件监控与关键词保留率统计
    ├── guard.ts       # 死循环护栏（同参计数：≥3 提醒 / ≥5 取消判定）
    ├── commands.ts    # /restore 与 /local-compact（两步确认）注册
    ├── events.ts      # cordis4 事件类型声明
    └── types.ts       # 共享类型
```
