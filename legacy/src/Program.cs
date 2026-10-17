using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Clipchan
{
    internal static class Program
    {
        private const string MutexName = "Global\\Clipchan.SingleInstance.v1";

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--selftest")
                return SelfTest.Run();

            // --wordcloud：直接打开「今日词云」，便于做快捷方式 / 计划任务，无需先点托盘
            bool openCloud = args.Length > 0 && args[0] == "--wordcloud";

            // --ghost[=分钟]：以幽灵模式启动（演示、录屏、借电脑给他人时的保险开关）
            int ghostMinutes = ParseGhostMinutes(args);

            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // 已有实例：广播自定义消息唤醒它，而不是开第二个窗口
                    NativeMethods.PostMessage(
                        (IntPtr)0xFFFF, NativeMethods.WM_CLIPCHAN_SHOW, IntPtr.Zero, IntPtr.Zero);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var store = new Store(Store.DefaultDir);

                if (openCloud)
                {
                    // 独立词云也要跟随用户保存的主题（auto/light/dark），
                    // 否则暗色用户单独打开词云会看到突兀的浅色面板。
                    Theme.SetMode(Settings.Load().ThemeMode);

                    // 只弹词云，不常驻托盘（用完即走）。
                    // 独立启动时不随失焦关闭，否则刚显示就会被别的窗口顶掉而退出。
                    using (var cloud = new WordCloudForm(store))
                    {
                        cloud.CloseOnDeactivate = false;
                        Application.Run(cloud);
                    }
                    return 0;
                }

                var form = new MainForm(store);
                form.StartUp();
                if (ghostMinutes > 0) form.EnterGhostMode(ghostMinutes);

                Application.Run(form);
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        /// <summary>解析 --ghost[=N]（分钟），默认 10 分钟，上限 720 分钟。</summary>
        private static int ParseGhostMinutes(string[] args)
        {
            foreach (string a in args)
            {
                if (a == "--ghost") return 10;
                if (a.StartsWith("--ghost=", StringComparison.OrdinalIgnoreCase))
                {
                    int m;
                    if (int.TryParse(a.Substring(8), out m) && m > 0) return Math.Min(m, 720);
                    return 10;
                }
            }
            return 0;
        }
    }

    internal static class NativeMethods
    {
        public const int WM_CLIPCHAN_SHOW = 0x8002;

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern IntPtr SendMessageW(IntPtr hWnd, int Msg, IntPtr wParam, string lParam);

        private const int EM_SETCUEBANNER = 0x1501;

        /// <summary>
        /// 用系统原生 cue banner 给文本框设占位符：由系统绘制，聚焦时才隐藏，
        /// 免去自绘 Label 叠层——暗色主题下不会有接缝色块，也更省一个控件。
        /// </summary>
        public static void SetCueBanner(IntPtr hWnd, string text)
        {
            if (hWnd == IntPtr.Zero) return;
            // wParam=TRUE：即使获得焦点也保留提示（本程序聚焦即清空搜索，行为一致）
            SendMessageW(hWnd, EM_SETCUEBANNER, (IntPtr)1, text);
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
        [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        private const int GWL_STYLE = -16;
        private const int WS_VSCROLL = 0x00200000;

        /// <summary>
        /// 移除控件自带的竖向滚动条样式。
        /// ListBox 只要有内容超出就会常驻约 17px 的滚动条区域，
        /// 且 ScrollAlwaysVisible=false 无法去掉，只能改窗口样式位。
        /// </summary>
        public static void RemoveVerticalScrollBar(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            int style = GetWindowLong32(hWnd, GWL_STYLE);
            if ((style & WS_VSCROLL) != 0)
                SetWindowLong32(hWnd, GWL_STYLE, style & ~WS_VSCROLL);
        }

        // ---- 自动粘贴所需的输入原语 ----

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO pGuiInfo);

        /// <summary>GetGUIThreadInfo 的输入结构（cbSize 必填）。</summary>
        public struct GUITHREADINFO
        {
            public uint cbSize;
            public uint flags;
            public IntPtr hwndActive;
            public IntPtr hwndFocus;
            public IntPtr hwndCapture;
            public IntPtr hwndMenuOwner;
            public IntPtr hwndMoveSize;
            public IntPtr hwndCaret;
            public System.Drawing.Rectangle rcCaret;
        }

        /// <summary>
        /// 目标窗口是否有可接收输入的落点。
        ///
        /// 只有"明确不会接收粘贴的空壳面"才判 false，其余一律放行：
        ///  - GetGUIThreadInfo 的 hwndFocus 并非所有窗口都暴露（Modern Notepad、
        ///    UWP/WinUI 应用的焦点走独立输入通道，常返回 0），拿它当必要条件
        ///    会把正常窗口全部误判成"无落点"，自动粘贴直接失效；
        ///  - 因此改为黑名单式排除：桌面壳层（Progman/WorkerW/Shell_TrayWnd/
        ///    Windows.UI.Core.*）才回退，其它可见窗口都认为能收键。
        /// </summary>
        public static bool HasFocusSink(IntPtr hWnd)
        {
            uint pid;
            uint tid = GetWindowThreadProcessId(hWnd, out pid);
            if (tid != 0)
            {
                var info = new GUITHREADINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
                // 能拿到落点就直接放行（最可靠的肯定证据）
                if (GetGUIThreadInfo(tid, ref info) && info.hwndFocus != IntPtr.Zero) return true;
            }

            // 拿不到落点时按窗口类判断：只有桌面壳层是真的"没有输入面"
            var cls = new System.Text.StringBuilder(64);
            GetClassName(hWnd, cls, cls.Capacity);
            string c = cls.ToString();
            if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" ||
                c == "Shell_SecondaryTrayWnd" || c.StartsWith("Windows.UI.Core"))
                return false;

            return IsWindowVisible(hWnd);
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        // union 必须按最大成员（MOUSEINPUT）定尺寸：x64=32、x86=24。
        // 只放 KEYBDINPUT 会让 Marshal.SizeOf(INPUT) 在 x64 得到 32 而非 OS 期望的 40，
        // SendInput 会静默返回 0——粘贴永远不发生。三成员并排，让布局器自己算对。
        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTU
        {
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public INPUTU u; }   // type=1: INPUT_KEYBOARD

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const int VK_CONTROL = 0x11;
        private const int VK_V = 0x56;

        // cbSize 只算一次：四个事件必须用同一个尺寸，避免每次粘贴重算的漂移
        private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));

        /// <summary>
        /// 向当前前台窗口发送一次 Ctrl+V（只发这一组键，不做其它模拟）。
        /// 返回 true 表示四个事件全部被系统接收；不足则尽力补发 key-up
        /// （防止 hook/BlockInput 截断后目标以为 Ctrl 一直被按着），由调用方回退提示。
        /// </summary>
        public static bool SendCtrlV()
        {
            var inputs = new INPUT[4];
            inputs[0] = Key(VK_CONTROL, 0);
            inputs[1] = Key(VK_V, 0);
            inputs[2] = Key(VK_V, KEYEVENTF_KEYUP);
            inputs[3] = Key(VK_CONTROL, KEYEVENTF_KEYUP);
            uint sent = SendInput((uint)inputs.Length, inputs, InputSize);
            if (sent == (uint)inputs.Length) return true;

            // 部分投递：单独抬起两个修饰键，别让 Ctrl 卡在按下态
            var lift = new INPUT[2];
            lift[0] = Key(VK_V, KEYEVENTF_KEYUP);
            lift[1] = Key(VK_CONTROL, KEYEVENTF_KEYUP);
            SendInput((uint)lift.Length, lift, InputSize);
            return false;
        }

        private static INPUT Key(int vk, uint flags)
        {
            var i = new INPUT();
            i.type = 1;
            i.u.ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
            return i;
        }
    }
}
