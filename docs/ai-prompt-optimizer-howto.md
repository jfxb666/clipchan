# 把 AI 提示词优化计划交给 agent 执行

> 本文解决的是**「怎么把计划交出去、怎么验收」**。功能本身面向用户的说明在 `README.md`（由计划 Task 9 产出）。
> 计划文件：`docs/superpowers/plans/2026-10-17-ai-prompt-optimizer.md`

---

## 1. 先搞清楚这份计划是什么

一份**自包含**的实现计划：9 个 Task，每个 Task 有 Files / Interfaces / 带复选框的 Step / 收口命令 / commit message。

它不依赖任何会话上下文。拿到文件就能开工——计划里的 §0 就是为此写的（环境前置、仓库硬约定、依赖图、已踩过的坑）。

| 段落 | 内容 |
|------|------|
| §0 | 给执行者：环境、约定、依赖图、已知坑 |
| §1 | 需求定稿（已拍板，不再讨论） |
| §2 | 全局约束 10 条 |
| §3 | 四类九小类的 do/verify 分层 |
| §4 | Review Focus 8 条（最容易踩的失效模式） |
| §5 | 完成判据（可自动验证 10 条 / 只能人工验证 4 条） |
| Task 1-9 | 具体实现步骤 |

---

## 2. 一句话交办

把下面这段整段发给 agent，不要只发一个链接——很多 agent 不会主动去读文件：

```
请实现 docs/superpowers/plans/2026-10-17-ai-prompt-optimizer.md。

开工前必读该文件的 §0（给执行者）与 §2（全局约束），然后严格按
Task 顺序执行：每个 Task 先写失败测试 → 跑它确认红 → 实现 → 跑绿 →
收口检查 → commit（用计划里写好的 commit message）。

本轮只做 Task 1 到 Task 4（packages/ai 包）。做完停下来，把
`pnpm typecheck` 与 `pnpm test` 的完整输出贴给我，不要自行开始 Task 5。

硬性要求：
- 不要引入任何新依赖（不装 axios / openai SDK / @anthropic-ai/sdk）
- 不要 git push
- 不要修改计划文件本身；发现计划有问题就停下来报告，不要自行改方案
```

**关键点：** 明确划出本轮范围（Task 1-4）、明确要求「停下来等验收」、明确禁止 push 与自行改方案。不写这三条，agent 会一口气跑完 9 个 Task 然后交给你一团需要逐个排查的 commit。

---

## 3. 分三批推进，别一次全交

| 批次 | Task | 交给谁 | 为什么这样切 |
|------|------|--------|--------------|
| 第一批 | 1-4 | agent | 纯 TS 包，纯函数 + fake server，**测试能自己证明对错**，不需要人看界面 |
| 第二批 | 5-7 | agent | 动 core / desktop / mobile，有 IPC 与 UI，需要人跑起来看 |
| 第三批 | 8-9 | **你自己** | Task 8 需要真实 API Key；Task 9 是文档，顺手做 |

Task 1-4 做完就能验证「优化质量到底行不行」——见下一节。质量不行就别急着做 UI。

---

## 4. 第一批做完先验质量（重要）

Task 1-4 交付的是纯引擎，还没有界面。这时候最值得做的是**跳过 UI 直接验产出**。

写个临时脚本放仓库根（用完删，不要提交），把你自己真实复制过的 10 段文字喂进去：

```ts
import { adapterFor, optimize, sceneById } from './packages/ai/src/index'

const key = process.env.MY_API_KEY as string   // 环境变量传，不要写进文件
const cfg = {
  id: 'p1', name: 'test', protocol: 'openai-compat' as const,
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
}
const adapter = adapterFor(cfg.protocol)

const samples = [
  '帮我写个 python 脚本读 excel',
  '我们做了个剪贴板工具，支持历史记录和快速粘贴',
  // ……换成你自己真的复制过的文字
]

for (const text of samples) {
  const r = await optimize(adapter, cfg, key, {
    text, scene: sceneById('general')!, mode: 'user',
  })
  console.log('--- 原文 ---')
  console.log(text)
  console.log('--- 优化后 ---')
  console.log(r.optimized)
  console.log('--- 改动说明 ---')
  console.log(r.notes.join(' / '))
}
```

**判断标准：** 10 段里有多少段你会**直接粘贴去用**。

- ≥7 段 → 继续做 Task 5-7
- 3-6 段 → 元提示词模板要重写（改 `packages/ai/src/meta-prompt.ts`），别往 UI 上堆
- ≤2 段 → 停下来重新想方法论，UI 做得再好也没用

---

## 5. 每批怎么验收

### 第一批（Task 1-4）

```bash
pnpm typecheck     # 必须 exit 0
pnpm test          # 必须全绿
```

看这几件事：

- [ ] `packages/ai/src/` 下确实有 `types.ts` / `adapters/` / `scenes.ts` / `meta-prompt.ts` / `optimize.ts`
- [ ] 三个 `*.spec.ts` 各有 ≥4 条用例（chat / listModels / 401 / 超时）
- [ ] `scenes.ts` 里有 4 个场景，每个 `rules` ≥4 条
- [ ] 根 `tsconfig.json` 的 `references` 里有 `packages/ai`（**漏了不会报错，是最阴的坑**）
- [ ] `git log` 有 4 个 commit，message 与计划一致

### 第二批（Task 5-7）

```bash
pnpm typecheck && pnpm test && pnpm smoke:main
```

看这几件事：

- [ ] `smoke:main` 报「通道一个都没漏」（`registeredChannels().length === ALL_INVOKE_CHANNELS.length`）
- [ ] 三处手写适配器都补了 `ai` 段：`packages/core/src/platform/adapter.ts`、`packages/core/src/state/store.spec.ts`、`packages/mobile/src/platform/mobile-adapter.ts`
- [ ] `preload.spec.ts` 的 `EXPECTED` 里有 `ai` 组
- [ ] `ai.spec.ts` 断言了返回对象**没有 apiKey 字段**
- [ ] `pnpm dev` 起得来，设置页能看到「AI 模型」区，列表页悬停卡片有「优化」按钮

### 第三批（Task 8-9，你自己做）

见计划 Task 8。三条必须亲眼看到：

1. 断网 → 「网络连接失败」
2. 错 Key → 「鉴权失败，请检查 API Key」
3. 超时 → 60 秒后「请求超时（60 秒）」，按钮恢复可点

---

## 6. agent 交回来有问题怎么办

**不要自己上手改它负责的模块**，带着证据打回去。打回时说清楚三件事：哪条命令、什么输出、期望什么。

常见故障与对应打回话术：

| 现象 | 大概率原因 | 打回话术 |
|------|------------|----------|
| `pnpm typecheck` 报 `missing the following properties from type 'ClipchanApi': ai` | 三处适配器漏改了一处 | 「报错文件是 X，请按计划 Task 5 Step 1 把 adapter.ts / store.spec.ts / mobile-adapter.ts 三处一次改完」 |
| 新包的类型错误没被检查出来 | 根 `tsconfig.json` 的 `references` 漏了 `packages/ai` | 「请检查根 tsconfig.json 的 references，并把一个故意写错类型的变量加进去验证 tsc -b 能报错」 |
| `pnpm smoke:main` 报通道数不相等 | 新通道没进 `ALL_INVOKE_CHANNELS` | 「smoke 报 N≠M，请检查 channels.ts 的 ALL_INVOKE_CHANNELS 展开」 |
| 存进去的配置重启后没了 | 走了 `setSettings` 而不是新的 KV 访问器 | 「db.ts 的 sanitizeSettings 是白名单，请改用 getSettingValue / setSettingValue」 |
| agent 自己加了流式输出 / 多轮迭代 | 没读 §2 的 YAGNI | 「计划明确不做流式与多轮迭代，请回退这部分改动」 |

同一份任务书**最多打回两次**。两次都不行就自己接手，或者换个 agent 重来。

---

## 7. 交给别的 agent 时最容易出事的四件事

1. **不划范围** → 它一口气做完 9 个 Task，Task 7 的 UI 出问题时你从 9 个 commit 里找原因。
2. **不说「不要 push」** → 它直接推上 main，你想回退都麻烦。
3. **不说「不要改计划」** → 它觉得计划有问题就自己改方案，最后交付的东西和你批准的方案对不上。
4. **不说「发现计划有问题就停下来报告」** → 它硬着头皮编一个能跑但不是你要的实现。

这四条都写进第 2 节那段交办话术里了，照抄即可。

---

## 8. 一句话总结

**Task 1-4 交给 agent（测试能自证），Task 5-7 交给 agent 但你得跑起来看，Task 8 自己做（要真实 Key）。每批做完先跑 `pnpm typecheck && pnpm test`，有问题带着命令输出打回，别自己上手改。**
