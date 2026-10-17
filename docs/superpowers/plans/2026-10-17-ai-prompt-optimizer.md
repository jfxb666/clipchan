# AI 提示词优化（Prompt Optimizer）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在剪贴板酱 Clipchan 里加一条"复制即优化"的路径：把随手复制的文字（或手输的一段话），按使用场景一键改写成可直接粘贴去用的高质量提示词——面向对 AI 提需求、描述事情、写产品/项目介绍、跟朋友聊天这四类真实场景。

**Architecture:** 三层，依赖单向向下。
1. `packages/ai`（新包，纯 TS、不 import electron/node 以外的宿主 API）：`ProviderAdapter` 统一接口 + 三个适配器（openai-compat / anthropic / gemini）、场景与方法论数据、元提示词组装、优化引擎纯函数。
2. `packages/desktop/electron`：主进程持有 API Key 与网络出口，通过 `ai:*` 通道把结果交回渲染层；Key 绝不出主进程。
3. `packages/core`：`ClipchanApi` 类型契约扩展 + 优化面板 UI + 设置页「AI 模型」区。

**Tech Stack:** TypeScript 5.9 / pnpm workspace / vitest 3.2 / Electron 37 / React 18 / Tailwind 3 / better-sqlite3 13。网络请求只用 `fetch`（Electron 主进程内置），**不引入新的运行时依赖**。

**Spec:** 本文件即规格。上游设计定稿见会话分级规划（北极星：让 Clipchan 用户把随手复制的文字一键变成按使用场景优化过的高质量提示词，直接粘贴去用）。

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

## 3. 四个交付大类（L1）与九个小类（L2）

| 大类 | 小类 | do | verify |
|------|------|----|--------|
| 一、AI 协议接入层 | 1. 协议适配器骨架 | subagent | self |
| | 2. 三协议 fake-server 单测 | subagent | self |
| 二、方法论库与优化引擎 | 3. 场景分类与方法论规则库 | subagent | self |
| | 4. 元提示词与优化引擎 | subagent | self |
| 三、桌面端 UI 集成与持久化 | 5. IPC 主进程桥 | subagent | self |
| | 6. 设置页 AI 模型配置 | subagent | self |
| | 7. 优化面板 UI | subagent | self |
| 四、端到端验收与文档 | 8. 真实模型端到端验收 | mixed | dual |
| | 9. 文档更新 | subagent | self |

## 4. Review Focus（规格没写进断言、但真人最容易踩中的失效模式）

1. **用户填了 Base URL 但没填 `/v1`** → 期望：适配器规范化 URL（去尾斜杠、按协议补默认路径），并有一条单测钉住。别让用户对着 404 猜。
2. **拉模型列表的接口不存在或不返回 `data[]`**（部分中转站、Gemini 原生路径不同） → 期望：降级为"手输模型名"而不是报错卡死。
3. **流式响应没做**（本轮明确不做流式） → 期望：优化期间按钮进 loading、可取消；超时上限明确（默认 60s），超时给中文提示。别让面板假死。
4. **模型返回的不是干净的提示词**（带"好的，这是优化后的提示词："前缀、包在 markdown 代码块里） → 期望：引擎解析层剥壳；解析失败时把原文照实展示 + 提示"模型输出格式异常，可重试"。
5. **系统提示词模式下** → 期望：产出的是角色/约束型 system prompt，不是把用户提示词换个标题。两种模式的模板必须实际不同（单测断言）。
6. **Key 泄漏** → 期望：渲染层拿到的 provider 对象里 Key 是掩码（`sk-…abcd`），完整值只在主进程内存/DB 里。

---

### Task 1: 新建 `packages/ai` 包与协议适配器骨架

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/tsconfig.json`
- Create: `packages/ai/src/types.ts`（`AiProtocol`、`ProviderConfig`、`ChatMessage`、`AiError`、`ProviderAdapter`）
- Create: `packages/ai/src/adapters/openai-compat.ts`
- Create: `packages/ai/src/adapters/anthropic.ts`
- Create: `packages/ai/src/adapters/gemini.ts`
- Create: `packages/ai/src/adapters/index.ts`（`adapterFor(protocol)` 工厂）
- Modify: `tsconfig.json`（根 `references` 加 `packages/ai`）
- Modify: `packages/core/src/types.ts`（`AiProtocol` 等跨端类型；core 不依赖 ai 包，避免循环）

**Interfaces:**
- Produces:
  - `type AiProtocol = 'openai-compat' | 'anthropic' | 'gemini'`
  - `interface ProviderConfig { id: string; name: string; protocol: AiProtocol; baseUrl: string; model: string }`（**无 apiKey 字段**，Key 单独走 `SecretsStore`）
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

- [ ] **Step 2: 写类型与统一错误**

`packages/ai/src/types.ts`：按上面 Interfaces 落类型。另加两个纯函数：
```ts
/** 去掉末尾斜杠；缺省补协议默认路径（Review Focus 1）。 */
export function normalizeBaseUrl(protocol: AiProtocol, raw: string): string
/** 把任意异常翻译成 AiError，绝不裸抛（约束：错误路径结构化）。 */
export function toAiError(e: unknown, ctx: { timeoutMs: number }): AiError
```

- [ ] **Step 3: 实现 openai-compat 适配器**

`chat` → `POST {base}/chat/completions`，body `{ model, messages }`，取 `choices[0].message.content`。
`listModels` → `GET {base}/models`，取 `data[].id`；**响应里没有 `data` 数组时返回 `[]`**（Review Focus 2：交给 UI 降级为手输，不抛错）。
认证头：`Authorization: Bearer <key>`。

- [ ] **Step 4: 实现 anthropic 适配器**

`chat` → `POST {base}/v1/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`，body `{ model, max_tokens, system, messages }`（把 `role: 'system'` 的消息提到顶层 `system` 字段，其余进 `messages`），取 `content[0].text`。
`listModels` → `GET {base}/v1/models`，取 `data[].id`。

- [ ] **Step 5: 实现 gemini 适配器**

`chat` → `POST {base}/v1beta/models/{model}:generateContent?key=<key>`，body `{ contents: [{ role: 'user'|'model', parts: [{ text }] }], systemInstruction? }`，取 `candidates[0].content.parts[0].text`。
`listModels` → `GET {base}/v1beta/models?key=<key>`，取 `models[].name` 并剥掉 `models/` 前缀。

- [ ] **Step 6: 工厂与统一超时**

`packages/ai/src/adapters/index.ts`：`export function adapterFor(p: AiProtocol): ProviderAdapter`。
三个适配器内部统一走一个私有 `requestJson(url, init, timeoutMs)` 帮助函数：`AbortSignal.timeout` + 状态码映射（401/403→`auth`，429→`rate-limit`，超时→`timeout`，网络失败→`network`，解析失败→`bad-response`）。

- [ ] **Step 7: 收口检查**

Run: `pnpm typecheck`
Expected: 无错误；`packages/ai` 被 tsc -b 编译到。

- [ ] **Step 8: 提交**

```bash
git add packages/ai tsconfig.json packages/core/src/types.ts
git commit -m "feat(ai): 三协议适配器骨架与结构化错误"
```

---

### Task 2: 三协议 fake-server 单测

**Files:**
- Create: `packages/ai/src/adapters/fake-server.ts`（测试用本地 HTTP 服务）
- Create: `packages/ai/src/adapters/openai-compat.spec.ts`
- Create: `packages/ai/src/adapters/anthropic.spec.ts`
- Create: `packages/ai/src/adapters/gemini.spec.ts`
- Create: `packages/ai/src/types.spec.ts`（`normalizeBaseUrl` / `toAiError`）

**Interfaces:**
- Consumes: Task 1 的 `adapterFor`、`ProviderAdapter`、`AiError`
- Produces: `startFakeServer(routes): Promise<{ url: string; close(): Promise<void> }>`，`routes` 为 `Record<string, (req) => { status: number; body: unknown; delayMs?: number }>`

- [ ] **Step 1: 写 fake server**

用 `node:http` 起服务监听 `127.0.0.1:0`（随机端口），按 `pathname` 匹配路由表；`delayMs` 用于超时用例。

- [ ] **Step 2–4: 每家适配器 4 条用例**

对 openai-compat / anthropic / gemini 各写：
1. 正常 `chat` → 返回期望文本
2. `listModels` → 返回模型 id 数组
3. 401 → `AiError.kind === 'auth'`
4. `delayMs > timeoutMs` → `AiError.kind === 'timeout'`（timeoutMs 传 50，delay 传 200）

- [ ] **Step 5: 补两类边界用例**

- openai-compat `/models` 返回 `{}` → `listModels` 返回 `[]` 而不抛错（Review Focus 2）。
- `normalizeBaseUrl('openai-compat', 'https://x.com/v1/')` → `'https://x.com/v1'`。

- [ ] **Step 6: 收口检查**

Run: `pnpm vitest run packages/ai`
Expected: 全部通过，至少 14 条用例。

- [ ] **Step 7: 提交**

```bash
git add packages/ai
git commit -m "test(ai): 三协议 fake-server 覆盖 chat/models/401/超时"
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

- [ ] **Step 1: 落四个内置场景**

| id | 名称 | 定位 | 规则要点（提炼自 Anthropic/OpenAI 指南、AWS 16 种提示词技术、promptingguide.ai） |
|----|------|------|------|
| `general` | 通用对话 | 对 AI 提需求、问问题 | 明确角色与目标；补足上下文；指定输出格式与长度；要求分步推理时显式写出来；给出成功判据 |
| `ai-generation` | AI 生成 | 文生图 / 文生视频 / 音乐等创作 | 主体 + 场景 + 风格 + 镜头/构图 + 光线 + 画质词；负面提示词单列；参数化可复用；避免互相冲突的风格词 |
| `product` | 产品·项目描述 | 写产品介绍、项目说明、需求文档 | 一句话价值主张；目标用户与痛点；差异化与证据；结构化分段（背景/方案/收益）；去掉形容词堆砌，换成可验证事实 |
| `casual` | 日常交流 | 跟朋友聊、发消息、回邮件 | 语气与关系匹配；长度贴合渠道（微信短、邮件可长）；保留说话人自己的口吻；给 1 个直接可发的版本 |

每条含 `description`（给用户看的一句话）与 `example`（input/output 各一段真实感示例）。

- [ ] **Step 2: 自定义场景支持**

`sceneById` 先查 `BUILTIN_SCENES`，再查 `custom`；找不到返回 `undefined`（调用方回落 `general`）。

- [ ] **Step 3: 断言离线**

`scenes.spec.ts`：4 条内置场景齐全、每条 `rules.length >= 4`、`id` 唯一；**断言模块源码里不含 `fetch`**（`import { readFileSync } from 'node:fs'` 读自身源码做字符串检查，钉住"离线"这条约束）。

- [ ] **Step 4: 收口检查**

Run: `pnpm vitest run packages/ai/src/scenes.spec.ts`
Expected: 通过。

- [ ] **Step 5: 提交**

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

- [ ] **Step 1: 写元提示词组装（两种模式必须不同）**

`buildMetaPrompt` 产出 `[{ role: 'system', content: 优化器角色说明 }, { role: 'user', content: 任务说明 }]`。
- `mode === 'user'`：要求"产出一段可直接发给 AI 的用户提示词，保留用户原意，补足缺失的角色/上下文/输出格式/约束"。
- `mode === 'system'`：要求"产出一段 system prompt：定义角色身份、能力边界、输出规范、拒答策略；不要复述用户的具体任务"。
两者都把 `scene.rules` 逐条注入，并要求输出**严格两段**：先 `<optimized>` 后 `<notes>`（每条改动一行）。

- [ ] **Step 2: 写解析层（剥壳）**

`parseOptimized`：
1. 若含 `<optimized>` 标签 → 按标签切分。
2. 否则若整体被 ```…``` 包裹 → 剥掉围栏。
3. 否则整段当 `optimized`，`degraded = true`（Review Focus 4），`notes` 给一条"模型未按格式输出，已直接采用全文"。

- [ ] **Step 3: 写 optimize 编排**

`optimize` = `buildMetaPrompt` → `adapter.chat` → `parseOptimized`。超时默认 60s（Review Focus 3），透传 `AbortSignal`。

- [ ] **Step 4: 测试**

- 同一 input 在 `user` / `system` 两种模式下 `buildMetaPrompt` 的 user content **不相等**，且各自包含场景规则。
- `parseOptimized` 三种输入：带标签 / 带围栏 / 裸文本（`degraded === true`）。
- `optimize` 用 stub adapter 走通，返回结构化字段。

- [ ] **Step 5: 收口检查**

Run: `pnpm vitest run packages/ai`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/ai
git commit -m "feat(ai): 元提示词双模式与优化引擎"
```

---

### Task 5: IPC 主进程桥

**Files:**
- Modify: `packages/core/src/types.ts`（`ClipchanApi` 加 `ai` 段；新增 `AiProvider` 对外投影、`OptimizeResult`）
- Modify: `packages/desktop/electron/channels.ts`（`CH.ai` + `ALL_INVOKE_CHANNELS`）
- Modify: `packages/desktop/electron/preload.ts`（`ai` 方法）
- Create: `packages/desktop/electron/ai.ts`（provider 增删改查 + Key 存取 + 调用 packages/ai）
- Create: `packages/desktop/electron/ai.spec.ts`
- Modify: `packages/desktop/electron/main.ts`（`buildHandlers()` 里接上 `CH.ai.*`）
- Modify: `packages/desktop/package.json`（`@clipchan/ai` workspace 依赖）

**Interfaces:**
- Produces（`ClipchanApi.ai`）:
  ```ts
  ai: {
    listProviders(): Promise<AiProvider[]>;                    // Key 已掩码
    saveProvider(p: AiProviderInput): Promise<AiProvider[]>;    // 含明文 apiKey（仅上行）
    removeProvider(id: string): Promise<AiProvider[]>;
    listModels(id: string): Promise<string[]>;
    test(id: string): Promise<{ ok: boolean; error?: AiError; model?: string }>;
    optimize(req: { providerId: string; text: string; sceneId: string; mode: 'user' | 'system'; extra?: string }): Promise<OptimizeResult>;
    onChanged(cb: () => void): () => void;
  }
  ```

- [ ] **Step 1: 扩 core 类型契约**

`packages/core/src/types.ts` 加 `AiProtocol`、`AiProvider`（`{ id; name; protocol; baseUrl; model; hasKey: boolean; keyMask: string }`）、`AiProviderInput`（多一个 `apiKey?: string`）、`AiError`、`OptimizeResult`（`{ optimized: string; notes: string[]; degraded: boolean }`）。**core 不 import `@clipchan/ai`**——类型在 core 与 ai 各留一份镜像，由 `ai.spec.ts` 断言两侧字段一致，避免 core→ai 的构建依赖。

- [ ] **Step 2: 加通道名**

`channels.ts` 的 `CH` 加：
```ts
ai: {
  listProviders: 'ai:listProviders',
  saveProvider: 'ai:saveProvider',
  removeProvider: 'ai:removeProvider',
  listModels: 'ai:listModels',
  test: 'ai:test',
  optimize: 'ai:optimize',
},
```
并把 `...Object.values(CH.ai)` 加进 `ALL_INVOKE_CHANNELS`（`--smoke` 断言靠它）。

- [ ] **Step 3: 主进程 ai.ts**

- Provider 元数据存 `settings` 表的单个键 `aiProviders`（JSON 数组，**不含 Key**）。
- Key 单独存 `settings` 表键 `aiKey:<providerId>`（本轮不做加密，但**绝不出主进程**；README 如实说明）。
- `listProviders` 返回掩码：`keyMask = key.slice(0,3) + '…' + key.slice(-4)`（长度 <8 时返回 `'••••'`），`hasKey` 布尔。
- `optimize` 在渲染层传入的 `providerId` 上取 Key，调 `packages/ai` 的 `optimize`，返回 `OptimizeResult`；任何异常经 `toAiError` 结构化后抛给渲染层。

- [ ] **Step 4: preload 接线**

按现有写法（`preload.ts:23-31` 模式）逐方法 `ipcRenderer.invoke(CH.ai.xxx, ...)`；`onChanged` 用 `EV.aiChanged`。

- [ ] **Step 5: main.ts 接处理器表**

在 `buildHandlers()`（`main.ts:352`）里加六条 `[CH.ai.xxx]: (...) => ...`，与既有 `CH.settings.get` 同风格。

- [ ] **Step 6: 测试**

`ai.spec.ts`：
- `ALL_INVOKE_CHANNELS` 含全部 `CH.ai.*`
- `listProviders` 返回对象**不含 `apiKey` 字段**，且 `keyMask` 不含完整 Key（Review Focus 6）
- core 的 `AiProvider` 与 ai 包的字段集合一致

- [ ] **Step 7: 收口检查**

Run: `pnpm typecheck && pnpm test && pnpm smoke:main`
Expected: 全绿；smoke 报通道一个都没漏。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/types.ts packages/desktop
git commit -m "feat(desktop): ai IPC 主进程桥，密钥不出主进程"
```

---

### Task 6: 设置页「AI 模型」区

**Files:**
- Create: `packages/core/src/ui/AiProviderForm.tsx`
- Modify: `packages/core/src/ui/SettingsView.tsx`（新增 `<Section title="AI 模型">`）
- Modify: `packages/core/src/ui/index.ts`（导出）
- Create: `packages/core/src/ui/aiProviderForm.spec.tsx`

**Interfaces:**
- Consumes: `ClipchanApi.ai.*`（经 `platform.adapter`）
- Produces: `AiProviderForm({ providers, onSave, onRemove, onTest, onListModels })`；纯校验函数 `validateProvider(input): string[]`（返回中文错误列表，可单测）

- [ ] **Step 1: 写校验纯函数**

`validateProvider`：名称必填；`baseUrl` 必须以 `http://` 或 `https://` 开头；`model` 必填；协议非 openai-compat 时 `baseUrl` 缺省可自动补官方默认值。

- [ ] **Step 2: 写表单组件**

字段：名称 / 协议（`Segmented`）/ Base URL（带占位符与默认值提示）/ API Key（`type="password"`，已存在时显示掩码 + "重新填写"）/ 默认模型（文本框 + "拉取列表"按钮 → `<select>`，拉取失败降级为纯手输，Review Focus 2）。
底部两个按钮：「发送测试消息」（loading → 成功显示模型名，失败显示 `AiError.message` 中文映射）/「保存」。

- [ ] **Step 3: 挂进设置页**

`SettingsView.tsx` 在「小组件」之后、「数据」之前插 `<Section title="AI 模型">`，内容为 provider 列表（每行：名称 + 协议 + 模型 + 测试/编辑/删除）+ 「添加模型」按钮展开表单。

- [ ] **Step 4: 测试**

`aiProviderForm.spec.tsx`：`validateProvider` 的空名称 / 非法 URL / 空模型三类返回非空中文错误；合法输入返回空数组。

- [ ] **Step 5: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/ui
git commit -m "feat(ui): 设置页 AI 模型配置（拉列表 + 连通性测试）"
```

---

### Task 7: 优化面板 UI

**Files:**
- Create: `packages/core/src/ui/OptimizeView.tsx`
- Modify: `packages/core/src/state/store.ts`（`View` 加 `'optimize'`；`ClipStoreState` 加 `optimizeSource: string | null` 与 `openOptimize(text)` / `closeOptimize()`）
- Modify: `packages/core/src/ui/App.tsx`（`view === 'optimize'` 分支）
- Modify: `packages/core/src/ui/ClipCard.tsx`（选中条目的「优化」入口）或 `ListPanel.tsx`
- Create: `packages/core/src/ui/optimizeView.spec.tsx`（纯函数部分）

**Interfaces:**
- Consumes: `ai.optimize`、`BUILTIN_SCENES` 的场景列表（经 IPC 暴露或 core 侧镜像一份只读列表）
- Produces: `OptimizeView()`；`scenesForUi(): { id; name; description }[]`

- [ ] **Step 1: 扩 store**

`View` 加 `'optimize'`；`openOptimize(text)` 记下原文并切视图；`closeOptimize()` 回 `'list'` 并清空。

- [ ] **Step 2: 写优化面板**

布局（沿用 900×620 面板比例）：
- 顶部工具条：场景选择（下拉，含描述 tooltip）/ 模式 `Segmented`（用户提示词 | 系统提示词）/ 模型选择（下拉）/「优化」按钮。
- 主体左右分栏：左「原文」（可编辑 textarea，来自选中的剪贴板条目，可清空手输），右「优化后」（只读，loading 骨架屏）。
- 底部：改动说明列表（`notes`）+ 按钮「复制」/「直接粘贴」/「重试」。
- 失败态：显示中文错误 + 「重试」，不白屏；`degraded === true` 时显示"模型未按格式输出，已直接采用全文"。

- [ ] **Step 3: 接入口**

剪贴板条目选中态加「优化」按钮（或快捷键）→ `openOptimize(item.preview)`。

- [ ] **Step 4: 测试**

`optimizeView.spec.tsx`：`scenesForUi()` 返回 4 条且含 `id/name/description`；`degraded` 提示文案函数在 `true`/`false` 下返回不同结果。

- [ ] **Step 5: 收口检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。

- [ ] **Step 6: 手动冒烟**

Run: `pnpm dev` → 复制一段文字 → 唤出面板 → 选中 → 优化 → 看到结果 → 复制/粘贴。
Expected: 全流程走通；未配模型时给出"请先在设置里添加 AI 模型"的中文提示而非白屏。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src
git commit -m "feat(ui): 优化面板（场景/模式/前后对比/一键粘贴）"
```

---

### Task 8: 真实模型端到端验收

**Files:** 无代码改动（发现问题回到对应 Task 修）

- [ ] **Step 1: 用户提供真实 Key**

任一协议即可（OpenAI 兼容最常见）。**Key 只填在设置页，不写进任何文件、不进 git。**

- [ ] **Step 2: 走通主路径**

添加 provider → 拉取模型列表 → 发送测试消息（成功）→ 选一段真实复制来的文字 → 优化（用户模式）→ 看改动说明 → 复制粘贴去实际使用。
Expected: 全流程成功，产出的提示词质量明显优于原文。

- [ ] **Step 3: 走通系统提示词模式**

同一段输入切到「系统提示词」→ 优化。
Expected: 产出的是角色/约束型 system prompt，不是把用户提示词换个标题。

- [ ] **Step 4: 三条异常路径**

1. 断网（关 Wi-Fi）→ 优化 → 期望："网络连接失败"中文提示，不崩。
2. 错 Key（改一位）→ 测试消息 → 期望："鉴权失败，请检查 API Key"。
3. 超时（把 baseUrl 指向一个不回包的地址）→ 期望：60s 后"请求超时"提示，按钮恢复可点。

- [ ] **Step 5: 记录证据**

把四条截图/输出存 `docs/superpowers/evidence/`（沿用现有命名 `task8-*.png` 风格，前缀改 `ai-`）。

---

### Task 9: 文档更新

**Files:**
- Modify: `README.md`（新增「AI 提示词优化」章节）
- Create: `docs/superpowers/specs/2026-10-17-ai-prompt-optimizer-design.md`（把本计划的 §1 需求定稿与 §3 分层固化）

- [ ] **Step 1: README 章节**

写清：怎么配模型（三种协议各一段、Base URL 填什么）、四类场景各自适合什么、两种模式的区别、**能力边界**（优化质量取决于所选模型；Key 明文存本地 `clipchan.db`，仅本机使用，不上传；本轮不做流式与多轮自动迭代）。

- [ ] **Step 2: 固化设计文档**

把 §1 决策表与 §3 分层表搬进 `docs/superpowers/specs/`，注明日期与状态。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/
git commit -m "docs: AI 提示词优化使用说明与设计定稿"
```

---

## 5. 完成判据

- [ ] `pnpm typecheck` 无错，`pnpm test` 全绿，`pnpm smoke:main` 通道无遗漏
- [ ] `packages/ai` 三个适配器各有 ≥4 条 fake-server 用例
- [ ] 四类场景数据齐全，模块离线（无运行时 fetch）
- [ ] 设置页完成「添加 → 拉列表 → 测试消息」全链路
- [ ] 面板完成「选中 → 优化 → 对比 → 复制/粘贴」全流程
- [ ] 真实模型跑通主路径 + 两条模式 + 三条异常路径
- [ ] 渲染进程拿不到明文 API Key（单测断言）
- [ ] README 含配置说明与如实的能力边界
