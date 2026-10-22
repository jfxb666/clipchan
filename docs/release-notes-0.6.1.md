## 剪贴板酱 Clipchan 0.6.1

Windows 剪贴板历史工具。Ctrl+` 唤起面板，选中即粘贴回刚才那个窗口。
这一版全是修复：**Word / Excel / PowerPoint 的格式终于保住了**，**拖出到外部真正能用了**。

### 下载

- **免安装版** `Clipchan.exe` — 双击即用，不要求安装任何运行时。
- **安装版** `Clipchan-Setup-0.6.1.exe` — 装到 `%LOCALAPPDATA%\Programs\Clipchan`，可从「设置 → 应用」卸载。

装过 0.6.0 的可以在「设置 → 版本与更新」里点「检查更新」自动升级。

### 修复：Word / Excel / PowerPoint 复制的内容带格式了

0.6.0 号称支持富文本，但对 Office 三件套一直是失效的 —— 从 Word 复制的加粗标题，粘回去只剩白板文字。这一版修好了。

- **Word**：段落样式、字号、加粗、表格全部原样粘贴回去。
- **Excel**：单元格里的加粗表头不再丢（之前粘回去整片变成常规字重）。
- **PowerPoint**：复制文本框现在记的是**文字**，不再是那张 423×105 的截图。之前 PPT 的复制内容会被误判成图片，文字全丢、搜也搜不到。

原因是 Office 写剪贴板用的不是网页那套 `text/html`，而是 Windows 原生的 `HTML Format`（CF_HTML）。旧的采集代码按名字取 `text/html`，对 Office 永远拿到 0 字节。现在的读法：

- 优先解 CF_HTML **整篇文档**（`StartHTML..EndHTML`），而不是中间的 `StartFragment..EndFragment` 片段 —— 片段的坏处是丢掉外层 `<style>`，Excel 的 `class=xl63` 样式全在那里面，只存片段粘回去加粗就没了。
- 拿不到整篇才退回片段，再退回 `text/html`。
- ★ CF_HTML 头里的偏移量是**字节偏移不是字符偏移**，含中文时必须先切 Buffer 再解码，否则整段错位。
- 顺带排掉了 Office 顺手塞的那份**渲染位图**（`CF_METAFILEPICT` / `CF_ENHMETAFILE`）：不排掉的话，从 Excel 复制两个单元格会被存成一张 145×39 的小截图，单元格内容全丢。判据是「同时有图片格式 + 富文本 + 非空纯文本」，不能按图片字节判 —— 那样会漏掉 PowerPoint。

### 修复：拖出到外部

卡片拖到资源管理器 / 聊天窗口之前一直是「拖了没反应」。两个原因叠在一起：

- **拖拽发起得太晚**。界面走的是 `invoke`（一次异步 IPC 往返），等主进程收到消息时，Chromium 早把这次拖拽收尾了，Windows 的 `DoDragDrop` 拿不到按下的鼠标键。改成单向 `send`，在 `dragstart` 的同步栈里发起。
- **payload 里带了一个 `files: undefined`**。Electron 的绑定是先 `item.Get("files", &files)` 探键，键存在但值是 `undefined` 时转换失败，会连带跳过 `file` 分支 —— 结果是既不拖也不报错。现在只在真有多文件时才带 `files`。

顺带补的：

- **多文件记录可以一次全拖**（Electron 的 `files` 数组会覆盖 `file`），不再回绝「多文件暂时不能拖出」。
- 拖之前先用 `fs.existsSync` 过滤不存在的路径 —— 原图被清理策略删掉、或文件记录指向的文件已被删，这时提示「这条记录没有可拖出的文件」，而不是把坏路径交给系统。
- 只有图片记录和文件记录可拖。文本记录拖不动时会明确说「文本记录暂时不能拖出」，不再静默无反应。

### 数据兼容

老库直接打开，不需要迁移动作。0.6.1 与 0.6.0 的 schema 相同。

### 环境

Windows 10 / 11 x64。数据全部落在 `%APPDATA%\Clipchan\`。

### 已知边界

- **富文本只保留原样的 HTML**，不做清洗与重排；粘贴到不支持 HTML 的地方自动退回纯文本。
- **Excel 走的是 HTML 通道**，如果某个程序只给 RTF 不给 HTML，格式仍然会丢。
- **拖出只支持图片与文件**，文本记录暂时不能拖出。
- 提权窗口因 UIPI 无法自动粘贴，会回退为「已复制，按 Ctrl+V 粘贴」。
- API Key 以明文存放在本地 `clipchan.db`，不加密。

详见仓库 README.md。
