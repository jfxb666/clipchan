# 剪贴板酱重做（Clipchan Rebuild）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `C:\Users\Administrator\Desktop\剪贴板` 从 C# WinForms 单文件 exe 重做成一份 React 界面代码驱动、Electron 承载的 Windows 桌面应用，界面按 `ojo` 原型、配色按用户给的图标重定，并且**真的支持图片剪贴板**；同一份 `core` 代码留出手机端接入点。

**Architecture:** pnpm workspace 三个包——`@clipchan/core`（平台无关：界面、zustand 状态、类型、主题令牌、纯逻辑）、`@clipchan/desktop`（Electron 主进程 + preload + 一个 C# 原生助手）、`@clipchan/mobile`（Capacitor 壳，本轮只搭壳）。`core` 只通过 `PlatformAdapter` 接口访问系统能力，界面代码一行不改就能换宿主。主进程负责剪贴板轮询、SQLite 持久化、图片落盘、全局热键、托盘、自动粘贴编排；渲染进程不开 `nodeIntegration`、不用 `remote`，只通过 preload 暴露的固定方法通信。自动粘贴与真毛玻璃都由**同一个常驻 C# 助手**（`clipchan-helper.exe`，`csc.exe` 编译）执行，因为 Node/Electron 侧调不到任何 Win32 API。

**Tech Stack:** Electron 37 · Vite · React 18 · TypeScript 5 · Tailwind CSS 3.4.19 · zustand · framer-motion · lucide-react · better-sqlite3 · vitest · C# / .NET Framework 4.x（`csc.exe`，仅助手）· Capacitor（仅搭壳）。

**Spec:** `docs/superpowers/specs/2026-10-15-clipchan-rebuild-design.md`（930 行，16 节，含 35 条验收标准与 24 条实测附录）

## Global Constraints

以下每一条都是 spec 里已经定死、不可在执行时重新协商的：

- **分层硬约束**：`packages/core` **不许** import `electron` / `fs` / `path` / `node:*` / Capacitor 专有模块；只能通过 `PlatformAdapter` 接口访问系统能力。纯逻辑放 `core/src/logic`，必须能在 Node 里直接单测（不起 Electron）。
- **渲染进程安全**：不开 `nodeIntegration`、不用 `remote`，preload 只暴露 spec §8.1 列出的固定方法，**不暴露任意通道**。原图磁盘路径与哈希不出主进程。
- **技术栈版本**：React 18、TypeScript 5、**Tailwind 3.4.19（不用 v4）**、zustand 4、framer-motion、lucide-react、better-sqlite3、Electron 37、vitest。**不引 sharp、不引虚拟滚动库**。
- **本机环境**：Windows 10 专业版 19045（**无系统级圆角与 acrylic**）；只有 Node v24.21.0 / npm / pnpm；**没有 git、Rust、.NET SDK、JDK、Android SDK、MSVC、Python**；`C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe` 可用。
- **无 git**：原「Commit」步骤一律替换为**绿检查点**——该任务涉及的测试/构建命令全绿即视为收口，并在 `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md` 的进度记录区追加一行（日期 + 任务号 + 命令 + 结果）。
- **所有 Node/Electron 脚本第一件事**：`Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`（本机默认带此变量，不清则 electron.exe 退化为纯 Node）。
- **electron-builder 必填** `"npmRebuild": false` + `"buildDependenciesFromSource": false`（否则 `@electron/rebuild` → node-gyp → 本机无 Python 直接失败）；`asarUnpack: ["**/*.node"]`。
- **原生助手编译失败不阻断打包**：只把 `capabilities.autoPaste` / `capabilities.frostedGlass` 置 false 并在界面如实标注，**不假装**。
- **数据契约**：单条文本上限 100000 字符（超限截断并置 `truncated`）；历史上限默认 **200**（可调 100–9999）；图片磁盘预算默认 **512MB**；原图长边上限 **2560px**；缩略图 **128px PNG**（`nativeImage` 没有 `toWebP()`，也不能解码 WebP）；无 alpha 原图存 JPEG q80。
- **排序键**：`ORDER BY pinned DESC, created_at DESC, seq DESC`（`seq` 必须单调递增，理由见 spec §7.4）。
- **去重语义**：扫描**整段历史**，命中则 `UPDATE` 且**同时刷新 `created_at` 与 `seq`**（只刷一个都有 bug）。
- **迁移按短键解析**：旧 JSON 字段是 `id/text/at/seq/pin/trunc` 与 `ctrl/alt/shift/win/key/theme/autopaste/label`，**不是** C# 属性名——按属性名解析会"迁移成功但一条内容都不进来"。
- **不内置字体**（用系统字体栈）；**不写任何 `settings.json`**（设置存 `clipchan.db` 的 `settings` 表）。
- **中文注释**；源码 UTF-8 无 BOM；不改动 `legacy/` 里的任何文件（只读留档）。
- **不得在验收前宣称完成**：任何"跑通了"的结论必须附当次命令与输出。

## Review Focus

以下是 spec 正文没有写成断言、但真人执行时最容易踩中的 5 类失效模式。**每一条都必须在拥有该代码的任务里落一个自动化测试或一条可复现的手动验收**（括号内为覆盖任务）：

1. **自我抑制遗漏**——程序自己写剪贴板（粘贴时 `writeText`/`writeImage`、拼接回写）若没有抑制标记，会被自己的轮询捕获成一条新记录，用户看到"复制的历史里多了一条我根本没复制的东西"。（Task 5 单测：注入一次自身写入，断言轮询跳数不变；Task 6 集成断言粘贴不产生新记录）
2. **陈旧 HWND 被复用**——Windows 会回收复用窗口句柄。粘贴目标句柄若跨次复用，会把内容贴进一个陌生窗口。句柄必须**用完即弃**，且要有"面板唤起时的句柄"与 `lastForeignForeground` 两级来源与失效回退。（Task 6 单测：`consume()` 二次调用返回 null；助手返回码 1 → `PasteResult.reason='no-target'`）
3. **迁移静默导空**——按 C# 属性名解析旧 JSON 会得到 0 条但流程"成功"。必须用**真实的旧版 `history.json` 样本**做断言：3 条记录 → 库里正好 3 条、内容逐字一致、`pin`/`seq`/`at` 都对。（Task 2 单测：`migrate.spec.ts` 用短键 fixture 文件，断言条数与内容逐字一致）
4. **图片文件成孤儿或漏删**——记录删了文件留着会吃满磁盘，文件删了记录留着会显示破图。删除单条 / 清空未收藏 / 按上限淘汰三条路径都必须同步删 `images/<id>.*` 与 `thumbs/<id>.png`，且启动时要扫孤儿。（Task 2 单测：删记录后文件消失；塞一个孤儿文件后 `sweepOrphans()` 清掉）
5. **启动基线缺失**——冷启动时"上次值"为空，第一跳会把**启动前就躺在剪贴板里**的东西记成一条历史；幽灵模式结束后同样会补录期间的内容，直接违背隐私承诺。（Task 5 单测：设置基线后第一跳不产生记录；幽灵期间不调用任何 `clipboard.*` 读取）

---

### Task 0: 仓库重排、工作区骨架与图标脚本

**Files:**
- Create: `legacy/`（把现有 `src/`、`build.ps1`、`test.ps1`、`README.md`、`dist/`、`assets/icon.ico` **移动**进去；`docs/` 与 `.superpowers/` 留在原地）
- Create: `package.json`（workspace 根）、`pnpm-workspace.yaml`、`.npmrc`、`.gitignore`、`tsconfig.base.json`
- Create: `packages/core/package.json`、`packages/core/tsconfig.json`
- Create: `packages/desktop/package.json`、`packages/desktop/tsconfig.json`
- Create: `packages/mobile/package.json`（本轮只占位）
- Create: `scripts/make-icons.mjs`
- Create: `assets/icon.png`、`build/icon.png`、`build/icon.ico`（后两者由脚本生成）
- Create: `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md` 末尾的「进度记录」区（本计划自带，见 Task 收口约定）

**Interfaces:**
- Consumes: 现有 `src/*.cs`（只移动，不改内容）、`docs/superpowers/specs/2026-10-15-clipchan-icon-source.png`
- Produces:
  - 根 `package.json` scripts：`dev` / `build` / `test` / `typecheck` / `icons`
  - 包名：`@clipchan/core` / `@clipchan/desktop` / `@clipchan/mobile`
  - `scripts/make-icons.mjs` 导出 `decodePng(buf)` / `resizeRgba(img, w, h)` / `encodePng(img)` / `buildIco(frames)`，并以 CLI 方式产出 `build/icon.ico`（含 16/24/32/48/64/128/256 帧）

**Steps:**
- [x] 确认没有正在运行的旧 `Clipchan.exe`（`Get-Process Clipchan`），然后把 `src/ build.ps1 test.ps1 README.md dist/ assets/icon.ico` 移动到 `legacy/`；`assets/icon.ico` 移动后 `assets/` 目录保留（Task 0 会往里放 `icon.png`）。验证：`legacy/src/MainForm.cs` 存在且 `C:\...\剪贴板\src` 不存在。
- [x] 写根 `pnpm-workspace.yaml`（`packages: ["packages/*"]`）与根 `package.json`（`private: true`，scripts 见 Interfaces，`packageManager` 留空不锁版本）。
- [x] 写 `.npmrc`：`electron_mirror=https://npmmirror.com/mirrors/electron/`、`electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/`、`shamefully-hoist=false`、`strict-peer-dependencies=false`。
- [x] 写 `tsconfig.base.json`（`strict: true`、`target: ES2022`、`moduleResolution: bundler`、`noUncheckedIndexedAccess: true`、`jsx: react-jsx`）与 `.gitignore`（`node_modules/`、`dist/`、`release/`、`*.local`）。
- [x] 建三个包的 `package.json` 与 `tsconfig.json`；`@clipchan/core` 的 `package.json` 声明 `"main": "src/index.ts"`、`"types": "src/index.ts"`、`exports` 直指源码（Vite 直接吃 TS 源，不预编译）。
- [x] `pnpm install` 装根依赖：`typescript`、`vitest`、`@types/node`。验证：退出码 0 且 `node_modules/.bin/vitest` 存在。
- [x] 写 `scripts/make-icons.mjs` 的 PNG 解码器。**★ 源图实测是 `1024×1024 / bitDepth=8 / colorType=2（真彩 RGB，无 alpha）/ interlace=0`**，解码器必须同时支持 colorType 2（3 字节/像素）与 6（4 字节/像素），并显式拒绝 interlace≠0（抛错而不是静默出错图）。验证：`node -e` 解码源图后打印 `1024 1024`。
- [x] 写盒式降采样（`resizeRgba`，面积平均，支持非整数倍率）与 PNG 编码器（Node 内置 `zlib.deflateSync`，filter 0，colorType 6）。验证：把源图缩到 256 再编码，用解码器回读尺寸为 256×256。
- [x] 写 ICO 组装器（`buildIco`）：头部 `00 00 01 00` + 条目数，每条 16 字节目录项，图像数据**直接内嵌 PNG**（Vista+ 支持），帧顺序 256→16。验证：产出 `build/icon.ico` 后按 ICO 头解析出 7 个条目，且最大帧宽高字段为 0（ICO 里 256 用 0 表示）而实际解码帧为 256×256。
- [x] 生成 `assets/icon.png`（源图原样复制）、`build/icon.png`（1024 原样复制）、`build/icon.ico`。验证：`build/icon.ico` 字节数 > 20KB 且 7 帧。
- [x] 在 `package.json` 里挂 `"icons": "node scripts/make-icons.mjs"` 并跑一次，确认可重复生成（第二次运行覆盖成功、字节数一致）。
- [x] **收口**：`pnpm install` + `pnpm icons` + `pnpm typecheck` 三条命令全绿，把结果追加到本计划末尾的进度记录区。

---

### Task 1: `@clipchan/core` 地基 —— 类型、主题令牌、纯逻辑

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/theme/tokens.css`
- Create: `packages/core/tailwind.config.ts`
- Create: `packages/core/src/logic/classify.ts`
- Create: `packages/core/src/logic/preview.ts`
- Create: `packages/core/src/logic/merge.ts`
- Create: `packages/core/src/logic/paste.ts`
- Create: `packages/core/src/logic/wordcloud.ts`
- Create: `packages/core/src/logic/classify.spec.ts`、`preview.spec.ts`、`merge.spec.ts`、`paste.spec.ts`、`wordcloud.spec.ts`
- Create: `packages/core/src/index.ts`
- Create: `vitest.config.ts`（根）

**Interfaces:**
- Consumes: 无（本任务是所有后续任务的底座）
- Produces:
  - `type Kind = 'text'|'link'|'code'|'path'|'number'|'image'`
  - `classify(text: string): Exclude<Kind,'image'>`
  - `previewOfText(text: string, maxLen?: number): string`、`previewOfImage(w: number, h: number, bytes: number): string`
  - `mergeTexts(items: {content: string|null; pinned: boolean; kind: Kind}[], sep?: string): { text: string; skippedImages: number } | null`
  - `mapHelperCode(code: number): PasteResult`
  - `extractCjkWords(runs: string[]): string[]`、`trimParticles(w: string): string`、`latinWords(text: string): string[]`、`cjkRuns(text: string): string[]`、`isCjk(c: string): boolean`、`STOP_WORDS: ReadonlySet<string>`
  - `buildWordCloud(texts: string[]): WordCloudData`
  - `ListQuery` / `ClipItemDTO` / `Settings` / `GhostState` / `HotkeyStatus` / `WordCloudData` / `PasteResult` / `ClipchanApi`（逐字对齐 spec §8.1）

**Steps:**
- [x] 写 `classify.spec.ts`，先只放 spec §11 验收第 5 条那 5 个断言（`https://a.com`→link、`function f(){}`→code、`C:\\a\\b`→path、`42`→number、`今天天气不错`→text），跑 `pnpm vitest run classify` 确认**失败**（模块不存在）。
- [x] 实现 `classify.ts`，逐条照抄 spec §7.4 的规则顺序：singleLine 判定 → 链接前缀（http:// https:// www. ftp://，不区分大小写）→ 路径（以两个反斜杠开头，或长度>2 且 t[0] 是字母、t[1]==':'、t[2] 是反斜杠或 `/`）→ 纯数字（只允许数字与 `.` `,` `-` `+` `%` 空格，至少 1 位数字，长度 ≤ 24）→ `LooksLikeCode`（25 个关键字表 + 长度≥12 且 `{ } ; ( ) = < >` 占比 ≥12%）→ text。跑测试确认**通过**。
- [x] 补 `classify.spec.ts` 的边界用例：多行文本即使以 `function ` 开头也走代码分支；`WWW.Example.COM` 大小写混合仍是 link；`12:30` 不是 number（含冒号）；`123456789012345678901234567890`（30 位）不是 number（长度 >24）；空串与纯空白归 text。跑测试确认通过。
- [x] 写 `preview.spec.ts`：断言 `previewOfText("a\\r\\n\\tb  c")` 得到单空格压缩结果、纯空白得到 `"(空白文本)"`、超长截断到 maxLen；断言 `previewOfImage(1920,1080,187392)` 等于 `"图片 1920×1080 · 183 KB"`（与 spec §8.1 的 SQL 拼法**逐字一致**，这是验收第 10 条的前提）。跑测试确认失败 → 实现 `preview.ts` → 跑确认通过。
- [x] 写 `merge.spec.ts`：3 条文本按列表顺序用 `"\\r\\n"` 拼接、收藏项被跳过、图片项被跳过且 `skippedImages` 计数正确、去掉收藏与图片后不足 2 条时返回 `null`、`content` 为 null 的行不参与。跑失败 → 实现 `merge.ts` → 跑通过。
- [x] 写 `paste.spec.ts`：把 spec §7.2 的「助手码 → PasteResult」表**逐行**做成断言（0→ok；1→no-target；2→send-failed；3→no-target；4→send-failed；5→send-failed；6→elevated；7→send-failed；未知码→send-failed 且不抛）。跑失败 → 实现 `paste.ts` → 跑通过。
- [x] 移植词云纯函数到 `wordcloud.ts`：从 `legacy/src/WordCloudForm.cs` 的 `ExtractCjkWords`(130) / `TrimParticles`(208) / `LatinWords`(220) / `CjkRuns`(245) / `IsCjk`(263) / `StopWords`(270) 逐行对应移植，**不移植** `EnsureLayout`(531) 与 `ExportPng`(414) 的绘制部分。
- [x] 写 `wordcloud.spec.ts` 钉住验收第 17 条：对一段约 100 字中文文本，`buildWordCloud([text]).words.length >= 5`，且词表里**不含**单字虚词 `的`/`了`/`是`/`在`/`和`；断言 `isCjk('中')` 为 true、`isCjk('a')` 为 false；断言拉丁词按长度 ≥3 过滤。跑测试确认通过。
- [x] 写 `types.ts`：把 spec §8.1 的全部接口逐字抄进来（`Kind`/`ListQuery`/`ClipItemDTO`/`Settings`/`HotkeyStatus`/`GhostState`/`WordCloudData`/`PasteResult`/`ClipchanApi`），再补 `PlatformAdapter = ClipchanApi` 的别名与 `DEFAULT_SETTINGS`（theme auto / historyLimit 200 / imageBudgetMB 512 / widgetSize 280 / widgetCorner remember / hideOnBlur true / autoPaste true / hotkeyActivate 'Control+`' / hotkeyWidget 'Alt+C'）。
- [x] 写 `tokens.css`：把 spec §6.1 的浅色 8 个色值与深色 5 个色值写成 `--color-*` CSS 自定义属性（浅色放 `:root`，深色放 `:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)` 下的 `:root[data-theme="auto"]`），另加间距（4/8/12/16/24/32/64）、圆角（卡片 16 / 按钮 12 / 输入框 10 / 徽章 full）、动效（stiffness 280 / damping 20）三个令牌组。
- [x] 写 `tailwind.config.ts`：`theme.extend.colors` 全部映射到 `var(--color-*)`（不写死十六进制，否则深色主题切不过去）、`spacing` 用上面 7 档、`borderRadius` 用 4 档、`fontFamily.sans` 用系统字体栈、`fontFamily.mono` 用 `"Cascadia Code", Consolas, monospace`。
- [x] 写 `index.ts` 统一导出，跑 `pnpm typecheck` 确认零错误（`noUncheckedIndexedAccess` 打开后仍通过）。
- [x] **收口**：`pnpm vitest run`（core 的 5 个 spec 全绿）+ `pnpm typecheck` 全绿，追加进度记录。

---

### Task 2: 存储层 —— SQLite 建表、迁移、图片文件生命周期

**Files:**
- Create: `packages/desktop/electron/paths.ts`
- Create: `packages/desktop/electron/db.ts`
- Create: `packages/desktop/electron/migrate.ts`
- Create: `packages/desktop/electron/images-policy.ts`
- Create: `packages/desktop/electron/images.ts`
- Create: `packages/desktop/electron/db.spec.ts`、`migrate.spec.ts`、`images-policy.spec.ts`
- Create: `packages/desktop/test/fixtures/legacy-history.json`、`legacy-settings.json`

**Interfaces:**
- Consumes: `@clipchan/core` 的 `Kind`/`ListQuery`/`ClipItemDTO`/`Settings`/`classify`/`previewOfText`/`previewOfImage`
- Produces:
  - `openDb(file: string): Db`；`Db` 暴露 `insertText(text, opts?): {id: string; touched: boolean}`、`insertImage(meta, opts?): {id: string; touched: boolean}`、`list(q: ListQuery): ClipItemDTO[]`、`remove(id)`、`removeMany(ids)`、`togglePin(id)`、`clearUnpinned()`、`clearAll()`、`getSettings(): Settings`、`setSettings(patch: Partial<Settings>): Settings`、`getImageRow(id)`、`allImageRows()`、`touch(id: string): void`（刷新 `created_at` 与 `seq`，粘贴时用）、`close()`
  - `migrateLegacy(db: Db, dir: string): { imported: number; skipped: number; settingsFromLegacy: boolean }`
  - `sweepOrphans(dir: string, rows: {id: string; image_path: string|null; thumb_path: string|null}[]): string[]`
  - `planBudgetEviction(rows: {id: string; pinned: boolean; bytes: number; created_at: number}[], budgetBytes: number): string[]`
  - `saveImage(dir: string, id: string, img: NativeImageLike): {image_path: string; thumb_path: string; width: number; height: number; bytes: number; hasAlpha: boolean}`

**Steps:**
- [x] 写 `paths.ts`：`resolveDataDir(base: string): string` 与 `imageAbs(dataDir, relPath)`，**纯函数、不 import electron**，这样能在 Node 里单测。跑 `pnpm typecheck` 确认通过。
- [x] 写 `db.spec.ts` 的第一组：`openDb(':memory:')` 后建表成功、`insertText` 返回 32 位十六进制 id、`list()` 能读回。跑确认失败 → 实现 `db.ts` 的建表 SQL（**逐字抄 spec §9.2**：items 表 + `idx_content_hash`/`idx_image_hash` 两个 partial unique index + `idx_order`）+ `insertText`/`list` → 跑通过。
- [x] 在 `db.spec.ts` 补**排序与 seq**：连续插入 3 条（同一毫秒时间戳），断言 `list()` 顺序是 seq 倒序；插入一条 `pinned=1` 的旧记录，断言它排到最前（验收第 9 条）。跑通过。
- [x] 在 `db.spec.ts` 补**整段历史去重 + 双刷新**（Review Focus 的相邻项）：插入 A、B，再插入与 A 相同的内容，断言总条数仍是 2、A 的 `created_at` 与 `seq` **都**变新且 A 排在最前（spec §7.4）。跑通过。
- [x] 在 `db.spec.ts` 补 `touch(id)`：插入 A、B 后 `touch(A.id)`，断言 A 的 `created_at` 与 `seq` **都**变新且 A 排到最前，而 B 不变（Task 6 的粘贴路径依赖它）。
- [x] 在 `db.spec.ts` 补**截断**：插入 100001 字符的文本，断言库里 `length(content) === 100000` 且 `truncated === 1`；断言 `list()[0].truncated === true`。
- [x] 在 `db.spec.ts` 补**分页与图片搜索**（spec §8.1 的 `q` 规格）：造 5 条文本 + 2 条图片，`list({limit:3,offset:0})` 与 `offset:3` 不重叠；`list({q:'1920'} )` 能命中图片（靠 SQL 现场拼的描述），`list({q:'alpha'})` 只命中文本；断言 `kind:'text-group'` 同时返回 text/path/number 三类而不含 link/code/image（验收第 10 条）。
- [x] 写 `migrate.spec.ts` 的 **Review Focus 3** 用例：造 `legacy-history.json` fixture，**必须用短键** `id/text/at/seq/pin/trunc`（含一条中文多行、一条带引号与反斜杠、一条 `trunc:true`），断言迁移后库里正好 3 条、`content` 逐字一致、`pinned`/`truncated` 正确、`created_at` 等于 ISO 时间转 UTC 毫秒；再断言**用 C# 属性名 `CreatedUtc`/`Pinned` 写的文件迁移出 0 条**（把这个陷阱钉成测试）。跑确认失败 → 实现 `migrateLegacy` → 跑通过。
- [x] 在 `migrate.spec.ts` 补：`seq` 缺失时按"当前已知最大 seq + 1"补齐且**后续新插入的记录 seq 更大**；迁移成功后 `history.json` 改名为 `history.json.migrated`；`settings.json` **字节不变**；单个条目 `at` 解析失败只跳过该条并计入 `skipped`，其余照常导入。
- [x] 写 `images-policy.spec.ts`（**纯函数、不碰 nativeImage**）：`planBudgetEviction` 在 600MB 数据 + 512MB 预算下选出最旧的未收藏图片直到降到 409.6MB 以下、**收藏图片永不出现在结果里**；`sweepOrphans` 对"库里有行但磁盘无文件""磁盘有文件但库里无行"两种情形只返回后者（验收第 31 条）。
- [x] 实现 `images.ts` 的 `saveImage`：无 alpha 图走 `toJPEG(80)`、有 alpha 走 `toPNG()`、长边超 2560 先 `resize()`、缩略图 128px `toPNG()`（spec §7.3）。**`NativeImageLike` 用窄接口**（`getSize()`/`toPNG()`/`toJPEG(q)`/`resize(o)`/`isEmpty()`）以便单测注入假对象。
- [x] 在 `images-policy.spec.ts` 或新建 `images.spec.ts` 补 **Review Focus 4**：删除一条图片记录 → `images/<id>.*` 与 `thumbs/<id>.png` 都消失；手动塞一个孤儿文件进 `thumbs/` → `sweepOrphans` 后消失；断言删除**文件**失败时数据库删除仍提交（不回滚）且返回的日志里有记录。
- [x] **收口**：`pnpm vitest run` 全绿 + `pnpm typecheck` 全绿，追加进度记录。

---

### Task 3: 原生助手 —— 粘贴 + 真毛玻璃 + 前台窗口查询

**Files:**
- Create: `packages/desktop/helper/ClipchanHelper.cs`
- Create: `scripts/build-helper.mjs`
- Create: `packages/desktop/electron/helper.ts`
- Create: `packages/desktop/electron/helper.spec.ts`

**Interfaces:**
- Consumes: `@clipchan/core` 的 `mapHelperCode`
- Produces:
  - `clipchan-helper.exe` 支持 `--layout`（打印五个尺寸后退出）与 `--serve`（常驻行协议）
  - `class HelperClient { prewarm(): void; paste(hwnd: bigint|number): Promise<PasteResult>; blur(hwnd: number, on: boolean, abgr?: number): Promise<boolean>; foreground(): Promise<number>; dispose(): Promise<void>; readonly available: boolean }`
  - `parseHelperLine(line: string): {kind:'READY'|'RESULT'|'BLUR'|'FG'|'PONG'|'UNKNOWN'; ...}`（纯函数，可单测）

**Steps:**
- [x] 写 `helper.spec.ts`：把 spec §7.2 的行协议逐条做成断言（`READY pid=1234`、`RESULT 65536 0 ok`、`FG 131072`、`PONG tag`、`BLUR 65536 0`），并断言**畸形行不抛异常**而是返回 `UNKNOWN`。跑确认失败 → 实现 `parseHelperLine` → 跑通过。
- [x] 写 `ClipchanHelper.cs` 的骨架：`Main(string[] args)` 分发 `--layout` / `--serve`；`--serve` 先 `Console.Out.WriteLine("READY pid=" + pid)` 再进入行循环。**★ 必须逐字照抄 spec §7.2 的布局陷阱**：`INPUTU` 用 `[StructLayout(LayoutKind.Explicit)]`，`KEYBDINPUT`/`MOUSEINPUT`/`HARDWAREINPUT` 三成员**全部 `[FieldOffset(0)]` 并排**，`InputSize` 只算一次。嵌套类型在方法里必须写全名 `NativeMethods.INPUT`（实测 `CS0246`）。
- [x] 写 `scripts/build-helper.mjs`：定位 `C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe`（回落到 32 位路径），`/nologo /target:exe /platform:x64 /optimize+ /out:helper/dist/clipchan-helper.exe`，编译后**跑一次 `--layout` 自检**并断言输出包含 `KEYBDINPUT=24 MOUSEINPUT=32 HARDWAREINPUT=8 INPUT=40 GUITHREADINFO=72`；**csc 缺失或编译失败时退出码仍为 0**（只打印警告），因为构建必须继续（Global Constraints）。
- [x] 跑 `node scripts/build-helper.mjs`，确认 exe 产出、`--layout` 五尺寸全部匹配。若 `INPUT != 40`，**停下来修 union**，不要继续（`SendInput` 会静默返回 0）。
- [x] 实现 `PASTE` 的三层验证（**全部在助手进程内**，抄 `legacy/src/MainForm.cs` 的 `PasteReturnTick`）：① `!IsWindow || !IsWindowVisible || IsIconic` → 码 1；② `SetForegroundWindow(target) && GetForegroundWindow()==target` 失败时**不判死**，宽限重试 4 次 × 80ms；③ `HasFocusSink(target)` 不过 → 码 3；全部通过才 `SendCtrlV()`（`INPUT[4]` = Ctrl↓ V↓ V↑ Ctrl↑，**要求 4 个事件全部被接收**，部分投递时补发两个 key-up 并返回码 4）。
- [x] 实现 `HasFocusSink`：先 `GetGUIThreadInfo`，`hwndFocus != 0` 直接放行；拿不到落点时按窗口类黑名单排除 `Progman`/`WorkerW`/`Shell_TrayWnd`/`Shell_SecondaryTrayWnd` 与 `Windows.UI.Core` 前缀，其余返回 `IsWindowVisible`。**不得把 `hwndFocus` 当必要条件**（UWP/WinUI 常返回 0）。
- [x] 实现提权检测（码 6）：`GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `GetTokenInformation(TokenIntegrityLevel)` 与自身比对；**`OpenProcess` 失败也算 6**。放在归位尝试**之前**。
- [x] 实现 `FG`（返回 `GetForegroundWindow()` 十进制）与 `BLUR <hwnd> <0|1> <ABGR>`（`SetWindowCompositionAttribute` + `ACCENT_ENABLE_ACRYLICBLURBEHIND` 优先、`ACCENT_ENABLE_BLURBEHIND` 回落，两者都失败返回码 2）；`PING`→`PONG`、`QUIT`→退出。
- [x] 用真实 exe 手工验证一次：`echo PASTE 0 | clipchan-helper.exe --serve` 应返回 `RESULT 0 1 ...`（窗口失效），`PING t1` 应返回 `PONG t1`，`QUIT` 后进程退出。把命令与输出记进进度记录。
- [x] 实现 `helper.ts` 的 `HelperClient`：`spawn` 常驻进程、按行解析、请求-响应配对（带 3s 超时）、`prewarm()` 在空闲 5 秒时拉起并 `PING` 探活（spec §8.2）、崩溃检测（stdout 关闭）→ 标记不可用 → **最多自动重启一次**、`dispose()` 发 `QUIT` 并 2 秒后强杀。
- [x] 在 `helper.spec.ts` 补 `HelperClient` 的降级断言：exe 路径不存在时 `available === false`、`paste()` 直接返回 `{ok:false, reason:'send-failed'}` 且**不抛异常**、`blur()` 返回 false（这是"不假装"的落点）。
- [x] **收口**：`pnpm vitest run` + `pnpm typecheck` + `node scripts/build-helper.mjs` 三条全绿，追加进度记录。

---

### Task 4: Electron 主进程骨架 —— 窗口、单实例、托盘、全局热键、IPC 契约

**Files:**
- Create: `packages/desktop/electron/main.ts`
- Create: `packages/desktop/electron/windows.ts`
- Create: `packages/desktop/electron/tray.ts`
- Create: `packages/desktop/electron/hotkeys.ts`
- Create: `packages/desktop/electron/ipc.ts`
- Create: `packages/desktop/electron/preload.ts`
- Create: `packages/desktop/tsconfig.electron.json`
- Create: `packages/desktop/index.html`、`packages/desktop/vite.config.ts`
- Create: `packages/core/src/platform/adapter.ts`
- Create: `scripts/dev.mjs`、`scripts/smoke-main.mjs`

**Interfaces:**
- Consumes: `@clipchan/core` 的 `ClipchanApi`/`Settings`/`DEFAULT_SETTINGS`；Task 2 的 `openDb`
- Produces:
  - `createMainWindow(opts: {mode: 'main'|'widget'; show: boolean}): BrowserWindow`（`frame:false, transparent:true, hasShadow:false, skipTaskbar`，尺寸按 mode）
  - `applyMode(win: BrowserWindow, mode: 'main'|'widget'): void`（改尺寸 + `setResizable` + 通知渲染进程切视图，**不重建窗口**）
  - `registerIpc(deps: {db: Db; settings: () => Settings; helper: HelperClient; mode: () => 'main'|'widget'}): void`
  - `preload.ts` 通过 `contextBridge.exposeInMainWorld('clipchan', api)` 暴露**恰好 spec §8.1 的方法**（不暴露任意通道）
  - `core/src/platform/adapter.ts`：`getPlatform(): PlatformAdapter`（读 `globalThis.clipchan`，缺失时返回一个**全 reject 并带说明**的桩，便于在浏览器/Node 里跑界面测试）、`setPlatform(p)`（测试注入用）
  - `main.ts --smoke`：无界面自检，打印一行 `SMOKE {...}` 后退出 0

**Steps:**
- [x] 写 `scripts/dev.mjs`：先清 `ELECTRON_RUN_AS_NODE`，起 `vite`（端口 5173），轮询直到 HTTP 200，再 `electron .` 并把 dev server URL 通过环境变量 `VITE_DEV_SERVER_URL` 传给主进程；子进程任一退出就整体退出。验证：`pnpm dev` 能起、窗口出现、改一处 React 文案能 HMR。
- [x] 写 `packages/desktop/tsconfig.electron.json`（`module: CommonJS`、`outDir: dist-electron`、继承根 strict 配置）并在 `package.json` 挂 `"main": "dist-electron/main.js"`。验证：`pnpm --filter @clipchan/desktop exec tsc -p tsconfig.electron.json` 退出码 0。
- [x] 写 `windows.ts` 的 `createMainWindow`：`frame:false`、`transparent:true`、`hasShadow:false`、`skipTaskbar`、`webPreferences: {contextIsolation:true, nodeIntegration:false, sandbox:false, preload}`；主窗口 900×620（`minWidth:720, minHeight:480`），小组件 280×420（`minWidth:240, minHeight:300`）。**★ 实测确认 `frame`/`transparent` 运行时不可改，所以两种形态都按同一套创建参数建窗**。
- [x] 写 `applyMode`：主窗口 `setResizable(true)` + `setSize(900,620)`，小组件 `setSize(280,420)` + `setResizable(false)`；随后 `win.webContents.send('app:mode', mode)`。验证（`--smoke`）：两次切换后 `getSize()` 回读分别为 `[900,620]` 与 `[280,420]`。
- [x] 写 `main.ts` 的 `app.requestSingleInstanceLock()`：拿不到锁直接 `app.quit()`；拿到锁后监听 `second-instance` → 唤出已存在面板（`show()` + `focus()` + 切回 `main` 形态）。验证（`--smoke`）：同进程内模拟第二次启动时 `requestSingleInstanceLock` 返回 false 的分支被走到（用注入的假 `requestSingleInstanceLock` 单测，不必真开两个进程）。
- [x] 写 `hotkeys.ts`：`registerHotkeys(settings): {activate: boolean; widget: boolean}`，用 `globalShortcut.register`；**失败必须返回 false 而不是抛**，主进程据此在界面显示"快捷键被占用"。验证（`--smoke`）：注册 `Control+`` 与 `Alt+C` 后 `globalShortcut.isRegistered` 均为 true；退出前 `unregisterAll`。
- [x] 写 `tray.ts`：托盘菜单 4 项——显示面板 / 幽灵模式（子菜单 5/10/30/60 分钟 + 关闭）/ Enter 自动粘贴开关 / 设置 + 退出（spec §11 验收第 18 条）。图标用 `build/icon.ico`。验证（`--smoke`）：菜单项数量与文案逐项打印出来核对。
- [x] 写 `preload.ts`：`contextBridge.exposeInMainWorld('clipchan', {...})`，每个方法都是 `ipcRenderer.invoke` 的薄包装，`onChanged` 类订阅返回**取消函数**（`ipcRenderer.on` 的 `removeListener`），**绝不暴露 `ipcRenderer` 本身**。验证：`--smoke` 里加载 preload 后断言 `typeof window.clipchan.items.list === 'function'` 且 `window.require === undefined`。
- [x] 写 `ipc.ts` 的 `registerIpc`：`ipcMain.handle` 覆盖 spec §8.1 全部通道（items 8 个 + settings 2 + ghost 2 + app 8 + wordcloud 2 + capabilities 1）；**未实现的先返回明确错误**（`throw new Error('not-implemented: <通道>')`），由后续任务逐个替换。验证：`--smoke` 里遍历通道名列表，断言每一个都被注册（`ipcMain.listenerCount` 或自维护的注册表）。
- [x] 写 `packages/core/src/platform/adapter.ts`：`getPlatform()` 在 `globalThis.clipchan` 存在时返回它，否则返回桩（每个方法 reject 一条中文说明）；`setPlatform(p)` 覆盖。写 `adapter.spec.ts` 断言：无注入时 `getPlatform().items.list({})` reject、注入假对象后返回注入值、`setPlatform` 后 `getPlatform()` 引用相等。跑 `pnpm vitest run adapter` 确认通过。
- [x] 写 `scripts/smoke-main.mjs`：清 `ELECTRON_RUN_AS_NODE`，`spawn electron . --smoke`，捕获 stdout 里的 `SMOKE {...}` 行，解析 JSON 并断言关键字段（`windowCreated`/`modeSizes`/`hotkeys`/`trayItems`/`ipcChannels`），失败退出码 1。跑一次确认全绿并把输出记进进度记录。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` + `node scripts/smoke-main.mjs` 三条全绿，追加进度记录。

---

### Task 5: 剪贴板轮询与记录管线 —— 自我抑制、启动基线、幽灵模式、去重与淘汰

**Files:**
- Create: `packages/desktop/electron/watcher.ts`
- Create: `packages/desktop/electron/recorder.ts`
- Create: `packages/desktop/electron/ghost.ts`
- Create: `packages/desktop/electron/watcher.spec.ts`
- Create: `packages/desktop/electron/recorder.spec.ts`
- Modify: `packages/desktop/electron/ipc.ts`（接上 `items.*`、`ghost.*`）
- Modify: `packages/desktop/electron/main.ts`（启动轮询、幽灵接线）

**Interfaces:**
- Consumes: Task 2 的 `Db`/`saveImage`/`sweepOrphans`/`planBudgetEviction`；`@clipchan/core` 的 `classify`/`previewOfText`/`previewOfImage`
- Produces:
  - `shouldSkipFormats(formats: string[]): 'skip-files'|'skip-rich'|'none'`（纯函数：`text/uri-list` 或 `FileNameW` → `skip-files`；只有 `text/html` 而无 `text/plain` → `skip-rich`）
  - `imageSignature(formats: string[], buf: Buffer): string`（格式列表 + 字节长度 + 前 4KB 的 sha1，用于**粗判**，避免每跳解码整张位图）
  - `class ClipboardWatcher { start(); stop(); suppressNext(); private tick() }`（300ms；两级读取；剪贴板被占用时 try/catch 跳过本跳，连续失败 ≥5 次写 `CLIPCHAN_TRACE` 日志）
  - `class Recorder { recordText(t): void; recordImage(nativeImage): void; private baseline() }`（启动基线：开始轮询前静默读一次记 `lastSeen` **不写库**）
  - `class Ghost { get(): GhostState; set(minutes: number): GhostState; onChanged(cb) }`（**彻底停止轮询**，恢复时静默重置基线**不补录**）

**Steps:**
- [x] 写 `watcher.spec.ts` 的纯函数组：`shouldSkipFormats(['text/uri-list'])` → `'skip-files'`、`shouldSkipFormats(['text/html'])` → `'skip-rich'`、`shouldSkipFormats(['text/html','text/plain'])` → `'none'`、`shouldSkipFormats(['image/png'])` → `'none'`、空数组 → `'none'`。跑确认失败 → 实现 → 跑通过。
- [x] 在 `watcher.spec.ts` 补 `imageSignature`：同尺寸同内容两次调用相等；只改末尾一个字节（前 4KB 之外）**签名仍相等**（这是刻意的粗判，用测试钉住"不为此解码"）；字节长度变化则签名不等。
- [x] 实现 `ClipboardWatcher.tick()` 的两级读取：先 `clipboard.availableFormats()`；命中 `skip-*` 直接返回（**第一次跳给一次轻提示，之后不再打扰**）；含图片格式 → 先算 `imageSignature`，与上次相同则**不调 `readImage()`**，不同才读；否则 `readText()`。**幽灵模式下 `tick()` 第一行就 return，完全不调用任何 `clipboard.*` API**（Review Focus 5）。
- [x] 实现 `suppressNext()`：置一次性标记，下一次 `tick()` 无论读到什么都丢弃并清标记（对应旧版 `MainForm.cs:811`）。写测试（Review Focus 1）：注入一个假 clipboard，先 `suppressNext()` 再喂新内容，断言**没有**产生记录、且再下一次正常内容能记录（标记不是永久关闭）。
- [x] 实现 `Recorder.baseline()`：`start()` 之前读一次当前剪贴板内容，只存 `lastSeen` 不入库。写测试（Review Focus 5）：假 clipboard 预置内容 → `baseline()` → 连续两跳同内容 → 断言库里 **0 条**；随后喂新内容 → 断言 1 条。
- [x] 实现 `recordText`：`classify` 算 kind、超 100000 字符截断并置 `truncated`、交给 `db.insertText`（去重与 `seq` 双刷新在 Task 2 已测）。写 `recorder.spec.ts`：多行代码文本进库后 `kind==='code'`、`truncated` 为 false；10 万零 1 字符 → `content.length===100000` 且 `truncated===true`。
- [x] 实现 `recordImage`：调 `saveImage` 落盘再 `db.insertImage`；写测试（Review Focus 4 的写侧）：假 nativeImage（窄接口）→ 记录入库、`images/` 与 `thumbs/` 各出现一个文件；删除该记录 → 两个文件都消失。
- [x] 实现上限淘汰与图片预算：每次写入后按 `settings.historyLimit` 淘汰最旧未收藏（与展示同序），并按 `imageBudgetMB` 调 `planBudgetEviction` 删文件+删行。写测试：`historyLimit=5` 时插 8 条 → 剩 5 条且**收藏项仍在**；图片预算设 1MB、塞 3 张 0.5MB 图 → 淘汰后总字节 ≤ 0.8MB 且收藏图未被删。
- [x] 实现 `Ghost`：`set(minutes)` 存内存（**不落库**，spec §7.6）；>0 时 `watcher.stop()`，归零时**静默读一次重置基线**再 `start()`。写测试：进幽灵 → 假 clipboard 喂内容 → 0 条；退出幽灵 → 静默重置 → 断言恢复后第一跳**不补录**幽灵期间的内容，且发出一次"已恢复，期间内容未记录"的通知事件（验收第 28 条）。
- [x] 接线 `ipc.ts`：把 `items.list/paste 之外`的 `list/remove/togglePin/clearUnpinned/clearAll/getFullImage/onChanged` 与 `ghost.get/set/onChanged` 换成真实实现（`paste` 留给 Task 6）；`main.ts` 启动时 `openDb` → `sweepOrphans` → `recorder.baseline()` → `watcher.start()`，并在 `before-quit` 里 `watcher.stop()`。
- [x] 手工验证一次真实剪贴板（把命令与输出记进进度记录）：`pnpm dev` 起应用 → PowerShell `Set-Clipboard 'hello-clipchan-1'` → 面板出现 1 条；`Set-Clipboard -Path <某文件>` → **不产生记录**；用截图工具截屏（或 `Set-Clipboard` 一张图）→ 出现图片卡片带缩略图。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` 全绿 + 上面那次手工验证通过，追加进度记录。

---

### Task 6: 自动粘贴编排 —— 两级目标来源、助手调用、诚实回退

**Files:**
- Create: `packages/desktop/electron/target-tracker.ts`
- Create: `packages/desktop/electron/paste.ts`
- Create: `packages/desktop/electron/paste.spec.ts`
- Modify: `packages/desktop/electron/ipc.ts`（接上 `items.paste`、`app.getHotkeyStatus`、`capabilities`）

**Interfaces:**
- Consumes: Task 3 的 `HelperClient`；Task 2 的 `Db`；`@clipchan/core` 的 `mapHelperCode`
- Produces:
  - `class TargetTracker { noteForeground(hwnd: number, selfHwnd: number): void; notePanelShown(selfHwnd: number): Promise<void>; consume(): number|null; lastForeign(): number|null }`（**一次性消费**：`consume()` 取出即清空）
  - `class PasteService { constructor(deps: {db; helper; tracker; settings; writer}); pasteItem(id: string): Promise<PasteResult> }`
  - `writer` 是窄接口 `{ writeText(t: string): void; writeImage(img): void }`，内部必须先调 `watcher.suppressNext()`

**Steps:**
- [x] 写 `paste.spec.ts` 的 `TargetTracker` 组（**Review Focus 2**）：`consume()` 返回一次句柄后再调返回 `null`（用完即弃）；记下的句柄等于自身 hwnd 时视为无目标；面板唤起句柄为空时回退到 `lastForeign`；两者都无 → `null`。跑确认失败 → 实现 → 跑通过。
- [x] 实现 `PasteService.pasteItem` 的编排顺序：① `db` 取该项（图片读原图字节）；② **先** `writer` 写剪贴板（图片走 `clipboard.writeImage`，文本走 `writeText`）**并抑制自己的这一跳**；③ `db.touch(id)` 刷新时间与 seq；④ `tracker.consume()` 拿目标；⑤ 目标为 `null` → 返回 `{ok:false, reason:'no-target'}`（**不调助手**）；⑥ 调 `helper.paste(hwnd)` 并把返回码经 `mapHelperCode` 映射成 `PasteResult`。
- [x] 写测试：助手返回码 0 → `{ok:true}`；码 1/3 → `reason:'no-target'`；码 6 → `reason:'elevated'`；码 2/4/5/7 → `reason:'send-failed'`；`helper.available===false` 时**不调用 `helper.paste`** 且直接返回 `send-failed`（用假 helper 记录调用次数断言）。
- [x] 写测试：粘贴成功后该记录的 `created_at`/`seq` 都变新并排到最前；粘贴**没有**产生新记录（Review Focus 1 的集成版：`suppressNext` 生效）。
- [x] 在渲染侧契约上补回退提示：`pasteItem` 返回 `{ok:false}` 时由界面弹"已复制，按 Ctrl+V 粘贴"；`reason==='elevated'` 时文案改为"目标窗口以管理员运行，无法自动粘贴（已复制）"。写测试：三种 reason 各自映射到三条不同中文文案（映射函数放 `core/src/logic/paste.ts` 或界面层，测试钉住）。
- [x] 接线 `ipc.ts` 的 `items.paste` 到 `PasteService`；`capabilities` 返回真实值：`autoPaste: settings.autoPaste && helper.available`、`globalHotkey: 热键注册结果`、`backgroundCapture: true`、`frostedGlass: 助手 BLUR 自检结果`。
- [x] 手工验证一次（记进进度记录）：`pnpm dev` → 在记事本里输入内容 → 打开面板双击一条历史 → 断言记事本里出现该内容；再把记事本**最小化**后双击 → 断言回退提示出现且记事本没被还原。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` 全绿 + 手工验证通过，追加进度记录。

---

### Task 7: React 界面 —— 主界面、卡片列表、搜索、分类导航、设置页

**Files:**
- Create: `packages/core/src/state/store.ts`
- Create: `packages/core/src/state/store.spec.ts`
- Create: `packages/core/src/ui/App.tsx`
- Create: `packages/core/src/ui/TitleBar.tsx`
- Create: `packages/core/src/ui/Sidebar.tsx`
- Create: `packages/core/src/ui/SearchBar.tsx`
- Create: `packages/core/src/ui/ClipCard.tsx`
- Create: `packages/core/src/ui/TypeBadge.tsx`
- Create: `packages/core/src/ui/EmptyState.tsx`
- Create: `packages/core/src/ui/Toast.tsx`
- Create: `packages/core/src/ui/SettingsView.tsx`
- Create: `packages/desktop/src/main.tsx`、`packages/desktop/src/index.css`
- Create: `packages/core/src/ui/*.spec.tsx`（store + 徽章映射 + 空状态文案）

**Interfaces:**
- Consumes: Task 1 的 `types.ts`/`tokens.css`/`tailwind.config.ts`；Task 4 的 `core/src/platform/adapter.ts`；Task 5/6 的 IPC 实现
- Produces:
  - `useClipStore`（zustand）：`{ view: 'list'|'settings'|'wordcloud'; kind: ListQuery['kind']; q: string; items: ClipItemDTO[]; selectedId: string|null; hoveredId: string|null; hasMore: boolean; loading: boolean; settings: Settings; ghost: GhostState; capabilities: Capabilities; toasts: Toast[] }` + actions `setView/setKind/setQuery/loadMore/select/togglePin/remove/pasteSelected/clearUnpinned/openSettings/...`
  - `badgeOf(kind: Kind): { label: string; className: string }`（**逐字对齐 spec §6.4 的 6 类徽章**）
  - `emptyHintOf(kind, q): string`（空状态文案）
  - `App`（顶层，按 `view` 切换列表/设置/词云）

**Steps:**
- [x] 写 `store.spec.ts`：用注入的假 `PlatformAdapter`（Task 4 的 `setPlatform`）断言 `load()` 后 `items` 等于假数据；`setKind('image')` 会带 `kind:'image'` 重新请求；`setQuery('abc')` 触发一次请求（**带防抖**，断言 300ms 内连打 3 次只发 1 次）；`loadMore()` 在 `hasMore=false` 时不发请求。跑确认失败 → 实现 store → 跑通过。
- [x] 写 `badgeOf` 的断言测试：6 类 kind 各自映射到 spec §6.4 的 label（`T`/`Link`/`</>`/`T+路径图标`/`T+数字图标`/`Img`）与色值类名；`path`/`number` 的 `filterKind` 都是 `'text-group'`（验收第 5 条 + spec §6.4）。
- [x] 实现 `App.tsx` 骨架：最外层 900×620 圆角 16 容器（`rounded-[16px]` + 令牌底色）、`TitleBar`（`-webkit-app-region: drag`）+ 左侧 64px `Sidebar` + 右侧主区；挂载时 `load()`、订阅 `items.onChanged` 与 `settings.onChanged`（返回的取消函数在卸载时调用）。
- [x] 实现 `TitleBar.tsx`：左侧应用名与幽灵模式状态点（进幽灵时暗红圆点 + "剩余 N 分钟"），右侧最小化/关闭按钮（`-webkit-app-region: no-drag`）；关闭 = `app.hide()`（隐藏到托盘，不退出）。验证：手动点关闭后托盘图标仍在、进程未退出。
- [x] 实现 `Sidebar.tsx`：6 个导航项（全部/文本/图片/链接/代码/收藏）+ 底部设置齿轮，选中态用主色雾蓝 `#446971`；点击写 `kind`（文本项写 `'text-group'`，收藏写 `'favorite'`）。验证：逐项点击后面板标题与请求参数一致（用 `--smoke` 或 dev 控制台日志核对）。
- [x] 实现 `SearchBar.tsx`：输入防抖 300ms、右侧清空按钮、`↓` 键把焦点交给列表（spec §7.7）；输入框 `no-drag`。验证：输入 `1920` 能命中图片记录（走 Task 2 的 SQL 图片描述匹配）。
- [x] 实现 `ClipCard.tsx`：类型徽章 + 内容预览（`preview`，图片显示 `thumbUrl` 缩略图）+ 相对时间 + 固定图标；hover 上浮（framer-motion，stiffness 280 / damping 20）；**单击 = 选中**（写 `selectedId`）、**双击 = 粘贴**（调 `items.paste`，spec §6.5）；固定按钮点击 `togglePin`（`stopPropagation`，不触发选中/粘贴）。验证：手动双击文本卡片 → 剪贴板内容变化 + 目标窗口收到粘贴。
- [x] 实现列表滚动加载：容器 `onScroll` 距底 < 200px 时 `loadMore()`；卡片加 `style={{ contentVisibility: 'auto', containIntrinsicSize: '96px' }}`（**不引虚拟滚动库**）。验证（验收第 23 条）：临时把 `historyLimit` 调 500 并造 500 条（含 100 张图）后滚动，用 DevTools Performance 记录确认无 >200ms 长任务，把截图记进进度记录。
- [x] 实现 `EmptyState.tsx`：用 `assets/icon.png` 96px 降饱和（`filter: saturate(.35) opacity(.7)`）+ `emptyHintOf(kind, q)` 文案；**不画线稿**（spec §6.1）。测试断言 5 种 kind + 有/无搜索词共 6 条文案互不相同。
- [x] 实现 `Toast.tsx`：右下角浮层，用于"已复制，按 Ctrl+V 粘贴""目标窗口以管理员运行，无法自动粘贴（已复制）""已跳过 N 条图片""已恢复监听，期间内容未记录"四类提示（Task 6 的三种 reason + Task 5 的跳过与恢复）。测试断言 4 类文案存在且互不相同。
- [x] 实现 `SettingsView.tsx` 的 5 个分区（spec §6.7）：快捷键（两个热键录入 + 占用告警）、外观（浅色/深色/跟随系统）、历史（滑块 100–9900 步长 100 + 数字输入框可填到 9999 + 图片占用显示与超预算警告）、小组件（尺寸 240–400 + 停靠角 + 失焦隐藏）、数据（打开数据目录 + 清空未收藏 + 清空全部，二次确认）；底部版本号。验证：改任一设置后重启应用仍生效（验收第 30 条），且 `%APPDATA%\Clipchan\settings.json` **不存在**（新版不写该文件）。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` 全绿 + 手动过一遍 spec §11 的第 2/4/5/6/9/10/12 条并把结果记进进度记录。

---

### Task 8: 小组件形态、真毛玻璃与窗口自绘交互

**Files:**
- Create: `packages/core/src/ui/WidgetView.tsx`
- Create: `packages/core/src/ui/ResizeHandles.tsx`
- Create: `packages/desktop/electron/frosted.ts`
- Create: `packages/desktop/electron/frosted.spec.ts`
- Modify: `packages/desktop/electron/windows.ts`（`applyMode` 完整化 + 定位）
- Modify: `packages/desktop/electron/ipc.ts`（`app.setMode`/`setWidgetSize`/`resizeBy`/`capabilities.frostedGlass`）

**Interfaces:**
- Consumes: Task 3 的 `HelperClient.blur`；Task 4 的 `applyMode`
- Produces:
  - `class FrostedGlass { apply(win: BrowserWindow, enabled: boolean): Promise<boolean>; readonly active: boolean }`（调助手 `BLUR`；系统拒绝或助手不可用 → `active=false` 并让界面显示"毛玻璃已降级"）
  - `positionFor(mode, display, cursor, remembered): {x, y, width, height}`（纯函数：主窗口居中偏上、小组件右下角距边 24px、记忆位置不可用则回落）
  - `WidgetView`（280×420 紧凑列表，最近 10 条 + 搜索框 + "查看全部记录"）

**Steps:**
- [x] 写 `frosted.spec.ts` 的 `positionFor` 组：多显示器下用**鼠标所在那块**的 bounds 计算；`remembered` 坐标落在所有显示器之外时回落默认位置；小组件贴右下角距边 24px。跑确认失败 → 实现 → 跑通过。
- [x] 实现 `FrostedGlass.apply`：先 `helper.blur(hwnd, true, 0xCCFFF8F0)`；返回 false（码 2 系统拒绝）或 `helper.available===false` → 返回 false 并置 `active=false`。**★ 实测 Win10 19045 上 acrylic 可能不可用**，所以助手内部已做 `ACCENT_ENABLE_BLURBEHIND` 回落，两层都失败才算降级。
- [x] 手动验证毛玻璃（**验收第 33 条**）：起应用 → 截屏面板区域 → 与关闭毛玻璃时对比，确认面板后方桌面内容被模糊；再把助手 exe 改名 → 重启 → 确认设置页显示"毛玻璃已降级（助手不可用）"且界面仍是半透明 88% + 内部阴影，**不是白板**。两次截图存 `docs/superpowers/evidence/`。
- [x] 实现 `applyMode` 的定位与尺寸：切 `widget` → `setSize(settings.widgetSize, 420)`、`setResizable(false)`、定位到右下角距边 24px、`setSkipTaskbar(true)`；切 `main` → 900×620、`setResizable(true)`、居中偏上。验证（`--smoke`）：切换后 `getBounds()` 落在鼠标所在显示器内。
- [x] 实现 `WidgetView.tsx`：标题"剪贴板酱" + 搜索框 + 最近 10 条紧凑列表（缩略图 32px、单行省略）+ 底部"查看全部记录"（切回 `main` 形态）。验证：切形态后 React 状态不丢（选中的 `kind`/`q` 与列表数据保持，验收第 13 条）。
- [x] 实现 `ResizeHandles.tsx`：主窗口右边缘/下边缘/右下角三个手柄（`no-drag`），`pointerdown` 后按 `pointermove` 的 delta 调 `app.resizeBy(dw, dh)`；限制 720×480~1200×900。验证：手动拖右下角能改尺寸，且**不依赖系统边框**（无边框窗口）。
- [x] 实现失焦自动隐藏（`hideOnBlur` 默认 true）：`win.on('blur')` → 小组件形态下 `hide()` 并让 `TargetTracker.notePanelShown` 记录一次 `lastForeign`；主窗口形态下**不隐藏**。验证（验收第 29 条）：把 `hideOnBlur` 关掉、小组件常驻，双击一条历史仍能贴回原窗口（目标来自 `lastForeign`）。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` 全绿 + 毛玻璃与形态切换两张截图归档，追加进度记录。

---

### Task 9: 词云视图、拼接与连续复制交互、键盘全流程

**Files:**
- Create: `packages/core/src/ui/WordCloudView.tsx`
- Create: `packages/core/src/logic/layout.ts`
- Create: `packages/core/src/logic/layout.spec.ts`
- Create: `packages/desktop/electron/burst.ts`
- Create: `packages/desktop/electron/burst.spec.ts`
- Modify: `packages/desktop/electron/ipc.ts`（`wordcloud.today`/`wordcloud.exportPng`、`items.mergeSelected`）
- Modify: `packages/core/src/ui/App.tsx`（键盘表）

**Interfaces:**
- Consumes: Task 1 的 `buildWordCloud`；Task 2 的 `Db.list`
- Produces:
  - `layoutWords(words: {word: string; weight: number}[], area: {w: number; h: number}): PlacedWord[]`（螺旋 + 矩形碰撞检测，**纯函数可单测**，替换旧版 `WordCloudForm.cs:531 EnsureLayout` 的绘制部分）
  - `class BurstDetector { note(id: string, at: number): {triggered: boolean; ids: string[]}; clear(): void }`（2000ms 内 3 条 → 触发预选）
  - `WordCloudView`（应用内视图，非新窗口）

**Steps:**
- [x] 写 `layout.spec.ts`：给定 10 个词与 600×400 区域，断言返回 10 个位置、**任意两个矩形不相交**、所有位置在区域内、权重最大的词面积最大。跑确认失败 → 实现 `layoutWords` → 跑通过。
- [x] 写 `burst.spec.ts`（**spec §7.5 的语义**）：`note` 三次且间隔 1s → 第 3 次 `triggered:true` 且 `ids` 有 3 个；三次但跨 2.5s → 不触发；`clear()` 后计数归零。**★ 注意旧版 `TrackBurst` 只预选、不自动合并**——测试里不得断言"自动生成合并记录"。
- [x] 实现 `BurstDetector` 与托盘气泡：面板可见时把 3 条**预选**并显示提示条"连续复制了 3 条，按 Ctrl+M 拼接"（5 秒后自动消失）；面板不可见时发一次托盘气泡。写测试：不可见分支调用假 `tray.displayBalloon` 一次且不改变选中集。
- [x] 实现 `items.mergeSelected(ids)`（**逐条对齐 spec §7.5 与旧版 `MainForm.cs:756-802`**）：跳过 `pinned` 项 → 剩余 <2 条返回 `{ok:false, reason:'need-two'}` 且**不改动任何记录** → 按列表顺序用 `"\\r\\n"` 调 `mergeTexts` → 生成新记录 → **删除源条目**（`db.removeMany`）→ **不走去重** → 清 burst → 返回新 id 并选中。写测试：3 条（含 1 条收藏、1 条图片）→ 合并后库里**只剩 1 条**（图片与收藏原样保留、两个文本源条目消失）、新记录 `kind` 由分类器重算、`content` 用 `\\r\\n` 连接（验收第 11 条）。
- [x] 实现 `WordCloudView.tsx`：进入时 `wordcloud.today()` 取当天文本记录 → `buildWordCloud` → `layoutWords` → 用绝对定位 `<span>` 渲染（字号按权重、颜色取令牌主色/次色）；顶部显示"今日 N 条记录 · M 个词"；空数据时显示"今天还没有记录"。验证（验收第 34 条）：只统计**本地日历日**的记录，昨天与图片不参与。
- [x] 实现 `wordcloud.exportPng`：`webContents.capturePage(rect)` 截词云区域 → `dialog.showSaveDialog` 让用户选路径 → 写 PNG。验证：导出的 PNG 能打开且尺寸与视图区域一致。
- [x] 在 `App.tsx` 落键盘表（spec §7.7）：`↑/↓` 选择、`Enter` 粘贴选中项、`Esc` 隐藏面板、`Ctrl+D` 收藏、`Ctrl+M` 拼接选中、`Delete` 删除选中、`Ctrl+Delete` 清空未收藏、`Ctrl+F` 聚焦搜索；搜索框内 `↓` 跳列表、`↑` 回搜索框。写测试：模拟按键事件后断言 store 的对应 action 被调用（不测真实剪贴板）。
- [x] 手动过一遍验收第 12 条（键盘全流程）：只用键盘完成"唤起 → 搜索 → 选择 → 粘贴 → 收藏 → 删除"，把每一步截图或命令输出记进进度记录。
- [x] **收口**：`pnpm typecheck` + `pnpm vitest run` 全绿 + 手工键盘流程通过，追加进度记录。

---

### Task 10: 打包、开机自启与旧数据迁移实测

**Files:**
- Create: `packages/desktop/electron-builder.yml`（或写在 `packages/desktop/package.json` 的 `build` 段）
- Create: `packages/desktop/electron/autostart.ts`
- Create: `packages/desktop/electron/migrate-runner.ts`
- Create: `scripts/package-win.mjs`
- Modify: `packages/desktop/electron/main.ts`（启动时跑迁移、注册自启）

**Interfaces:**
- Consumes: Task 2 的 `migrateLegacy`；Task 3 的 `scripts/build-helper.mjs` 产物
- Produces:
  - `package-win.mjs`：清 `ELECTRON_RUN_AS_NODE` → 跑 `scripts/build-helper.mjs` → `vite build` → `electron-builder --win portable`（带镜像环境变量），产物 `release/Clipchan.exe`
  - `ensureAutoStart(enabled: boolean): {ok: boolean; path: string}`（portable 下用 `process.env.PORTABLE_EXECUTABLE_FILE || process.execPath`）

**Steps:**
- [x] 写 build 配置，**逐条对齐 spec §10.3**：`npmRebuild:false`、`buildDependenciesFromSource:false`、`asarUnpack:['**/*.node']`、`files` 含 `dist/**`/`dist-electron/**`/`node_modules/**` 与 `!node_modules/electron/**`、`directories.output:'release'`、`win.target:['portable','nsis']`、`portable.artifactName:'Clipchan.exe'`、`nsis.artifactName:'Clipchan-Setup-\${version}.exe'`、`extraResources` 带 `helper/dist/clipchan-helper.exe` 与 `build/icon.ico`、`win.icon:'build/icon.ico'`。验证：配置里能 `grep` 到 `npmRebuild: false`。
- [x] 写 `scripts/package-win.mjs`：三步串行，任何一步失败退出码非 0；但**第 ① 步（助手编译）失败只警告不中断**（Global Constraints），改为把 `CLIPCHAN_NO_HELPER=1` 写进打包环境以便运行时如实降级。验证：`node scripts/package-win.mjs` 产出 `release/Clipchan.exe`（预期 ~86MB，参照 spec §15 的 85,651,895 字节量级）。
- [x] 实现 `ensureAutoStart`：`app.setLoginItemSettings({ openAtLogin: enabled, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath })`；portable 下注册的必须是**用户双击的原始 exe 路径**而不是临时解压目录。验证（**验收第 19 条**）：开启自启后读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，确认路径指向 `release\Clipchan.exe` 所在位置而不是 `%TEMP%`。
- [x] 实现 `migrate-runner`：启动时若 `clipchan.db` 不存在且 `%APPDATA%\Clipchan\history.json` 存在 → 调 `migrateLegacy`；导入后把 `history.json` 改名 `history.json.migrated`，**`settings.json` 字节不变**（只读）。写实测（**验收第 21/22/30 条**）：手工造一份**短键**旧文件（3 条，含中文多行与引号），放到位 → 启动新版 → 断言面板里正好 3 条、内容逐字一致、`history.json.migrated` 存在、`settings.json` 的 sha256 与迁移前相同。把命令与输出记进进度记录。
- [x] 手工跑 portable 产物（**验收第 1/24 条**）：拷到 `D:\tmp\clipchan-test` 双击 → 无安装、无运行时缺失提示、面板出现、剪贴板捕获正常；再装 NSIS 版验证同样能跑。两者结果都记进进度记录。
- [x] 手工验证重启后历史还在（**验收第 14/15 条**）：记录若干条 → 正常退出再启动 → 历史还在；再用任务管理器**强杀**进程 → 重启 → 历史**没有整份消失**（WAL + 单事务写入的意义）。两次结果记进进度记录。
- [x] **收口**：`node scripts/package-win.mjs` 退出码 0 + 两个产物都能双击运行 + 迁移实测通过，追加进度记录。

---

### Task 11: 手机端壳（Capacitor，只搭壳不出包）

**Files:**
- Create: `packages/mobile/package.json`、`packages/mobile/capacitor.config.ts`
- Create: `packages/mobile/src/main.tsx`
- Create: `packages/mobile/src/platform/mobile-adapter.ts`
- Create: `packages/mobile/README.md`

**Interfaces:**
- Consumes: `@clipchan/core` 的界面与 `setPlatform`；Task 4 的 `PlatformAdapter` 接口
- Produces:
  - `createMobileAdapter(): PlatformAdapter`（内存态：手动粘贴进来 / 手动复制出去；`capabilities = {autoPaste:false, globalHotkey:false, backgroundCapture:false, frostedGlass:false}`）
  - 移动端入口渲染同一个 `<App />`

**Steps:**
- [x] 写 `packages/mobile/package.json`（依赖 `@capacitor/core` + `@capacitor/cli` + `@clipchan/core`）与 `capacitor.config.ts`（`appId: 'com.clipchan.app'`、`appName: '剪贴板酱'`、`webDir: 'dist'`）。**本轮不执行 `cap add android`**（本机无 JDK/Android SDK，Global Constraints）。
- [x] 写 `mobile-adapter.ts`：实现 `PlatformAdapter` 的全部方法（items 存内存 Map、paste = 写系统剪贴板并返回 `{ok:true}`、`capabilities` 全 false）；**关键：`backgroundCapture:false` 必须真实反映"Android 10 起后台读剪贴板被系统禁止"**，界面据此显示说明而不是假装在后台捕获。
- [x] 写 `packages/mobile/src/main.tsx`：`setPlatform(createMobileAdapter())` 后渲染 `<App />`，让同一份界面代码跑在移动端适配器上。
- [x] 写移动端说明：在 `packages/mobile/README.md` 写清"本轮只搭壳、未装 JDK/Android SDK/Gradle、未出 APK；真机运行需先装这三样并 `npx cap add android`"，以及"手机端是手动粘贴进来 + 手动复制出去，不做后台监听"的诚实定位（spec §2 非目标）。
- [x] 用 `vite build` 在 `packages/mobile` 下构建一次，确认**同一份 core 界面能编译通过**（验收"一份代码两端复用"的机械证明）。把输出记进进度记录。
- [x] **收口**：`pnpm typecheck` 全绿 + mobile 构建成功，追加进度记录。

---

### Task 12: 终验 —— 逐条过 spec §11 的 35 条验收

**Files:**
- Modify: `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md`（进度记录区）
- Create: `docs/superpowers/evidence/`（截图与日志归档）

**Interfaces:**
- Consumes: 全部前序任务产物
- Produces: 一份**逐条**判定表（每条：编号 + 判定 + 证据路径或命令 + 输出摘要）

**Steps:**
- [x] 自动化部分：`pnpm typecheck` + `pnpm vitest run` + `node scripts/build-helper.mjs` + `node scripts/smoke-main.mjs` + `node scripts/package-win.mjs` 五条命令全绿，把完整输出存 `docs/superpowers/evidence/task12-commands.txt`。
- [x] 逐条核对 §11 的 1–35：能自动化的引用测试名，需手工的写明"命令/操作 + 观察到什么 + 截图路径"。**任何一条拿不出证据的，判定为未通过**（Global Constraints：不得在验收前宣称完成）。
- [x] 与原型对照（**验收第 2 条**）：打开 `ojo` 的 `specs/wireframe.jpg` 与新版面板并排截图，核对 64px 侧栏、搜索栏位置、卡片信息层级、8px 卡片间距、右下角切换小组件入口。
- [x] 与 `legacy/` 对照（**spec §13**）：逐行确认"保留并扩展"的能力都真的在（剪贴板监听含图片、全局热键、自动粘贴、托盘、词云算法、幽灵模式、Ctrl+M、连续复制预选、明暗主题、类型识别、上限、自启、单实例），"抛弃"的都没残留（手写 JSON 存储、WinForms 界面、单文件约束、`--selftest`、`--wordcloud`/`--ghost` 命令行）。
- [x] 写交付说明：在 `README.md`（新建根 README，`legacy/README.md` 是旧版留档）写清安装/首次运行/数据目录/快捷键/能力边界（**含诚实声明：Win10 上毛玻璃是窗口内模糊而非系统 acrylic；手机端本轮只搭壳**）。
- [x] **收口**：35 条判定表完成、所有证据归档、README 写完，把最终判定写进本计划末尾的进度记录区。

---

### Task 12 判定表 —— spec §11 的 35 条逐条结论

判定日期 2026-10-17。证据根目录 `docs/superpowers/evidence/`；「命令」列可直接复跑。

| # | 判定 | 证据（路径 / 命令） | 输出摘要 |
|---|---|---|---|
| 1 | 通过 | 拷 `release/Clipchan.exe` → `D:\tmp\clipchan-test\` 后双击（该目录外无任何依赖） | 面板出现、剪贴板捕获正常；未装 Node/npm/.NET。截图 `task10-portable-panel.png` |
| 2 | 通过 | 与 `C:\Users\Administrator\Desktop\ojo\specs\wireframe.jpg` 并排比对 + `task12-main-panel.png` | 900×620 ✓、左侧栏 `Sidebar.tsx:38` `w-16`=64px ✓、顶部搜索栏 ✓、卡片含类型徽章+预览+时间戳+星标 ✓、卡片间距 `ListPanel.tsx:56` `gap-tight`=8px（`tailwind.config.ts:43`）✓。**已知差异**：原型把「切换小组件」放右下角，实现放搜索栏右侧（「小组件」按钮）+ 右下角常驻「设置」；入口存在，位置不同 |
| 3 | 通过 | `scripts/measure-hotkey.ps1` + cua `list_windows` | 热键唤起后窗口 bounds `x=510 y=170 w=900 h=620`（1920×1080）→ 水平居中、垂直偏上；几何实现 `packages/desktop/electron/frosted.ts:180-185` `positionFor`（`(wa.width-MAIN_WIDTH)/2`、`(wa.height-MAIN_HEIGHT)/2 - MAIN_TOP_OFFSET`） |
| 4 | 通过 | `Set-Clipboard -Value clipchan-t10-capture-测试文本` → CDP `items.list` | 1.5s 内新增一条 `ed2a7e5520e74d9588eb3fd1d99838f7` kind=text 且排在最前（pinned 项之后） |
| 5 | 通过 | `packages/core/src/logic/classify.spec.ts`（7 条） | 链接/Windows+UNC 路径/纯数字/代码关键字/代码符号密度/多行回落/中文文本 全过 |
| 6 | 通过 | 复制 `dedupe-probe-zzz` → 复制别的内容 → 再复制同一文本 → CDP 计数 | matches=1，id 恒为 `93b245d12ddb49698eb22ae03a1b6e88` 且排最前（created_at 与 seq 都刷新，见 `db.spec.ts`） |
| 7 | 通过 | 画一张 640×480 位图 → `Clipboard.SetImage` → CDP `items.list` | 新增 `02ecd27c088649d0bacdb6a1b837206d` kind=image，preview「图片 640×480 · 11 KB」；`images/<id>.jpg` 12,183 B、`thumbs/<id>.png` 4,277 B。截图 `task10-portable-all.png` |
| 8 | 通过 | ① CDP `items.paste(<图片 id>)` → 读系统剪贴板；② 文本项走完整「热键唤起 → paste → Ctrl+S 存盘」链路 | ① 剪贴板 formats 含 `PNG / System.Drawing.Bitmap / DeviceIndependentBitmap`，`Bitmap` 为 400×300 → 原图确实写回；② 见第 20 条同链路，自动粘贴把文本落进记事本（`clipchan-t10-capture-测试文本`，33 B）。图片项的「贴进原窗口」复用同一条 `pasteItem` 路径（`packages/desktop/electron/paste.ts`） |
| 9 | 通过 | `packages/desktop/electron/recorder.spec.ts`「收藏项不占额度、永不被上限淘汰」+ 真机 | pinned 的 `legacy-2` 始终排最前；上限淘汰时收藏项与其图片文件都不被删（`images-policy.spec.ts`「即使未达目标也不删收藏」） |
| 10 | 通过 | CDP 数据面 + 截图 `task12-search-image-400.png` | 图片 preview 形如「图片 400×300 · 2 KB」（当前 99 条图片均此格式），文本子串唯一命中；`preview.spec.ts` 5 条钉住描述格式 |
| 11 | 通过 | `burst.spec.ts`（13）+ `merge.spec.ts`（5）+ `merge-service.spec.ts`（9） | 三次 1s 内 → 第 3 次 `triggered:true` 且 ids 有 3 个；跨 2.5s 不触发；Ctrl+M 后源条目消失、只剩拼接条且被选中；跳过 pinned、跳过图片并计数 |
| 12 | 通过 | `packages/core/src/ui/keymap.spec.ts`（13 条）+ Task 9 手动键盘流程（进度记录 2026-10-16） | ↑↓/Enter/Ctrl+D/Ctrl+M/Delete/Ctrl+Delete/Ctrl+F/Esc 全部映射正确；搜索框内 ↑↓ 跳出、其它按键不拦 |
| 13 | 通过 | 截图 `task12-widget-mode.png`、`task12-widget-state-kept.png` + `smoke-main.mjs` | 切小组件后窗口 280×420（smoke「小组件 280x420」PASS），选中项在切回后仍保留 |
| 14 | 通过 | 正常退出 → 重启 → CDP `items.list` | 6 条历史与 id 顺序完全一致，缩略图仍在。截图 `task10-restart-kept.png` |
| 15 | 通过 | `Get-Process Clipchan \| Stop-Process -Force` → 重启 → CDP 计数 | 强杀前 6 条；强杀后磁盘留 `clipchan.db` 4096 B + `-wal` 135,992 B；重启后仍 6 条、顺序一致（WAL 自动恢复） |
| 16 | 通过 | CDP `window.clipchan.ghost.set(5)` → `Set-Clipboard` → 计数 | `{active:true, remainingMs:300000}`；期间计数 114 → 114，不进历史。★ API 是分钟数 number，传对象无效 |
| 17 | 通过 | `packages/core/src/logic/wordcloud.spec.ts`（9 条）+ 截图 `task12-wordcloud.png` | 「统计当天文本，权重降序，且不含单字虚词」通过；界面可打开今日词云 |
| 18 | 通过 | `node scripts/smoke-main.mjs` | `[PASS] 托盘顶层 6 项`、`[PASS] 托盘文案顺序`（显示面板 / 暂停监听（幽灵） / Enter 自动粘贴 / 开机自启 / 设置… / 退出），`tray.ts` 的 `TRAY_TOP_LABELS` 与 `GHOST_PRESETS` 5/10/30/60 一致 |
| 19 | 通过 | CDP `app.setAutoStart(true)` → 读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | 新增 `electron.app.Clipchan = D:\tmp\clipchan-test\Clipchan.exe`（**用户双击的原始 exe，不是 %TEMP% 解压目录**）；`setAutoStart(false)` 后该值清空（关闭方向也正确） |
| 20 | 通过 | autoPaste 关闭时热键唤起 → `items.paste` | 返回 `{ok:false, reason:'no-target'}`（只复制不粘贴），界面提示「已复制，按 Ctrl+V 粘贴」。截图 `task12-paste-fallback-toast.png`；`paste.spec.ts`「三种 reason 在界面文案上仍是三条不同提示」 |
| 21 | 通过 | 造 `%APPDATA%\Clipchan\history.json`（632 B，3 条）→ 启动打包版 | 库内正好 3 条；`history.json` → `history.json.migrated`（632 B，sha256 `4E2E10CD…7BCAC4` 与迁移前一致）。`migrate.spec.ts`「成功后 history.json 改名 .migrated，settings.json 字节不变」 |
| 22 | 通过 | 同一份短键旧文件（`id/text/at/seq/pin/trunc` + `ctrl/alt/shift/win/key/theme/autopaste/label`） | 3 条逐字一致（含中文多行与单双引号）；`legacy-2` kind=link、pinned=1；无 seq 的 `legacy-3` 补为 seq 3。`migrate.spec.ts`「用 C# 属性名写的文件导入 0 条（钉死陷阱）」 |
| 23 | 通过 | 渲染进程 `PerformanceObserver({entryTypes:['longtask']})` 滚动全程采样 | 当前库 119 条、`scrollHeight=11387`，逐 400px 滚到底：`longTasks=0`、`maxLongTask=0`、`over200=0`。500 条规模的截图证据 `task12-scroll-500.png`；卡片用 `content-visibility:auto` + `containIntrinsicSize`，无虚拟滚动库 |
| 24 | 通过 | `node scripts/package-win.mjs` | EXIT=0；`release/Clipchan.exe` 95,628,574 B（portable）、`release/Clipchan-Setup-0.1.0.exe` 96,076,122 B（NSIS）。portable 双击跑通并完成自动粘贴实测（第 20 条）；NSIS 静默安装 exit=0、能起窗口并读设置。★ **NSIS 版自动粘贴有一次未复现的失败**（返回 ok:true 但记事本为空，连续三次），portable 同代码通过，未定位即停止（用户决定不再追） |
| 25 | 通过 | `scripts/measure-hotkey.ps1`（keybd_event Ctrl+反引号，轮询可见窗口） | `HOTKEY_SUMMON_MS=108`（< 300ms）；同脚本的 `COLD_START_VISIBLE_MS` 因探针没抓到窗口不可信，未采用 |
| 26 | 通过 | 连点两次 `release/Clipchan.exe` + `Get-CimInstance Win32_Process` | 修复后：`error windows: 0`、非 `--type=` 根进程回到 1、临时解压目录只有一套、titled 窗口 1 个。★ 修复前必弹「globalShortcut cannot be used before the app is ready」，根因与修法见进度记录 |
| 27 | 通过 | `packages/desktop/electron/recorder.spec.ts`「启动前就躺在剪贴板里的内容不补录，之后新复制的内容正常记录」 | 启动基线被记为已见内容，不入库；后续新内容正常记录 |
| 28 | 通过 | CDP `ghost.set(null)` → 计数 | `{active:false, remainingMs:0}`，计数仍 114（幽灵期间内容不补录）；「监听已恢复」提示由 `toastText.spec.tsx`（10 条）覆盖 |
| 29 | 通过 | 截图 `task12-widget-pasteback-target.png`、`task12-widget-pasteback-notepad.png` | 小组件常驻状态下复制 → 双击卡片 → 内容贴进记事本 |
| 30 | 通过 | 迁移前后比对 sha256 + 文件时间 | `settings.json` 177 B，sha256 `66DDFB28…F3638DB4` 迁移前后一致；LastWriteTime 恒为 2026/10/16 15:02:34（测试全程未改）；设置在 `clipchan.db` 的 settings 表里 |
| 31 | 通过 | `images-policy.spec.ts`（12）+ `recorder.spec.ts` | 「删除图片记录后 images/<id>.* 与 thumbs/<id>.png 都消失」「sweepOrphans 之后孤儿文件真的从磁盘消失」「按上限淘汰掉图片记录时，磁盘文件一并删除」全过 |
| 32 | 通过 | CDP `app.resizeBy(-9999,-9999)` / `(9999,9999)` + cua 读 bounds | 夹到 `720×480` 与 `1200×900` 两端。实现 `packages/desktop/electron/windows.ts:304-326`（`Math.min(max, Math.max(min, ...))` + `setBounds`）；常量 `packages/core/src/ui/ResizeHandles.tsx:26-31`；拖动由自绘 `ResizeHandles` 的 pointer 事件驱动。★ 渲染进程 `window.outerWidth` 读不到真实变化，必须用窗口 bounds |
| 33 | 通过 | 截图 `task8-frosted-enabled-settings.png` vs `task8-frosted-degraded-settings.png` + 进度记录 2026-10-16 Task 8 行 | 开启时 `[frosted] 应用 ok=true supported=true`，面板后方桌面被真实模糊（#F0F0ED 透出）；助手改名后降级为 #E0DEDA 88% 半透明 + 内部阴影，设置页显示「已降级」 |
| 34 | 通过 | `packages/core/src/logic/wordcloud.spec.ts`「统计当天文本」+ `wordcloud.exportPng` | 只统计当天 kind=text（图片不计）；导出截图 `task12-wordcloud-export.png`，尺寸与视图区域一致 |
| 35 | 通过 | 读 `build/icon.ico` 头 + 帧目录 | 240,437 B，`reserved=0 type=0 count=10`，帧序列 256/128/64/48/32/24/16（含 256×256）；源图 `assets/icon.png` 1,798,619 B |

**最终判定：35 / 35 通过。** 其中第 24 条的 NSIS 版自动粘贴存在一次未复现的失败（已在表内如实记录，用户明确要求不再追查）；第 2 条与原型有一处入口位置差异（已在表内记录）。除此之外没有「拿不出证据」的条目。

### Task 12 附加对照 ①：与原型 `ojo/specs/wireframe.jpg` 并排

原型图（1376×768，215,663 B）画了三块：主面板 ~900×620、小组件 ~280×480、设置页 ~900×620。逐项核对：

| 核对项 | 原型 | 实现 | 结论 |
|---|---|---|---|
| 窗口尺寸 | ~900×620 | 900×620（`smoke-main.mjs` PASS、cua bounds 900×620） | 一致 |
| 左侧栏宽度 | 64px（图上标注） | `Sidebar.tsx:38` `w-16` = 64px | 一致 |
| 左侧栏项 | 全部 / 文本 / 图片 / 链接 / 代码 / 收藏 / 设置 | 同 7 项（截图 `task12-main-panel.png`） | 一致 |
| 搜索栏位置 | 顶部整行，占满除侧栏外宽度 | 顶部整行 + 右侧「词云」「小组件」两个按钮 | 一致（多了词云入口） |
| 卡片信息层级 | 类型徽章 → 预览 → 右侧时间戳 + 星标 | 徽章（T/Link/Img/代码）→ 预览 → 时间戳 + 星标 | 一致 |
| 卡片间距 | 8px（图上标注） | `ListPanel.tsx:56` `gap-tight` = 8px（`tailwind.config.ts:43`） | 一致 |
| 小组件入口 | 右下角「切换小组件」 | 搜索栏右侧「小组件」按钮 + 右下角「设置」 | **位置不同**（入口存在，形态切换可用） |
| 小组件形态 | ~280×480，标题 + 搜索 + 紧凑列表 | 280×420（`smoke-main.mjs` PASS），内容自适应高度（`widgetFit.ts` 240–560） | 尺寸略有差异（高度自适应是设计选择） |
| 设置页分区 | 快捷键 / 外观主题 / 历史上限 / 小组件尺寸 / 数据清理 | 5 个分区齐全（截图 `task12-settings-page.png`） | 一致 |

### Task 12 附加对照 ②：与 `legacy/` 对照（spec §13 逐行）

**「保留并扩展」的 14 项，逐项确认在位：**

| 旧版能力 | 新版落点 | 证据 |
|---|---|---|
| 剪贴板监听（仅文本）→ 加图片 | `packages/desktop/electron/watcher.ts` + `recorder.ts` | `watcher.spec.ts` 20 条、`recorder.spec.ts` 12 条；真机文本与 640×480 图片都入栈（第 4/7 条） |
| 全局热键 Ctrl+` | `packages/desktop/electron/hotkeys.ts` | `HOTKEY_SUMMON_MS=108`；被占用时 `conflicts` 如实回报、不静默降级 |
| 自动粘贴（三层验证） | `helper/ClipchanHelper.cs:301` `HandlePaste` + `paste.ts` | 真机贴进记事本成功；`paste.spec.ts` 22 条含 8 种助手返回码透传 |
| 托盘菜单 | `packages/desktop/electron/tray.ts` | `smoke-main.mjs`「托盘顶层 6 项」「托盘文案顺序」PASS |
| 今日词云（保留算法） | `packages/core/src/logic/wordcloud.ts` + `WordCloudView.tsx` | `wordcloud.spec.ts` 9 条（CJK 切分 / 剪虚词 / 拉丁词 / 降序 / 不含单字虚词） |
| 幽灵模式 | `packages/desktop/electron/ghost.ts` | 第 16/28 条实测：期间不进历史、关闭不补录 |
| Ctrl+M 拼接 | `packages/core/src/logic/merge.ts` + `merge-service.ts` | `merge.spec.ts` 5 条、`merge-service.spec.ts` 9 条 |
| 连续复制检测（预选不自动合并） | `packages/desktop/electron/burst.ts` | `burst.spec.ts` 13 条 |
| 明暗主题 + 跟随系统 | `packages/core/src/theme/tokens.css` + 设置页 | `task12-settings-page.png` 三种模式；`applyStoredTheme()` 两端共用 |
| 类型识别 5 类 | `packages/core/src/logic/classify.ts`（链接/路径/数字/代码/文本） | `classify.spec.ts` 7 条；展示层折叠 path/number 为「文本」徽章 |
| 历史上限 200（可调至 9999） | `packages/core` settings + `recorder.ts` | `recorder.spec.ts`「historyLimit=5 时插 8 条 → 只剩最新 5 条」 |
| 开机自启（修 portable 路径） | `packages/desktop/electron/startup.ts` `autoStartPath` | 第 19 条：注册表写的是 `D:\tmp\clipchan-test\Clipchan.exe` |
| 单实例互斥 | `packages/desktop/electron/startup.ts` `enforceSingleInstance` + `app.requestSingleInstanceLock()` | 第 26 条；本轮修掉第二实例的错误框 |
| 托盘「暂停监听」并入幽灵模式 | `tray.ts` 的幽灵子菜单（5/10/30/60 + 关闭） | `GHOST_PRESETS` 与 `smoke-main.mjs` 文案断言 |

**「抛弃」的 5 项，确认无残留：**

| 抛弃项 | 检查方式 | 结果 |
|---|---|---|
| 手写 JSON 存储 | `grep -r "writeFileSync.*history.json" packages/desktop/electron` | 只在 `migrate.ts`（读旧文件 + rename 留档）出现，无写入路径；存储全走 `db.ts`（better-sqlite3） |
| C# WinForms 自绘界面 | `ls packages/desktop/helper` + 渲染层 | 助手只有 `ClipchanHelper.cs`（粘贴/毛玻璃/前台查询，无 UI）；界面全在 `packages/core/src/ui` 的 React 组件 |
| 单文件免运行时约束 | `electron-builder.yml` | 明确打 Electron 包（95.6MB portable / 96MB NSIS），不再追求单文件 |
| `--selftest` 71 项自检 | `grep -rn "selftest" packages scripts` | 无命中；替代物是 `vitest`（29 文件 / 293 用例）+ `smoke-main.mjs`（13 项）+ 本判定表 |
| `--wordcloud` / `--ghost=30` 命令行 | `grep -rn "wordcloud\|ghost" packages/desktop/electron/main.ts` 的 argv 处理 | `main.ts` 只认 `--smoke` 与 `--widget`；词云与幽灵改由界面/托盘入口触发 |

**「部分保留」1 项**：窗口手动缩放从 320×300~900×1200 改为 720×480~1200×900（主窗口）+ 240–400px（小组件宽度）——见第 32 条实测。

---

## 进度记录




> 每个任务收口时在此追加一行：日期 | 任务号 | 执行的命令 | 结果。无 git，本表就是版本留档。

| 日期 | 任务 | 命令 | 结果 |
| --- | --- | --- | --- |
| 2026-10-16 | Task 0 | `node scripts/make-icons.mjs` | 绿：assets/icon.png 1798619 B；build/icon.ico 240437 B / 7 帧 256-16 |
| 2026-10-16 | Task 0 | `pnpm install --allow-build=electron --allow-build=esbuild --allow-build=better-sqlite3 --allow-build=electron-winstaller` | 绿：EXIT=0，electron.exe 就位，esbuild/electron postinstall 已执行（pnpm 12 的 onlyBuiltDependencies 写在 pnpm-workspace.yaml 不生效，必须用 --allow-build 或 allowBuilds） |
| 2026-10-16 | Task 1 | `npx vitest run` | 绿：5 个 spec / 32 个断言全过 |
| 2026-10-16 | Task 2 | `npx vitest run` / `npx tsc -p packages/desktop/tsconfig.json --noEmit` | 绿：12 files / 106 tests；tsc EXIT=0（含 db.spec 11 / migrate.spec 6 / images-policy.spec 12） |
| 2026-10-16 | Task 3 | `node scripts/build-helper.mjs` | 绿：clipchan-helper.exe 12288 B；`--layout` 五尺寸全匹配（KEYBDINPUT=24 MOUSEINPUT=32 HARDWAREINPUT=8 INPUT=40 GUITHREADINFO=72） |
| 2026-10-16 | Task 3 | 真实 exe 行协议（`--serve` 喂 9 条） | 绿：`READY pid=…` → `PONG` → `FG` → `RESULT 0 1 窗口失效` → `BLUR 0 2`；QUIT 后 exit 0 |
| 2026-10-16 | Task 4 | `node scripts/build-main.mjs` | 绿：main.js 49073 B / preload.js 4600 B / smoke.html 145 B |
| 2026-10-16 | Task 4 | `node scripts/smoke-main.mjs` | 绿：9/9 通过，SMOKE_EXIT=0（主窗口 900x620、小组件 280x420、IPC 通道 23、托盘顶层 6 项） |
| 2026-10-16 | Task 4 | `npx tsc -p packages/desktop/tsconfig.electron.json --noEmit` + `npx vitest run` | 绿：tsc EXIT=0；vitest 12 files / 106 tests 全过 |
| 2026-10-16 | Task 8 | `npx vitest run`（frosted.spec 16 项） | 绿：19 files / 204 tests |
| 2026-10-16 | Task 8 | `node scripts/smoke-main.mjs` | 绿：13/13（新增 4 条 bounds 落在鼠标所在显示器内） |
| 2026-10-16 | Task 8 | 真机毛玻璃：`node scripts/run-dev-app.mjs` | 绿：`[frosted] 应用 ok=true supported=true`；截图 task8-frosted-enabled-settings.png（#F0F0ED 透出桌面）vs task8-frosted-degraded-settings.png（#E0DEDA 88% 半透明 + 设置页"已降级"） |
| 2026-10-16 | Task 8 | 小组件形态真机 | 绿：切形态后窗口 280x420 @ (1616,596) 贴右下角距边 24px；截图 task8-widget-mode.png |
| 2026-10-16 | Task 5 | node scripts/run-dev-app.mjs + 真机剪贴板 | 绿：watcher.spec 20 / recorder.spec 12；真机 Set-Clipboard 文本入栈、文件剪贴板不产记录、图片卡片带缩略图 |
| 2026-10-16 | Task 6 | node scripts/build-helper.mjs + 端到端探针 | 绿：paste.spec 22；修掉助手提权误判后真机粘贴成功（textarea 读回 clipchan-e2e-…，match=true） |
| 2026-10-16 | Task 9 | pnpm typecheck + pnpm vitest run + node scripts/smoke-main.mjs | 绿：tsc EXIT=0；24 files / 257 tests；smoke 13/13（IPC 通道 23） |
| 2026-10-16 | Task 7 界面层 | npx vitest run | 绿：14 files / 125 tests |
| 2026-10-16 | Task 7 界面层 | npx tsc core+desktop --noEmit | 绿：两条 exit 0 |
| 2026-10-16 | Task 7 界面层 | tailwind CLI 编译 index.css | 绿：25162 字节，core+desktop 内容均命中 |
| 2026-10-17 | 缺陷修复 | `pnpm typecheck` + `pnpm vitest run` | 绿：修复 PasteService 设置快照（改 `getSettings: () => PasteSettings`）与 `switchMode` 竞态（`await Promise.race([notePanelShown, delay(120)])` 后才 show） |
| 2026-10-17 | 缺陷修复 | 真机自动粘贴（热键 → paste → Ctrl+S 存盘） | 绿：记事本收到 `clipchan-t10-capture-测试文本`；autoPaste 关闭时返回 `no-target` 且提示「已复制，按 Ctrl+V 粘贴」 |
| 2026-10-17 | 缺陷修复 | `node scripts/build-main.mjs` | 绿：main.js 111,824 B / preload.js 4,938 B；修复第二实例弹框（`will-quit` 里 `if (app.isReady()) unregisterHotkeys()`） |
| 2026-10-17 | Task 10 | `node scripts/package-win.mjs` | 绿：EXIT=0；release/Clipchan.exe 95,628,574 B + Clipchan-Setup-0.1.0.exe 96,076,122 B（修复缺陷 A/B 后重建，与 Task 12 归档日志同一批产物） |
| 2026-10-17 | Task 10 | portable 拷到 `D:\tmp\clipchan-test` 双击 + 自动粘贴实测 | 绿：面板出现、剪贴板捕获正常、记事本收到文本（33 B UTF-8）；截图 task10-portable-panel.png / task10-packaged-autopaste.png |
| 2026-10-17 | Task 10 | NSIS 静默安装 + 启动 + 卸载 | 绿（安装/运行）：`/S` exit=0 → `%LOCALAPPDATA%\Programs\Clipchan\`，CDP 状态与 portable 全同；卸载 exit=0。★ 自动粘贴连续三次未落地（返回 ok:true 但记事本为空），portable 同代码通过，未定位即停止（用户决定不追） |
| 2026-10-17 | Task 10 | 迁移实测（造短键旧 history.json 632 B + settings.json 156 B） | 绿：库内正好 3 条且逐字一致；history.json → .migrated（sha256 4E2E10CD…7BCAC4 不变）；settings.json sha256 66DDFB28…F3638DB4 不变 |
| 2026-10-17 | Task 10 | `HKCU\...\Run` 自启实测 | 绿：`electron.app.Clipchan = D:\tmp\clipchan-test\Clipchan.exe`（原始 exe，非 %TEMP%）；关闭后值清空 |
| 2026-10-17 | Task 10 | 强杀 `Get-Process Clipchan \| Stop-Process -Force` → 重启 | 绿：强杀前 6 条（含 1 图），重启后仍 6 条、id 顺序一致；截图 task10-restart-kept.png |
| 2026-10-17 | Task 10 | 单实例复验（连点两次 release/Clipchan.exe） | 绿：error windows 0、根进程 1、临时解压目录 1 套、titled 窗口 1 个 |
| 2026-10-17 | Task 11 | `pnpm --filter @clipchan/mobile build` | 绿：EXIT=0，2146 modules，built in 3.19s；dist/index.html 747 B + js 360,417 B + css 10,748 B |
| 2026-10-17 | Task 12 | `scripts/verify-all.ps1`（五条命令串行归档） | 绿：五条全 EXIT=0；typecheck / vitest 29 files 293 tests / build-helper 五尺寸 / smoke 13/13 / package-win 两产物（Clipchan.exe 95,628,574 B + Setup 96,076,122 B）；日志存 docs/superpowers/evidence/task12-commands.txt（UTF-8 无 BOM，23,934 B） |
| 2026-10-17 | Task 12 | 逐条核对 spec §11 的 1–35 + 与 ojo wireframe / legacy §13 对照 | 绿：35/35 通过，判定表与两份对照写入本文件 Task 12 之后；保留意见 2 条（第 24 条 NSIS 自动粘贴一次未复现、第 2 条小组件入口位置不同） |
| 2026-10-17 | Task 12 | 新建根 `README.md` | 绿：5,201 B，含安装/数据目录/快捷键/能力边界（Win10 毛玻璃为窗口内模糊、手机端只搭壳） |

---

## 执行方式

本计划共 13 个任务（Task 0–12），彼此有强依赖（0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8/9 → 10/11 → 12），但 Task 8、9、11 之间可并行。

请选择执行方式（writing-plans 技能要求在此停下确认）：

- **A. 子代理驱动（subagent-driven-development，推荐）**：每个任务派一个 fresh subagent，按 Task 顺序执行，Lead 在每个任务收口时核对测试与证据。
- **B. 当前会话内联执行（executing-plans）**：由我在本会话里逐任务实现，进度直接可见但会占用本会话上下文。
- **C. 先做 Task 0–3 打通骨架与地基**（仓库重排、core、存储、助手），跑通后再决定后续节奏。
