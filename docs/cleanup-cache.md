# 缓存残留与清理

免安装版（`Clipchan.exe` 单文件）用久了会在系统里留下两类缓存，加起来可能有好几个 GB。
这篇说明它们是怎么来的、能删哪些、不能删哪些，以及一键清理的办法。

## 一句话结论

| 位置 | 是什么 | 能删吗 | 典型大小 |
| --- | --- | --- | --- |
| `%TEMP%\<25 位随机串>\` | 免安装版每次启动自解压出来的整套程序 | **能删**（退出程序后） | 每个 324–415 MB |
| `%LOCALAPPDATA%\@clipchandesktop-updater\installer.exe` | 自动更新下载好的新版安装包 | **能删** | 约 92 MB |
| `%APPDATA%\Clipchan\` | 你的历史记录、设置、原图、缩略图、OCR 语言包 | **别删**（删了就没了） | 十几 MB 起 |

## 免安装版为什么会留下一堆解压目录

`Clipchan.exe` 不是普通 exe，它是一个 NSIS 自解压包。每次双击，它做的是：

1. 在 `%TEMP%` 下建一个 25 位随机名目录（例如 `3L2W7eo5QMWqnnVDePnblmWf4BX`）；
2. 把整个程序（约 316 MB、143 个文件）解压进去；
3. 启动解压出来的那份，自己退出；
4. 等你关掉程序后，由解压出来的那份把目录删掉。

**第 4 步只有在正常退出时才发生。** 下面这些情况目录会留下来：

- 用任务管理器强杀进程；
- 程序崩溃、蓝屏、断电；
- 系统重启时程序还开着；
- 杀毒软件拦截了删除动作。

一个目录约 360 MB，攒十个就是 3.6 GB。实测一台机器上积了 **18 个目录、6.4 GB**。

> 这也是免安装版启动慢的原因：每次双击都要先把 316 MB 解压一遍。
> 安装版（`Clipchan-Setup-x.y.z.exe`）把这些文件一次放到位，启动是 0.3 秒级，也不产生这些临时目录。**能装就装安装版。**

## 一键清理

仓库里带了一个脚本 `scripts/clean-cache.ps1`，默认只报告、不删：

```powershell
# 预演：只列出会删什么、能释放多少
powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1

# 真删
powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1 -Apply
```

它只认两个判据，不会误删别的东西：

- 临时目录必须同时含 `Clipchan.exe` 和 `resources\app.asar` 才算解压残留（其他程序的临时目录不满足）；
- 更新缓存只删 `installer.exe` 这一个文件。

正在运行的实例所对应的目录会被跳过，并提示「退出剪贴板酱后重跑」。

## 手动清理

不想跑脚本也可以，两条命令：

```powershell
# 1. 解压残留（先关掉剪贴板酱）
Get-ChildItem $env:TEMP -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'Clipchan.exe') } |
  Remove-Item -Recurse -Force

# 2. 自动更新下载的安装包
Remove-Item "$env:LOCALAPPDATA\@clipchandesktop-updater\installer.exe" -Force
```

或者用 Windows 自带的「磁盘清理」→ 勾选「临时文件」，效果一样，只是会连别的程序的临时文件一起删。

## 千万不要删的东西

`%APPDATA%\Clipchan\` 里是：

- `clipchan.db` —— 历史记录与设置（SQLite，WAL 模式）；
- `images\` / `thumbs\` —— 截图原图与缩略图；
- `ocr\` —— tesseract 中英文语言包（删了下次识别会重新下载 4.7 MB）。

这个目录删掉 = 清空全部历史记录。想减小它，用程序里的「设置 → 数据 → 清空历史」或「回收站 → 清空」，别手删文件。

## 装安装版之后

安装版把程序放在 `%LOCALAPPDATA%\Programs\Clipchan\`，启动不再解压，也不会产生上面的临时目录。从免安装版换过去时：

1. 装好安装版并启动一次（它会读同一个 `%APPDATA%\Clipchan\`，历史记录自动带过去）；
2. 关掉程序，跑一次上面的清理命令，把旧的解压目录删掉；
3. 之后可以删掉手上那个 `Clipchan.exe` 单文件。

## 一个已知的不便

程序目前**不会**在启动时自动清理这些历史残留目录 —— 因为它分不清「上次崩溃留下的」和「另一个正在运行的实例的」。清理需要你手动跑一次上面的脚本。如果这个不便对你有影响，欢迎在 Issues 里说一声。
