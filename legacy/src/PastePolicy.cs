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

        /// <summary>
        /// 发送前的目标就绪门（纯决策，参数由 MainForm 在发送时刻用 Win32 采集）：
        /// 窗口存活、可见、未最小化，且归位到前台，是发键的最低条件。
        ///
        ///  - 最小化必须排除：SetForegroundWindow 会"顺手还原"它，键落在正在还原的
        ///    窗口上（游戏/全屏视频/shell 面可能误吞），这不是用户要的"粘回原处"；
        ///  - 归位必须验：SetForegroundWindow 返回 true 也可能是"闪了任务栏但没真给"，
        ///    所以还要 GetForegroundWindow() == target 确认。
        ///
        /// 注意这里**不包含**"有没有键盘焦点落点"：后台窗口刚被置前的一瞬间，
        /// 其线程的 hwndFocus 常常还是空的，拿它当硬条件会把正常粘贴全部误判成失败。
        /// 落点缺失只用于*拒绝*明确无输入面的窗口，作为兜底门单独判定（见 HasPasteTarget）。
        /// </summary>
        public static bool TargetIsPasteReady(bool alive, bool visible, bool iconic, bool restored)
        {
            return alive && visible && !iconic && restored;
        }

        /// <summary>
        /// 兜底门：目标是不是"明确的、不会接收粘贴"的空壳窗口（桌面/shell 面）。
        /// 这类窗口归位会成功、发键却没有任何控件接收，必须回退而不是假装成功。
        /// 判据是"归位后仍无任何焦点落点"，而不是"归位瞬间没有落点"。
        /// </summary>
        public static bool HasPasteTarget(bool hasFocusSink)
        {
            return hasFocusSink;
        }
    }
}
