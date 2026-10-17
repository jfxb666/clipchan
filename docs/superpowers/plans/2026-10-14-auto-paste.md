# Enter 自动粘贴（Auto-Paste）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在面板中按 Enter（或双击）后，把选中内容写入剪贴板并自动粘贴回唤出面板前所在的窗口，替代现在"已复制，请自己按 Ctrl+V"的最后一公里。

**Architecture:** 纯决策逻辑抽成 `PastePolicy`（可单测）；Win32 输入原语集中在 `NativeMethods`（Program.cs 内已有此类）；`MainForm` 在 `ShowPanel()` 记录前台窗口、在 `Commit()` 走"隐藏→归位→验证→SendInput"管线，验证不通过就回退为旧行为（只复制+提示），绝不盲发按键。开关持久化在 `settings.json`，托盘菜单可勾选。

**Tech Stack:** C# / .NET Framework 4.x（csc.exe 编译）、WinForms、user32 P/Invoke（GetForegroundWindow / SetForegroundWindow / IsWindow / IsWindowVisible / SendInput）。零外部依赖。

**Spec:** 本文件即规格（源自 2026-10-14 产品复审，无独立 spec 文档）。

## Global Constraints

- 编译只用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1`（csc .NET 4.0，`/langversion` 默认 C# 5：**禁用** `?.`、`nameof`、字符串插值、`using static`）。
- 不引入任何外部程序集/NuGet；仅 `System.dll`、`System.Drawing.dll`、`System.Windows.Forms.dll`。
- 源码 UTF-8 无 BOM；中文注释直接写汉字（现有文件两种风格并存，新文件用汉字）。
- 每个任务收口时 `.\dist\Clipchan.exe --selftest` 必须全绿（当前基线 56 项），且构建无 error CS。
- **本机无 git**：原"Commit"步骤一律替换为"绿检查点"（构建 + selftest 通过即视为该任务收口）。
- 设置文件新字段必须向后兼容：缺字段=默认值，损坏=回落默认（沿用 Settings.Load 现有模式）。

## Review Focus

规格没写进测试断言、但真人最容易踩中的失效模式（每条在对应任务里钉一个测试或手动验收项）：

1. **目标窗口在 Enter 时已关闭/隐藏** → 期望：不粘贴、不报错，内容仍在剪贴板，气球提示回退文案。（Task 2 手动验收 + `PastePolicy` 不在此列——存活检查在发送时刻做）
2. **SetForegroundWindow 归位失败**（焦点被第三方抢走） → 期望：**验证当前前台==目标后才发键**，否则回退提示，绝不把 Ctrl+V 打进错误窗口。（Task 2 管线核心 + 手动验收）
3. **面板由托盘双击/菜单唤出**（前台是 shell/托盘） → 期望：不把粘贴打进资源管理器；`_preWindow` 记录时机与"自我窗口不覆盖"规则兜住。（Task 1 纯逻辑 + Task 2 手动验收）
4. **幽灵模式下按 Enter** → 期望：粘贴照常执行（幽灵只挡"记录"，不挡用户主动"取用"）。（Task 1 决策函数不含幽灵判断——这是设计决定，写进注释钉死）
5. **自动粘贴开关关闭后** → 期望：行为与今天完全一致（复制+提示，不碰前台）。（Task 1 测试 + Task 2 手动验收）

---

### Task 1: 纯决策层 — Settings.AutoPaste + PastePolicy

**Files:**
- Create: `src/PastePolicy.cs`
- Modify: `src/Settings.cs`（字段区 `ThemeMode` 之后；`Load()` 的解析；`Save()` 的序列化）
- Modify: `src/SelfTest.cs`（在"25. 虚词裁剪"用例之后追加 26–28 号用例；`TestSettings()` 的往返用例补 AutoPaste 断言）

**Interfaces:**
- Consumes: 既有 `Settings.Load()/Save()`、`ReadBool(raw, key, dflt)`
- Produces:
  - `Settings.AutoPaste`（`public bool`，默认 `true`）
  - `internal static class PastePolicy { static bool ShouldAttemptAutoPaste(bool enabled, IntPtr target, IntPtr self) }`（Task 2 消费）

- [ ] **Step 1: 写失败测试**

`src/SelfTest.cs` 追加（放在第 25 号用例之后，`catch` 之前）：

```csharp
// 26. 自动粘贴决策：开关关 / 目标为空 / 目标是本程序自己的窗口 → 都不自动粘贴
Check(!PastePolicy.ShouldAttemptAutoPaste(false, new IntPtr(123), new IntPtr(1)), "auto-paste off never pastes");
Check(!PastePolicy.ShouldAttemptAutoPaste(true, IntPtr.Zero, new IntPtr(1)), "no recorded window never pastes");
Check(!PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(1), new IntPtr(1)), "self window never pastes");
// 27. 自动粘贴决策：开关开 + 他窗 → 尝试（存活与归位验证发生在发送时刻，不在这里）
Check(PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(456), new IntPtr(1)), "foreign window with switch on attempts paste");
// 28. 幽灵模式不影响粘贴：决策函数签名里没有幽灵参数即设计决定——只挡记录，不挡取用
Check(PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(789), new IntPtr(1)), "ghost mode does not block paste path");
```

`TestSettings()` 内、往返保存用例之后追加：

```csharp
// AutoPaste 默认开、可关、可往返
Check(new Settings().AutoPaste, "auto-paste defaults to on");
var ap = Settings.Load(); ap.AutoPaste = false; ap.Save();
Check(!Settings.Load().AutoPaste, "auto-paste off round-trips");
ap = Settings.Load(); ap.AutoPaste = true; ap.Save();
Check(Settings.Load().AutoPaste, "auto-paste on round-trips");
```

- [ ] **Step 2: 运行确认失败**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1`
Expected: `error CS0103/CS0246`（PastePolicy / AutoPaste 不存在）——红灯即成立。

- [ ] **Step 3: 实现**

`src/PastePolicy.cs`（新文件）：

```csharp
using System;

namespace Clipchan
{
    /// <summary>
    /// 「Enter 自动粘贴」的纯决策：哪些情况下值得去尝试粘贴。
    /// 只回答"要不要试"；窗口是否还活着、能否归位成功，
    /// 由 MainForm 在发送时刻用 Win32 验证——失败一律回退为"只复制"。
    /// 注意：幽灵模式不在此判断——它只挡"记录"，不挡用户主动"取用"。
    /// </summary>
    internal static class PastePolicy
    {
        public static bool ShouldAttemptAutoPaste(bool enabled, IntPtr target, IntPtr self)
        {
            if (!enabled) return false;
            if (target == IntPtr.Zero) return false;
            if (target == self) return false;
            return true;
        }
    }
}
```

`src/Settings.cs`：
- 字段区 `ThemeMode` 之后加 `public bool AutoPaste = true;`
- `Load()` 中 `s.ThemeMode = ...` 之后加 `s.AutoPaste = ReadBool(raw, "autopaste", s.AutoPaste);`
- `Save()` 中 `"theme"` 行之后加 `sb.Append("  \"autopaste\": ").Append(AutoPaste ? "true" : "false").Append(",\n");`

- [ ] **Step 4: 运行确认通过**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1` 然后 `.\dist\Clipchan.exe --selftest`
Expected: 编译成功；`SELFTEST OK`，PASS 数 = 56 + 5 + 3 = 64（TestSettings 3 条在 OK 行前同屏）。

- [ ] **Step 5: 绿检查点（代替 commit）**

构建产物存在且 selftest 全绿；`%APPDATA%\Clipchan\settings.json` 删除后重建默认含 `"autopaste": true`。

---

### Task 2: Win32 输入原语 + MainForm 粘贴管线 + 托盘开关

**Files:**
- Modify: `src/Program.cs`（`NativeMethods` 类内追加 P/Invoke 与结构体）
- Modify: `src/MainForm.cs`（字段区、`ShowPanel()`、`Commit()`、`BuildMenu()`、`ExitApp()`）
- Modify: `test.ps1` 不改；新增手动验收清单见 Step 6

**Interfaces:**
- Consumes: Task 1 的 `PastePolicy.ShouldAttemptAutoPaste(bool, IntPtr, IntPtr)`、`Settings.AutoPaste`
- Produces（均 `internal`，MainForm 私有使用）：
  - `NativeMethods.GetForegroundWindow() : IntPtr`
  - `NativeMethods.SetForegroundWindow(IntPtr) : bool`
  - `NativeMethods.IsWindow(IntPtr) : bool`、`IsWindowVisible(IntPtr) : bool`
  - `NativeMethods.SendCtrlV() : void`（一次 ctrl+v 的 down/up 四事件）
  - `MainForm._preWindow : IntPtr`、`MainForm._pasteTimer : Timer`

- [ ] **Step 1: 在 NativeMethods 加输入原语**

`src/Program.cs` 的 `NativeMethods` 类内追加。SendInput 的 INPUT 结构是规格钉死的部分（C# 5 无 FieldOfUnion，用 Explicit 布局）：

```csharp
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

[StructLayout(LayoutKind.Sequential)]
private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Explicit, Size = 28)]
private struct INPUTU { [FieldOffset(0)] public KEYBDINPUT ki; }

[StructLayout(LayoutKind.Sequential)]
private struct INPUT { public uint type; public INPUTU u; }   // type=1: INPUT_KEYBOARD

[DllImport("user32.dll", SetLastError = true)]
private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

private const uint KEYEVENTF_KEYUP = 0x0002;
private const int VK_CONTROL = 0x11;
private const int VK_V = 0x56;

/// <summary>向当前前台窗口发送一次 Ctrl+V（不模拟其它按键）。</summary>
public static void SendCtrlV()
{
    var inputs = new INPUT[4];
    inputs[0] = Key(VK_CONTROL, 0);
    inputs[1] = Key(VK_V, 0);
    inputs[2] = Key(VK_V, KEYEVENTF_KEYUP);
    inputs[3] = Key(VK_CONTROL, KEYEVENTF_KEYUP);
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
}

private static INPUT Key(int vk, uint flags)
{
    var i = new INPUT();
    i.type = 1;
    i.u.ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
}
```

（`Program.cs` 顶部若无 `using System.Runtime.InteropServices;` 则补；`Marshal` 已在该命名空间。）

- [ ] **Step 2: MainForm 记录唤出前的前台窗口**

字段区（`_shownUtc` 旁）加：

```csharp
private IntPtr _preWindow;   // 唤出面板前用户所在窗口，Enter 自动粘贴的回填目标
```

`ShowPanel()` 中、`_shownUtc = DateTime.UtcNow;` 之前加：

```csharp
// 记录"用户原来在哪个窗口"。面板已在前台时不覆盖（避免托盘二次唤出把 _preWindow 弄丢）。
IntPtr fg = NativeMethods.GetForegroundWindow();
if (fg != IntPtr.Zero && fg != Handle) _preWindow = fg;
```

- [ ] **Step 3: 重写 Commit() 走粘贴管线**

现 `Commit()`（`SuppressNext → SetText → Touch → 气球 → Hide`）改为：

```csharp
private void Commit()
{
    ClipItem it = Selected();
    if (it == null) { Hide(); return; }

    try
    {
        _msg.SuppressNext();
        Clipboard.SetText(it.Text);
        _store.Touch(it.Id);
    }
    catch (Exception) { Hide(); return; }

    bool attempt = PastePolicy.ShouldAttemptAutoPaste(_settings.AutoPaste, _preWindow, Handle);
    if (attempt)
    {
        Hide();
        StartPasteReturn();   // 归位 + 验证 + 发键；失败回退提示
        return;
    }

    _tray.BalloonTipTitle = "已复制";
    _tray.BalloonTipText = "内容已放入剪贴板，按 Ctrl+V 粘贴。";
    _tray.ShowBalloonTip(1200);
    Hide();
}
```

新增方法（一次性 80ms 定时器，避免与窗口隐藏动画抢前台）：

```csharp
/// <summary>
/// 隐藏面板后把焦点归还原窗口，验证成功才发送 Ctrl+V——
/// 任何一步不满足（窗口关了、归位失败、前台又被抢）都回退为"已复制请粘贴"，
/// 绝不在错误窗口里盲发按键。
/// </summary>
private void StartPasteReturn()
{
    if (_pasteTimer == null)
    {
        _pasteTimer = new Timer();
        _pasteTimer.Tick += PasteReturnTick;
    }
    _pasteTimer.Interval = 80;
    _pasteTimer.Stop();
    _pasteTimer.Start();
}

private void PasteReturnTick(object sender, EventArgs e)
{
    _pasteTimer.Stop();
    IntPtr target = _preWindow;
    bool ok = NativeMethods.IsWindow(target)
           && NativeMethods.IsWindowVisible(target)
           && NativeMethods.SetForegroundWindow(target)
           && NativeMethods.GetForegroundWindow() == target;
    if (ok)
    {
        NativeMethods.SendCtrlV();
    }
    else
    {
        _tray.BalloonTipTitle = "已复制";
        _tray.BalloonTipText = "内容已放入剪贴板，按 Ctrl+V 粘贴。";
        _tray.ShowBalloonTip(1200);
    }
}
```

字段区加 `private Timer _pasteTimer;`；`ExitApp()` 里 `_fade.Stop();` 之后加 `_pasteTimer` 的 Stop/Dispose 判空清理。

- [ ] **Step 4: 托盘菜单加开关**

`BuildMenu()` 中 `pause` 之后加：

```csharp
var paste = new ToolStripMenuItem("Enter 自动粘贴");
paste.CheckOnClick = true;
paste.Click += delegate(object s, EventArgs e)
{
    _settings.AutoPaste = ((ToolStripMenuItem)s).Checked;
    _settings.Save();
};
```

`m.Items.Add(pause);` 之后加 `m.Items.Add(paste);`；`m.Opening` 委托里加 `paste.Checked = _settings.AutoPaste;`。

- [ ] **Step 5: 回归验证**

Run: 构建 + `--selftest`
Expected: 编译成功、`SELFTEST OK`（64 项含新用例）；`--selftest` 连跑 5 次稳定。

- [ ] **Step 6: 手动验收清单（对应 Review Focus 1/2/3/5）**

1. 记事本里选中面板按 Enter → 文本出现在记事本，无多余提示。
2. 记事本被关掉后再按 Enter → 不崩溃，气球显示"已复制，按 Ctrl+V"。
3. 托盘菜单取消勾选"Enter 自动粘贴" → Enter 行为回到旧版（只复制+提示）。
4. 全局热键唤出面板（前台是记事本）→ 粘贴进记事本；托盘双击唤出 → 不粘进 explorer 桌面（观察 `_preWindow` 规则生效）。

---

### Task 3: 文档与终验

**Files:**
- Modify: `README.md`（快捷键表、功能列表、数据与隐私、测试计数）
- Modify: 无代码

**Interfaces:**
- Consumes: Task 1–2 的最终行为
- Produces: 与实现一致的文档

- [ ] **Step 1: README 更新**

- 快捷键表：`Enter（或双击）` 行改为 `复制并自动粘贴回原窗口（可在托盘关闭）`。
- 差异化能力区加一条：` Enter 自动粘贴：选中即回填到唤出面板前的窗口，归位验证失败自动回退为手动粘贴，绝不误贴。`
- 测试章节计数 56 → 64。
- 已知限制第 2 条（"不模拟按键"）改写为：默认模拟一次 Ctrl+V 且带归位验证；可在托盘关闭。

- [ ] **Step 2: 终验**

Run: `build.ps1` → `--selftest`（×5）→ `test.ps1`
Expected: 全绿；exe 约 115–118 KB。

---

## Self-Review 记录

- **Spec 覆盖**：5 条 Review Focus 均有归属（2 条纯逻辑测试 + 4 条手动验收）；幽灵×粘贴为设计决定，写进 PastePolicy 注释与测试 28。
- **步骤扫描**：SendInput 结构体属"规格钉死的平台样板"，给全码；Commit 管线给全码因失败回退顺序是安全关键；其余为签名+锚点。
- **类型一致性**：`ShouldAttemptAutoPaste(bool, IntPtr, IntPtr)` 在 Task 1 定义、Task 2 消费一致；`_preWindow`/`_pasteTimer` 命名两处一致。
- **比例**：约 200 行文档对约 120 行代码，合理。
