# SDD ledger — plan: docs/superpowers/plans/2026-10-14-auto-paste.md

Spec: 计划自含规格（"Spec: 本文件即规格"）——无独立 spec 文档，裁定按技能要求记录于此。

Setup rulings:
- Ruling: 本机无 git/bash/仓库 → 不建 worktree，就地执行；task-start/task-done/review-package 脚本以手工等效替代（ledger 手动维护、"commit"=绿检查点）— 计划 Global Constraints 已预先裁定 — 代价若错：无版本历史兜底，改坏需手工回退。
- Ruling: Task 2 计划代码 SendInput INPUTU(Explicit Size=28) 尺寸错误 — x64 下真实 INPUT=40（union 按 MOUSEINPUT 定大小），计划写法 Marshal.SizeOf=32 会让 SendInput 静默失败 — 改用完整三成员 union（ki/mi/hi），Marshal.SizeOf 自动匹配 OS — 代价若错：自动粘贴完全失效（按键发不出去），但归位验证管线不会误贴。

Pre-flight interface scan:
- Task 1 Produces `PastePolicy.ShouldAttemptAutoPaste(bool, IntPtr, IntPtr)` ↔ Task 2 Consumes：一致。
- Task 1 Produces `Settings.AutoPaste(bool,默认true)` ↔ Task 2 Consumes：一致。
- Task 2 Produces 托盘开关 ↔ Task 3 文档：一致。
- 计数核对：56+5(Run)+3(TestSettings)=64，与计划一致。

Task 1: complete (no-git 绿检查点; tests: build.ps1 + --selftest → 64/64 PASS, SELFTEST OK; RED 先观察到 CS1061/CS0103)

Task 2: Ruling: 计划 Step 1 代码缺 `using System.Runtime.InteropServices;`（Program.cs 原文件用全限定名，新代码用了短名）— 补 using 而非全限定，与新增结构体密度一致 — 代价若错：编译失败（已观察到 CS0246，修复后绿）。
Task 2: Ruling: 验收④（托盘唤出不粘进 explorer）未做自动化——环境前台锁使托盘双击不可脚本化；由 PastePolicy self-window 检查 + _preWindow 不覆盖规则 + 验收①②③ 间接覆盖 — 代价若错：极端时序下粘到错误窗口（回退路径仍保证内容在剪贴板）。
Task 2: complete (no-git 绿检查点; tests: build.ps1 + --selftest 5/5 稳定 → 64/64 PASS; 手动验收 ①Enter→记事本出现 AUTO-PASTE-OK-123 PASS ②目标窗口关闭→不崩溃+回退 PASS ③开关关→不粘贴 PASS)

Task 3: complete (no-git 绿检查点; tests: build.ps1 → 116,736B; --selftest 5/5 → 64/64; test.ps1 → E2E ALL PASS 12/12; README 四处更新完成)



