# @clipchan/mobile —— 手机端（Capacitor 壳）

界面代码来自 [`@clipchan/core/ui`](../core/src/ui) —— 与桌面端**同一份** `<App />`。
两端差异全部收敛在平台适配器里（spec §4 分层），`packages/mobile` 只提供壳与适配器。

## 本轮做了什么 / 没做什么

**做了**：可以构建出能在 Capacitor WebView 里跑的 Web 包。

| 文件 | 作用 |
| --- | --- |
| `index.html` | 挂载点（`#root`）+ CSP。图片只允许 `data:` / `blob:` |
| `vite.config.ts` | `base './'`、`@clipchan/core` 别名指向 core 源码、端口 5174、`target 'chrome100'` |
| `src/main.tsx` | 注入适配器 → `applyStoredTheme()` → 挂载 `<App />` |
| `src/platform/mobile-adapter.ts` | `PlatformAdapter` 的手机端实现（内存存储 + 系统剪贴板） |
| `src/index.css` | 最小工具类补齐层（见下） |
| `capacitor.config.ts` | `appId com.clipchan.app`、`appName 剪贴板酱`、`webDir dist` |

**没做（有意为之，不要当成遗漏）**：

1. **没有出 APK。** 没有执行 `npx cap add android`，仓库里也没有 `android/` 目录 ——
   本机未安装 JDK / Android SDK / Gradle，`cap add android` 会直接失败。
   真机打包需要先装这三样，再依次执行：
   ```bash
   pnpm --filter @clipchan/mobile build   # 产出 dist/
   npx cap add android                    # 生成原生工程（需要 JDK 17 + Android SDK + Gradle）
   npx cap sync android                   # 把 dist/ 拷进原生工程
   npx cap open android                   # Android Studio 里 Run
   ```
2. **没有持久化。** 记录放在**模块级内存数组**里（`src/platform/mobile-adapter.ts` 的 `records`），
   进程杀掉即清空。手机端持久化（Capacitor Preferences / SQLite）是后续任务；
   换掉存储实现即可，对外的 `PlatformAdapter` 契约不变，界面代码一行不用改。
3. **没有装 Tailwind。** 见下一节。

## 手机端为什么是「手动粘进来 + 手动复制出去」

**Android 10（API 29）起，后台应用读取剪贴板被系统禁止**：只有持有焦点的应用才能调用
`ClipboardManager.getPrimaryClip()`。iOS 同样有 `UIPasteboard` 的粘贴授权提示。

所以手机端**在系统层面就做不到**桌面端那种「复制即入历史」的后台捕获。
`capabilities.backgroundCapture = false` 是对平台限制的**真实反映，不是偷懒**；
界面读到之后会自动降级（隐藏热键、忽略 autoPaste、不渲染玻璃效果）。

手机端的产品形态是：

1. 用户把内容**手动粘贴进来**（界面上的新增入口 / 系统分享）；
2. 用户在列表里点某条 → 应用写系统剪贴板 → 用户到目标 App **手动粘贴出去**。

四个能力开关在手机端全为 `false`，各自的原因写在
`src/platform/mobile-adapter.ts` 的文件头注释里（`autoPaste` / `globalHotkey` /
`backgroundCapture` / `frostedGlass`）。

## 为什么没有 Tailwind，却还是「同一份界面」

core 的组件全部用 Tailwind 工具类名写样式。桌面端由 `packages/desktop` 的
`tailwindcss + postcss` 编译这些类名；`packages/mobile` 的 `package.json` 里**没有**
tailwindcss，本轮也**不允许新增依赖**。

所以 `src/index.css` 是一份**手写的最小补齐层**：对 core 界面真正用到的 187 个类名
逐个映射成等价 CSS 规则，颜色 / 间距 / 圆角 / 阴影全部指向 `tokens.css` 的 `--cc-*`
变量（映射表与 `packages/core/tailwind.config.ts` 逐条对齐），因此明暗主题照常跟随
`data-theme` 切换。

它是**补齐层，不是新设计**。将来手机端能装 tailwindcss 时，删掉它和 `main.tsx` 里
对应的一行 import 即可。

## 怎么跑

```bash
# 只构建 Web 包（不依赖 JDK / Android SDK）
pnpm --filter @clipchan/mobile build
# → dist/index.html、dist/assets/*.js、dist/assets/*.css

# 本地预览（端口 5174，避开桌面端的 5173）
cd packages/mobile && npx vite
```

## 验证状态

- `pnpm typecheck`（仓库根）EXIT=0
- `pnpm --filter @clipchan/mobile build` 成功，产出 `dist/index.html` 与
  `dist/assets/index-*.js` —— 这是「同一份 core 界面两端复用」的机械证明
- `packages/mobile` 下**没有** `.spec.ts`：`vitest.config.ts` 的 include 是
  `packages/**/*.spec.ts(x)`，所以手机端的运行时校验是临时跑的一次性 spec，
  未留在仓库里；长期测试基线是 core + desktop 的 24 files / 257 tests
