# AI 提示词优化（Prompt Optimizer）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在剪贴板酱 Clipchan 里加一条"复制即优化"的路径：把随手复制的文字（或手输的一段话），按使用场景一键改写成可直接粘贴去用的高质量提示词——面向对 AI 提需求、描述事情、写产品/项目介绍、跟朋友聊天这四类真实场景。

**Architecture:** 三层，依赖单向向下。
1. `packages/ai`（新包，纯 TS）：只用 Web 标准 API（`fetch` / `AbortSignal`），**不 import electron，也不 import `node:http` 等宿主 API**（测试里的 fake server 例外，见 Task 2）。内容：`ProviderAdapter` 统一接口 + 三个适配器（openai-compat / anthropic / gemini）、场景与方法论数据、元提示词组装、优化引擎纯函数。
2. `packages/desktop/electron`：主进程持有 API Key 与网络出口，通过 `ai:*` 通道把结果交回渲染层；Key 绝不出主进程。
3. `packages/core`：`ClipchanApi` 类型契约扩展 + 优化面板 UI + 设置页「AI 模型」区。

**Tech Stack:** TypeScript 5.9 / pnpm workspace / vitest 3.2 / Electron 37 / React 18 / Tailwind 3 / better-sqlite3 13。网络请求只用 `fetch`（Electron 主进程内置），**不引入新的运行时依赖**。

**Spec:** 本文件即规格，不依赖任何会话上下文或外部文档——拿到这个文件就能开工。北极星：让 Clipchan 用户把随手复制的文字一键变成按使用场景优化过的高质量提示词，直接粘贴去用。

---

## 0. 给执行者（尤其是没有本项目上下文的 agent）

本仓库**没有** `AGENTS.md` / `CLAUDE.md`，所有约定都在这一节，开工前先读完。

### 0.1 环境前置

```bash
cd <仓库根目录>          # 含 pnpm-workspace.yaml 的那一层
pnpm install            # 必须，否则 tsc/vitest 都跑不起来
pnpm typecheck          # 基线必须 exit 0，非 0 说明环境或分支有问题，先停下来报告
pnpm test               # 基线必须全绿
```

- **包管理器只用 pnpm**。不要用 npm / yarn，会破坏 workspace 链接与 `onlyBuiltDependencies`。
- Node 需 ≥ 22（实测环境 v24.21.0，pnpm 12.11.2）。
- Windows + PowerShell（pwsh）。**不要设 `$ErrorActionPreference='Stop'`**：pnpm 把正常输出写到 stderr，会被当成 NativeCommandError 让整条命令假失败。判断成功只看 `$LASTEXITCODE`。

### 0.2 仓库硬约定（违反会被人打回）

1. **不引新运行时依赖**。HTTP 用全局 `fetch`，不装 axios / openai SDK / @anthropic-ai/sdk。`packages/ai` 的 dependencies 留空。
2. **UI 全中文**，视觉复用 `packages/core/src/ui/SettingsView.tsx` 里的 `Section` / `Row` / `Segmented` / `Toggle` 与 tailwind token，不新造设计语言。
3. **无 jsdom、无 testing-library**。所有 `*.spec.tsx` 只能测纯函数，不得渲染组件（依据：`packages/core/src/ui/App.tsx:86`、`badges.spec.tsx:7` 的注释）。
4. **不假装成功**。未实现/不支持的路径明确抛错（中文），不返回 `undefined`、不返回空数组充数。
5. **每步 TDD**：先写失败测试 → 跑它确认红 → 实现 → 跑绿 → 收口 → 提交。跳步的 PR 会被打回。
6. **通道名是契约**：新增 IPC 顺序固定为 `packages/core/src/types.ts` 的 `ClipchanApi` → `packages/desktop/electron/channels.ts` → `ipc.ts` 处理器表 → `preload.ts` → `preload.spec.ts` 的 `EXPECTED`。漏任何一步 `pnpm smoke:main` 或契约测试会红。
7. **YAGNI**：本计划没写的功能不要顺手加（流式输出、多轮迭代、Key 加密、模型热切换都明确不做）。

### 0.3 git 约定

- 直接在 `main` 上做，不开分支（仓库现状就是如此）。
- 一个 Task 一个 commit，message 用计划里写好的那句（`feat(ai): ...` / `feat(ui): ...`）。
- 不要 `git push`，除非用户明确要求；推之前先 `git fetch` 确认没有他人提交。
- 不要提交：`node_modules/`、`dist/`、`dist-electron/`、`release/`、`_diag_*.jsonl`（工作区里那两个诊断文件与本任务无关，别误加）。

### 0.4 任务依赖图（决定谁能并行）

```
Task 1 ──► Task 2 ──┐
                    ├──► Task 5 ──► Task 6 ──┐
Task 3 ──► Task 4 ──┘                        ├──► Task 8 ──► Task 9
                              Task 7 ◄───────┘
```

- **可并行**：`Task 1+2`（协议层）与 `Task 3+4`（方法论层）互不依赖，可同时开工。
- **必须串行**：Task 5 需要 1-4 全部收口（它 import `@clipchan/ai`）；Task 7 需要 Task 5 的通道先存在；Task 6 与 Task 7 可并行，但两者都改 `App.tsx`，**并行时先约定好各自改哪一段，否则必冲突**。
- **Task 8 必须人来做**：需要真实 API Key，agent 不得编造、不得跳过、不得把 Key 写进任何文件或 commit message。

### 0.5 已踩过的坑（省你半小时）

- `scripts/build-main.mjs` 用**原生 esbuild.exe**（在 `node_modules/.pnpm` 里找），不能用 `node_modules/.bin/esbuild` —— pnpm 没提升 bin，JS 包装会静默失败、退出码 0、无产物。参数必须等号形式（`--bundle`、`--outfile=...`）。
- `tsc -b` 会编译到新加的 `packages/ai`，但**前提是根 `tsconfig.json` 的 `references` 里有它**。忘加 = 那个包完全不参与类型检查（也不会报错，最阴）。
- `packages/desktop/electron/db.ts:323-336` 的 `sanitizeSettings` 是逐键白名单，写白名单外的键会被**静默丢弃**。这就是为什么 Key 与 provider 元数据必须走新加的 KV 访问器。
- 改 `ClipchanApi` 会让三处手写的适配器对象同时报错：`packages/core/src/platform/adapter.ts:19-65`（stub）、`packages/core/src/state/store.spec.ts:41-77`（测试假 adapter）、`packages/mobile/src/platform/mobile-adapter.ts:177`（手机端）。一次改完，别分三次跑 typecheck。

---

## 1. 需求定稿（用户已拍板，不再讨论）

| # | 决策点 | 结论 |
|---|--------|------|
| Q1 | 形态 | 集成进现有 Clipchan 桌面端（不做独立 Web/CLI/插件） |
| Q2 | 优化对象 | **两者都要**：用户提示词 + 系统/角色提示词（system prompt） |
| Q3 | 模型接入 | **多协议**：OpenAI 兼容（自定义 Base URL + Key + 模型名，`/v1/models` 拉列表）+ Anthropic 原生 + Gemini 原生 |
| Q4 | 优化方法 | **内置方法论库 + 元提示词**（离线，无运行时联网取规则） |
| Q5 | 验证方式 | 连通性测试（发测试消息）+ 优化前后同屏对比 |
| — | 场景分类 | 由我设计，用户认可 4 类起：通用对话 / AI 生成 / 产品·项目描述 / 日常交流，可自定义 |

**非目标（本轮不做，别顺手做）：**
- 不做多轮自动迭代优化循环（PromptWizard / SPO 式生成-批判-自进化）——留作后续。
- 不做云端账号与密钥同步。
- `packages/mobile` 本轮不接 AI，只保证 core 结构改动不破坏它的构建。

## 2. 全局约束

- **Key 不出主进程**：渲染进程只传 `providerId`，明文 Key 只在 `electron/` 侧读取与使用；IPC 返回值里绝不回显 Key。
- **不假装成功**：沿用项目既有纪律（`ipc.ts:42` 的 not-implemented 兜底）——未实现的通道明确抛错，不返回 `undefined`。
- **通道名是契约**：新增 IPC 先加到 `packages/core/src/types.ts` 的 `ClipchanApi`，再改 `packages/desktop/electron/channels.ts`，最后在 `ipc.ts` 的处理器表里接上（见 `channels.ts:6` 的注释）。
- **不引新依赖**：HTTP 用全局 `fetch`；不装 axios/openai SDK/@anthropic-ai/sdk。
- **离线可用**：场景数据与方法论规则是编译进包的 TS 数据，无运行时网络请求。
- **每个任务收口**：`pnpm typecheck` 无错 + `pnpm test` 全绿。任务里写明要跑的命令，跑过再勾。
- **UI 中文、沿用现有视觉**：复用 `SettingsView.tsx` 里的 `Section` / `Row` / `Segmented` / `Toggle` 组件与 tailwind token，不新造设计语言。
- **API Key 不进 `Settings` 接口**：`Settings` 会被 `settings:get` 整份回给渲染层。Provider 元数据与 Key 必须走**独立的 KV 访问器**（`Db.getSettingValue` / `setSettingValue`），不经过 `sanitizeSettings` 白名单（见 Task 5 Step 2）。
- **无 jsdom、无 testing-library**：仓库只跑 node 环境 vitest（`App.tsx:86`、`badges.spec.tsx:7` 的注释写死了这条）。所有 `*.spec.tsx` **只能测纯函数**，不得渲染组件。
- **`View` 联合类型有四处，必须同步改**：`state/store.ts:35`、`ui/Sidebar.tsx:33`（内联字面量，不引用 `View`）、`types.ts:93` 的 `NavigateTarget`、`ui/TitleBar.tsx:27` 的标题三元。漏一处 `pnpm typecheck` 就红。

## 3. 四个交付大类（L1）与九个小类（L2）

| 大类 | 小类 | do | verify |
|------|------|----|--------|
| 一、AI 协议接入层 | 1. 协议适配器骨架 | subagent | self |
| | 2. 三协议 fake-server 单测 | subagent | self |
| 二、方法论库与优化引擎 | 3. 场景分类与方法论规则库 | subagent | self |
| | 4. 元提示词与优化引擎 | subagent | self |
| 三、桌面端 UI 集成与持久化 | 5. IPC 主进程桥（含 db KV 访问器） | subagent | self |
| | 6. 设置页 AI 模型配置 | subagent | self |
| | 7. 优化面板 UI（含 items.getText / ai.copyAndPaste） | subagent | self |
| 四、端到端验收与文档 | 8. 真实模型端到端验收 | mixed | dual |
| | 9. 文档更新 | subagent | self |

## 4. Review Focus（规格没写进断言、但真人最容易踩中的失效模式）

1. **用户填了 Base URL 但没填 `/v1`** → 期望：适配器规范化 URL（去尾斜杠、按协议补默认路径），并有一条单测钉住。别让用户对着 404 猜。
2. **拉模型列表的接口不存在或不返回 `data[]`**（部分中转站、Gemini 原生路径不同） → 期望：降级为"手输模型名"而不是报错卡死。
3. **流式响应没做**（本轮明确不做流式） → 期望：优化期间按钮进 loading 且禁用（本轮不做取消通道，只靠 60s 超时兜底）；超时上限明确（默认 60s），超时给中文提示、按钮恢复可点。别让面板假死。
4. **模型返回的不是干净的提示词**（带"好的，这是优化后的提示词："前缀、包在 markdown 代码块里） → 期望：引擎解析层剥壳；解析失败时把原文照实展示 + 提示"模型输出格式异常，可重试"。
5. **系统提示词模式下** → 期望：产出的是角色/约束型 system prompt，不是把用户提示词换个标题。两种模式的模板必须实际不同（单测断言）。
6. **Key 泄漏** → 期望：渲染层拿到的 provider 对象里 Key 是掩码（`sk-…abcd`），完整值只在主进程内存/DB 里。
7. **写进去读不回来**（最容易踩）→ `db.ts:323-336` 的 `sanitizeSettings` 逐键白名单，`setSettings` 写 `aiProviders` 会被静默丢弃、`loadSettings`（`db.ts:554-569`）读回来也会被丢。期望：走新增的 KV 访问器，并有 `db.spec.ts` 用例钉住"写入后读得回"。
8. **加了通道但没人校验** → `preload.spec.ts` 的 `EXPECTED` 表是通道契约的唯一守门人；新通道不进这张表，等于没有契约。

---

### Task 1: 新建 `packages/ai` 包与协议类型

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/tsconfig.json`
- Create: `packages/ai/src/types.ts`（`AiProtocol`、`ProviderConfig`、`ChatMessage`、`AiError`、`ProviderAdapter`、`normalizeBaseUrl`、`toAiError`）
- Create: `packages/ai/src/types.spec.ts`
- Create: `packages/ai/src/index.ts`（本任务只导出 `types.ts` 的公共面）
- Modify: `tsconfig.json`（根 `references` 加 `packages/ai`）

> 跨端类型（`AiProtocol` / `AiProvider` / `AiError` / `OptimizeResult`）**统一在 Task 5 加进 core**，本任务不动 core —— 否则 core 会在 Task 1 就引用还不存在的 ai 包。
> 三个适配器的**实现**在 Task 2，本任务只落包骨架、类型与两个纯函数，保证本任务收口时 `pnpm typecheck` 与 `pnpm test` 都是绿的。

**Interfaces:**
- Produces:
  - `type AiProtocol = 'openai-compat' | 'anthropic' | 'gemini'`
  - `interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }`
  - `interface ProviderConfig { id: string; name: string; protocol: AiProtocol; baseUrl: string; model: string }`（**无 apiKey 字段**，Key 单独由主进程保管）
  - `interface ProviderAdapter {
  chat(cfg: ProviderConfig, key: string, messages: ChatMessage[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  listModels(cfg: ProviderConfig, key: string): Promise<string[]>;
  test(cfg: ProviderConfig, key: string): Promise<{ ok: true; model: string } | { ok: false; error: AiError }>;
}`
  - `interface AiError { kind: 'auth' | 'network' | 'timeout' | 'rate-limit' | 'bad-response' | 'unknown'; status?: number; message: string }`

- [ ] **Step 1: 建包骨架**

`packages/ai/package.json`：`"name": "@clipchan/ai"`、`"type": "module"`、`"main"/"types": "src/index.ts"`、`exports` 指向 `./src/index.ts`，**dependencies 留空**。
`packages/ai/tsconfig.json`：`extends "../../tsconfig.base.json"`、`noEmit: true`、`include: ["src/**/*.ts"]`。
根 `tsconfig.json` 的 `references` 数组追加 `{ "path": "packages/ai" }`。

- [ ] **Step 2: 先写失败的测试（`normalizeBaseUrl` / `toAiError`）**

`packages/ai/src/types.spec.ts` 先落这些断言，此时 `types.ts` 还不存在，跑测试必须是红的：

| 用例 | 断言 |
|------|------|
| openai-compat 补默认路径 | `normalizeBaseUrl('openai-compat', 'https://x.com')` → `'https://x.com/v1'` |
| 去尾斜杠 | `normalizeBaseUrl('openai-compat', 'https://x.com/v1/')` → `'https://x.com/v1'` |
| 已有版本段不重复补 | `normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1')` → 原样（`/v1` 已在） |
| gemini 补 `/v1beta` | `normalizeBaseUrl('gemini', 'https://generativelanguage.googleapis.com')` → 结尾是 `/v1beta` |
| 非法 URL | `normalizeBaseUrl('openai-compat', 'x.com')` → 抛错或返回空串（二选一，测试里写死选定的那一种） |
| 401 翻译 | `toAiError({ status: 401 }, { timeoutMs: 60000 }).kind === 'auth'` |
| 429 翻译 | `toAiError({ status: 429 }, ...).kind === 'rate-limit'` |
| 超时翻译 | `toAiError(new DOMException('aborted', 'TimeoutError'), ...).kind === 'timeout'` |
| 未知异常不裸抛 | `toAiError(new Error('boom'), ...)` 返回 `{ kind: 'unknown', message: 含 'boom' }` |

Run: `pnpm vitest run packages/ai/src/types.spec.ts`
Expected: **红**（模块不存在）。这一步的产出是"测试先红"这件事本身。

- [ ] **Step 3: 写类型与两个纯函数，让测试转绿**

`packages/ai/src/types.ts`：按上面 Interfaces 落类型 + 两个纯函数：
```ts
/** 去掉末尾斜杠；缺省补协议默认路径（Review Focus 1）。 */
export function normalizeBaseUrl(protocol: AiProtocol, raw: string): string
/** 把任意异常翻译成 AiError，绝不裸抛（约束：错误路径结构化）。 */
export function toAiError(e: unknown, ctx: { timeoutMs: number }): AiError
```
`packages/ai/src/index.ts`：`export * from './types';`（后续任务逐行追加导出）。

Run: `pnpm vitest run packages/ai/src/types.spec.ts`
Expected: 全绿。

- [ ] **Step 4: 收口检查**

Run: `pnpm typecheck`
Expected: 无错误；`packages/ai` 被 `tsc -b` 编译到（已实测：故意写类型错误会让 tsc -b 报 `packages/ai/src/index.ts(...)` 的错）。

Run: `pnpm test`
Expected: 全绿（含新增的 `types.spec.ts`）。

- [ ] **Step 5: 提交**

```bash
git add packages/ai tsconfig.json
git commit -m "feat(ai): 新建 @clipchan/ai 包，协议类型与结构化错误"
```

---

### Task 2: 三个协议适配器（fake-server 驱动）

**Files:**
- Create: `packages/ai/src/adapters/fake-server.ts`（测试用本地 HTTP 服务，**唯一允许 `node:http` 的地方**）
- Create: `packages/ai/src/adapters/request.ts`（`requestJson` 帮助函数 + 状态码映射）
- Create: `packages/ai/src/adapters/openai-compat.ts`
- Create: `packages/ai/src/adapters/anthropic.ts`
- Create: `packages/ai/src/adapters/gemini.ts`
- Create: `packages/ai/src/adapters/index.ts`（`adapterFor(protocol)`）
- Create: `packages/ai/src/adapters/openai-compat.spec.ts`
- Create: `packages/ai/src/adapters/anthropic.spec.ts`
- Create: `packages/ai/src/adapters/gemini.spec.ts`
- Modify: `packages/ai/src/index.ts`（追加 `adapterFor` 导出）

**Interfaces:**
- Consumes: Task 1 的 `ProviderAdapter` / `ProviderConfig` / `ChatMessage` / `AiError` / `normalizeBaseUrl` / `toAiError`
- Produces:
  - `function adapterFor(protocol: AiProtocol): ProviderAdapter`
  - `function startFakeServer(routes: FakeRoutes): Promise<{ url: string; close(): Promise<void>; requests: { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[] }>`，其中 `type FakeRoutes = Record<string, (req: { method: string; path: string; headers: ...; body: string }) => { status: number; body: unknown; delayMs?: number }>`

- [ ] **Step 1: 写 fake server**

用 `node:http` 起服务监听 `127.0.0.1:0`（随机端口），`server.address()` 取端口拼出 `url`；按 `url.pathname` 精确匹配路由表（不匹配回 404）；把每次请求的 `path/method/headers/body` 记进 `requests`，供断言"认证头对不对"。`delayMs` 用 `setTimeout` 延后 `res.end()`，用于超时用例。`close()` 里 `server.close()` 并 `await` 回调，避免 vitest 报句柄泄漏。

- [ ] **Step 2: 写三份失败的适配器测试**

每家一个 spec，各 4 条（此时适配器还不存在，跑起来必须红）：

| # | 用例 | 断言要点 |
|---|------|----------|
| 1 | `chat` 正常 | 返回期望文本；并断言 fake server 收到的 `Authorization`（openai）/ `x-api-key` + `anthropic-version`（anthropic）/ `?key=`（gemini）确实带上了 |
| 2 | `listModels` | 返回模型 id 数组；anthropic 断言打到 `/v1/models`、gemini 断言 `models/` 前缀被剥掉 |
| 3 | 401 | `await expect(...).rejects` 到的 `AiError.kind === 'auth'` |
| 4 | 超时 | `timeoutMs: 50` + `delayMs: 200` → `kind === 'timeout'` |

Run: `pnpm vitest run packages/ai/src/adapters`
Expected: **红**（模块不存在）。

- [ ] **Step 3: 写 `request.ts`**

`requestJson(url, init, timeoutMs)`：`AbortSignal.timeout(timeoutMs)` 合并调用方传入的 `signal`（`AbortSignal.any`，Node 20+ 可用，本项目跑 Node 22+）；状态码映射 401/403→`auth`、429→`rate-limit`、5xx→`network`；JSON 解析失败→`bad-response`；所有抛出统一经 `toAiError`。

- [ ] **Step 4: 写 openai-compat 适配器，让它的 4 条转绿**

`chat` → `POST {base}/chat/completions`，body `{ model, messages }`，取 `choices[0].message.content`（缺失则抛 `bad-response`）。
`listModels` → `GET {base}/models`，取 `data[].id`；**响应里没有 `data` 数组时返回 `[]`**（Review Focus 2：交给 UI 降级为手输，不抛错）。
认证头：`Authorization: Bearer <key>`。

Run: `pnpm vitest run packages/ai/src/adapters/openai-compat.spec.ts`
Expected: 4 条全绿。

- [ ] **Step 5: 写 anthropic 适配器**

`chat` → `POST {base}/v1/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`，body `{ model, max_tokens: 2048, system, messages }`（把 `role: 'system'` 的消息提到顶层 `system` 字段，其余进 `messages`），取 `content[0].text`。
`listModels` → `GET {base}/v1/models`，取 `data[].id`。

Run: `pnpm vitest run packages/ai/src/adapters/anthropic.spec.ts`
Expected: 4 条全绿。

- [ ] **Step 6: 写 gemini 适配器**

`chat` → `POST {base}/v1beta/models/{model}:generateContent?key=<key>`，body `{ contents: [{ role: 'user'|'model', parts: [{ text }] }], systemInstruction? }`，取 `candidates[0].content.parts[0].text`。
`listModels` → `GET {base}/v1beta/models?key=<key>`，取 `models[].name` 并剥掉 `models/` 前缀。

Run: `pnpm vitest run packages/ai/src/adapters/gemini.spec.ts`
Expected: 4 条全绿。

- [ ] **Step 7: 工厂**

`packages/ai/src/adapters/index.ts`：`export function adapterFor(p: AiProtocol): ProviderAdapter`，`switch` 三个分支 + `default` 抛 `unknown protocol`（`never` 收窄，别让缺分支静默返回 `undefined`）。

- [ ] **Step 8: 补一条"降级不抛错"的边界用例**

openai-compat `/models` 返回 `{}` → `listModels` 返回 `[]` 而不抛错（Review Focus 2）。

- [ ] **Step 9: 收口检查**

Run: `pnpm vitest run packages/ai`
Expected: 全绿，用例数 = 3×4 + 1 = **13 条**（Task 1 的 9 条 `types.spec.ts` 另计，合计 22 条）。

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 10: 提交**

```bash
git add packages/ai
git commit -m "feat(ai): 三协议适配器，fake-server 覆盖 chat/models/401/超时"
```

---

### Task 3: 场景分类与方法论规则库

**Files:**
- Create: `packages/ai/src/scenes.ts`
- Create: `packages/ai/src/scenes.spec.ts`

**Interfaces:**
- Produces:
  - `interface Scene { id: string; name: string; description: string; rules: string[]; example?: { input: string; output: string } }`
  - `const BUILTIN_SCENES: Scene[]`（4 条：`general` / `ai-generation` / `product` / `casual`）
  - `function sceneById(id: string, custom?: Scene[]): Scene | undefined`

- [ ] **Step 1: 先写失败测试**

`packages/ai/src/scenes.spec.ts` 先落断言（此时 `scenes.ts` 不存在，必红）：

| 用例 | 断言 |
|------|------|
| 四个内置场景齐全 | `BUILTIN_SCENES.map(s => s.id)` 排序后等于 `['ai-generation','casual','general','product']` |
| 规则够用 | 每条 `rules.length >= 4` |
| id 唯一 | `new Set(ids).size === ids.length` |
| 字段非空 | 每条 `name` / `description` 非空，且 `description` 长度 `>= 10` |
| 有示例 | 每条 `example` 的 `input` / `output` 非空（给 UI 做示例展示） |
| 查得到 | `sceneById('general')?.id === 'general'` |
| 查不到回落 | `sceneById('nope')` → `undefined` |
| 自定义优先 | `sceneById('x', [custom])` 返回 `custom` |
| 离线 | `readFileSync('packages/ai/src/scenes.ts')` 的源码字符串里**不含** `fetch(` 与 `http` |

Run: `pnpm vitest run packages/ai/src/scenes.spec.ts`
Expected: **红**。

- [ ] **Step 2: 落四个内置场景，让测试转绿**

| id | 名称 | 定位 | 规则要点（提炼自 Anthropic/OpenAI 指南、AWS 16 种提示词技术、promptingguide.ai） |
|----|------|------|------|
| `general` | 通用对话 | 对 AI 提需求、问问题 | 明确角色与目标；补足上下文；指定输出格式与长度；要求分步推理时显式写出来；给出成功判据 |
| `ai-generation` | AI 生成 | 文生图 / 文生视频 / 音乐等创作 | 主体 + 场景 + 风格 + 镜头/构图 + 光线 + 画质词；负面提示词单列；参数化可复用；避免互相冲突的风格词 |
| `product` | 产品·项目描述 | 写产品介绍、项目说明、需求文档 | 一句话价值主张；目标用户与痛点；差异化与证据；结构化分段（背景/方案/收益）；去掉形容词堆砌，换成可验证事实 |
| `casual` | 日常交流 | 跟朋友聊、发消息、回邮件 | 语气与关系匹配；长度贴合渠道（微信短、邮件可长）；保留说话人自己的口吻；给 1 个直接可发的版本 |

每条含 `description`（给用户看的一句话）与 `example`（input/output 各一段真实感示例）。场景数据是**纯数据模块**，不 import 任何 node/electron API（离线的源码断言就靠这一点）。

`sceneById` 先查 `BUILTIN_SCENES`，再查 `custom`；找不到返回 `undefined`（调用方回落 `general`）。

`packages/ai/src/index.ts` 追加 `export * from './scenes';`。

Run: `pnpm vitest run packages/ai/src/scenes.spec.ts`
Expected: 9 条全绿。

- [ ] **Step 3: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/ai/src/scenes.ts packages/ai/src/scenes.spec.ts
git commit -m "feat(ai): 四类场景与方法论规则库（离线）"
```

---

### Task 4: 元提示词与优化引擎

**Files:**
- Create: `packages/ai/src/meta-prompt.ts`
- Create: `packages/ai/src/optimize.ts`
- Create: `packages/ai/src/meta-prompt.spec.ts`
- Create: `packages/ai/src/optimize.spec.ts`
- Modify: `packages/ai/src/index.ts`（导出公共面）

**Interfaces:**
- Produces:
  - `type TargetMode = 'user' | 'system'`
  - `function buildMetaPrompt(input: { text: string; scene: Scene; mode: TargetMode; extra?: string }): ChatMessage[]`
  - `function parseOptimized(raw: string): { optimized: string; notes: string[]; degraded: boolean }`
  - `async function optimize(adapter, cfg, key, input): Promise<{ optimized: string; notes: string[]; degraded: boolean }>`

- [ ] **Step 1: 先写两份失败测试**

`packages/ai/src/meta-prompt.spec.ts`（此时 `meta-prompt.ts` 不存在，必红）：

| 用例 | 断言 |
|------|------|
| 结构 | `buildMetaPrompt(...)` 返回 2 条消息，第一条 `role === 'system'` |
| 两模式不同 | 同一 `{ text, scene }` 下 `mode: 'user'` 与 `mode: 'system'` 的 user content **不相等**（Review Focus 5） |
| system 模式语义 | `mode: 'system'` 的 user content 含「角色」「边界」等关键词，且**不含** `input.text` 的完整原文（system prompt 不该复述具体任务） |
| 规则注入 | 两种模式的 prompt 里都逐条出现 `scene.rules` 的每一条 |
| extra 透传 | 传了 `extra` 时它出现在 prompt 里；不传时不出现「undefined」 |
| 格式契约 | 两种模式都要求输出 `<optimized>` 与 `<notes>` 两个标签 |

`packages/ai/src/optimize.spec.ts`：

| 用例 | 断言 |
|------|------|
| 带标签 | `parseOptimized('<optimized>A</optimized><notes>- x</notes>')` → `{ optimized: 'A', notes: ['- x'], degraded: false }` |
| 带围栏 | `parseOptimized('\`\`\`\nA\n\`\`\`')` → `optimized` 为 `'A'`，围栏被剥掉 |
| 裸文本 | `parseOptimized('A')` → `degraded === true`，`notes` 有一条「模型未按格式输出，已直接采用全文」（Review Focus 4） |
| 编排走通 | `optimize(stubAdapter, cfg, 'k', input)` 用 stub 返回固定文本，断言返回结构 + stub 收到的 messages 来自 `buildMetaPrompt` |
| 超时默认值 | stub 断言收到的 `opts.timeoutMs === 60000`（Review Focus 3） |

Run: `pnpm vitest run packages/ai/src/meta-prompt.spec.ts packages/ai/src/optimize.spec.ts`
Expected: **红**。

- [ ] **Step 2: 写元提示词组装，让 meta-prompt 测试转绿**

`buildMetaPrompt` 产出 `[{ role: 'system', content: 优化器角色说明 }, { role: 'user', content: 任务说明 }]`。
- `mode === 'user'`：要求"产出一段可直接发给 AI 的用户提示词，保留用户原意，补足缺失的角色/上下文/输出格式/约束"。
- `mode === 'system'`：要求"产出一段 system prompt：定义角色身份、能力边界、输出规范、拒答策略；不要复述用户的具体任务"。
两者都把 `scene.rules` 逐条注入，并要求输出**严格两段**：先 `<optimized>` 后 `<notes>`（每条改动一行）。

Run: `pnpm vitest run packages/ai/src/meta-prompt.spec.ts`
Expected: 全绿。

- [ ] **Step 3: 写解析层（剥壳）**

`parseOptimized`：
1. 若含 `<optimized>` 标签 → 按标签切分（`<notes>` 缺失时 `notes = []`）。
2. 否则若整体被 ```…``` 包裹 → 剥掉围栏，`degraded = false`。
3. 否则整段当 `optimized`，`degraded = true`（Review Focus 4），`notes` 给一条"模型未按格式输出，已直接采用全文"。

- [ ] **Step 4: 写 optimize 编排**

`optimize` = `buildMetaPrompt` → `adapter.chat` → `parseOptimized`。超时默认 60s（Review Focus 3），`AbortSignal` 透传；`adapter.chat` 抛出时**不吞异常**，原样上抛（由主进程统一 `toAiError` 结构化）。

`packages/ai/src/index.ts` 追加 `export * from './meta-prompt'; export * from './optimize';`。

Run: `pnpm vitest run packages/ai`
Expected: 全绿。

- [ ] **Step 5: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/ai
git commit -m "feat(ai): 元提示词双模式与优化引擎"
```

---

### Task 5: IPC 主进程桥

**Files:**
- Modify: `packages/core/src/types.ts`（`ClipchanApi` 加 `ai` 段；新增 `AiProtocol` / `AiProvider` / `AiProviderInput` / `AiError` / `OptimizeResult` / `OptimizeRequest`）
- Modify: `packages/core/src/platform/adapter.ts`（`:19-65` 的 `stub: PlatformAdapter` 必须补 `ai` 段，否则非 Electron 环境直接 typecheck 红）
- Modify: `packages/core/src/state/store.spec.ts`（`:41-77` 的假 `adapter: ClipchanApi` 也要补 `ai` 段，同理）
- Modify: `packages/mobile/src/platform/mobile-adapter.ts`（**必须同步**：`:177` 的 `const adapter: PlatformAdapter = {...}` 少 `ai` 段 typecheck 就红）
- Modify: `packages/desktop/electron/db.ts`（新增独立 KV 访问器 `getSettingValue` / `setSettingValue`，绕过 `sanitizeSettings` 白名单）
- Modify: `packages/desktop/electron/db.spec.ts`（KV 存取用例）
- Modify: `packages/desktop/electron/channels.ts`（`CH.ai` + `EV.aiChanged` + `ALL_INVOKE_CHANNELS`）
- Modify: `packages/desktop/electron/ipc.ts`（`makeBroadcaster` 加 `aiChanged()`）
- Modify: `packages/desktop/electron/preload.ts`（`ai` 方法）
- Modify: `packages/desktop/electron/preload.spec.ts`（`EXPECTED` 表加 `ai` 组 7 个方法名）
- Create: `packages/desktop/electron/ai.ts`（provider 增删改查 + Key 存取 + 调用 `@clipchan/ai`）
- Create: `packages/desktop/electron/ai.spec.ts`
- Modify: `packages/desktop/electron/main.ts`（`buildHandlers()` 里接上 `CH.ai.*`）
- Modify: `packages/desktop/package.json`（`"@clipchan/ai": "workspace:*"` 进 dependencies）

**Interfaces:**
- Produces（`ClipchanApi.ai`）:
  ```ts
  ai: {
    listProviders(): Promise<AiProvider[]>;                     // Key 已掩码
    saveProvider(p: AiProviderInput): Promise<AiProvider[]>;     // apiKey 仅上行
    removeProvider(id: string): Promise<AiProvider[]>;
    listModels(id: string): Promise<string[]>;
    test(id: string): Promise<{ ok: boolean; error?: AiError; model?: string }>;
    optimize(req: OptimizeRequest): Promise<OptimizeResult>;
    scenes(): Promise<{ id: string; name: string; description: string }[]>;  // 只投影 id/name/description
    onChanged(cb: () => void): () => void;
  }
  ```

- [ ] **Step 1: 扩 core 类型契约（同时修 mobile 适配器）**

`packages/core/src/types.ts` 加：
```ts
export type AiProtocol = 'openai-compat' | 'anthropic' | 'gemini';
export interface AiError { kind: 'auth' | 'network' | 'timeout' | 'rate-limit' | 'bad-response' | 'unknown'; status?: number; message: string }
export interface AiProvider { id: string; name: string; protocol: AiProtocol; baseUrl: string; model: string; hasKey: boolean; keyMask: string }
export interface AiProviderInput { id?: string; name: string; protocol: AiProtocol; baseUrl: string; model: string; apiKey?: string }
export interface OptimizeRequest { providerId: string; text: string; sceneId: string; mode: 'user' | 'system'; extra?: string }
export interface OptimizeResult { optimized: string; notes: string[]; degraded: boolean }
```
`ClipchanApi` 加 `ai` 段（签名见上面 Interfaces）。**core 不 import `@clipchan/ai`**——类型在 core 与 ai 各留一份镜像，由 `ai.spec.ts` 断言两侧字段一致，避免 core→ai 的构建依赖。

**同一个 Step 里必须改两处会因缺 `ai` 段而红的地方**：
1. `packages/mobile/src/platform/mobile-adapter.ts` 的 `:177` 对象字面量 —— 加 `ai` 段，七个方法全部 `async () => { throw new Error('手机端暂不支持 AI 提示词优化'); }`（`onChanged` 返回 `() => {}`）。**不能返回空数组假装成功**。
2. `packages/core/src/platform/adapter.ts` 的 `:19-65` `stub` —— 同样七方法全部 `() => Promise.reject(new Error(notAvailable('AI 提示词优化')))`（沿用 `:13` 的 `notAvailable`），`onChanged` 返回 `unsubscribe`。

顺带：`packages/core/src/state/store.spec.ts:41-77` 里手写的 `const adapter: ClipchanApi = {...}` 也补 `ai` 段（七个方法给 `jest` 无关的普通 async 桩即可，`onChanged: () => () => {}`），否则 `pnpm test` 之前的 typecheck 会先红。

Run: `pnpm typecheck`
Expected: 无错误（漏改任一处会报 `Type '{...}' is missing the following properties from type 'ClipchanApi': ai`）。

- [ ] **Step 2: db.ts 加独立 KV 访问器**

`db.ts` 的 `Db` 接口（`:151-170`）加两个方法，并实现：

```ts
/** 读任意 settings 表键的原始 JSON；不存在返回 undefined。不走 sanitizeSettings 白名单。 */
getSettingValue<T = unknown>(key: string): T | undefined;
/** 写任意 settings 表键（JSON 序列化）。不走 sanitizeSettings 白名单。 */
setSettingValue(key: string, value: unknown): void;
```
实现要点：直接查 `settings` 表，**不要**复用 `getSettings` / `setSettings`（那两个受 `:323-336` 的白名单限制，写进去读不回来，见 Review Focus 7）。

`db.spec.ts` 加 3 条用例（先写，跑红，再实现）：
1. `setSettingValue('aiProviders', [{...}])` 后 `getSettingValue('aiProviders')` 深相等
2. `setSettingValue('aiKey:p1', 'sk-abc')` 后读回 `'sk-abc'`；且 `getSettings()` 的返回对象里**没有** `aiKey:p1` 与 `aiProviders` 键（Key 不进 `settings:get` 的载荷）
3. 读不存在的键返回 `undefined`，不抛

- [ ] **Step 3: 加通道名与事件名**

`channels.ts` 的 `CH` 加：
```ts
ai: {
  listProviders: 'ai:listProviders',
  saveProvider: 'ai:saveProvider',
  removeProvider: 'ai:removeProvider',
  listModels: 'ai:listModels',
  test: 'ai:test',
  optimize: 'ai:optimize',
  scenes: 'ai:scenes',
},
```
`EV` 加 `aiChanged: 'ai:changed'`（注意 `:50-56` 的"事件名不得与 invoke 通道重名"断言）。把 `...Object.values(CH.ai)` 加进 `ALL_INVOKE_CHANNELS`（`--smoke` 断言靠它）。`ipc.ts` 的 `makeBroadcaster`（`:80-93`）加 `aiChanged: () => send(EV.aiChanged)`。

- [ ] **Step 4: 主进程 ai.ts**

- Provider 元数据存 KV 键 `aiProviders`（JSON 数组，**不含 Key**）。
- Key 单独存 KV 键 `aiKey:<providerId>`（本轮不加密，但**绝不出主进程**；README 如实说明）。
- `listProviders` 返回掩码：`keyMask = key.slice(0,3) + '…' + key.slice(-4)`（长度 <8 时返回 `'••••'`），`hasKey` 布尔；**返回对象里不得出现 `apiKey` 字段**。
- `saveProvider`：有 `apiKey` 就写 Key，没传就保留原 Key（编辑时不清空）；返回 `listProviders()` 的掩码结果。
- `optimize` 在渲染层传入的 `providerId` 上取 Key，调 `@clipchan/ai` 的 `optimize`，返回 `OptimizeResult`；任何异常经 `toAiError` 结构化后抛给渲染层。
- `scenes` 通道返回 `BUILTIN_SCENES` 的投影 `{ id, name, description }[]`（**不把 rules 发给渲染层**，渲染层用不上，减少契约面）。

`ai.ts` 必须能被 `ai.spec.ts` 单测：依赖通过参数注入（`{ kv, adapterFor, optimize }`），不在模块顶层直接 `import { app } from 'electron'`。

- [ ] **Step 5: preload 接线**

按现有写法（`preload.ts:21-64` 模式）逐方法 `ipcRenderer.invoke(CH.ai.xxx, ...)`；`onChanged` 用 `ipcRenderer.on(EV.aiChanged)` 并返回取消函数（照 `:13-17` 的 `on` 帮助函数）。

**同步改 `preload.spec.ts` 的 `EXPECTED`**：加 `ai: ['listProviders','saveProvider','removeProvider','listModels','test','optimize','scenes']`。这一步不改，契约测试不会覆盖新通道（Review Focus 8）。

- [ ] **Step 6: main.ts 接处理器表**

在 `buildHandlers()`（`main.ts:352`）里加七条 `[CH.ai.xxx]: (...) => ...`，与既有 `CH.settings.get`（`:406`）同风格。未配置任何 provider 时 `optimize` 抛中文错误「请先在设置里添加 AI 模型」，不返回 `undefined`。

- [ ] **Step 7: 测试**

`ai.spec.ts`（注入假 kv + 假 adapter）：
- `ALL_INVOKE_CHANNELS` 含全部 `CH.ai.*`；`EV.aiChanged` 不在其中
- `listProviders` 返回对象**不含 `apiKey` 字段**，且 `JSON.stringify(result)` 不含完整 Key（Review Focus 6）
- `saveProvider` 不传 `apiKey` 时保留原 Key
- `optimize` 在无 provider 时抛中文错误
- 镜像类型不漂移：ai 包 `ProviderConfig` 的五个字段（`id`/`name`/`protocol`/`baseUrl`/`model`）**全部存在于** core 的 `AiProvider` 里（后者多 `hasKey`/`keyMask` 两个只在渲染层用的派生字段）

- [ ] **Step 8: 收口检查**

Run: `pnpm typecheck && pnpm test && pnpm smoke:main`
Expected: 全绿；smoke 报通道一个都没漏（`registeredChannels().length === ALL_INVOKE_CHANNELS.length`）。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/platform/adapter.ts packages/core/src/state/store.spec.ts packages/mobile/src/platform/mobile-adapter.ts packages/desktop
git commit -m "feat(desktop): ai IPC 主进程桥，密钥不出主进程"
```

---

### Task 6: 设置页「AI 模型」区

**Files:**
- Create: `packages/core/src/ui/aiProviderForm.ts`（纯函数与常量：`validateProvider`、`DEFAULT_BASE_URL`、`aiErrorMessage`）
- Create: `packages/core/src/ui/aiProviderForm.spec.ts`（**纯函数测试**，不是 `.spec.tsx`——无 jsdom，见 §2 约束）
- Create: `packages/core/src/ui/AiProviderForm.tsx`（表单组件，**不写渲染测试**）
- Modify: `packages/core/src/ui/SettingsView.tsx`（新增 props + 一个 `<Section title="AI 模型">`）
- Modify: `packages/core/src/ui/App.tsx`（把 `ai.*` 接成 SettingsView 的回调）
- Modify: `packages/core/src/ui/index.ts`（导出 `AiProviderForm` 与 `aiProviderForm.ts` 的公共面）

**Interfaces:**
- Consumes: 由 `App.tsx` 注入的回调（组件**不直接** `getPlatform()`，与 `SettingsView` 现有 props 驱动风格一致）
- Produces:
  - `function validateProvider(input: AiProviderInput): string[]`（返回中文错误列表，空数组 = 通过）
  - `const DEFAULT_BASE_URL: Record<AiProtocol, string>`（`openai-compat: 'https://api.openai.com/v1'`、`anthropic: 'https://api.anthropic.com'`、`gemini: 'https://generativelanguage.googleapis.com'`）
  - `function aiErrorMessage(e: unknown): string`（把 `AiError.kind` 映射成中文：`auth` → 「鉴权失败，请检查 API Key」、`network` → 「网络连接失败」、`timeout` → 「请求超时（60 秒）」、`rate-limit` → 「请求过于频繁，稍后再试」、`bad-response` → 「模型返回格式异常」、`unknown` → 原 message）
  - `AiProviderForm({ provider?, onSave, onRemove, onTest, onListModels, onCancel })`

- [ ] **Step 1: 先写 `aiProviderForm.spec.ts`（跑红）**

```ts
// 断言（此时 aiProviderForm.ts 不存在，必红）
validateProvider({ name: '', protocol: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'gpt-4o' })
  // → 长度 > 0，且含「名称」
validateProvider({ name: 'x', protocol: 'openai-compat', baseUrl: 'x.com', model: 'gpt-4o' })
  // → 含「http」
validateProvider({ name: 'x', protocol: 'openai-compat', baseUrl: 'https://x.com/v1', model: '' })
  // → 含「模型」
validateProvider({ name: 'x', protocol: 'openai-compat', baseUrl: 'https://x.com/v1', model: 'gpt-4o' })
  // → 空数组
aiErrorMessage({ kind: 'auth', message: 'whatever' })  // → 含「API Key」
aiErrorMessage({ kind: 'timeout', message: 'whatever' })  // → 含「超时」
```

Run: `pnpm vitest run packages/core/src/ui/aiProviderForm.spec.ts`
Expected: **红**（模块不存在）。

- [ ] **Step 2: 写 `aiProviderForm.ts`，让测试转绿**

`validateProvider` 四条规则：① `name.trim()` 非空；② `baseUrl` 必须 `/^https?:\/\//` 且 `new URL()` 不抛；③ `model.trim()` 非空；④ `protocol` 必须是三个枚举之一（防御渲染层传脏值）。
`aiErrorMessage` 只做 `kind → 中文` 的纯映射，**不改** `AiError` 本身（结构化错误由 `@clipchan/ai` 产出）。

Run: `pnpm vitest run packages/core/src/ui/aiProviderForm.spec.ts`
Expected: 全绿。

- [ ] **Step 3: 写 `AiProviderForm.tsx` 组件**

字段：名称 / 协议（`Segmented`）/ Base URL（占位符用 `DEFAULT_BASE_URL[protocol]`，切换协议时若输入框为空则填入默认值）/ API Key（`type="password"`；`provider.hasKey` 时显示 `provider.keyMask` + 「重新填写」按钮，不填就沿用原 Key）/ 默认模型（文本框 + 「拉取列表」按钮 → `<select>`；`onListModels` 返回空数组或抛错时**降级为纯手输并提示**「没拉到模型列表，可直接手输模型名」，Review Focus 2）。
底部：「发送测试消息」（loading 中禁用；成功显示 `模型名 可用`；失败显示 `aiErrorMessage`）/「保存」/「取消」。
校验失败时把 `validateProvider` 的返回逐条列在按钮上方，不发请求。

- [ ] **Step 4: 挂进设置页**

`SettingsView.tsx` 的插入锚点：**「小组件」`Section` 的闭合 `</Section>`（`:300`）之后、「数据」`<Section title="数据">`（`:302`）之前**，插 `<Section title="AI 模型">`。
Section 内容：provider 列表（每行：名称 + 协议徽标 + 模型 + 「测试」「编辑」「删除」）+ 「添加模型」按钮（展开 `AiProviderForm`）。
`SettingsView` 新增 5 个 props：`aiProviders: AiProvider[]`、`onAiSave`、`onAiRemove`、`onAiTest`、`onAiListModels`（签名对齐 `ClipchanApi.ai.*`）。
`App.tsx` 里用 `getPlatform().ai.*` 实现这 5 个回调，并在 `ai.onChanged` 时刷新列表（照 `store.ts:507` 的订阅写法，或在 `usePlatformValue` 之外单开一个 `useEffect`）。

- [ ] **Step 5: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（`aiProviderForm.spec.ts` 6 条）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/ui
git commit -m "feat(ui): 设置页 AI 模型配置（拉列表 + 连通性测试）"
```

---

### Task 7: 优化面板 UI

**Files:**
- Modify: `packages/core/src/state/store.ts`（`:35` 的 `View` 加 `'optimize'`；`ClipStoreState` 加 `optimizeSource: string`；`ClipStoreActions` 加 `openOptimize(text: string)` / `closeOptimize()`）
- Modify: `packages/core/src/types.ts`（`:93` 的 `NavigateTarget` 加 `'optimize'`）
- Modify: `packages/core/src/ui/Sidebar.tsx`（`:33` 的 `view` 内联字面量加 `'optimize'`）
- Modify: `packages/core/src/ui/TitleBar.tsx`（`:27` 的标题三元加 `'优化提示词'` 分支）
- Create: `packages/core/src/ui/OptimizeView.tsx`
- Create: `packages/core/src/ui/optimizeView.ts`（纯函数：`degradedHint`、`OPTIMIZE_MODES`）
- Create: `packages/core/src/ui/optimizeView.spec.ts`（**纯函数测试**）
- Modify: `packages/core/src/ui/ClipCard.tsx`（hover 操作区加「优化」按钮，新增 `onOptimize?(id: string): void`）
- Modify: `packages/core/src/ui/ListPanel.tsx`（透传 `onOptimize`）
- Modify: `packages/core/src/ui/App.tsx`（`view === 'optimize'` 分支 + 把 `onOptimize` 接到 store）
- Modify: `packages/core/src/ui/index.ts`（导出 `OptimizeView`、`optimizeView` 公共面）
- Modify: `packages/desktop/electron/db.ts` + `db.spec.ts`（新增 `getText(id)`）
- Modify: `packages/desktop/electron/paste.ts`（新增 `pasteText(text)`，复用既有 writer / tracker / helper）
- Modify: `packages/desktop/electron/channels.ts`（`CH.items.getText`、`CH.ai.copyAndPaste`）
- Modify: `packages/desktop/electron/preload.ts` + `preload.spec.ts`（同步 `EXPECTED`）
- Modify: `packages/desktop/electron/main.ts`（两条新处理器）
- Modify: `packages/mobile/src/platform/mobile-adapter.ts`（`items.getText` / `ai.copyAndPaste` 同样抛中文「手机端暂不支持」）

**Interfaces:**
- Consumes: `ai.scenes()`、`ai.optimize()`、`ai.listProviders()`、`items.getText(id)`、`ai.copyAndPaste(text)`
- Produces:
  - `Db.getText(id: string): string`（`content` 全文；图片行或不存在返回 `''`）
  - `PasteService.pasteText(text: string): Promise<PasteResult>`（写剪贴板 → `touch` 不需要 → 消费 tracker → 按 `autoPaste` / 目标可用性返回 `COPY_ONLY` 或 `helper.paste`，语义与 `pasteItem` 完全一致）
  - `ClipchanApi.items.getText(id: string): Promise<string>`
  - `ClipchanApi.ai.copyAndPaste(text: string): Promise<PasteResult>`
  - `function degradedHint(degraded: boolean): string | null`（`true` → 「模型未按格式输出，已直接采用全文」；`false` → `null`）
  - `const OPTIMIZE_MODES: { key: 'user' | 'system'; label: string }[]`

- [ ] **Step 1: 先写 `optimizeView.spec.ts`（跑红）**

```ts
degradedHint(true)   // → 含「未按格式输出」
degradedHint(false)  // → null
OPTIMIZE_MODES.map(m => m.key)  // → ['user', 'system']
OPTIMIZE_MODES.map(m => m.label) // 两条互不相同且非空
```

Run: `pnpm vitest run packages/core/src/ui/optimizeView.spec.ts`
Expected: **红**。

- [ ] **Step 2: 写 `optimizeView.ts` 转绿**

只放纯函数与常量，组件里不写可测逻辑（无 jsdom，组件不可测——见 §2 约束）。

- [ ] **Step 3: 扩 store 与四处 `View` 字面量**

`store.ts:35` `View` 加 `'optimize'`；`initialState()` 加 `optimizeSource: ''`；`ClipStoreActions` 加 `openOptimize(text)`（`set({ view: 'optimize', optimizeSource: text })`）与 `closeOptimize()`（`set({ view: 'list', optimizeSource: '' })`）。
**同一步**改 `types.ts:93` 的 `NavigateTarget`、`Sidebar.tsx:33` 的内联字面量、`TitleBar.tsx:27` 的标题三元——漏一处 `pnpm typecheck` 就红。

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: 主进程补两条能力（全文读取 + 写剪贴板并粘贴）**

`db.ts` 加 `getText(id)`：`SELECT content, kind FROM items WHERE id = ?`，`kind === 'image'` 或查不到返回 `''`。
`paste.ts` 加 `pasteText(text)`：与 `pasteItem` 的 ②③④⑤⑥ 同构，只是内容来自入参、不查库、不 `touch`（原文不是历史记录）。`text.length === 0` 返回 `SEND_FAILED`。
`channels.ts` 加 `CH.items.getText: 'items:getText'` 与 `CH.ai.copyAndPaste: 'ai:copyAndPaste'`，两者都要进 `ALL_INVOKE_CHANNELS`。
`preload.spec.ts` 的 `EXPECTED`：`items` 数组追加 `'getText'`，`ai` 数组追加 `'copyAndPaste'`（Review Focus 8）。
`main.ts` 接两条处理器；`mobile-adapter.ts` 同签名抛中文「手机端暂不支持」。

Run: `pnpm typecheck && pnpm smoke:main`
Expected: 无错；smoke 报「通道一个都没漏」。

- [ ] **Step 5: 写优化面板 `OptimizeView.tsx`**

布局（沿用 900×620）：
- 顶部工具条：场景下拉（`ai.scenes()` 取，含 `description` 作 `title`）/ 模式 `Segmented`（用 `OPTIMIZE_MODES`）/ 模型下拉（`ai.listProviders()`）/「优化」按钮（loading 中禁用并显示「优化中…」）。
- 主体左右分栏：左「原文」可编辑 `textarea`（初值来自 `optimizeSource`，可清空手输）；右「优化后」只读，loading 期间显示骨架块。
- 底部：`notes` 列表 + 「复制」/「直接粘贴」/「重试」；`degradedHint(degraded)` 非空时显示黄条。
- 失败态：`aiErrorMessage(e)` 的中文 + 「重试」，不白屏；无 provider 时提示「请先在设置里添加 AI 模型」并给「去设置」按钮（`setView('settings')`）。
- 「复制」调 `ai.copyAndPaste(text)` 并复用 `pasteToast(result)`（`toastText.ts:24`）提示；「直接粘贴」同一个通道（`autoPaste` 开且目标可用时自动贴回）。

- [ ] **Step 6: 接入口**

`ClipCard.tsx` 的 hover 操作区（收藏按钮旁）加「优化」按钮，`event.stopPropagation()` 防止触发选中；新增可选 `onOptimize`，`ListPanel` 透传，`App.tsx` 里实现为 `async (id) => { const text = await getPlatform().items.getText(id); useClipStore.getState().openOptimize(text); }`。取不到全文（`''`）时 `toast('这条记录没有可优化的文本', 'warn')`，**不打开空面板**。
`App.tsx` 加 `view === 'optimize'` 分支渲染 `OptimizeView`（与 `:314` 的 settings 分支同构）。

- [ ] **Step 7: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（新增 `optimizeView.spec.ts` 4 条 + `db.spec.ts` 的 `getText` 用例）。

- [ ] **Step 8: 手动冒烟**

Run: `pnpm dev` → 复制一段文字 → 唤出面板 → 悬停卡片点「优化」→ 面板带出全文 → 选场景/模式 → 优化 → 看 `notes` → 点「复制」→ 去别处 Ctrl+V。
Expected: 全流程走通；未配模型时给出「请先在设置里添加 AI 模型」而非白屏。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src packages/desktop packages/mobile/src/platform/mobile-adapter.ts
git commit -m "feat(ui): 优化面板（场景/模式/前后对比/一键粘贴）"
```

---

### Task 8: 真实模型端到端验收

**Files:** 无代码改动（发现问题回到对应 Task 修；**不要在本任务里改代码**）

> 前置：Task 1-7 全部收口（`pnpm typecheck && pnpm test && pnpm smoke:main` 全绿）。

- [ ] **Step 1: 用户提供真实 Key**

任一协议即可（OpenAI 兼容最常见）。**Key 只填在设置页，不写进任何文件、不进 git、不进对话记录。** 验收结束后可在设置页删除该 provider。

- [ ] **Step 2: 走通主路径**

添加 provider → 拉取模型列表 → 发送测试消息（成功）→ 复制一段真实文字 → 面板悬停点「优化」→ 优化（用户模式）→ 看 `notes` → 点「复制」→ 去别处 Ctrl+V。
Expected: 全流程成功；产出提示词可直接使用。

- [ ] **Step 3: 走通系统提示词模式**

同一段输入切到「系统提示词」→ 优化。
Expected: 产出的是角色/身份/边界/输出规范型 system prompt，**不是**把用户提示词换个标题（对应 Review Focus 5）。

- [ ] **Step 4: 三条异常路径**

1. 断网（关 Wi-Fi）→ 优化 → 期望「网络连接失败」，不崩、按钮恢复可点。
2. 错 Key（改一位）→ 测试消息 → 期望「鉴权失败，请检查 API Key」。
3. 超时（把 baseUrl 指向不回包的地址）→ 期望 60s 后「请求超时（60 秒）」，按钮恢复可点。

- [ ] **Step 5: 记录证据**

截图存 `docs/superpowers/evidence/`，命名 `ai-<序号>-<场景>.png`（沿用现有 `task*.png` 风格）。每条证据在提交说明里写一句「看到了什么」。

---

### Task 9: 文档更新

**Files:**
- Modify: `README.md`（新增「AI 提示词优化」章节）
- Create: `docs/superpowers/specs/2026-10-17-ai-prompt-optimizer-design.md`（把本计划的 §1 需求定稿、§2 约束、§3 分层固化）

- [ ] **Step 1: README 章节**

必须写清四件事：
1. **怎么配模型**：三种协议各一段，写明 Base URL 填什么（openai-compat 填到 `/v1` 或只填域名由程序补；anthropic 填 `https://api.anthropic.com`；gemini 填 `https://generativelanguage.googleapis.com`）。
2. **四类场景**各自适合什么（对应 `BUILTIN_SCENES` 的 `description`）。
3. **两种模式的区别**：用户提示词 vs 系统提示词，各给一句什么时候用。
4. **能力边界（如实写，不美化）**：优化质量取决于所选模型；**API Key 明文存本地 `clipchan.db`**，仅本机使用、不上传，共享电脑需自行注意；本轮不做流式输出、不做多轮自动迭代、手机端不接 AI。

- [ ] **Step 2: 固化设计文档**

把 §1 决策表、§2 全局约束、§3 分层表搬进 `docs/superpowers/specs/2026-10-17-ai-prompt-optimizer-design.md`，文件头注明日期与状态（「已实现」或「实现中」），并链接回本计划。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/
git commit -m "docs: AI 提示词优化使用说明与设计定稿"
```

---

## 5. 完成判据

**可自动验证（每条都能贴命令输出）：**

- [ ] `pnpm typecheck` 无错
- [ ] `pnpm test` 全绿
- [ ] `pnpm smoke:main` 报「通道一个都没漏」（`registeredChannels().length === ALL_INVOKE_CHANNELS.length`）
- [ ] `packages/ai` 三个适配器各有 ≥4 条 fake-server 用例（含认证头断言与超时断言）
- [ ] 四类场景数据齐全，`scenes.ts` 源码不含 `fetch(` / `http`（离线断言）
- [ ] `parseOptimized` 三条路径（标签 / 围栏 / 裸文本 degraded）各有断言
- [ ] 两种模式模板实际不同（`meta-prompt.spec.ts` 断言）
- [ ] `db.spec.ts` 钉住 KV 写入后读得回，且 `getSettings()` 里不含 `aiProviders` / `aiKey:*`
- [ ] `ai.spec.ts` 断言渲染层拿到的 provider 对象**无 `apiKey` 字段**，`JSON.stringify` 不含完整 Key
- [ ] `preload.spec.ts` 的 `EXPECTED` 覆盖全部新通道（`items.getText` / `ai.*`）

**只能人工验证（Task 8 的证据截图）：**

- [ ] 设置页「添加 → 拉列表 → 测试消息」全链路
- [ ] 面板「选中 → 优化 → 对比 → 复制/直接粘贴」全流程
- [ ] 真实模型跑通主路径 + 两种模式 + 三条异常路径
- [ ] README 含配置说明与如实的能力边界（含 Key 明文存储的告知）
