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

## 能力边界（请按真实情况预期）

- **Win10 上的「毛玻璃」是窗口内模糊，不是系统级 acrylic。** 助手进程调 DWM 把面板背后的桌面真正模糊掉；助手不可用（被杀毒软件拦、编译失败、被改名）时自动降级为半透明 + 内部阴影，设置页会显示「已降级」，不会假装成功。
- **自动粘贴在提权窗口会失效。** UIPI 是系统限制，不是 bug。此时回退为「已复制，按 Ctrl+V 粘贴」的提示，不静默失败。
- **手机端这一轮只搭壳。** `packages/mobile` 能构建出在 Capacitor WebView 里跑的 Web 包，但**没有 APK**（本机没装 JDK / Android SDK / Gradle），也没有持久化（记录在内存里，进程杀掉即清空）。Android 10 起后台读剪贴板被系统禁止，所以手机端的产品形态是「手动粘进来 + 手动复制出去」，`backgroundCapture` 恒为 `false`。
- **只记文本和图片。** 文件列表（在资源管理器里复制文件）与富文本（`text/html` 单独存在时）会被跳过 —— 实测这两类读出来不是用户预期的东西。

## 开发

```bash
pnpm install --allow-build=electron --allow-build=esbuild --allow-build=better-sqlite3
pnpm dev          # 开发模式（Vite + Electron 热重载）
pnpm typecheck    # tsc -b
pnpm test         # vitest run，29 个文件 / 293 个用例
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
| `packages/desktop` | Electron 主进程（`electron/`）、C# 原生助手（`helper/`）、渲染层入口 |
| `packages/mobile` | Capacitor 壳 + 手机端平台适配器（只搭壳，见上） |
| `legacy` | 旧版 C# WinForms 源码留档，仅作参考，不参与构建 |
| `docs/superpowers` | 设计规格（`specs/`）、实施计划（`plans/`）、验收证据（`evidence/`） |

## 验收状态

35 条验收标准逐条判定见 `docs/superpowers/plans/2026-10-15-clipchan-rebuild.md` 的 Task 12 与进度记录区；
自动化证据在 `docs/superpowers/evidence/task12-commands.txt`，截图证据同目录 `task8-*` / `task10-*` / `task12-*`。
