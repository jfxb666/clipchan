# 剪贴板酱 · Clipchan

Windows 剪贴板历史工具。Ctrl+` 唤起面板，选中即粘贴回刚才那个窗口。
Electron + React + SQLite，界面代码与手机端壳共用一份。

- **下载**：[Releases · v0.1.0](https://github.com/jfxb666/clipchan/releases/tag/v0.1.0)
  - 免安装版 `Clipchan.exe`（单文件，双击即用，不要求装任何运行时）
  - 安装版 `Clipchan-Setup-0.1.0.exe`
- **源码**：本仓库（私有）。构建产物不进版本库，由 `pnpm build` 生成到 `release\`。

## 安装与首次运行

1. 从 Releases 下载并双击 `Clipchan.exe`（免安装版会先解压到临时目录再启动，首次启动约 3–5 秒）。
2. 托盘出现图标，按 **Ctrl+`** 唤出面板。
3. 面板出现在**鼠标所在显示器的中间偏上**，宽度 900、高度 620。

卸载安装版：从「设置 → 应用」卸载，或运行安装目录里的 `Uninstall Clipchan.exe`。

## 数据目录

一切落在 `%APPDATA%\Clipchan\`：

| 文件 | 内容 |
| --- | --- |
| `clipchan.db` | SQLite 库（历史记录 + 设置）。WAL 模式，强杀进程也不会整份丢历史 |
| `images\` | 原图（JPEG q80 或 PNG，长边 ≤ 2560） |
| `thumbs\` | 缩略图（PNG，长边 128） |
| `history.json.migrated` | 旧版数据导入后的留档（改名即表示已迁移） |
| `settings.json` | 旧版设置文件。**新版只读不改**，设置存在 `clipchan.db` 里 |

从旧版升级：首次启动若发现 `history.json` 且库是空的，会自动导入全部记录并把文件改名为 `history.json.migrated`。旧文件的短键（`id/text/at/seq/pin/trunc`）与 C# 属性名两种写法都能认，认不出的单条跳过、不阻塞启动。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl+`` | 唤起/隐藏主面板 |
| `Alt+C` | 唤起/隐藏小组件 |
| `↑` / `↓` | 在列表里上下选择 |
| `Enter` | 粘贴选中项（开了自动粘贴就直接贴进原窗口） |
| `Ctrl+D` | 收藏 / 取消收藏 |
| `Ctrl+M` | 把当前选中的多条拼接成一条 |
| `Delete` | 删除选中项 |
| `Ctrl+Delete` | 清空所有未收藏项 |
| `Ctrl+F` | 聚焦搜索框 |
| `Esc` | 隐藏面板 |

搜索框里按 `↓` 跳到列表、按 `↑` 回到搜索框；在搜索框里打字不会被快捷键拦。

## AI 提示词优化

选中一条记录，悬停卡片右侧点亮星星「优化提示词」→ 选场景与模式 → 点「优化」→ 左右分栏对比原文与结果 → 「复制」或「直接粘贴」贴回原窗口。优化由你自己配置的模型完成；场景与方法论是编译进程序的固定数据，运行时不联网取规则。

完整路径：**设置 → AI 模型 → 添加模型**（填名称 / 协议 / Base URL / API Key / 模型名 → 保存）→「发送测试消息」验证连通 → 回到列表悬停卡片点「优化」→ 选场景与模式 → 优化 → 看结果与补充说明 → 复制或直接粘贴。

### 三种协议的 Base URL 怎么填

| 协议 | Base URL 填什么 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1`，或只填到域名 `https://api.openai.com` | 程序会去掉末尾多余斜杠；路径里没有 `/v1` 这类版本段时自动补 `/v1`。中转站填它给你的地址 |
| Anthropic | `https://api.anthropic.com` | 程序按协议补 `/v1` |
| Gemini | `https://generativelanguage.googleapis.com` | 程序按协议补 `/v1beta` |

填的地址不是完整链接（例如漏了 `https://`）会被当场拦下并提示，不会拿一个半成品去发请求。

「发送测试消息」通过会显示模型可用，不通给中文原因：鉴权失败 / 网络连接失败 / 请求超时 / 请求过于频繁 / 模型返回格式异常。
「拉取列表」在部分中转站、以及 Gemini 原生路径下可能失败 —— 这不是 bug，**直接手输模型名即可**，不影响使用。
Key 只在主进程读取，界面上只回显掩码（`sk-…abcd`）；编辑已有模型时 Key 留空表示不修改。

### 四类场景各适合什么

| 场景 | 适合 |
| --- | --- |
| 通用对话 | 对 AI 提需求、问问题，把随手写的诉求补成一条能直接用的提示词 |
| AI 生成 | 文生图 / 文生视频 / 音乐等创作，把一句想法补成可复现的生成提示词 |
| 产品·项目描述 | 写产品介绍、项目说明、需求文档，把形容词换成能验证的事实 |
| 日常交流 | 跟朋友聊、发消息、回邮件，改写成你自己会发出去的那句话 |

### 两种模式的区别

| 模式 | 产出什么 | 什么时候用 |
| --- | --- | --- |
| 用户提示词 | 一条能直接发给 AI 的提示词：保留原意，补上角色与目标、上下文、输出格式与长度、约束条件 | 你要问 AI 一件事、要一段内容或一次生成 |
| 系统提示词 | 一份角色 / 约束型 system prompt：按角色身份、能力边界、输出规范、拒答策略四块组织，写成对 AI 的第二人称指令 | 你要给某个 AI 应用或助手定人设与规矩 |

两种模式用的是两套不同模板，不是把同一段文字换个标题。

### 能力边界（如实写）

- **优化质量取决于你选的模型。** 同一个场景换模型，结果差别可能很大；程序只负责把方法论和原文拼成一次请求，不联网取规则。
- **API Key 以明文存放在本地 `clipchan.db` 里，本轮不做加密。** Key 只在本机被读取、只发给你填的那个接口地址，不上传到别处；但共享电脑上任何人拿到该文件就等于拿到 Key，需自行注意。
- **本轮不做流式输出。** 优化期间按钮进 loading 并禁用，默认 60 秒超时，超时给中文提示、按钮恢复可点；也不做多轮自动迭代优化（生成-批判-自进化那一套留作后续）。
- **手机端不接 AI。** `packages/mobile` 这一轮只搭壳，AI 相关能力只在桌面端可用。
- **模型输出不干净时**（带「好的，这是优化后的提示词：」前缀、被包在 markdown 代码块里），程序会剥掉外壳；实在解析不出结构就把全文直接采用，并在界面上给一条「模型未按格式输出，已直接采用全文」的提示，原文照实展示、可重试。

## 能力边界（请按真实情况预期）

- **Win10 上的「毛玻璃」是窗口内模糊，不是系统级 acrylic。** 助手进程调 DWM 把面板背后的桌面真正模糊掉；助手不可用（被杀毒软件拦、编译失败、被改名）时自动降级为半透明 + 内部阴影，设置页会显示「已降级」，不会假装成功。
- **自动粘贴在提权窗口会失效。** UIPI 是系统限制，不是 bug。此时回退为「已复制，按 Ctrl+V 粘贴」的提示，不静默失败。
- **手机端这一轮只搭壳。** `packages/mobile` 能构建出在 Capacitor WebView 里跑的 Web 包，但**没有 APK**（本机没装 JDK / Android SDK / Gradle），也没有持久化（记录在内存里，进程杀掉即清空）。Android 10 起后台读剪贴板被系统禁止，所以手机端的产品形态是「手动粘进来 + 手动复制出去」，`backgroundCapture` 恒为 `false`。
- **只记文本和图片。** 文件列表（在资源管理器里复制文件）与富文本（`text/html` 单独存在时）会被跳过 —— 实测这两类读出来不是用户预期的东西。
- **AI 优化用你自备的 Key，Key 以明文存放在本地 `clipchan.db`，本轮不做加密。** 只在桌面端可用，手机端不接 AI；详见上文「AI 提示词优化」。

## 开发

```bash
pnpm install      # pnpm 11 的构建脚本许可写在 pnpm-workspace.yaml 的 allowBuilds 里；老版本 pnpm 才需要 --allow-build=electron --allow-build=esbuild --allow-build=better-sqlite3
pnpm dev          # 开发模式（Vite + Electron 热重载）
pnpm typecheck    # tsc -b
pnpm test         # vitest run，39 个文件 / 360 个用例（缺真实助手 exe 时另有 4 条跳过）
pnpm build:helper # 编译 C# 原生助手 → packages/desktop/helper/dist/clipchan-helper.exe
pnpm smoke:main   # 主进程冒烟（13 项断言）
pnpm build        # 打包 → release/Clipchan.exe 与 release/Clipchan-Setup-<版本>.exe
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-all.ps1    # 上面五条串行跑一遍，输出归档到 docs/superpowers/evidence/task12-commands.txt

跑 `smoke:main` 前先退出已在运行的 Clipchan（单实例锁会让 smoke 的第二个实例直接退出，表现为「没拿到 SMOKE 行」）。
```

手工排查用的两个小工具：`scripts/measure-hotkey.ps1`（量冷启动与热键唤起毫秒）与 `scripts/cdp.mjs`（连 `--remote-debugging-port=9222` 的窗口，支持 `read <表达式文件>` / `shot <png>` / `click x,y` / `dblclick x,y` / `key` / `type`）。

目录结构：

| 路径 | 内容 |
| --- | --- |
| `packages/core` | 平台无关：类型、分类/去重/拼接/词云算法、状态管理、React 界面（`ui`） |
| `packages/ai` | 平台无关的提示词优化层：三协议适配器、场景与方法论数据、元提示词、优化引擎（只用 Web 标准 API） |
| `packages/desktop` | Electron 主进程（`electron/`）、C# 原生助手（`helper/`）、渲染层入口 |
| `packages/mobile` | Capacitor 壳 + 手机端平台适配器（只搭壳，见上） |
| `legacy` | 旧版 C# WinForms 源码留档，仅作参考，不参与构建 |
| `docs/superpowers` | 设计规格（`specs/`）、实施计划（`plans/`）、验收证据（`evidence/`） |

## 验收状态

35 条验收标准逐条判定见 `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md` 的 Task 12 与进度记录区；
自动化证据在 `docs/superpowers/evidence/task12-commands.txt`，截图证据同目录 `task8-*` / `task10-*` / `task12-*`。
