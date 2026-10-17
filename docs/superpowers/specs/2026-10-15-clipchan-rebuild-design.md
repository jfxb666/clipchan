# 剪贴板酱 Clipchan 重做 · 设计文档

日期：2026-10-15
工作目录：C:/Users/Administrator/Desktop/剪贴板
原型参考：C:/Users/Administrator/Desktop/ojo
状态：已定稿。用户 2026-10-15 已就原 §14 三项拍板（1a 手机端只搭壳 / 2b 毛玻璃做真的 / 3a 字体不内置），正文已按此更新。动工前不再有未决项。

> 本版把 builder check 与独立事实核对提出的全部问题逐条落定。**凡标 ★ 的结论都有证据**——要么是本机实测（命令与原始输出见 §15 实测附录 1–15 条），要么是逐行核对旧源码得出的结论（附录 16–24 条）。凡是与旧版 C# 行为不一致的地方，都写明"有意偏离"及理由。
>
> 独立事实核对（fresh subagent 对照 `src/*.cs` 逐条验证）已回来，纠正了 4 处：旧 JSON 字段名（迁移会静默导空，最严重）、`--selftest` 实际 71 项、`SuppressNext` 行号 :811、以及全部 `legacy/src/` 引用路径（legacy/ 搬迁尚未发生）。这些修正已并入正文与 §15 附录 16、18–20 条。
>
> 用户拍板：手机端本轮只搭壳（1a）、毛玻璃做真的（2b）、字体不内置（3a）——见 §14。
>
> builder check（fresh subagent）的完整问题清单后来**收到了**（10 条），连同用户对 §14 的拍板（1a / 2b / 3a）一起并入正文：§6.6 改为真毛玻璃 + 降级路径、新增 §9.4 设置持久化、§7.1 补启动基线、§7.2 补小组件常驻时的目标窗口追踪、§7.3 补图片文件生命周期、§8.1 补分页与分页渲染、§11 扩到 35 条验收。

---

## 1. 目的与缘由（Why）

现在的剪贴板酱是一个 C# WinForms 单文件 exe：功能上已经长出了不少东西（今日词云、幽灵模式、拼接、连续复制自动拼接、Enter 自动粘贴），但界面是无边框自绘的 Win32 窗口，和桌面上的其他应用不是一个时代的东西；而且它只认文本剪贴板，图片一律进不来。技术上它被"单文件、免运行时、手写 JSON"这三条约束绑住，加一个界面改动就要动 5 万字节的 MainForm.cs。

要做的事：**按 ojo 原型重做这个应用**，换成一款现代、有性格的桌面剪贴板工具，并且这次真的支持图片。旧的 C# 实现整包挪进 `legacy/` 留档（存储、去重、自动粘贴的判定逻辑要抄过来），不删。

用户明确要的三件事：

1. 用 **React + Tailwind 网页技术**重做（不用 WinForms 自绘）。
2. **三端都能用**，先做电脑端 exe，再做手机端 app。
3. 新版**真的做图片剪贴板**：截图/复制的图片进历史、有缩略图预览、能贴回原窗口。

---

## 2. 目标 / 非目标 / 反目标

### 目标（这一轮做完就算成功）

- Windows 上跑得起来的一个**免安装 exe**（双击即用），外加一个可选的 NSIS 安装包。
- 主界面 = ojo 原型那套：900×620 圆角窗口，左侧 64px 图标导航，右侧搜索栏 + 卡片列表，卡片带类型徽章 / 预览 / 时间戳 / 收藏星标。
- 桌面小组件模式：悬浮的紧凑面板，只显示最近几条，可切换。
- 设置页：快捷键、外观主题、历史上限、小组件尺寸、失焦自动隐藏、数据清理。
- **图片进历史**：复制或截图产生的图片被捕获，卡片显示缩略图，双击卡片能贴回刚才那个窗口（单击只选中不粘贴，见 §6.5）。
- 文本剪贴板：捕获、搜索、分类（文本 / 链接 / 代码 / 路径 / 数字）、收藏、删除、清空。
- 全局快捷键唤起（默认 Ctrl+反引号键，被占用则降级）。
- 托盘常驻：显示面板 / 暂停监听 / 开机自启 / 退出。
- 数据落在磁盘上，重启还在；存储要能扛住写入中断（SQLite 事务接管旧版的原子写思路）。
- 保留旧版已经做出来的差异化能力：幽灵模式、今日词云、拼接、连续复制预选、Enter 自动粘贴。
- 一份界面代码同时给桌面和手机用。**手机端本轮只搭壳**（Capacitor 工程建好、`core` 接上、能在浏览器里看界面），不装 JDK / Android SDK、不出 APK——用户已拍板（见 §14）。

### 非目标（这一轮不做）

- 不做 macOS / Linux 的**打包与签名**（代码按跨平台写，但不测、不出包）。
- 不做 iOS 打包（没有 Mac，没有 Xcode）。手机端只做 Android。
- **手机端本轮不出 APK**：不装 JDK + Android SDK + Gradle（约 2–3 GB），不做真机验收；只搭壳、接上 `core`、能在浏览器里看界面（用户拍板 1a，见 §14）。
- 不做云同步、账号、多设备共享。
- 不做富文本（RTF / HTML）保真粘贴——只存纯文本降级版。★ 实测：剪贴板里只有 `text/html` 时 `readText()` 返回空字符串，所以富文本复制会**捕获不到纯文本**，此时按"内容为空"跳过，不产生空记录。
- **不做文件列表（CF_HDROP）**：★ 实测从资源管理器复制文件时，Electron 侧 `availableFormats()` 是 `["text/uri-list"]`，`clipboard.has('FileNameW')` 为 true，而 `readText()` 返回空、`readImage()` 也是空。所以不做特殊处理也不会产生垃圾记录（本来就读不到内容）。处理方式：检测到 `text/uri-list` 或 `FileNameW` 格式就**明确跳过**，并在面板上给一次轻提示「本轮暂不记录文件」——避免用户以为程序坏了。
- 不做插件系统、不做脚本扩展。
- **不重做词云的算法**（照搬旧版 6 个纯函数），但**界面形态改为应用内视图**，理由见 §6.9。

### 反目标（技术上跑通了也算失败）

- **变成一个需要装运行时/装依赖才能跑的东西。** 用户双击 exe 就得能用。如果最后交付的是"先装 Node 再 npm install 再 npm start"，这一轮就是失败的。
- **界面比原型丑或比旧版难用。** 抄原型是为了变好看，不是为了换个技术栈还退步。旧版是键盘密集型的（↑↓ / Enter / Ctrl+D / Ctrl+M / Delete / Esc），**键盘操作要一条不丢**（§7.7）。
- **图片支持是假的。** 如果图片只能进历史不能贴回去，或者贴回去变成一串乱码，那"真的做图片"这条就没达成。
- **启动慢到让人不想用。** 面板唤起要跟手（目标 < 300ms 可见）。
- **数据丢。** 崩溃或强杀进程后历史不能整份消失。
- **卡顿。** 500 条历史（含图片缩略图）滚动要跟手，不能一滚一卡。

---

## 3. 约束（已经定死、不可协商的东西）

| 约束 | 内容 | 来源 |
|---|---|---|
| 界面技术 | React + Tailwind，视觉按 ojo 原型，**构建用 Vite 而非 ojo 的 rspack**（见 §4） | 用户 m00030 |
| 复用范围 | 一份代码三端复用，先桌面 | 用户 m00030 / m00052 |
| 图片剪贴板 | 必须真支持，含贴回原窗口 | 用户 m00055 |
| 交付顺序 | 先 Windows exe，后手机 app | 用户 m00052 |
| 本机工具链 | 只有 Node v24.21.0 / npm / pnpm 12.11.2。**没有** git、Rust、.NET SDK、JDK、Android SDK、MSVC、Python | 环境勘察 |
| 可用编译器 | `C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe` 实测可用（Win10 自带 .NET Framework 4.x） | ★ 实测 |
| 无 git | 这台机器没装 git，"提交到仓库""git worktree 隔离"做不了，版本留档靠目录拷贝 | 环境勘察 |
| 磁盘 | C 盘剩 89.5 GB | 环境勘察 |
| 网络 | npmjs.org 与 npmmirror 均可达；Electron 二进制与 electron-builder 打包二进制都能下 | ★ 实测 |
| 系统 | Windows 10 专业版 19045（**不是 Win11**，因此没有系统级圆角与 acrylic） | ★ 实测 |
| 环境变量坑 | 本机默认存在 `ELECTRON_RUN_AS_NODE=1`，会让 electron.exe 退化成纯 Node。开发脚本与构建脚本必须先清除它 | ★ 实测 |
| 旧代码 | 原地重做，旧的 C# 挪 `legacy/`，不删 | Lead 决定 |

---

## 4. 技术选型（及为什么不是别的）

**桌面：Electron 37 + Vite + React 18 + TypeScript + Tailwind CSS 3 + zustand + framer-motion + lucide-react。**

选它的理由：

- 与 ojo 原型**同款界面栈**，原型里的页面、store、主题令牌可以搬过来，改动面最小。
- 这台机器只有 Node 和 pnpm。Tauri 需要 Rust 工具链 + MSVC，两个都没有；WPF/WinUI 需要 .NET SDK，没有。Electron 是唯一**现在就能装、现在就能打包**的选项。
- 全局快捷键、剪贴板监听、托盘、多显示器定位——Electron 全都内置，不用自己写 Win32 消息循环。
- 一份 React 代码后面可以直接喂给 Capacitor 做手机端。

**★ 与 ojo 原型的复用边界（重要澄清）**：只复用**视觉与结构**（配色令牌、布局比例、组件外观、动效参数、页面信息架构），**不复用它的构建与运行时内核**。理由：ojo 是 design-template-workspace 的 prototype，跑在 rspack 上，并且依赖一套只为"原型预览宿主"存在的运行时（`window.App.transitionTo` 页面跳转、postMessage 桥接的 store、`tools/build-theme-classes.ts` 主题类名代码生成）。那套内核在真实应用里没有意义，搬过来只会带来无谓的间接层。所以：

- 构建工具用 **Vite**（生态标准、HMR 快、Electron 集成成熟）。
- 页面跳转用 **React Router（或一个 3 值的 view state）**，不用 `window.App`。
- 状态用 **zustand 直接实例**，不走 postMessage 桥。
- 主题令牌从 `theme.json` 手抄进 CSS 变量 + Tailwind 预设（一次性的，量很小），不引代码生成器。

**手机：Capacitor + 同一份 React 界面（Android 优先）。**
本轮只需要把壳搭起来、能在真机/模拟器上看到界面（是否出 APK 见 §14）。Android 上后台读剪贴板自 Android 10 起被系统禁止，手机端定位是"手动粘贴进来 + 手动复制出去"，界面要明说，不能假装它和桌面一样。

**存储：better-sqlite3（同步 API）+ 磁盘上的图片文件。**

- 不用 JSON 文件：图片是二进制，塞进 JSON 会让文件变得巨大且每次写入都要全量重写。
- 不用 IndexedDB（渲染进程）：数据要能被主进程读写（托盘、自动粘贴都需要）。放主进程更合适。
- **★ 已实测：better-sqlite3 在本机开箱可用，不需要 MSVC、不需要 Python、不需要 `@electron/rebuild`。** `better-sqlite3@13.0.3` 自带 8 个平台的 prebuild（`prebuilds/win32-x64.node`），二进制里含 61 个 `napi_*` 符号，是 **Node-API（ABI 稳定）**，跨 Node/Electron 版本无需重编译。已在真实 Electron 37.6.0 里跑通建表/插入/查询与 WAL 模式。
- **★ 但 electron-builder 默认会跑 `@electron/rebuild`，那一步会走 node-gyp 并因本机无 Python 而失败。** 修法已在探针工程验证：打包配置里设 `npmRebuild: false` + `buildDependenciesFromSource: false`，随后 portable.exe 构建成功（85.6 MB，exit 0）。这是**必填配置**，不是可选优化。

已知代价（接受）：

- 包体大（免安装 exe 约 86 MB）。这是换来"开箱即用 + 跨平台"的价钱。
- 内存占用比原生窗口高（空闲约 100–150 MB）。剪贴板工具常驻，这个代价可接受。
- 图片走 IPC 到渲染进程时**只传缩略图**，原图按需读（§7.3）。

**自动粘贴：自带 C# 助手 `clipchan-helper.exe`（常驻模式）。** 理由与实测见 §7.2 与 §8.2。

---

## 5. 代码结构

```
剪贴板/
├─ legacy/                    旧 C# 全部源码 + build.ps1 + README（只读留档，不再构建）
│                             ★ 搬迁是动工的第 0 步：本文档中所有 `src/xxx.cs` 行号引用都指搬迁前的当前位置
├─ docs/superpowers/specs/    设计文档与本轮产出
├─ packages/
│  ├─ core/                   ★ 平台无关：界面、状态、类型、主题令牌、纯逻辑
│  │  ├─ src/ui/              所有页面与组件（原型搬过来改造）
│  │  ├─ src/state/           zustand store（items / settings / ghost / ui）
│  │  ├─ src/theme/tokens.css 设计令牌（CSS 自定义属性，§6.2）
│  │  ├─ src/logic/           classify.ts / dedupe.ts / merge.ts / wordcloud.ts（纯函数，可单测）
│  │  ├─ src/platform/        PlatformAdapter 接口（桌面与手机各实现一份）
│  │  ├─ src/types.ts         全部共享类型（§8.1 的 ListQuery / ClipItemDTO / Settings / GhostState …）
│  │  ├─ tailwind.config.ts   Tailwind 预设（令牌映射，§6.2）
│  │  └─ src/index.ts
│  ├─ desktop/                Electron 外壳
│  │  ├─ electron/main.ts     窗口、托盘、热键、剪贴板轮询、自动粘贴编排
│  │  ├─ electron/preload.ts  contextBridge 暴露固定 API
│  │  ├─ electron/db.ts       better-sqlite3 建表/迁移/查询
│  │  ├─ electron/images.ts   图片解码/缩放/编码/落盘
│  │  ├─ electron/helper.ts   与 clipchan-helper.exe 的常驻通信（粘贴 / 毛玻璃 / 前台窗口查询）
│  │  ├─ electron/platform.ts PlatformAdapter 的桌面实现
│  │  ├─ helper/ClipchanHelper.cs  唯一原生助手：SendInput 自动粘贴 + DWM 真毛玻璃（csc 编译成 clipchan-helper.exe）
│  │  ├─ index.html
│  │  └─ vite.config.ts
│  └─ mobile/                 Capacitor 外壳（Android）
│     ├─ capacitor.config.ts
│     └─ android/             （手机端那一步生成）
├─ scripts/make-icons.mjs     从 1024×1024 源图生成 build/icon.ico 与 assets/icon.png
├─ assets/icon.png            用户给的 1024×1024 图标（从 docs/superpowers/specs/2026-10-15-clipchan-icon-source.png 复制）
├─ build/icon.ico             打包用多尺寸图标（由 scripts/make-icons.mjs 生成，含 256×256 帧）
└─ package.json               pnpm workspace 根
```

**分层规则（硬性）**：

1. `packages/core` **不许** import `electron`、`fs`、`path` 或任何 Node/Capacitor 专有模块。它只能通过 `PlatformAdapter` 接口访问系统能力。
2. `PlatformAdapter` 接口就是 §8.1 的 `ClipchanApi`，桌面由 preload 实现，手机由 Capacitor 插件实现。
3. 纯逻辑（分类、去重判定、拼接、分词）全部放 `core/src/logic`，不碰任何平台 API——这样它们可以在 Node 里直接单测，不用起 Electron。

---

## 6. 界面设计

### 6.1 视觉基调：以用户给的图标为准（重要决定）

原型里三份材料互相打架：`specs/product-brief.md` 写冷靛蓝 #2B6CB0，`specs/theme-guide.md` 写马卡龙天蓝 #87CEEB + 暖橙 #FFB380，`prototype/src/data/theme.json` 又是第三套 hsl 通道值。

**决定：以用户提供的应用图标为准。** 理由是图标是唯一一件**用户自己选定并交付**的视觉资产，界面和图标必须是一套东西；而三份文字材料是原型阶段的中间产物，彼此都不一致，没有权威性。

图标实测取色（1024×1024 PNG，System.Drawing 采样）：

| 用途 | 取色 | 来源 |
|---|---|---|
| 应用底色 / 窗口底 | `#FEFBF4`（奶油白） | 图标背景纸面 |
| 卡片 / 面板表面 | `#FFFDF8` | 比底色亮一档 |
| 主文字 | `#3C2814`（深暖棕） | 哥特标题与头发 |
| 次要文字 | `#8C6450` | 书本中调棕 |
| 主色（accent / 选中） | `#446971`（雾蓝） | 衣裙 |
| 次色（强调 / 星标） | `#81271E`（缎带暗红） | 缎带 |
| 边框 / 分割线 | `#3C2814` @ 8% | 描边色降透明 |
| 暖棕点缀 | `#C8A078` | 书本 |

深色主题不是简单反色，而是"夜晚书房"：底 `#1E1813`，表面 `#2A221B`，主文字 `#F5EDE1`，雾蓝提亮为 `#7FA8B0`，暗红提亮为 `#C25A4E`。

排版：中文用系统字体栈（`"Microsoft YaHei UI", "PingFang SC", ...`），**不内置中文字体**（一个中文字体子集动辄几 MB，为了包体不值得）。拉丁数字与代码用 `"Cascadia Code", Consolas, monospace`。

**★ 关于原型要求的 jfOpenHuninn（jf open 粉圓）中文字体与 Manrope 拉丁字体：本轮不内置。** 理由：这两个字体都要随包分发（几 MB 起），而"圆润的粉圓"这个观感可以靠**圆角 + 配色**达成主要部分；随包字体是包体与授权成本的净增项。如果用户看了成品坚持要，再单独作为一项加入——这属于可以后补的决定，不该在动工前卡住。

**★ 关于"从图标提取简化版线稿做空状态插画"：不做。** 图标是水彩位图，位图无法自动提取成干净线稿，手工描一遍是数小时的插画工作且效果不可控。空状态改用**图标本身**（缩放到 96px、轻微降饱和 + 一个柔和的圆角底衬）加上一句文案。这比描坏的线稿好看，且成本是零。

### 6.2 令牌落地方式

`theme.json` 里的令牌**手抄**进 `core/src/theme/tokens.css`（CSS 自定义属性）+ `tailwind.config.ts` 的 `theme.extend`。不引 ojo 的 `tools/build-theme-classes.ts` 代码生成器——令牌总共几十个，手抄一次的成本远低于维护一套生成链。

间距刻度沿用原型的 8px 基准：4 / 8 / 12 / 16 / 24 / 32 / 64。
圆角：卡片 16px，按钮 12px，输入框 10px，徽章 full。**比原型的 24px 收敛一档**——24px 圆角在 900×620 的窗口里配密集列表会显得散，16px 更贴合"工具"的密度。
动效：沿用原型的弹簧参数（stiffness 280 / damping 20），但**只用在面板出现、卡片 hover、视图切换三处**，列表滚动不做动效。

### 6.3 主界面（900×620）

与原型一致：

- 左侧 64px 图标导航：全部 / 文本 / 图片 / 链接 / 代码 / 收藏 /（底部）设置。
- **自定义标题栏**（无系统边框）：左侧「剪贴板酱」+ 幽灵模式状态点，右侧最小化 / 关闭（关闭 = 隐藏到托盘，不退出）。标题栏是拖拽区（CSS `-webkit-app-region: drag`），搜索栏与按钮设 `no-drag`。
- 顶部搜索栏 + 右侧「小组件」按钮。
- 卡片列表，8px 间距，每张卡：类型徽章 + 内容预览（文本 2 行截断 / 图片 64×64 缩略图）+ 时间戳 + 收藏星标。
- 右下角浮动「切换小组件」按钮。
- 空状态：图标 + 文案。

### 6.4 类型徽章：6 类，收敛自旧版的 5 类（解决 builder-check B-7）

| 内部 kind | 侧栏归类 | 徽章 | 徽章色 |
|---|---|---|---|
| `text` | 文本 | `T` | 暖棕 `#C8A078` |
| `link` | 链接 | `Link` | 雾蓝 `#446971` |
| `code` | 代码 | `</>` | 暗红 `#81271E` |
| `path` | **文本**（归入文本页） | `T` + 路径图标 | 暖棕 |
| `number` | **文本**（归入文本页） | `T` + 数字图标 | 暖棕 |
| `image` | 图片 | `Img` | 粉 `#DCB4A0` |

**理由**：侧栏保持原型那 6 个（全部/文本/图片/链接/代码/收藏），不新增两个筛选页——路径和数字本来就是文本的细分，单独开页会让侧栏变长而价值不大。但**分类结果照旧保留 5 类**（旧版 `ClipClassifier` 的判定规则要抄），只是在**展示层**把 path/number 折叠到文本页并用不同小图标区分。这样"链接、代码分类正确"这条验收照样覆盖 path/number（因为分类器本身照测）。

**★ 代码卡的「语言标签」：本轮不做，库里也**不**预留 `lang` 列。** 理由：语言识别要么引一个依赖（体积 + 准确率都不划算），要么自己写一套启发式（准确率低，标错了比不标更糟）；旧版也没有这个能力。预留一个没有任何消费者的列，只会让迁移脚本多一处要维护的字段——真要做时再加一次迁移。

### 6.5 单击卡片的行为（解决 builder-check B-6）

旧版是纯键盘驱动的：↑↓ 移动选中，Enter 粘贴。原型是鼠标点击即粘贴。两者要并存：

| 操作 | 行为 |
|---|---|
| **单击卡片** | 选中该卡片（只选中，不粘贴）——避免误点就把内容塞进别的窗口 |
| **双击卡片** | 粘贴（= Enter） |
| **Enter** | 粘贴当前选中项 |
| **↑ / ↓** | 移动选中 |
| **Ctrl / Shift + 单击** | 多选（进入拼接候选） |
| **Ctrl+M** | 拼接选中的多条 |
| **Ctrl+D** | 收藏 / 取消收藏 |
| **Delete** | 删除选中 |
| **Ctrl+Delete** | 清空未收藏 |
| **Esc** | 隐藏面板 |

**理由**：单击即粘贴在鼠标操作下太容易误触发（用户想滚动或想选中一条看看，结果内容被替换进了别的应用）；双击是桌面应用里"打开/执行"的通用手势，误触率低。键盘流程完全保留，重度用户不受影响。

### 6.6 小组件模式（解决 builder-check A-7 / B-3）

**★ 实测结论决定了实现方式**：`frame` 与 `transparent` 只能在创建时设定，运行时不能改；但 `setSize` / `setResizable` / `setMinimumSize` 运行时都生效。因此：

- 主窗口与小组件**是同一个 BrowserWindow**，创建时就带 `frame:false, transparent:true, hasShadow:false`。切形态时改的是**尺寸 + 内容布局 + 可缩放性**，不碰窗口属性。React 状态因此不会丢。
- 主窗口 900×620（`resizable: true`，可手动缩放，范围 720×480 ~ 1200×900）；切到小组件后 `setSize(280, 420)` + `setResizable(true)` + `setMinimumSize(240, 300)`，用户可在 240–400px 之间拖拽调整宽度。
- **★ 真毛玻璃（用户拍板 2b，本轮要做）**：本机是 Win10 19045，`backgroundMaterial:'acrylic'` 不可用（那是 Win11 22H2+ 的能力），CSS `backdrop-filter` 在 Electron 里**只模糊窗口内的内容、不会模糊窗口背后的桌面**。所以真磨砂改由**同一个原生助手**调 DWM 实现：`SetWindowCompositionAttribute` + `ACCENT_ENABLE_ACRYLICBLURBEHIND`（优先）/ `ACCENT_ENABLE_BLURBEHIND`（回落），助手常驻，命令见 §7.2；面板与小组件显示时开启、隐藏时关闭。
- **★ 动工第一件事：先写 30 行探针，验证本机 Win10 19045 + `transparent:true` 窗口上这两个 accent 标志是否真的生效**（`ACCENT_ENABLE_BLURBEHIND` 在 Win10 上通常可用，`ACRYLICBLURBEHIND` 在部分 19045 版本上会退化成纯色）。不生效就当场走降级路径并如实告诉用户，不硬撑。
- **★ 降级路径（必须实现，不是可选项）**：助手不可用（csc 缺失 / 编译失败 / 进程崩溃 / 系统拒绝）时自动回落为「半透明底色（约 88%）+ 窗口内部柔和阴影与渐变」，并把 `capabilities.frostedGlass` 置为 `false`；设置页外观分区显示「毛玻璃：已启用 / 当前系统不支持，已降级」。**不假装**有真磨砂。
- 位置：唤起时出现在**鼠标所在那块显示器**（`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`，★ 实测该 API 可用）的中间偏上；记忆上次位置，但若该坐标已不在任何显示器内则回落到主显示器中央。小组件形态默认贴右下角、距边 24px。
- **无边框窗口的拖动与缩放**：拖动靠标题栏的 CSS `-webkit-app-region: drag`；缩放**不依赖系统边框**（透明无边框窗口在 Windows 上的边缘拖拽不可靠），改为自绘右下角 / 右边缘 / 下边缘缩放手柄，通过 IPC `app.resizeBy(dw, dh)` 调 `win.setBounds` 实现，限制 720×480 ~ 1200×900。
- 失焦自动隐藏：**默认开**，可在设置里关（解决 builder-check 提的"该设置项不在 5 个分区里"——它就放在"小组件"分区里，见 §6.7）。

### 6.7 设置页（5 个分区）

| 分区 | 内容 |
|---|---|
| 快捷键 | 唤起面板（默认 Ctrl+`，被占用自动降级并提示）、切换小组件（默认 Alt+C）、拼接（Ctrl+M，只读展示） |
| 外观 | 主题：跟随系统 / 浅色 / 深色；毛玻璃状态（已启用 / 已降级，只读一行） |
| 历史 | 条数上限（默认 **200**；滑块 100–9900、步长 100，旁边另有一个数字输入框可直接填 100–9999）、图片磁盘预算（默认 512MB，档位 256/512/1024/2048）、当前占用显示 |
| 小组件 | 尺寸（240–400px 滑块）、位置（记忆/右下角）、**失焦自动隐藏**（开关） |
| 数据 | 清空未收藏（两次点击确认）、清空全部（两次点击确认）、**幽灵模式**（开关 + 时长 5/10/30/60 分钟 + 剩余时间显示）、存储位置显示与「打开文件夹」 |

底部显示版本号。

**★ 历史默认上限定为 200（解决 builder-check B-11）**：沿用旧版的实际默认值，且旧版在 200 条规模上已经证明可用。原型写 500 只是原型数据里的一个数字，没有实测依据。上限可调，用户想要 500 自己改。

### 6.8 幽灵模式（解决 builder-check A-3）

旧版语义：**只存内存（重启即失效）、只挡记录不挡取用**。

**新版决定：**

- **彻底停止剪贴板轮询**（而不是照读后丢弃）。理由：这是隐私承诺，"读取后丢弃"在内存里留过痕迹、也让"我暂停了它"这个说法不诚实。停止轮询 = 这段时间剪贴板里出现过什么，程序真的不知道。**★ 代价要写进 UI**：幽灵模式期间用户主动复制过的内容**不会**在结束后补录（因为没记录）。面板上要有一句说明。
- **重启后不保留**（沿用旧版）。理由：用户设 30 分钟去处理敏感内容，如果重启后还在暂停状态，他会以为程序坏了；而如果是重启后自动恢复监听，那"我明明开着幽灵模式"的隐私预期就破了。**两者都有问题，选"不保留"并在恢复时给一次明确提示**「幽灵模式已结束，剪贴板监听已恢复」。
- 上限 **720 分钟**，UI 提供 5/10/30/60 分钟快捷档 + 自定义；面板上常驻一个醒目的状态标记（标题栏区域一个暗红圆点 + "幽灵模式 · 剩余 23 分钟"）。

### 6.9 今日词云（解决 builder-check B-2）

旧版的词云是一个独立的 WinForms 自绘窗口（28KB），Electron 无法沿用其界面。

**决定：移植分词与布局算法，界面改为应用内的一个视图。**

- 从 `src/WordCloudForm.cs` 移植 6 个纯函数到 `core/src/logic/wordcloud.ts`：`ExtractCjkWords`（第 130 行）、`TrimParticles`（208）、`LatinWords`（220）、`CjkRuns`（245）、`IsCjk`（263）、`StopWords`（ HashSet，270）。这些是无词典中文分词的核心，纯字符串处理，零依赖，直接搬。
- **不移植** `EnsureLayout`（531，防重叠布局）与 `ExportPng`（414）的**绘制**部分——那是 GDI+ 专有代码。改用 **HTML/CSS 布局 + 简单碰撞检测**重做：词按权重分档定字号，随机初始位置，螺旋/重力式散开，碰撞则重试（上限次数后放到外围）。这比 GDI+ 版本更容易调，也能直接 `dom-to-image` 类方式导出 PNG（或干脆用 Electron 的 `capturePage` 截该区域——零依赖，★ 已实测可用）。
- 入口：托盘菜单「✨ 今日词云」→ 面板切到词云视图（同一个窗口换视图，不是新窗口）。
- **理由**：新做一个窗口 = 新做一套窗口生命周期（无边框、拖拽、缩放、关闭），成本高且和主窗口的视觉要重新对齐；做成应用内视图则复用现有窗口与主题，工作量小得多，效果也更统一。
- **统计范围（定死，免得实现时自由发挥）**：**本地日历日**（当天 00:00:00 至当前，系统时区）；只统计**文本类记录**（`kind` ∈ text/link/code/path/number），**图片不参与**；收藏与未收藏都算；拼接记录（`source='merge'`）也算（它就是用户自己产出的文本）。`WordCloudData.totalItems` = 参与统计的记录条数。
- **导出 PNG：本轮做**，零新依赖——`webContents.capturePage(rect)` 截词云区域（★ 实测 `capturePage` 可用），经 `dialog.showSaveDialog` 存盘。

---

## 7. 行为规格

### 7.1 剪贴板捕获

**★ 两级轮询（实测约束）**：`clipboard.readImage()` 在有大图时会解码整张位图，300ms 一次会把 CPU 吃满。

```
每 300ms：
  fmts = clipboard.availableFormats()
  1. 若 fmts 含 text/uri-list，或 clipboard.has('FileNameW') 为真 → 跳过（文件列表，本轮不做）+ 轻提示一次
  2. 若 fmts 含 image/*  → readImage()，走图片管线
  3. 否则若 fmts 含 text/plain → readText()，走文本管线
  4. 否则（text/html 单独出现、空剪贴板等）→ 跳过
```

变更检测：文本用字符串比较；图片先用 `availableFormats()` + 字节长度 + 前 4KB 哈希粗判，粗判相同就跳过完整解码。

解码 / 缩放 / 缩略图 / 编码**全部在主进程**做（`nativeImage.toPNG()` 在渲染进程会阻塞 UI）。

**★ 启动基线与幽灵模式恢复**：冷启动时「上次值」是空的，若不处理，第一跳会把**启动前就躺在剪贴板里**的东西记成一条历史。规则：

- 应用启动后、开始轮询前，先**静默读一次**剪贴板（只读格式与内容）记为 `lastSeen`，**不记录**。
- 幽灵模式**结束时**同样先静默读一次并重置 `lastSeen`（期间剪贴板可能被换过），**不补录**——与 §6.8 的隐私承诺一致。
- 幽灵模式期间**完全不调用** `availableFormats()` / `readText()` / `readImage()`。

**★ 剪贴板被别的进程占用时**：Electron 的 `clipboard.*` 在剪贴板被锁时会抛异常。处理：整个 tick 包在 `try/catch` 里，**失败即跳过本跳**（300ms 后本来就有下一跳，重试风暴只会更糟），连续失败 ≥ 5 次时在 `CLIPCHAN_TRACE` 日志里记一条。与旧版 `src/HotkeyWindow.cs` 的「3 次重试（20/60/120ms）」**有意不同**：旧版是事件驱动、没有下一跳，新版是定时轮询、天然自愈。

**★ 自我抑制**：程序自己写剪贴板（用户点卡片粘贴、拼接结果回写）时要先置抑制标记，否则自己的写入会被轮询捕获成一条新记录。旧版 `MainForm.cs:811` 的 `_msg.SuppressNext()`（`Commit()` 从 :804 开始） 就是这个作用，必须抄。

### 7.2 自动粘贴（助手常驻）

**★ 实测：一次性启动助手要 403–471ms**（5 次采样：465/449/449/421/403），用户按 Enter 等半秒不可接受。**常驻模式**下每条命令的往返延迟是 **min 0.02ms / median 0.03ms / max 0.22ms**（60 次）。所以助手必须常驻：应用启动后按 §8.2 的方式预热拉起（空闲 5 秒时，避免开机就多一个进程），之后走 stdin/stdout 行协议。

**行协议**：

启动   → READY pid=<进程号>
粘贴   → PASTE <十进制句柄>
响应   ← RESULT <句柄> <码> <说明>
毛玻璃 → BLUR <十进制句柄> <0|1> <ABGR 色值>
响应   ← BLUR <句柄> <码>
前台窗 → FG
响应   ← FG <十进制句柄>
探活   → PING <标记>
响应   ← PONG <标记>
退出   → QUIT

结果码：0=成功 / 1=窗口失效 / 2=归位失败 / 3=无输入落点 / 4=SendInput 部分投递 / 5=参数错误 / 6=目标提权 / 7=归位后仍无输入落点；`BLUR` 另用 2=系统拒绝（回落降级）。`--layout` 子命令打印五个结构体尺寸（KEYBDINPUT / MOUSEINPUT / HARDWAREINPUT / INPUT / GUITHREADINFO），供构建脚本自检。

**★ 结构体布局（x64 实测）**：`SIZE_KEYBDINPUT=24`、`SIZE_MOUSEINPUT=32`、`SIZE_HARDWAREINPUT=8`、**`SIZE_INPUT=40`**、`SIZE_GUITHREADINFO=72`。40 正是 OS 期望值。

**★ 布局陷阱必须照抄**：`INPUTU` 用 `[StructLayout(LayoutKind.Explicit)]`，三个成员 `KEYBDINPUT`/`MOUSEINPUT`/`HARDWAREINPUT` **全部 `[FieldOffset(0)]` 并排放**。只放 `KEYBDINPUT` 会让 `Marshal.SizeOf(INPUT)` 在 x64 得到 32 而不是 40，`SendInput` 会**静默返回 0**、粘贴永远不发生（`src/Program.cs:135-260` 的注释记录了这个坑）。`InputSize` 只算一次并复用。

**目标窗口**：默认是**唤起面板那一刻**记下的前台窗口。句柄一次性，用过立刻清空，绝不复用——Windows 会回收复用 HWND，陈旧句柄会粘进陌生窗口（`src/MainForm.cs:821-824` 有注释）。

**★ 小组件常驻 / 关掉失焦隐藏时怎么定目标**：这两种情况下「唤起那一刻」早就过去了，用户双击卡片时前台可能是别的应用、甚至就是 Clipchan 自己。所以主进程额外维护一个 **`lastForeignForeground`**：

- 助手提供 `→ FG` / `← FG <hwnd>`（当前前台窗口句柄）。主进程在**面板显示时**与**面板失焦（`win.on('blur')`）时**各查一次，结果不是 Clipchan 自己的 hwnd 就记下来。
- 粘贴目标 = 唤起时记下的句柄；为空或等于自身 hwnd 时用 `lastForeignForeground`；两者都不可用 → `{ok:false, reason:'no-target'}`，界面提示「没有可粘贴的目标窗口，内容已复制」。
- 无论走哪条路，句柄都是**用完即弃**，不跨次复用。

**★ 三层验证跑在哪里**：三层验证全部在**助手进程内部**执行——Electron / Node 侧调不到任何 Win32 API（`SetForegroundWindow` / `IsWindow` / `GetGUIThreadInfo` 都不行，除非再写一个原生模块）。主进程只做两件事：发 `PASTE <hwnd>`、把返回的码翻译成 `PasteResult`。下面三层是助手的实现规格（抄 `src/MainForm.cs:864 PasteReturnTick`）：

1. 硬失效：`!IsWindow || !IsWindowVisible || IsIconic` → 直接放弃（不还原用户的窗口）。
2. 归位尝试：`SetForegroundWindow(target) && GetForegroundWindow()==target`，**不在这里判死**。
3. 落点兜底：`HasFocusSink(target)`，归位后仍无落点说明是桌面/shell 空壳面，诚实回退。

三层都过才发 Ctrl+V。软失效（前台还没交接完）宽限重试 4 次 × 80ms ≈ 320ms，到点判死回退提示「已复制，按 Ctrl+V 粘贴」。

`HasFocusSink` 的实现（`src/Program.cs`）：先 `GetGUIThreadInfo`，`hwndFocus != 0` 直接放行；拿不到落点时按窗口类**黑名单**排除 `Progman` / `WorkerW` / `Shell_TrayWnd` / `Shell_SecondaryTrayWnd` 与 `Windows.UI.Core*` 前缀，其余返回 `IsWindowVisible`。**不能把 hwndFocus 当必要条件**——UWP/WinUI 的焦点走独立输入通道常返回 0，当必要条件会让自动粘贴直接失效。

**`elevated` 的判定（解决 builder-check 提的「退出码没覆盖 elevated」）**：助手在**归位尝试之前**做一次提权检测——`GetWindowThreadProcessId(target, out pid)` 拿进程号，`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, pid)` 后 `GetTokenInformation(TokenIntegrityLevel)` 取目标完整性级别，与自身进程比对；目标更高即返回码 **6**。**`OpenProcess` 失败也算 6**（UIPI 挡住查询本身就是"目标更高"的证据）。这个检测在助手内部做，因为只有助手能调 Win32。

**★ 助手码 → `PasteResult` 映射（唯一权威，别在别处再猜一遍）**：

| 助手码 | `PasteResult` | 界面文案 |
|---|---|---|
| 0 | `{ ok: true }` | —（静默贴进目标窗口） |
| 1 窗口失效 | `{ ok:false, reason:'no-target' }` | 没有可粘贴的目标窗口，内容已复制 |
| 2 归位失败 | `{ ok:false, reason:'send-failed' }` | 已复制，按 Ctrl+V 粘贴 |
| 3 无输入落点 | `{ ok:false, reason:'no-target' }` | 没有可粘贴的目标窗口，内容已复制 |
| 4 SendInput 部分投递 | `{ ok:false, reason:'send-failed' }` | 已复制，按 Ctrl+V 粘贴 |
| 5 参数错误 | `{ ok:false, reason:'send-failed' }` | 已复制，按 Ctrl+V 粘贴（同时写 `CLIPCHAN_TRACE`，这是实现 bug） |
| 6 目标提权 | `{ ok:false, reason:'elevated' }` | 目标窗口以管理员身份运行，无法自动粘贴 |
| 7 归位后仍无落点 | `{ ok:false, reason:'send-failed' }` | 已复制，按 Ctrl+V 粘贴 |

**兼容性回退**：助手编译失败（`csc.exe` 不在）或运行时不可用时打包继续：`capabilities.autoPaste` 为 false（界面隐藏自动粘贴开关）、`capabilities.frostedGlass` 为 false（界面显示「已降级」）。

### 7.3 图片管线（解决 builder-check A-6）

**★ 实测结论**：`nativeImage` **没有 `toWebP()`**，也**不能解码 WebP**（`createFromBuffer` 喂 WebP 返回 `isEmpty()===true`）。所以：

| 项 | 决定 |
|---|---|
| 缩略图 | **PNG**，长边 128px（实测 11–13KB，比 WebP 只大几 KB，零依赖） |
| 原图（无 alpha） | **JPEG q80**（实测照片 11742KB → 1894KB，降 6.2 倍） |
| 原图（有 alpha） | **PNG** |
| 原图长边上限 | **2560px**（从 4096 下调，配合磁盘预算） |
| 存储位置 | `app.getPath('userData')/images/<id>.<ext>` 与 `.../thumbs/<id>.png` |

**磁盘预算**：记录条数上限管不住磁盘（200 张截图能到 GB 级）。另设 `imageBudgetMB` 默认 **512MB**，超出时从**最旧的未收藏图片**开始删，降到 80% 以下为止。收藏图片不自动清，但设置页显示「收藏图片占用 XX MB」，让用户知道是谁占的。

**IPC 只传缩略图**：渲染进程拿到的 `thumbUrl` 指向缩略图文件（或 data URL），原图按需通过 `items.getFullImage(id)` 读取。原图路径与哈希不出主进程——即使渲染层被 XSS 也读不到磁盘。

**贴回原窗口**：图片粘贴走同一个三层验证，只是发送前把图片写进剪贴板（`clipboard.writeImage`）再发 Ctrl+V。**★ 注意**：写图片剪贴板本身会触发轮询，必须走自我抑制。

**★ 图片文件的生命周期**：图片记录在库里有 `image_path` / `thumb_path`，磁盘文件必须跟着记录走，否则会漏磁盘：

- **删除单条 / 清空未收藏 / 按 `historyLimit` 淘汰**：同一次操作里把对应的 `images/<id>.*` 与 `thumbs/<id>.png` 一并删掉（文件删除失败只记日志、不回滚数据库——库里没有行、文件留着就是垃圾，交给下一步清理）。
- **启动时扫一遍孤儿文件**：列出 `images/`、`thumbs/` 里所有文件，凡在库里找不到对应 `id` 的直接删掉（覆盖强杀进程留下的残留）。
- **收藏图片超出预算**：**只警告不自动删**——设置页显示「收藏图片占用 XX MB（已超出预算）」。理由：收藏是用户明确的「别动它」信号，程序自作主张删掉是最不能接受的一类 bug。

### 7.4 分类与去重

**分类器照抄旧版 `src/ClipClassifier.cs`**（5 类 + 图片，展示层折叠见 §6.4）：

- 先判 `singleLine`（无 `\n` `\r`）。
- 单行时依次判：**链接**（前缀 `http://` `https://` `www.` `ftp://`，不区分大小写）→ **路径**（`\\` 开头，或长度 > 2 且 `t[0]` 是字母、`t[1]==':'`、`t[2]` 是 `\` 或 `/`）→ **纯数字**（只允许数字与 `.` `,` `-` `+` `%` 空格，至少 1 位数字，长度 ≤ 24）。
- 否则 `LooksLikeCode(t)`：命中关键字表任一即代码——`"function "` `"def "` `"class "` `"import "` `"public "` `"private "` `"void "` `"const "` `"let "` `"var "` `"return "` `"SELECT "` `"select "` `"using "` `"namespace "` `"console.log"` `"println"` `"#!/"` `"<?xml"` `"<html"` `"{\n"` `"};` `"=>"` `"()"` `");"`；或 长度 ≥ 12 且 `{ } ; ( ) = < >` 占比 ≥ 12%。
- 都不命中 → `text`。

**★ 去重作用域：扫描整段历史（解决 builder-check A-2）。** 旧版 `src/Store.cs:90-117`（去重循环在 :102-109）的行为是：新内容与**历史上任意一条**完全相同即视为重复，不新增，而是 `TouchExisting` 提升到最前。新版沿用这个语义（与 §7.1 旧稿的"只比最近一条"不同，**有意纠正**）。实现：`content_hash` 列建**唯一索引**（文本）或 `image_hash` 列（图片），插入前 `SELECT` 命中则 `UPDATE` 时间戳与序号。

**★ 重复命中时同时刷新 `created_at` 和 `seq`（抄旧版）**：只刷时间戳会在同一 15ms tick 内并列、旧序号把条目压回后面；只刷序号会让相对时间显示失真。两个都刷。

**★ `seq` 存在的理由（必须抄）**：Windows `DateTime.UtcNow` 精度约 15ms，连续快速复制会产生相同时间戳，而 SQL 的 `ORDER BY created_at DESC` 在时间相同时顺序不确定，"最新一条"会随机漂移。所以排序键是 **`ORDER BY pinned DESC, created_at DESC, seq DESC`**（与旧版 `CompareForDisplay` 的"收藏优先 → 时间倒序 → 序号倒序"一致）。`seq` 用单调递增整数（SQLite 里用 `AUTOINCREMENT` 的独立列或进程内计数器 + 持久化最大值）。

### 7.5 拼接与"连续复制"（解决 builder-check A-1）

**★ 纠正旧稿的错误描述**：旧版**不做自动合并**。

- `src/MainForm.cs:573-600 TrackBurst`（`_burstIds` 在 :45 声明，阈值 `BurstHintAt`）：2 秒内连续复制达到 3 条时，把这几条的 id 收进 `_burstIds`，在 :590 调用 `ApplyBurstSelection()`（:603 实现）—— **只是预选中**，不合并。
- 真正合并发生在 `MainForm.cs:756 MergeSelected` → `Store.cs:141 MergeTexts`，且**只在用户按 Ctrl+M 时触发**（调用点 `MainForm.cs:670` 与 `:707`）。合并后 `:788` 清空 `_burstIds`。

**新版行为**（逐条对齐 `MainForm.cs:43-44` 与 `:573-625`）：

1. 两次复制的间隔 ≤ **2000ms**（`BurstWindowMs`）算同一串；攒到 **3 条**（`BurstHintAt`）才动作，避免打扰。
2. 攒够 3 条时**分两种情况**（旧版就是分开的，照抄）：
   - **面板可见**：预选中这一串（跳过收藏项与已消失的条目），列表上方浮出提示条「检测到连续复制 3 条 · 按 Ctrl+M 拼接」。提示条 5 秒后淡出，**选中保持**。
   - **面板不可见**：发一条系统托盘气泡通知「已连续复制 3 条 / 唤出面板后已自动选好，按 Ctrl+M 可拼接成一条」，并打标记，下次唤出面板时再执行预选（旧版 `_burstHinted` 的作用）。
3. 用户按 **Ctrl+M** → 取选中项，**跳过收藏项**（`src/MainForm.cs:772 if (it.Pinned) continue;`），把剩下的文本按**列表顺序**用分隔符 `"\r\n"` 拼接（`MainForm.cs:785 MergeTexts(texts, "\r\n")`）→ 生成一条新记录，**然后删除这些源条目**（`MainForm.cs:787 _store.RemoveMany(ids)`）。
   - 参与拼接的**未收藏**记录少于 2 条时**什么都不做**，只提示：不足 2 条选中 → 「拼接需要至少 2 条，按住 Ctrl 或 Shift 多选几条再按 Ctrl+M」；选中够但去掉收藏后不足 2 条 → 「拼接需要至少 2 条未收藏记录，收藏项不会被合并」（`MainForm.cs:759-783`）。
4. 新记录：`kind` 按分类器**重新计算**（拼接结果可能是代码或长文本），`pinned=0`，来源标记 `source='merge'`（旧版没有这个字段，新增）。**★ 拼接不走去重**：旧版 `Store.cs:152` 是直接 `_items.Add(merged)`，不做 hash 比对——拼接结果与既有记录内容相同也照样新增。照抄这个行为（用户刚明确要求拼接，静默"提升已有条目"会让他的操作看起来没生效）。
5. 拼接**只对文本记录生效**。选中项里含图片时，图片不参与拼接，提示「图片不参与拼接，已跳过 N 条」；若去掉图片后不足 2 条，按第 3 条的规则什么都不做。
6. 拼接完成后清空 burst 状态（`MainForm.cs:788-789 _burstIds.Clear(); _burstHinted = false;`），并**选中新记录**（`MainForm.cs:793-796`）。

**理由**：自动合并会静默吃掉用户的独立记录（旧版作者显然也这么想，才做成"预选 + 手动确认"）。预选 + 提示保留了效率，同时把"要不要合并"的决定权留给用户。

### 7.6 幽灵模式与容量

见 §6.8 与 §7.3。补充：**`ghost_until` 不写入数据库**（旧版 `Settings.cs:18` 注释即如此），只在主进程内存里；进程退出即失效。

### 7.7 键盘操作（一条不丢，反目标要求）

```
↑ / ↓          移动选中
Enter          粘贴选中项
Esc            隐藏面板
Ctrl+D         收藏 / 取消收藏
Ctrl+M         拼接选中项
Delete         删除选中
Ctrl+Delete    清空未收藏
Ctrl+F         聚焦搜索框
```

搜索框内按 `↓` 从搜索框跳到列表，`↑` 到顶再回搜索框。

---

## 8. IPC 契约与助手协议

### 8.1 渲染进程可见的 API

渲染进程**不开 `nodeIntegration`、不用 `remote`**。preload 用 `contextBridge.exposeInMainWorld('clipchan', ...)` **只暴露下面这些固定方法，不暴露任意通道**：

```ts
interface ClipchanApi {
  items: {
    list(q: ListQuery): Promise<ClipItemDTO[]>
    paste(id: string): Promise<PasteResult>
    remove(id: string): Promise<void>
    togglePin(id: string): Promise<void>
    clearUnpinned(): Promise<void>
    clearAll(): Promise<void>                        // 设置页「清空全部」（两次点击确认在界面侧）
    getFullImage(id: string): Promise<string>       // 按需取原图
    onChanged(cb: () => void): () => void           // 取消订阅函数
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChanged(cb: (s: Settings) => void): () => void
  }
  ghost: {                                       // 幽灵模式是运行态，不落库（§7.6）
    get(): Promise<GhostState>
    set(minutes: number | null): Promise<GhostState>   // null = 关闭
    onChanged(cb: (g: GhostState) => void): () => void
  }
  app: {
    setMode(mode: 'main' | 'widget'): void       // ★ 同一个窗口换形态（§6.6），不新建窗口
    hide(): void
    setWidgetSize(px: number): void
    resizeBy(dw: number, dh: number): void       // 自绘缩放手柄用
    getHotkeyStatus(): Promise<HotkeyStatus>
    getAutoStart(): Promise<boolean>
    setAutoStart(on: boolean): Promise<boolean>  // 写 HKCU\...\Run（§8.3）
    openDataFolder(): void                       // 打开 %APPDATA%\Clipchan
  }
  wordcloud: {
    today(): Promise<WordCloudData>
    exportPng(): Promise<{ ok: boolean; path?: string }>   // 验收 34
  }
  capabilities: { autoPaste: boolean; globalHotkey: boolean; backgroundCapture: boolean; frostedGlass: boolean }
}
```

`ClipItemDTO` 是给界面看的**投影**：`{ id, kind, preview, thumbUrl?, createdAt, pinned, sizeLabel?, source }`。原图磁盘路径与哈希**不出主进程**。

上面 API 里出现的其余类型，全部定义在 `packages/core/src/types.ts`（界面与主进程共用同一份声明）：

```ts
type Kind = 'text' | 'link' | 'code' | 'path' | 'number' | 'image'

interface ListQuery {
  kind?: Kind | 'all' | 'favorite' | 'text-group'   // 侧栏筛选；'text-group' = text|path|number（§6.4）
  q?: string                          // 搜索词
  limit?: number                      // 每页条数，默认 200，最大 500
  offset?: number                     // 分页偏移，默认 0
}
```

**★ `q` 的匹配范围（解决「图片搜索怎么实现」）**：文本类走 SQL——`content LIKE '%' || ? || '%'`（图片行 `content` 为 NULL，天然不匹配）；图片类按**同一套描述文案**匹配，由 SQL 现场拼出、**不落库**：`(kind='image' AND ('图片 ' || width || '×' || height || ' · ' || (bytes/1024) || ' KB') LIKE '%' || ? || '%')`。两者用 `OR` 连起来，排序与分页全部在 SQL 里完成（`ORDER BY pinned DESC, created_at DESC, seq DESC LIMIT ? OFFSET ?`），渲染进程**不做二次过滤**——否则分页会错位。

```ts
interface ClipItemDTO {
  id: string
  kind: Kind
  preview: string            // 文本：压缩空白后的预览；图片：'图片 1920×1080 · 183 KB'
  thumbUrl?: string          // 图片才有，指向缩略图
  createdAt: number          // epoch ms
  pinned: boolean
  truncated?: boolean        // 文本被 100000 上限截断
  sizeLabel?: string         // '183 KB'
  source: 'clip' | 'merge'
}

interface Settings {
  theme: 'auto' | 'light' | 'dark'
  historyLimit: number          // 默认 200，100–9999
  imageBudgetMB: number         // 默认 512
  widgetSize: number            // 240–400
  widgetCorner: 'remember' | 'bottom-right'
  hideOnBlur: boolean           // 默认 true
  autoPaste: boolean            // 默认 true
  hotkeyActivate: string        // Electron accelerator，默认 'Control+`'
  hotkeyWidget: string          // 默认 'Alt+C'
}

interface HotkeyStatus {
  activate: { accelerator: string; registered: boolean; fallback?: string }
  widget:   { accelerator: string; registered: boolean }
}

interface GhostState {
  active: boolean
  until: number | null        // epoch ms，active=false 时为 null
  remainingMs: number
}

interface WordCloudData {
  words: { text: string; weight: number }[]   // 已按 weight 降序
  totalItems: number                          // 今天参与统计的条目数
}
```

`PasteResult = { ok: boolean; reason?: 'no-target' | 'elevated' | 'send-failed' }`（三种理由，与上表一一对应）。

**★ 列表分页与渲染**：`historyLimit` 可调到 9999，但一次查询**不会**把 9999 条全拉进渲染进程。约定：`items.list({ limit: 200, offset })` 分页，界面滚到底部再拉下一页；卡片用 CSS `content-visibility: auto` + `contain-intrinsic-size` 让浏览器跳过屏幕外卡片的渲染（零依赖，不用引 `react-window` / tanstack/react-virtual`）。这样既能让用户真的看到超过 200 条，又不会一次渲染几千个 DOM 节点。

### 8.2 助手进程管理

- 应用启动后**懒启动**（第一次需要粘贴时才拉起，避免开机就多一个进程）——但启动要 403–471ms，所以**首次粘贴会慢一次**。折中：应用启动后 5 秒空闲时**预热**（提前拉起并 PING 探活），这样用户第一次按 Enter 也是快的。
- 助手崩溃/退出 → 检测到 stdout 关闭 → 标记 `autoPaste` 不可用 → 下次需要时重启一次，仍失败则提示并关闭该功能（不反复重启）。
- 应用退出时发 `QUIT`，并设 2 秒超时强杀，避免残留进程。
- **毛玻璃**：面板 / 小组件显示时 `BLUR <hwnd> 1 <色值>`、隐藏时 `BLUR <hwnd> 0`；助手不可用则 `capabilities.frostedGlass=false`，界面显示「已降级」。助手是**一个进程**同时负责粘贴、毛玻璃、前台窗口查询（命令见 §7.2），不额外多起进程。

### 8.3 打包产物与自启

**★ 实测：electron-builder 必须设 `npmRebuild: false` + `buildDependenciesFromSource: false`**，否则会走 `@electron/rebuild` → node-gyp → 因本机无 Python 而失败（探针实测报错 `Could not find any Python installation to use`）。加上后 portable.exe 构建成功（85.6 MB，exit 0）。

**★ portable 自启（解决 builder-check A-4 / B-4）**：electron-builder 的 portable 模板（`app-builder-lib/templates/nsis/portable.nsi:77-79`）会注入 `PORTABLE_EXECUTABLE_FILE` 等环境变量。所以：

```ts
app.setLoginItemSettings({
  openAtLogin: true,
  path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
})
```

注册的是**用户双击的那个原始 exe**，不是临时解压路径。**主产物定 portable.exe**（免安装，符合反目标），NSIS 安装包作为可选第二产物。

---

## 9. 存储

### 9.1 位置

`app.getPath('userData')` 但目录名保持 **`Clipchan`**（用 `app.setPath('userData', ...)` 指向 `%APPDATA%\Clipchan`），这样旧用户的数据原地可迁移。

%APPDATA%\Clipchan\
├─ clipchan.db              SQLite（WAL 模式，★ 实测可用）：items 表 + settings 表
├─ images\<id>.<jpg|png>
├─ thumbs\<id>.png
├─ history.json.migrated   迁移后的旧文件留档（不删）
└─ settings.json           ★ 旧版的文件：新版**只读不写**（见 §9.4）

### 9.2 表结构

```sql
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- text|link|code|path|number|image
  content      TEXT,                   -- 文本内容；图片记录为 NULL
  content_hash TEXT,                   -- 文本的 sha256（唯一索引）
  image_path   TEXT,                   -- 相对 app.getPath('userData')（%APPDATA%\Clipchan），如 images/<id>.jpg
  image_hash   TEXT,                   -- 图片的 sha256
  thumb_path   TEXT,                   -- 同上，如 thumbs/<id>.png
  width        INTEGER, height INTEGER, bytes INTEGER,
  source       TEXT NOT NULL DEFAULT 'clip',   -- clip|merge
  pinned       INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,      -- 内容是否被 100000 字符上限截断
  created_at   INTEGER NOT NULL,       -- epoch ms
  seq          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL;
CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
```

**★ 单条文本上限沿用旧版的 100000 字符**（`src/Store.cs:15 MaxChars`，`ClipItem.SetText` 超限即截断并置 `Truncated`）。库里的 `truncated` 列就是这个标记，导入旧数据时从 `trunc` 键读入；界面在超长记录的预览上加一个「已截断」小标记，让用户知道完整内容不在库里。图片不适用此上限（走 §7.3 的 2560px 与磁盘预算）。

**★ 图片记录的 `content` 字段存什么（解决 builder-check 的悬空问题）**：存 `NULL`。预览文字（如 `"图片 1920×1080 · 183 KB"`）由 `ClipItemDTO.preview` 在读取时**计算**，不落库——避免同一信息存两份而不同步。

### 9.3 迁移（解决 builder-check A-5）

条件：`clipchan.db` 不存在 且 `%APPDATA%\Clipchan\history.json` 存在。

**★ 先看旧文件的真实字段名（已核对源码，不是猜的）**：旧版是手写 JSON，**字段名是短键，不是 C# 属性名**。

`history.json`（`src/Store.cs:237-249` 写出、`:395-417` 读回）：

```jsonc
{
  "version": 1,
  "items": [
    {
      "id":    "…",           // 32 位十六进制 GUID（Guid.NewGuid().ToString("N")）
      "text":  "…",           // 内容
      "at":    "2026-10-14T…", // ISO 8601 往返格式（DateTime "o"），UTC
      "seq":   12345,          // 单调序号（后加字段，旧文件可能没有）
      "pin":   false,          // 注意是 pin，不是 pinned
      "trunc": false           // 是否因超过 100000 字符被截断
    }
  ]
}
```

`settings.json`（`src/Settings.cs:152-161` 写出、`:133-135` 读回）：

```jsonc
{
  "ctrl": true, "alt": false, "shift": false, "win": false,
  "key": 192,            // WinForms Keys 值（192 = Keys.Oemtilde 即反引号）
  "theme": "auto",       // auto | light | dark
  "autopaste": true,
  "label": "Ctrl+`"      // 仅展示用，导入时忽略
}
```

**★ 关键陷阱：如果按 C# 属性名（`CreatedUtc` / `Pinned` / `Truncated`）去解析，会全部读成空值** —— 迁移会"成功"但一条内容都不进来，或者导入一堆空记录。必须用上面这些短键。

迁移步骤：

1. 建库建表。
2. 逐条导入，字段映射：`id` → `id`、`text` → `content`、`at` → `created_at`（`DateTimeStyles.RoundtripKind` 解析后转 UTC 毫秒；解析失败则用当前时间并记一条警告）、`pin` → `pinned`、`seq` → `seq`。
3. **`seq` 缺失时（旧文件是 seq 之前写的）按 `src/Store.cs:411-415` 的做法**：把该条的 seq 设为"当前已知最大 seq + 1"（旧版是回落到 `ClipItem.NextSeq()`），并保证之后的新记录序号一定大于所有导入值——否则新记录会排到旧记录后面。
4. **`kind` 按分类器重算**（解决 builder-check 指出的 §9 两处不一致）：旧版的类型识别规则和新版是同一套（§7.4 已逐条核对），重算结果一致。图片不存在于旧数据中（旧版只处理文本）。
5. 读 `settings.json`：`theme` → 主题、`autopaste` → 自动粘贴开关、`ctrl/alt/shift/win/key` → 热键（WinForms 的 `key` 数值不能直接当 Electron 的 accelerator 用，见下方"热键映射"）。`label` 忽略。
6. 导入成功后把 `history.json` **改名**为 `history.json.migrated`（不删，留档）；`settings.json` 保留原样不动（旧 exe 可能还要用）。
7. 导入过程用单个事务，失败则回滚并保留原文件；**部分条目解析失败不整体失败**（跳过该条并计数，导入完成后若跳过数 > 0 则在设置页给一条提示）。

**★ 热键映射（`key` 数值不是 Electron accelerator）**：旧版存的是 WinForms `Keys` 枚举值（`src/Settings.cs:34`，默认 192 = `Keys.Oemtilde`）。新版要用 Electron 的 accelerator 字符串（如 `Control+``）。映射方式：**不试图翻译数值**，而是直接采用新版的默认热键（Ctrl+`），并在设置页显示"检测到旧版热键设置，已重置为默认值，如需请重新设置"。理由：WinForms 的 `Keys` 值到 Electron accelerator 的映射表要覆盖上百个键，而用户的旧热键大概率就是默认的 Ctrl+`；为一个小概率场景写一张大映射表不划算。**这是有意的简化，写在这里以免被当成遗漏。**

**★ 新旧共存（解决 builder-check A-5 后半）**：不做进程互斥（新旧是两个不同程序，抢不到同一个互斥体），但要做两件事：

- 新版的全局热键注册失败时（大概率是旧版正占着 Ctrl+`），提示里明确写「可能是旧版 Clipchan 正在运行，请退出后重试」——把症状和原因连起来。
- 设计文档与 README 里写明：**迁移完成后建议不要再运行 `legacy/` 里的旧 exe**，两者会抢同一个热键并各自记录一份历史。

### 9.4 设置持久化

新版的 `Settings` **存进 `clipchan.db` 的 `settings` 表**，不写任何 `settings.json`：

`~sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL          -- JSON 编码的值
);
`~


理由：`%APPDATA%\Clipchan\settings.json` 正是旧 exe 的配置文件（§9.3）。新版若复用它，旧 exe 会读到不认识的格式、甚至被写坏。放进库里就完全没有碰撞面。

迁移时**只读**旧 `settings.json`（`theme` / `autopaste` 两项照搬，热键按 §9.3 重置为默认），**不写回**该文件、也不改名——旧 exe 仍能正常启动。

读取策略：启动时把整表读进内存（几十字节），`settings.set(patch)` 单事务写回并广播变更事件给渲染进程。

---

## 10. 开发与构建

### 10.1 日常开发

```
pnpm dev
```

起 Vite dev server + Electron 指向它。**HMR 只作用于渲染进程**；主进程（`electron/*.ts`）改动要重启（可用 `electron-vite` 或自己写 watch，本轮先用"改了手动重启"）。

**★ 所有开发/构建脚本第一件事：`Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`**——本机默认带这个变量，不清掉 electron.exe 会退化成纯 Node（实测报 `Cannot read properties of undefined (reading 'whenReady')`）。

### 10.2 构建顺序

```
pnpm build
  ① csc.exe 编译 helper/ClipchanHelper.cs → clipchan-helper.exe
     C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
       /nologo /target:exe /platform:x64 /optimize+ /out:...
     ★ 编译失败不阻断打包，只把 autoPaste 标为不可用
  ② Vite 构建渲染进程
  ③ electron-builder --win portable（+ 可选 nsis）
     环境变量：ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 指向 npmmirror
```

### 10.3 构建配置要点（★ 全是实测得出的必填项）

```jsonc
{
  "npmRebuild": false,                    // ★ 必填，否则 node-gyp 因无 Python 失败
  "buildDependenciesFromSource": false,
  "asarUnpack": ["**/*.node"],            // better-sqlite3 的 .node 不能进 asar
  "files": ["dist/**/*", "electron-dist/**/*", "node_modules/**/*",
            "!node_modules/electron/**"],
  "directories": { "output": "release" },
  "win": { "target": ["portable", "nsis"] },
  "portable": { "artifactName": "Clipchan.exe" },
  "nsis":     { "artifactName": "Clipchan-Setup-${version}.exe" },
  "extraResources": [{ "from": "helper/dist/clipchan-helper.exe", "to": "." }]
}
```

### 10.4 技术选型细节

- **Tailwind 用 v3.4.19**（与原型一致）。**不用 v4**——v4 的配置模型变了（CSS-first），原型搬过来的 `tailwind.config` 与令牌要重写，没有必要。
- `better-sqlite3` **不需要 `@electron/rebuild`**（★ 实测：自带 prebuild，Node-API ABI 稳定，真实 Electron 里跑通）。但仍保留 `sql.js` 作为退路——如果未来某台机器上 prebuild 不匹配，可以切 WASM 版本（代价是内存占用与性能）。
- 不用 `nodeIntegration`、不用 `remote`、不引 `sharp`（图片处理全用 `nativeImage`，★ 实测够用）。

---

## 11. 验收标准

每一条都必须是**可以当场演示或可以跑脚本验证**的。（共 35 条。）

| # | 验收项 | 怎么验 |
|---|---|---|
| 1 | 双击 `Clipchan.exe` 能启动并显示面板，不要求预装 Node/npm/.NET 或任何运行时 | 把 exe 单独拷到 `D:\tmp\clipchan-test\` 双击（该目录外无任何依赖） |
| 2 | 界面与原型同构：窗口 900×620、左栏 64px、有搜索栏与卡片列表（徽章/预览/时间戳/星标） | 截图与 `ojo/specs/wireframe.jpg` 并排比对，逐项打勾 |
| 3 | 全局快捷键唤起面板，面板出现在鼠标所在显示器中间偏上 | 按键，看位置 |
| 4 | 复制文本 → 立刻出现在历史第一条 | 复制，看列表 |
| 5 | 分类正确：`https://a.com` → 链接；`function f(){}` → 代码；`C:\\a\\b` → 路径；`42` → 数字；其余 → 文本 | 跑 `logic/classify.spec.ts` 单测 |
| 6 | 复制同一内容两次 → 只有一条记录，且被提升到最前（★ 时间戳与 seq 都刷新） | 复制两次，看条数与顺序 |
| 7 | **复制图片（截图）→ 进历史，卡片显示缩略图** | 截图，看列表 |
| 8 | **双击图片卡片 → 原图写回剪贴板并 Ctrl+V 贴进刚才那个窗口** | 在画图/微信里试 |
| 9 | 收藏 / 取消收藏，收藏项置顶且不计入条数上限 | 点星标，看顺序与设置页计数 |
| 10 | 搜索实时过滤：文本按内容子串；图片按「图片 W×H · N KB」描述匹配（§8.1 的 `q` 规格） | 输入关键词 |
| 11 | 连续复制 3 条 → 自动选中 3 条并浮出提示；按 Ctrl+M 后 3 条**合并为 1 条**（源条目消失、列表只剩这条且被选中） | 按脚本连续复制 |
| 12 | 键盘全流程：↑↓ / Enter / Ctrl+D / Ctrl+M / Delete / Ctrl+Delete / Esc | 全程不碰鼠标操作一遍 |
| 13 | 切换小组件模式，窗口变小、内容变紧凑，React 状态不丢（选中的项还在） | 点切换按钮 |
| 14 | 重启应用 → 历史还在（含图片缩略图） | 关掉再开 |
| 15 | 强杀进程（任务管理器结束）→ 重新打开，历史没有整份消失 | 杀进程再开 |
| 16 | 幽灵模式开启 → 复制内容不进历史；关闭 → 恢复捕获并给提示 | 开幽灵，复制，看条数 |
| 17 | 今日词云视图能打开；对一段 100 字左右中文，输出词数 ≥ 5 且不含单字虚词（的/了/是/在/和） | 造数据看词云 + `logic/wordcloud.spec.ts` 断言词表 |
| 18 | 托盘菜单：显示面板 / 暂停监听 / 开机自启 / 退出都能用 | 逐个点 |
| 19 | 开机自启：勾选后注册表 `HKCU\...\Run` 里的路径是**原始 exe 路径**而非临时目录 | 勾选后查注册表 |
| 20 | 自动粘贴失败时（目标是最小化窗口/桌面）回退为「已复制，按 Ctrl+V 粘贴」，不静默失败 | 在桌面上按 Enter |
| 21 | 旧数据迁移：`history.json` 存在时首次启动自动导入，原文件改名为 `.migrated` | 造一份旧数据启动 |
| 22 | ★ 旧 JSON 字段名核对：迁移代码按短键 `id/text/at/seq/pin/trunc` 与 `ctrl/alt/shift/win/key/theme/autopaste/label` 解析，**不是** C# 属性名；造一份含 3 条记录的真实旧文件，迁移后库里正好 3 条且内容逐字一致 | 独立 fact-check subagent 已核对源码；实现后再用真实旧文件跑一遍 |
| 23 | 先把上限调到 500，造 500 条（含 100 张图）；滚动全程无单帧超过 200ms 的长任务 | DevTools Performance 录一段滚动，看长任务 |
| 24 | 打包产物：`release\Clipchan.exe`（portable）与 `release\Clipchan-Setup-<版本>.exe` 构建成功且都能跑 | 跑 `pnpm build`，双击两个产物 |
| 25 | 面板唤起 < 300ms 可见 | 秒表/日志打点 |
| 26 | 单实例：重复启动只唤出已运行的面板，不出现第二个托盘图标 / 第二个轮询器 | 双击两次 exe |
| 27 | 启动基线：**启动前**剪贴板里已有的内容不会被记成历史第一条 | 先复制一句，再启动应用，看列表 |
| 28 | 幽灵恢复：幽灵期间复制的内容结束后**不补录**，且给一次「监听已恢复」提示 | 开幽灵 → 复制 → 关闭幽灵，看条数 |
| 29 | 小组件常驻时也能贴回：开着面板切到记事本复制一句，双击面板里的卡片 → 内容贴进记事本 | 手动试 |
| 30 | 设置落库：改主题 / 上限后重启保留，且 `%APPDATA%\Clipchan\settings.json` **未被修改**（比对修改时间） | 改设置重启 + 看文件时间 |
| 31 | 图片文件生命周期：删掉一条图片记录后对应 `images/`、`thumbs/` 文件消失；手动塞一个孤儿文件进 `thumbs/`，重启后被清掉 | 手动试 |
| 32 | 无边框窗口可拖动（拖标题栏）与可缩放（拖右下角手柄），限制在 720×480 ~ 1200×900 | 手动试 |
| 33 | 真毛玻璃：面板背后的桌面被真正模糊（开关前后截图对比）；把助手改名后重启 → 降级为半透明且设置页显示「已降级」 | 截图对比 + 改名重试 |
| 34 | 词云只统计**当天**的文本记录（图片不计），能导出 PNG | 造数据看词云 |
| 35 | 图标：`build/icon.ico` 由 1024×1024 源图生成，含 256×256 帧 | 检查 ico 头与帧 |

---

## 12. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| electron-builder 因 node-gyp 失败 | ~~中~~ **已消除** | ★ 实测加 `npmRebuild:false` 后成功出包 |
| better-sqlite3 装不通 | ~~中~~ **已消除** | ★ 实测自带 prebuild，真实 Electron 里跑通 |
| 助手启动慢 | ~~中~~ **已消除** | ★ 实测改常驻（403ms → 0.03ms） |
| 图片把磁盘吃光 | 中 | 512MB 预算 + 2560px 上限 + JPEG q80（★ 实测降 6.2 倍） |
| Win10 没有系统级毛玻璃（acrylic） | **已解决** | ★ 用户拍板做真的（2b）：助手调 DWM `SetWindowCompositionAttribute`；助手不可用时降级为半透明 + 内部阴影并在设置页标注（§6.6） |
| 打包体积 86MB | 低（接受） | 免安装的代价；用户已同意用 Electron |
| 全局热键被占用 | 低 | 沿用旧版降级策略 + 提示可能是旧版在运行 |
| 自动粘贴在提权窗口失效 | 中 | 三层验证回退 + `elevated` 提示；**不假装能解决**（UIPI 是系统限制） |
| 手机端后台读剪贴板被系统禁止 | **已确认存在** | 手机端定位改为"手动进出手动出"，界面明说，不假装 |
| 透明窗口在某些显卡驱动上异常 | 低 | ★ 实测本机可行；异常时降级为不透明 + 系统边框 |
| 原生助手（粘贴 + 毛玻璃）编译或运行失败 | 中 | 构建时编译失败**不阻断打包**；运行时崩溃只重启一次；`autoPaste` / `frostedGlass` 各自降级并在界面如实标注（§6.6 / §8.2） |
| 无边框透明窗口的边缘缩放不可靠 | 中 | 不依赖系统边框，自绘缩放手柄 + `app.resizeBy` 调 `win.setBounds`（§6.6） |
| 无 git，改动无法版本化 | 低 | 每个里程碑前手动拷贝一份到 `backup/<日期>/` |

---

## 13. 旧版能力处置表

| 旧版能力 | 新版 | 说明 |
|---|---|---|
| 剪贴板监听（仅文本） | **保留并扩展** | 增加图片；跳过文件列表与富文本（★ 实测读不到） |
| 全局热键 Ctrl+` | 保留 | 被占用降级 |
| 自动粘贴（三层验证） | **保留** | 逻辑照抄，执行体改为常驻 C# 助手 |
| 托盘菜单 | 保留 | 按新界面风格重做图标与文案 |
| 今日词云 | **保留算法，界面改应用内视图** | 见 §6.9 |
| 幽灵模式 | 保留 | 语义细化见 §6.8 |
| Ctrl+M 拼接 | 保留 | 语义澄清见 §7.5 |
| 连续复制检测 | 保留（预选，不自动合并） | 纠正旧稿错误描述 |
| 明暗主题 + 跟随系统 | 保留 | 配色按图标重定（§6.1） |
| 类型识别（5 类） | 保留 | 展示层折叠 path/number |
| 历史上限 200 | 保留默认值 | 可调至 9999 |
| 手写 JSON 存储 | **抛弃** | 换 SQLite（图片是二进制，JSON 不合适） |
| C# WinForms 自绘界面 | **抛弃** | 换 React + Tailwind |
| 单文件免运行时约束 | **抛弃** | 换 Electron（86MB 代价已接受） |
| 窗口 320×300~900×1200 手动缩放 | 部分保留 | 主窗口可缩放（自绘手柄，720×480~1200×900）；小组件 240–400px |
| 开机自启 | 保留 | 修 portable 路径问题（§8.3） |
| `--selftest` 71 项自检 | **抛弃** | 换 vitest 单测 + 手工验收清单（§11） |
| `--wordcloud` / `--ghost=30` 命令行 | 抛弃 | 改为托盘/设置页入口 |
| 单实例互斥（`Global\Clipchan.SingleInstance.v1`） | 保留 | 换成 `app.requestSingleInstanceLock()`；旧 exe 与新版仍是两个不同程序，可并存（§9.3） |
| 托盘「暂停监听」 | **并入幽灵模式** | 旧版是「永久暂停 + 定时幽灵」两套状态；新版合并成一套（托盘项打开幽灵模式子菜单），避免用户开了永久暂停就忘了关 |

---

## 14. 用户已拍板的事项（原「待拍板」三项）

用户 2026-10-15 答复「先做12」并选定：

| # | 事项 | 决定 | 影响 |
|---|---|---|---|
| 1 | 手机端这一轮做到哪一步 | **(a) 只搭壳** | Capacitor 工程建好、`core` 接上、能在浏览器看界面；**不装 JDK + Android SDK + Gradle（省约 2–3 GB）**、不出 APK、不做真机验收 |
| 2 | 毛玻璃 | **(b) 做真的** | 加原生助手调 DWM `SetWindowCompositionAttribute` 实现真背景模糊；多一个原生模块与调试面，助手不可用时自动降级（§6.6） |
| 3 | 随包内置字体 | **(a) 不内置**（Lead 按建议默认，用户未反对，可随时推翻） | 用系统字体栈；观感靠圆角 + 配色补 |

**因第 2 项（做真毛玻璃）产生的改动**：§5 的助手从「只有粘贴」变成「粘贴 + 毛玻璃 + 前台窗口查询」的唯一原生助手（`clipchan-helper.exe`）；§6.6 从「诚实降级」改成「真磨砂 + 降级路径」；§7.2 行协议新增 `BLUR` 与 `FG`；§8.1 新增 `capabilities.frostedGlass`；§11 新增验收 33。

**关于「三端」的第三端**：本轮明确只有**两端**——Windows 桌面 + Android 手机。「三端复用」的含义是**一份 `core` 被两个平台复用**，外加代码结构预留第三端（任何能跑 Web 的宿主）的接入点，但**本轮不做网页版**（不做 web 入口、不做浏览器平台适配器）。`PlatformAdapter` 接口的存在就是为了让第三端将来只写一个适配器，不动界面。

**本轮另外由 Lead 自行拍板、写进正文的 builder-check 遗留项**（用户如不同意可推翻，改动成本都很小）：单实例锁（§13）、启动与幽灵恢复的剪贴板基线（§7.1）、设置存进 `clipchan.db` 的 `settings` 表而不是 `settings.json`（§9.4）、列表分页 + `content-visibility` 而不是引入虚拟滚动库（§8.1）、托盘「暂停监听」并入幽灵模式（§13）、词云只统计当天文本记录且导出 PNG（§6.9）、无边框窗口自绘缩放手柄（§6.6）、剪贴板被锁时跳过本跳不重试（§7.1）、图片删除同时删文件 + 启动清孤儿（§7.3）、图标由 1024 源图重新生成（§5）。

---

## 15. 实测附录（结论的证据）

全部在 `%TEMP%\electron-probe` 与 `%TEMP%\build-probe` 两个临时工程里完成，**未污染项目目录**。

| # | 验的是什么 | 结论 |
|---|---|---|
| 1 | better-sqlite3 是否要 MSVC | 不要。自带 8 个平台 prebuild，含 61 个 `napi_*` 符号（Node-API）；真实 Electron 37.6.0 里建表/插入/查询 + WAL 全通 |
| 2 | 助手进程启动与往返延迟 | 一次性启动 465/449/449/421/403ms；常驻后往返 median 0.03ms、max 0.22ms（60 次）→ 必须常驻 |
| 3 | 结构体尺寸 | `KEYBDINPUT=24` `MOUSEINPUT=32` `HARDWAREINPUT=8` `INPUT=40` `GUITHREADINFO=72`（x64）→ 三成员并排 union 是对的 |
| 4 | electron-builder 首次失败原因 | `Could not find any Python installation to use`（`@electron/rebuild` → node-gyp），**不是 better-sqlite3 的问题** |
| 5 | 加 `npmRebuild:false` 后 | `BUILD_EXIT=0`，`ClipchanProbe-portable.exe` 85,651,895 字节 |
| 6 | `nativeImage` 能不能编 WebP | 不能。无 `toWebP()`，也不能解码 WebP（`isEmpty()===true`）→ 缩略图改 PNG |
| 7 | PNG vs JPEG 体积 | photo 3840×2160：png 11742KB / jpeg80 1894KB（6.2 倍）；thumb128：png 13KB / jpeg80 1KB |
| 8 | Win10 透明无边框窗口 | 创建成功；`setSize`/`setResizable`/`setMinimumSize` 运行时生效；`capturePage` 读回 alpha 角落 0 / 中心 184 |
| 9 | `frame`/`transparent` 能否运行时改 | 不能（只能在创建时定）→ "一个窗口换形态"靠尺寸+布局 |
| 10 | Electron 37 是否有 `isTransparent()`/`isSkipTaskbar()` | **没有**，调用会抛 `is not a function` |
| 11 | portable 自启路径 | `portable.nsi:77-79` 注入 `PORTABLE_EXECUTABLE_FILE` → 注册原始 exe 路径有效 |
| 12 | 剪贴板格式 | 文本 `["text/plain"]`；图片 `["image/png"]`；HTML `["text/html"]`（`readText()` 空）；文件 `["text/uri-list"]` + `FileNameW`（`readText()` 空、`readImage()` 空） |
| 13 | 多显示器 API | `screen.getAllDisplays()` / `getCursorScreenPoint()` 可用 |
| 14 | 环境变量坑 | `ELECTRON_RUN_AS_NODE=1` 默认存在，必须清除 |
| 15 | `csc.exe` | `C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe` 可用，编译助手 < 1s，产物 6–8KB |
| 16 | **旧 JSON 的真实字段名** | `history.json` 用短键 `id/text/at/seq/pin/trunc`（`Store.cs:237-249` 写、`:395-417` 读），**不是** C# 属性名 `CreatedUtc/Pinned/Truncated`；`settings.json` 用 `ctrl/alt/shift/win/key/theme/autopaste/label`（`Settings.cs:152-161`）。★ 按属性名解析会让迁移静默导空 |
| 17 | 分类器关键字表 | `ClipClassifier.cs:53-56` 的 25 个关键字与 §7.4 引用**逐字一致**；规则顺序（singleLine → 链接 → 路径 → 数字 → 代码）与 `:16-45` 一致 |
| 18 | ★ `--selftest` 项数 | 旧版实际 **71** 项 `Check()`（`SelfTest.cs`，12 在 `TestSettings` + 59 在 `Run`），不是 64；直接数 `Check(` 调用点 |
| 19 | ★ `SuppressNext` 行号 | `MainForm.cs:811`（`:804` 是 `Commit()` 签名）；去重循环 `Store.cs:102-109`（`Add` 跨 `:90-117`）；`MergeSelected` 到 `:802` 止；源码对照 |
| 20 | ★ 文档路径前缀 | 文档里所有 C# 源码引用都写成 `src/xxx.cs`（搬迁前位置）；`legacy/` 搬迁是动工第 0 步，搬迁后由计划统一替换前缀 |
| 21 | 排序与去重 | `Store.cs:48-54 CompareForDisplay` = 收藏优先 → 时间倒序 → 序号倒序；`Store.cs:97-105` 扫描整段历史去重后调 `TouchExisting`（`:120`），同时刷 `CreatedUtc` 与 `Seq` |
| 22 | 词云函数与行号 | `WordCloudForm.cs`：`ExtractCjkWords` 130、`TrimParticles` 208、`LatinWords` 220、`CjkRuns` 245、`IsCjk` 263、`StopWords` 270 —— 与 §6.9 一致 |
| 23 | INPUTU 与 HasFocusSink | `Program.cs:220-225` 三成员全部 `[FieldOffset(0)]`（注释 `:219` 说明只放一个会让 x64 得到 32 而非 40、SendInput 静默返回 0）；`:182-199` 黑名单式 `HasFocusSink`，明确不要求 hwndFocus |
| 24 | 粘贴重试 | `MainForm.cs:862` 注释「80ms 一档，最多 4 档」，`:911` `if (!dead && _pasteRetries < 4)` —— 与 §7.2 一致 |

**探针里踩过的坑（写下来免得重踩）**：嵌套类型必须写全名（`NativeMethods.INPUT` 而不是 `INPUT`）；局部变量重名会 `CS0136`；Electron 探针用管道捕获 stdout 容易挂住，改用"进程内 `appendFileSync` 写日志 + `Start-Process` 独立跑 + watchdog"才稳定拿到结果。

---

## 16. 这一轮不做但记下来的事

- 富文本保真粘贴（现在只存纯文本降级）。
- 文件列表捕获（★ 实测：Electron 侧读不到 CF_HDROP 的内容）。
- 代码语言识别（§6.4）。
- macOS / Linux 打包。
- iOS。
- 云同步。
- 内置字体（已拍板 3a：不内置，用系统字体栈；中文字体几 MB 且需确认授权）。
- 图片编辑（裁剪/标注）。
- 多窗口 / 多标签。

---

**下一步**：本文件交用户批准。批准后按 `writing-plans` 写实施计划，再动工。**批准前不写任何产品代码。**
