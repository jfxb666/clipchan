# Clipchan 借鉴 Paster 的功能路线图

> 日期：2026-10-18 · 基线：clipchan v0.2.0 · 参考对象：geekerstar/Paster v1.4.0
>
> **⚠️ 本文件是首轮产品级逆向的产物，已被取代。**
> 实际排期与选型见 [2026-10-19-v0.3.0-data-safety.md](./2026-10-19-v0.3.0-data-safety.md)。
> 下方保留原始推理过程，但 2026-10-19 之后的事实性错误已就地修正（标 `[已修正]`）。

## 0. 前提校正（先说不成立的部分）

**Paster 没有源码。** 仓库 `geekerstar/Paster` 的 tree 共 77 个 blob，全部是：
`README.md` / `README.en.md` / `CHANGELOG.md` / `resource/*`（发布说明、公告、版本号）
+ `image/**`（70 张截图）+ `image/appearance_previews/**`（12 套外观的静态 HTML 与 png）。

语言统计为 `{"HTML": 399721}`，license 字段为 `null`。README 原文：

> 特别说明：本软件目前暂未开源，主要为防范源码被篡改后二次分发并植入恶意程序。

`[已修正]` README 的「技术栈」表是营销口径。对 v1.4.0 安装包（Inno Setup 6.3.0）解包后的实测结论：

- **Qt 6.11.0 纯 Widgets，零 QML/Quick**（无 `qml/` 目录、无独立 `.rcc`、导入表无 `Qt6Quick`/`Qt6Qml`）。UI 是 QSS + 内嵌 SVG + `QPainter` 自绘，资源编译进 `.rdata`。
- **Tesseract / PaddleOCR V4 / Argos Translate 全部运行时下载**，不在安装包里（包里 grep `tesser|paddle|onnx|traineddata|argos|sentencepiece` 零命中）。三者统一套路：找 Python → 解压脚本与模型 → 起子进程 → HTTP/stdio → 引用计数关闭。
- **FFmpeg 7.1.3 随包**（`avcodec-61` / `avformat-61` / `avutil-59` FileVersion 均 7.1.3），经 `multimedia/ffmpegmediaplugin.dll` 使用。
- **无 SQLite**（grep `sqlite|QSqlDatabase|QSQLITE` 零命中）。存储是**分文件 JSON**：`history.json` / `trash.json` / `folders.json` / `stickynotes.json` + `images/` 目录，配置走 QSettings。
- **截图只做 GDI `BitBlt`**（`grabViaBitBlt`），无 `PrintWindow`、无 DXGI。
- 主 exe 未加壳、无 Authenticode 签名，但尾部有 1.58 MB **未剥离的 COFF 符号表**（37,007 个符号 / 9,966 个 mangled 类名）——这是逆向信息量最大的来源。

和 clipchan 的 Electron + React + SQLite 完全不同栈。

**结论：能学的只有三样——功能清单、交互设计、界面形态。拿不到任何实现。**
所以本路线图是「产品级逆向」，不是「代码移植」。合规边界：不复制其截图素材进本仓库，只借鉴功能定义与交互逻辑。

## 1. 差距总表

| Paster 能力 | clipchan v0.2.0 现状 | 决定 |
| --- | --- | --- |
| 剪贴板历史（文本/图片/文件/链接/代码） | 有，`kind: text\|link\|code\|path\|number\|image` | 保持 |
| 实时搜索 + 高亮 | 有，SQL 侧完成 | 保持 |
| 收藏置顶 | 有（`pinned`） | 保持 |
| 回收站 + 恢复 + 保留期 | **无**，`DELETE FROM items` 是真删 | **P0 做** |
| 代码语法高亮 | 有 `kind='code'` 分类，**无高亮渲染** | **P0 做** |
| 截图 + 区域标注 + 落成记录 | **无** | **P1 做** |
| OCR 文字识别 | **无** | **P2 做** |
| 文件夹 / 标签分类 | 无（只有 kind 筛选 + 收藏） | 暂不做 |
| 12 套历史外观（便签墙/瀑布流/时间轴…） | 无 | **先做 2–3 个**（见下） |
| 屏幕录制 GIF/MP4 | 无 | 不做 |
| 桌面贴图 / 桌面便签 / 悬浮球 | 无 | 不做 |
| 局域网共享 / 远程连接 | 无 | 不做 |
| 实用工具箱（JSON/正则/文本对比…） | 无 | 不做 |
| 离线翻译（Argos） | 无 | 不做 |
| 批量选择 + 批量删除 | 有（`mergeSelected` 等） | 保持 |
| 导入导出 | 有（`items:exportAll` → JSON） | 保持 |
| AI 提示词优化 | **有，Paster 没有** | 保持并作为差异点 |

**选型结论（用户已确认）**：分阶段先精选，不追全能工具箱；重依赖一律不打包，改为首次使用一键下载。

## 2. 阶段划分

### P0 · v0.3.0「数据安全 + 阅读体验」（无外部依赖）

两件事都不需要新增任何二进制依赖，风险最低，先吃下 schema 变更。

#### P0-1 回收站与撤销删除

设计要点（关键决策：**软删除，不是影子表**）：

- `items` 加列 `deleted_at INTEGER`（NULL = 存活）。所有列表查询追加 `AND deleted_at IS NULL`。
- **必须同步重建两个唯一索引**，否则回收站里的内容会挡住重新复制同一条内容：
  ```sql
  DROP INDEX IF EXISTS idx_content_hash;
  DROP INDEX IF EXISTS idx_image_hash;
  CREATE UNIQUE INDEX idx_content_hash ON items(content_hash)
    WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
  CREATE UNIQUE INDEX idx_image_hash ON items(image_hash)
    WHERE image_hash IS NOT NULL AND deleted_at IS NULL;
  ```
  这是本阶段唯一有破坏性的改动，必须写迁移 + 回滚测试。
- 保留期设置 `trashRetentionDays`：7 / 15 / 30 / 永不（对齐 Paster）。启动自检清理过期项。
- 图片文件策略：进回收站时**不删盘**，purge 时才调 `deleteImageFiles()`（`packages/desktop/electron/images.ts:162`）。
- IPC 新增：`items:listTrash` / `items:restore` / `items:purge` / `items:emptyTrash`；
  现有 `items:remove` 语义改为软删，`items:clearUnpinned` / `items:clearAll` 同步改为软删。
- UI：Sidebar 加「回收站」入口；删除后 Toast 带「撤销」（3 秒窗口，对齐现有 `Ctrl+Delete` 双击确认的节奏）；`Ctrl+Z` 撤销最近一次删除。
- 删除路径全部要改：`db.ts` 里 5 处 `DELETE FROM items` 语句。

验收：`pnpm test` 全绿；新增用例覆盖「删→恢复→内容哈希唯一性」「过期自动清理」「purge 后图片文件消失」。

#### P0-2 代码语法高亮

- 渲染层用 **highlight.js**（core + 约 12 种语言，按需动态 import 分包），不用 shiki（shiki 打包体积和语法包数量对当前体量过重）。
- 语言判定：扩 `packages/core/src/logic/classify.ts` 的启发式；识别失败不猜，退化为等宽纯文本。
- 渲染位置：`ClipCard.tsx` 卡片、`TextViewer.tsx` 全文浮层。
- 主题跟随现有 `theme: auto|light|dark`，用 hljs 的两套 CSS 变量而不是两套样式表。
- 硬约束：**只渲染，不执行、不注入**。长文本超过阈值（如 8000 字）不渲染高亮，避免卡列表。

验收：深/浅主题下代码卡片正确着色；500 条历史滚动帧率不低于现状；`pnpm typecheck` 通过。

### P1 · v0.4.0「截图与标注」

本阶段是整条路线里最重的一块，也是 Paster 的核心竞争力。

- 新增 overlay 窗口：每个显示器一个透明全屏窗（复用 `windows.ts:61 allDisplays()`、`windows.ts:55 cursorDisplay()`），多显示器混合 DPI 分别处理。
- 采集：`[已修正]` 原写「优先走已有 C# 原生助手（BitBlt 路径）」——**助手没有任何截图能力**，这是新增不是复用。`ClipchanHelper.cs` 对外只有 5 条命令（`PASTE` / `BLUR` / `FG` / `PING` / `QUIT`，T5 后加第 6 条 `FGEXE`），P/Invoke 只涉及 user32 / kernel32 / advapi32，**无 gdi32、无 `BitBlt`、无 `GetDC`**。Paster 用的正是 GDI `BitBlt`（`grabViaBitBlt`，无 `PrintWindow`、无 DXGI），但那是它自己的 C++ 代码。所以要在 clipchan 里走 BitBlt，必须在助手里**新增** `CAPTURE <x> <y> <w> <h>` 命令 + gdi32 P/Invoke；不想动 C# 就用 Electron 内置 `desktopCapturer`。
- 标注层：Canvas 2D，工具集按 Paster 的裁剪版——矩形 / 箭头 / 自由笔刷 / 文字 / 马赛克 / 撤销重做 / 颜色。**不做**长截图、图层管理、水印、气泡。
- 落库：走现有 `saveImage()`（`images.ts:107`，长边 ≤2560、JPEG q80、缩略图 128），写入 `items` 且 `source='capture'`——DTO 里 `'capture' | 'merge'` 这个枚举值已经预留好了。
- 快捷键：新增第三个热键槽位（现有 `hotkeyActivate` / `hotkeyWidget`，需扩 `Settings` 与设置页录制控件）。
- 完成后动作：复制到剪贴板（默认）/ 直接粘贴回原窗口 / 存文件。**不做**钉到桌面（贴图是独立大工程）。

验收：单屏/双屏/125% 与 150% 混合 DPI 下截图区域与选区像素对齐；截图落成一条 image 记录且缩略图正常；`pnpm smoke:main` 通过。

### P2 · v0.5.0「OCR」

- 引擎策略（用户已确认「不打包，首次使用一键下载」）：
  1. 默认兜底：`tesseract.js`（WASM，零安装，精度一般，中英可用）。
  2. 可选增强：检测到系统有 `tesseract.exe` 或用户一键下载 PaddleOCR PP-OCRv4 时走原生路径，精度明显更高。
- 下载器要有：来源固定、SHA256 校验、断点/失败重试、明确中文失败原因（对齐 Paster 的「一键下载安装」体验）。
- 入口三处：图片卡片右键「识别文字」、截图完成后工具栏「OCR」、全文浮层。
- 结果：弹窗展示 + 一键复制 + 「存为一条新记录」（`kind='text'`，`source` 标记来源）。
- 明确不做：离线翻译、截图翻译。

验收：无引擎时给出可操作的下载引导而不是报错；引擎就绪后中英文截图识别可用；下载失败路径有单测。

## 3. 顺序理由

1. **先 P0-1**：它要动 `items` 表结构与唯一索引，越晚做迁移成本越高；而 P1 的 `source='capture'`、P2 的来源标记都建立在这套 schema 上。
2. **再 P0-2**：纯渲染层，零依赖零风险，能立刻提升日常使用手感。
3. **然后 P1**：工程量最大，且需要复用原生助手，放独立版本窗口。
4. **最后 P2**：唯一引入外部二进制的阶段，隔离到最后，失败也不影响前三阶段。

## 4. 明确不做的事（及理由）

- **12 套外观全做**：`[已修正]` 原判断「纯视觉工作量」不成立。实测「12 套外观」= **10 个布局视图 × 2 套配色变量**，不是 12 份皮肤：

  ```
  TimelineView / KanbanView / MasterDetailView / MasonryView / StickyWallView
  HeatView / SourceView / TagsView / GalleryView / CarouselView
  构造签名统一：NameView(const QList<ClipboardItem>&, const Appearance::Config&, bool, QWidget*)
  ```

  也就是说它们吃同一份数据、同一份 `Appearance::Config`，只是 `paintEvent` 的排布不同；配色是 `Appearance::Config` 里的变量，不是第二份视图。所以**单个视图的成本远低于预估**。真正贵的不是「12 套」，而是「一次性做 12 个」。用户已定：先做 2–3 个高价值视图（时间轴 + 瀑布流 + 按来源分组）。
- **屏幕录制**：要 FFmpeg 依赖 + 编码参数面板，投入产出比最低。
- **桌面贴图 / 便签 / 悬浮球**：各自都是独立产品级模块，会把单文件小体积优势抹平。
- **局域网共享 / 远程连接**：要服务端、设备发现、加密协商，是另一个产品的量级。
- **实用工具箱**：与剪贴板主链路无关，属于「顺手加个 JSON 格式化」级别的独立需求，可随时单点插队。
- **离线翻译**：Argos 模型 100MB+，且与 AI 提示词优化的定位重叠。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 唯一索引重建失败导致老用户数据异常 | 迁移前后各跑一次 `PRAGMA integrity_check`；迁移前自动备份 `clipchan.db` |
| 软删除后 `items:count` 与列表数不一致 | 所有计数查询统一加 `deleted_at IS NULL`，并加一条断言型单测 |
| 截图在混合 DPI 下偏移 | 每个显示器单独取 `scaleFactor`；若走 BitBlt 需先在助手里新增 gdi32 P/Invoke（现有助手无此能力） |
| 外部引擎下载被墙/校验失败 | 固定 SHA256 + 失败中文原因 + 手动指定本地路径的兜底入口 |
| 借鉴边界越界 | 只抄功能定义与交互流程，不复制其截图、文案、图标 |

## 6. 每阶段的固定验证链

```bash
pnpm typecheck
pnpm test          # 用例基线只增不减（v0.2.0 基线 501；v0.3.0 开工后已增至 542+）
pnpm smoke:main    # 主进程冒烟，13 项断言
pnpm build         # 产出 release/Clipchan.exe
```
跑 `smoke:main` 前先退出已运行的 Clipchan（单实例锁会让第二个实例直接退出）。
