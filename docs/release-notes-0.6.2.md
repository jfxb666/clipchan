## 剪贴板酱 Clipchan 0.6.2

Windows 剪贴板历史工具。Ctrl+` 唤起面板，选中即粘贴回刚才那个窗口。
这一版只做一件事：**启动变快**。同时顺手清掉了免安装版在 `%TEMP%` 里越积越多的残留。

### 下载

- **安装版** `Clipchan-Setup-0.6.2.exe` — **推荐**。装到 `%LOCALAPPDATA%\Programs\Clipchan`，启动 0.3 秒级，可从「设置 → 应用」卸载。
- 免安装版 `Clipchan.exe` — 单文件双击即用，但**每次启动要等 20 秒以上**（原因见下），只建议在不能安装的场合使用。

装过旧版的可以在「设置 → 版本与更新」里点「检查更新」自动升级。

### 免安装版为什么慢，以及这次改了什么

免安装版不是一个普通 exe，而是一个 NSIS 自解压包：每次双击都要先把整个目录解到 `%TEMP%\<随机串>\` 再启动，退出后再删掉。本机实测 26.6 秒 / 41.1 秒，而同样代码的 `win-unpacked` 目录只要 0.27 秒 —— 慢的全部是解压时间，跟程序本身无关。

要让它真正快起来只能装安装版。但既然有大量人直接用免安装版，这一版把解压量压下去了：

- **`node_modules` 里 21MB 从来没被加载过的包不再打包**。打包后的主进程 `dist-electron/main.js` 是 esbuild 打出的单文件，实测它运行时真正 `require` 的只有 `electron`、`better-sqlite3` 和 Node 内置模块 —— 其余全部内联进去了；渲染层则由 vite 打成自包含文件。所以 `react` / `react-dom` / `lucide-react` / `framer-motion` / `highlight.js` / `pinyin-pro` / `zustand` / `adm-zip` 这些已经内联的包整份剔除；`zlibjs`（3.55MB）与 `idb-keyval` 只有 tesseract.js 的 `browser/*` 分支会加载，我们的 OCR worker 走的是 `src/worker-script/node/*`，同样剔除。
- **界面用的图标从 1024×1024 降到 256×256**（1.8MB → 170KB）。这张图只在空状态里以 96×96 显示，1024 的源图是给 Windows 图标缩放用的，界面里那份没必要跟着变大。`build/icon.ico` 的 7 帧仍由 1024 源图生成，不受影响。

两处合计让 `app.asar` 从 50.3MB 降到约 29MB。整体包体仍有 340MB 上下 —— Electron 本体（`Clipchan.exe` 204MB + `dxcompiler.dll` 26MB + `LICENSES.chromium.html` 15MB + `icudtl.dat` 10MB）占 255MB，这部分动不了。**所以想让启动真的变快，还是装安装版。**

### 清理 `%TEMP%` 里的历史残留

免安装版退出时会删自己的临时目录，但如果当时有文件被占用（杀软扫描、资源管理器预览、上次异常退出、强杀进程、断电），删除就会失败，目录留在 `%TEMP%\<25 位随机串>\`。攒久了很占地方 —— 这台机器上攒了 **18 个目录、6.4GB**。

清理用仓库里的 `scripts/clean-cache.ps1`，默认只报告不删：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1          # 预演，只列出会删什么
powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1 -Apply   # 真删
```

不想跑脚本也可以，两条命令：

```powershell
Get-ChildItem $env:TEMP -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'Clipchan.exe') } |
  Remove-Item -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\@clipchandesktop-updater\installer.exe" -Force
```

判据是「临时目录里同时有 `Clipchan.exe` 与 `resources\app.asar`」，不会误删别的程序。**`%APPDATA%\Clipchan\` 不要手删** —— 那是历史记录、设置和 OCR 语言包。完整说明见 [docs/cleanup-cache.md](docs/cleanup-cache.md)。

这一版没有改自解压脚本（NSIS 的清理逻辑由 electron-builder 生成），程序也不会在启动时自动清 —— 它分不清「上次崩溃留下的」和「另一个正在运行的实例的」。所以清理这一步目前需要手动跑一次。

### 数据兼容

老库直接打开，不需要迁移动作。0.6.2 与 0.6.1 的 schema 相同。

### 环境

Windows 10 / 11 x64。数据全部落在 `%APPDATA%\Clipchan\`。

### 已知边界

- **免安装版的启动时间没有本质改善**。340MB 里 255MB 是 Electron 本体，打包白名单只能省下 `node_modules` 那 21MB，解压时间大约少 6%。要秒开请装安装版。
- **富文本只保留原样的 HTML**，不做清洗与重排；粘贴到不支持 HTML 的地方自动退回纯文本。
- **拖出只支持图片与文件**，文本记录暂时不能拖出。
- 提权窗口因 UIPI 无法自动粘贴，会回退为「已复制，按 Ctrl+V 粘贴」。
- API Key 以明文存放在本地 `clipchan.db`，不加密。

详见仓库 README.md。