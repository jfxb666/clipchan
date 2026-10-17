# 剪贴板酱 · AI 提示词优化 · 设计文档

日期：2026-10-17
工作目录：D:/DSHworkspace/jiantieban/clipchan
计划文件：docs/superpowers/plans/2026-10-17-ai-prompt-optimizer.md
状态：已实现。Task 1–7（协议层、方法论与优化引擎、IPC 桥与持久化、设置页、优化面板）已落地并通过验收（HEAD `3a16f2a`，共 8 个 commit）；Task 8 真实模型端到端验收与 Task 9 文档更新属收尾。本文件是计划 §1 需求定稿、§2 全局约束、§3 分层交付的固化版，后续变更以计划文件为准并同步回这里。

> 这份文档回答三件事：为什么做（§1）、哪些东西不可协商（§3）、按什么分层交付（§4）。用户拍板的决策与「本轮不做」的边界都在这里写明，避免后来者把「没做」当成「漏做」。
>
> 事实来源：计划文件 `docs/superpowers/plans/2026-10-17-ai-prompt-optimizer.md`；实现位置见 §5，失效模式与对策见 §6。文中引用的行号、常量、通道名都取自当下代码，不是转述。

---

## 1. 目的与缘由（Why）

剪贴板里存的常常是「想跟 AI 说的一句话」，但这句话往往是随手写的：缺上下文、缺输出格式、缺约束。本功能把这条记录改写成一条**能直接用的提示词**，或改写成一份**system prompt**；改写由用户自己配置的模型完成，场景与方法论则内置在程序里。

三条设计前提：

1. **不引入服务端。** 用户自备模型与 Key（OpenAI 兼容 / Anthropic / Gemini），程序只做拼装与转发。没有账号、没有云同步。
2. **离线可用。** 场景数据与方法论是编译进包的 TS 数据，运行时不联网取规则 —— 只有「发一次优化请求」这一步走网络。
3. **不做假装成功。** 未实现的能力明确抛中文错误，宁可让用户看到失败，也不返回 `undefined` 或空数组糊过去。

## 2. 需求定稿（用户已拍板）

| # | 决策点 | 结论 |
| --- | --- | --- |
| Q1 | 形态 | 集成进现有 Clipchan 桌面端；不做独立 Web / CLI / 插件 |
| Q2 | 优化对象 | 两者都要：用户提示词 + 系统 / 角色提示词（system prompt） |
| Q3 | 模型接入 | 多协议：OpenAI 兼容（自定义 Base URL + Key + 模型名，`/v1/models` 拉列表）+ Anthropic 原生 + Gemini 原生 |
| Q4 | 优化方法 | 内置方法论库 + 元提示词（离线，无运行时联网取规则） |
| Q5 | 验证方式 | 连通性测试（发测试消息）+ 优化前后同屏对比 |
| — | 场景分类 | 由实现方设计，用户认可 4 类起：通用对话 / AI 生成 / 产品·项目描述 / 日常交流，可自定义 |

### 非目标（本轮不做，且不是漏做）

- 不做多轮自动迭代优化循环（PromptWizard / SPO 式「生成 — 批判 — 自进化」），留作后续。
- 不做云端账号与密钥同步。
- `packages/mobile` 本轮不接 AI：只保证 core 的结构改动不破坏它的构建。
- 不做流式输出、不做 Key 加密、不做模型热切换。

## 3. 全局约束（不可协商）

1. **Key 不出主进程。** 渲染进程只传 providerId；明文 Key 只在 `packages/desktop/electron/` 侧读取与使用，IPC 返回值绝不回显 Key，界面上只给掩码。
2. **不假装成功。** 未实现的通道明确抛中文错误，不返回 `undefined`、不返回空数组。
3. **通道名是契约。** `packages/core/src/types.ts` 的 `ClipchanApi` → `packages/desktop/electron/channels.ts` → `ipc.ts` 处理器表 → `preload.ts` 逐层对齐；`preload.spec.ts` 的 `EXPECTED` 表是唯一守门人。
4. **不引新依赖。** HTTP 用全局 `fetch`，不装 axios / openai SDK / @anthropic-ai/sdk。
5. **离线可用。** 场景数据与方法论是编译进包的 TS 数据。
6. **每个任务收口 `pnpm typecheck` + `pnpm test` 双绿。**
7. **UI 全中文**，沿用现有视觉：复用 `SettingsView.tsx` 的 Section / Row / Segmented / Toggle 与 tailwind token。
8. **API Key 不进 `Settings` 接口。** `db.ts` 的 `sanitizeSettings` 是逐键白名单，写白名单外的键会被静默丢弃；Key 与 provider 元数据走独立 KV 访问器 `Db.getSettingValue` / `Db.setSettingValue`。
9. **无 jsdom、无 testing-library。** 所有 `*.spec.tsx` 只能测纯函数，不得渲染组件；因此面板里可测的逻辑一律抽到不依赖 React 的模块。
10. **每步 TDD**：先写 spec 跑红，再写实现转绿。

## 4. 分层交付（四个大类 / 九个小类）

| 大类 | 小类 | do | verify |
|------|------|----|--------|
| 一、AI 协议接入层 | 1. 协议适配器骨架 | subagent | self |
| | 2. 三协议 fake-server 单测 | subagent | self |
| 二、方法论库与优化引擎 | 3. 场景分类与方法论规则库 | subagent | self |
| | 4. 元提示词与优化引擎 | subagent | self |
| 三、桌面端 UI 集成与持久化 | 5. IPC 主进程桥（含 db KV 访问器） | subagent | self |
| | 6. 设置页 AI 模型配置 | subagent | self |
| | 7. 优化面板 UI（含 `items.getText` / `ai.copyAndPaste`） | subagent | self |
| 四、端到端验收与文档 | 8. 真实模型端到端验收 | mixed | dual |
| | 9. 文档更新 | subagent | self |

## 5. 落地位置（实际有什么）

| 位置 | 内容 |
| --- | --- |
| `packages/ai/src/types.ts` | `AiProtocol` / `ChatMessage` / `ProviderConfig`（**不含 apiKey**）/ `AiError` / `ChatOptions` / `ProviderAdapter`；`normalizeBaseUrl(protocol, raw)` 去尾斜杠并按协议补版本段（openai-compat `/v1`、anthropic `/v1`、gemini `/v1beta`），非法 URL 抛中文错 |
| `packages/ai/src/adapters/` | `openai-compat.ts` / `anthropic.ts` / `gemini.ts` 三个适配器 + `request.ts`（超时与错误归一）+ `fake-server.ts` 与各自 `.spec.ts` |
| `packages/ai/src/scenes.ts` | `Scene` 类型与 `BUILTIN_SCENES` 四条：`general` 通用对话 / `ai-generation` AI 生成 / `product` 产品·项目描述 / `casual` 日常交流；`sceneById(id, custom)` 先内置后自定义 |
| `packages/ai/src/meta-prompt.ts` | `buildMetaPrompt({ text, scene, mode, extra })`，产出两条消息；`mode: 'user' \| 'system'` 两套模板，system 模式产出角色 / 约束型 system prompt |
| `packages/ai/src/optimize.ts` | `optimize(adapter, cfg, key, input)`：拼元提示词 → `adapter.chat` → `parseOptimized`；`DEFAULT_TIMEOUT_MS = 60000`、`DEGRADED_NOTE = '模型未按格式输出，已直接采用全文'` |
| `packages/desktop/electron/channels.ts` | `ai` 八个通道：`listProviders` / `saveProvider` / `removeProvider` / `listModels` / `test` / `optimize` / `scenes` / `copyAndPaste`，外加事件 `ai:changed` |
| `packages/desktop/electron/ipc.ts` | 上述通道的处理器表；Key 只在此侧读取 |
| `packages/desktop/electron/ai.ts` | 主进程 AI 服务；`PROVIDERS_KEY = 'aiProviders'`，`keyKey = (id) => 'aiKey:' + id`（元数据与 Key 分开存 KV） |
| `packages/desktop/electron/db.ts` | KV 访问器 `getSettingValue` / `setSettingValue`（绕开 `sanitizeSettings` 白名单） |
| `packages/core/src/types.ts` | `ClipchanApi.ai`（七方法）、`AiProtocol` / `AiError` / `AiProvider` / `AiProviderInput`、`OptimizeRequest` / `OptimizeResult` / `PasteResult` |
| `packages/core/src/ui/aiProviderForm.ts` | 表单纯逻辑：`DEFAULT_BASE_URL` 三协议、`validateProvider` 四条规则、`aiErrorMessage`（kind → 中文）、`protocolLabel` |
| `packages/core/src/ui/AiProviderFormCard.tsx` | 设置页表单组件（文件名偏离计划，理由见下） |
| `packages/core/src/ui/SettingsView.tsx` | 新增「AI 模型」Section，位于「小组件」与「数据」之间 |
| `packages/core/src/ui/optimizeView.ts` | 面板纯逻辑：`OPTIMIZE_MODES`（用户提示词 / 系统提示词）、`degradedHint` |
| `packages/core/src/ui/OptimizeViewCard.tsx` | 优化面板组件：场景 / 模式 / 模型选择、左右分栏对比、复制与直接粘贴、错误摊在右栏且可重试 |

### 落地时的一处偏离（有意为之）

计划把组件写作 `packages/core/src/ui/AiProviderForm.tsx` 与 `OptimizeView.tsx`，但同目录已有仅差大小写的纯函数模块 `aiProviderForm.ts` / `optimizeView.ts`。在大小写不敏感的文件系统上，TypeScript 会把这两个名字解析成同一个文件：报 `TS1149`，且 `import from './OptimizeView'` 会解析到 `optimizeView.ts`（`TS2305`）。因此组件实际落地为 **`AiProviderFormCard.tsx`** 与 **`OptimizeViewCard.tsx`**，导出名不变；两个文件头部都写明了原因。

## 6. 关键失效模式与对策

| 失效模式 | 对策 |
| --- | --- |
| 用户填了 Base URL 但没填 `/v1` | `normalizeBaseUrl` 去尾斜杠、按协议补默认版本段，并有单测钉住；不让用户对着 404 猜 |
| 拉模型列表的接口不存在（部分中转站、Gemini 原生路径） | 降级为「手输模型名」，给一条 `没拉到模型列表，可直接手输模型名`，不报错卡死 |
| 不做流式响应 | 优化期间按钮 loading 且禁用；默认 60 秒超时，超时给中文提示、按钮恢复可点，面板不假死 |
| 模型返回的不是干净提示词（前缀、markdown 围栏） | 解析层剥壳；解析不出结构则整段采用并置 degraded，界面显示「模型未按格式输出，已直接采用全文」，原文照实展示、可重试 |
| 系统提示词模式做成「换个标题」 | 两套模板实际不同：system 模式按角色身份 / 能力边界 / 输出规范 / 拒答策略四块组织，`meta-prompt.spec.ts` 断言两模式产物不相等 |
| Key 泄漏到渲染层 | provider 对象只带掩码 `sk-…abcd`；完整 Key 只在主进程内存与 DB |
| 写进去读不回来 | 走 `Db.getSettingValue` / `setSettingValue`，`db.spec.ts` 钉住写入后读得回，且 `getSettings()` 里不含 `aiProviders` / `aiKey:*` |
| 加了通道但没人校验 | 新通道进 `preload.spec.ts` 的 `EXPECTED` 表；不进表等于没有契约 |

## 7. 这一轮不做但记下来的事

- 多轮自动迭代优化（生成 — 批判 — 自进化）。
- 流式输出与可取消请求（本轮只靠 60 秒超时兜底）。
- Key 加密存储（当前明文存 `clipchan.db`，README 已如实告知）。
- 手机端接入 AI（`packages/mobile` 只搭壳）。
- 云端账号与密钥同步。

## 8. 核对记录（本文档里的事实出处）

下列位置在 2026-10-17 逐条打开核对过，不是转述计划：

| 事实 | 出处 |
| --- | --- |
| 三协议默认版本段 `/v1`、`/v1`、`/v1beta` | `packages/ai/src/types.ts:33-37`（`DEFAULT_VERSION_PATH`，配 `VERSION_SEGMENT = /\/v\d/`） |
| URL 规范化去尾斜杠、按协议补版本段，非法地址抛中文错 | `packages/ai/src/types.ts:45-63`（`normalizeBaseUrl`） |
| `ProviderConfig` 不含 `apiKey` | `packages/ai/src/types.ts:10-16` |
| 四类场景的 id / 名称 / description | `packages/ai/src/scenes.ts:20-22`（general）、`:36-38`（ai-generation）、`:53-55`（product）、`:69-71`（casual） |
| 两种模式的字样 | `packages/core/src/ui/optimizeView.ts:13-16`（`OPTIMIZE_MODES`） |
| degraded 提示原文 | `packages/core/src/ui/optimizeView.ts:22-24`（`degradedHint`） |
| 八个 `ai:*` 通道名 | `packages/desktop/electron/channels.ts:36-44`（`ai` 对象）+ `:59` `aiChanged: 'ai:changed'` |
| 通道契约守门人 | `packages/desktop/electron/preload.spec.ts:29`（`ai: [...]` 八个）与 `:13`（`items` 含 `getText`） |
| provider 元数据与 Key 分开存 KV | `packages/desktop/electron/ai.ts:30-32`（`PROVIDERS_KEY = 'aiProviders'`、`keyKey = (id) => 'aiKey:' + id`） |
| KV 写入后读得回、`getSettings()` 里不含 Key 与 provider | `packages/desktop/electron/db.spec.ts:176-183`、`:189-197` |
| 设置页表单的降级提示原文 | `packages/core/src/ui/AiProviderFormCard.tsx:16`（`LIST_FAILED_HINT`） |
| 优化面板的按钮与提示原文 | `packages/core/src/ui/OptimizeViewCard.tsx:163`（场景加载中 / 失败）、`:189`（优化中… / 优化）、`:253` 与 `:256`（复制 / 直接粘贴）、`:228` 与 `:259`（重试） |
| 卡片上的入口按钮 | `packages/core/src/ui/ClipCard.tsx:86-99`（`title="优化提示词"`，悬停显示） |

