## 剪贴板酱 Clipchan 0.1.0

Windows 剪贴板历史工具。Ctrl+` 唤起面板，选中即粘贴回刚才那个窗口。

### 下载

- **免安装版** `Clipchan.exe` — 双击即用，不要求安装任何运行时（首次启动会解压到临时目录，约 3–5 秒）。
- **安装版** `Clipchan-Setup-0.1.0.exe` — 装到 `%LOCALAPPDATA%\Programs\Clipchan`，可从「设置 → 应用」卸载。

### 环境

Windows 10 / 11 x64。数据全部落在 `%APPDATA%\Clipchan\`。

### 已知边界

- Win10 上「毛玻璃」是窗口内模糊，不是系统级 acrylic。
- 提权窗口（以管理员身份运行的窗口）因 UIPI 无法自动粘贴，会回退为「已复制，按 Ctrl+V 粘贴」。
- 只记录文本与图片。
- 手机端只搭了壳（可构建 Web 包，无 APK、无持久化）。

详见仓库 README.md。
