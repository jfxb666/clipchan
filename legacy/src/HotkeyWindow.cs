using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>
    /// 隐形消息窗：承载剪贴板监听与全局热键。
    /// ShowInTaskbar=false 并移到屏幕外，用户不可见。
    /// </summary>
    internal sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        private const int WM_CLIPBOARDUPDATE = 0x031D;
        private const int WM_HOTKEY = 0x0312;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool AddClipboardFormatListener(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hwnd, int id);

        private const int HOTKEY_ID = 0xA11;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_SHIFT = 0x0004;
        private const uint MOD_WIN = 0x0008;
        private const uint MOD_NOREPEAT = 0x4000;

        private bool _listening;
        private bool _hotkeyOk;
        private bool _disposed;
        private volatile bool _suppress;

        public event EventHandler ClipboardChanged;
        public event EventHandler HotkeyPressed;

        public bool HotkeyRegistered { get { return _hotkeyOk; } }
        public string HotkeyLabel { get; private set; }

        public HotkeyWindow(Form host)
        {
            CreateHandle(new CreateParams
            {
                Caption = "ClipchanMessageWindow",
                X = -4000,
                Y = -4000,
                Width = 1,
                Height = 1,
                Style = unchecked((int)0x80000000), // WS_POPUP
                ExStyle = 0x00000080                // WS_EX_TOOLWINDOW
            });
            HotkeyLabel = "(未注册)";
        }

        public void StartListening()
        {
            if (_listening) return;
            _listening = AddClipboardFormatListener(Handle);
        }

        public void StopListening()
        {
            if (!_listening) return;
            RemoveClipboardFormatListener(Handle);
            _listening = false;
        }

        /// <summary>把 Settings 里的修饰键转成 Win32 位标志。</summary>
        private static uint ModifiersOf(Settings s)
        {
            uint m = 0;
            if (s.Ctrl) m |= MOD_CONTROL;
            if (s.Alt) m |= MOD_ALT;
            if (s.Shift) m |= MOD_SHIFT;
            if (s.Win) m |= MOD_WIN;
            return m | MOD_NOREPEAT;
        }

        /// <summary>
        /// 按配置注册全局热键。会先注销旧的热键，因此可在运行时重新绑定。
        /// 返回 true 表示注册成功。
        /// </summary>
        public bool ApplyHotkey(Settings s)
        {
            UnregisterHotkey();

            if (s == null || !s.IsValid)
            {
                HotkeyLabel = "(未设置)";
                return false;
            }

            if (RegisterHotKey(Handle, HOTKEY_ID, ModifiersOf(s), (uint)s.Key))
            {
                _hotkeyOk = true;
                HotkeyLabel = s.Label;
                return true;
            }

            _hotkeyOk = false;
            HotkeyLabel = s.Label;
            return false;
        }

        /// <summary>
        /// 试注册指定组合并立即还原原来的热键，用于设置界面检测冲突，
        /// 不会真的改变当前生效的热键。
        /// </summary>
        public bool IsAvailable(Settings candidate, Settings current)
        {
            if (candidate == null || !candidate.IsValid) return false;

            // 与当前生效的组合完全相同 → 视为不可用。
            // 否则下面的"先释放再试注册"会让它和自己不冲突，从而误判为可用。
            if (current != null && SameCombo(candidate, current)) return false;

            // 先释放当前热键，否则会与自己冲突
            bool wasOk = _hotkeyOk;
            UnregisterHotkey();

            bool ok = RegisterHotKey(Handle, HOTKEY_ID + 1, ModifiersOf(candidate), (uint)candidate.Key);
            if (ok) UnregisterHotKey(Handle, HOTKEY_ID + 1);

            // 还原当前热键
            if (wasOk && current != null && current.IsValid)
            {
                if (RegisterHotKey(Handle, HOTKEY_ID, ModifiersOf(current), (uint)current.Key))
                    _hotkeyOk = true;
                else
                    _hotkeyOk = false;
            }
            return ok;
        }

        /// <summary>判断两个组合是否完全一致。</summary>
        private static bool SameCombo(Settings a, Settings b)
        {
            return a.Ctrl == b.Ctrl && a.Alt == b.Alt &&
                   a.Shift == b.Shift && a.Win == b.Win && a.Key == b.Key;
        }

        public void UnregisterHotkey()
        {
            if (_hotkeyOk)
            {
                UnregisterHotKey(Handle, HOTKEY_ID);
                _hotkeyOk = false;
            }
        }

        /// <summary>标记下一次剪贴板变化由本程序引起，应忽略。</summary>
        public void SuppressNext()
        {
            _suppress = true;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_CLIPBOARDUPDATE)
            {
                if (_suppress)
                {
                    _suppress = false;
                }
                else
                {
                    EventHandler h = ClipboardChanged;
                    if (h != null) h(this, EventArgs.Empty);
                }
            }
            else if (m.Msg == WM_HOTKEY)
            {
                if (m.WParam.ToInt32() == HOTKEY_ID)
                {
                    EventHandler h = HotkeyPressed;
                    if (h != null) h(this, EventArgs.Empty);
                }
            }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            StopListening();
            UnregisterHotkey();
            if (Handle != IntPtr.Zero) DestroyHandle();
            GC.SuppressFinalize(this);
        }
    }

    /// <summary>剪贴板读取助手：带退避重试，避免被其他进程占用时抛异常。</summary>
    internal static class ClipboardReader
    {
        /// <summary>读取剪贴板文本；非文本或持续失败返回 null。</summary>
        public static string TryGetText()
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    if (!Clipboard.ContainsText()) return null;
                    return Clipboard.GetText();
                }
                catch (Exception)
                {
                    Thread.Sleep(attempt == 0 ? 20 : (attempt == 1 ? 60 : 120));
                }
            }
            return null;
        }
    }
}
