// ClipchanHelper.cs —— Clipchan 原生助手（常驻 stdin/stdout 行协议）
//
// 设计依据：docs/superpowers/specs/2026-10-15-clipchan-rebuild-design.md
//   §7.2（助手协议与三层验证）、§8.2（生命周期）。
// 判定逻辑抄自 legacy/src/Program.cs（NativeMethods 段）与
//   legacy/src/MainForm.cs（PasteReturnTick）。
//
// 编译（本机无 .NET SDK，只有 .NET Framework 4.x 的 csc）：
//   csc.exe /nologo /target:exe /platform:x64 /optimize+ /utf8output \
//           /out:dist/clipchan-helper.exe ClipchanHelper.cs
//
// 用法：
//   clipchan-helper.exe --layout   打印五个关键结构体尺寸后退出（构建脚本自检）
//   clipchan-helper.exe --serve    常驻，按行协议服务
//
// ★ 结构体布局陷阱（实测踩出来的）：
//   INPUTU 是 [StructLayout(LayoutKind.Explicit)]，KEYBDINPUT / MOUSEINPUT /
//   HARDWAREINPUT 三个成员必须全部 [FieldOffset(0)] 并排。只放 KEYBDINPUT 会让
//   Marshal.SizeOf(INPUT) 在 x64 得到 32 而不是 OS 期望的 40，SendInput 会
//   静默返回 0，粘贴永远不发生。InputSize 只算一次并复用。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Clipchan
{
    internal static class NativeMethods
    {
        // ---- 窗口状态 ----

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        // ---- 输入落点查询 ----

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        // x64 实测 72 字节：cbSize(4)+flags(4)+6×IntPtr(48)+rcCaret(16)。
        [StructLayout(LayoutKind.Sequential)]
        internal struct GUITHREADINFO
        {
            public uint cbSize;
            public uint flags;
            public IntPtr hwndActive;
            public IntPtr hwndFocus;
            public IntPtr hwndCapture;
            public IntPtr hwndMenuOwner;
            public IntPtr hwndMoveSize;
            public IntPtr hwndCaret;
            public RECT rcCaret;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

        // ---- SendInput ----

        [StructLayout(LayoutKind.Sequential)]
        internal struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        // ★ 三个成员全部 FieldOffset(0) 并排；这决定了 INPUT 在 x64 是 40 而不是 32。
        [StructLayout(LayoutKind.Explicit)]
        internal struct INPUTU
        {
            [FieldOffset(0)]
            public KEYBDINPUT ki;

            [FieldOffset(0)]
            public MOUSEINPUT mi;

            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct INPUT
        {
            public uint type;
            public INPUTU u;
        }

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        // ---- 毛玻璃 ----

        [StructLayout(LayoutKind.Sequential)]
        internal struct AccentPolicy
        {
            public int AccentState;
            public int AccentFlags;
            public int GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct WindowCompositionAttributeData
        {
            public int Attribute;
            public IntPtr Data;
            public int SizeOfData;
        }

        [DllImport("user32.dll")]
        internal static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

        // ---- 提权检测 ----

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr hObject);

        // ★ lpExeName 是 TCHAR 缓冲，必须显式 CharSet.Unicode：默认 ANSI 会让 marshaller
        //   按单字节写，拿回来的是半截乱码路径（实测踩过）。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

        // ---- 剪贴板（只读，取 CF_HDROP）----
        //
        // ★ 为什么文件列表必须走原生：Electron 37 的 clipboard 读 CF_HDROP 不可靠。
        //   实测（同一份剪贴板数据，同一时刻）：C# 用 GetClipboardData(15) +
        //   DragQueryFileW 能拿到全部路径；Electron 的 has('FileNameW') 是 true，但
        //   readBuffer()/read() 全空、availableFormats() 还谎报 text/uri-list。
        //   也就是说"有没有文件"问 Electron 是可靠的，"有哪些文件"只能问这里。

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint DragQueryFileW(IntPtr hDrop, uint iFile, StringBuilder lpszFile, uint cch);

        // ---- 剪贴板（写 CF_HDROP）----
        //
        // ★ 写也必须走原生：Electron 的 clipboard.writeBuffer('FileNameW', buf) 注册出来的是
        //   一个**自定义格式**（EnumClipboardFormats 实测 id=49159、名字 FileNameW），
        //   根本不是标准 CF_HDROP(15)。别的程序（资源管理器、WinForms GetFileDropList）
        //   一律读不到，表现就是"复制了文件记录但粘贴不出文件"。
        //   writeBuffer('CF_HDROP', ...) 同理，注册成 id=49962 的自定义格式。

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalLock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GlobalUnlock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalFree(IntPtr hMem);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);
    }

    internal static class Program
    {
        // ---- 常量 ----

        private const uint VK_CONTROL = 0x11;
        private const uint VK_V = 0x56;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint INPUT_KEYBOARD = 1;

        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenIntegrityLevel = 25;

        private const int WCA_ACCENT_POLICY = 19;
        private const int ACCENT_DISABLED = 0;
        private const int ACCENT_ENABLE_BLURBEHIND = 3;
        private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;

        /// <summary>进程映像路径的缓冲字符数：MAX_PATH 之上留足，长路径 exe 不会被截断。</summary>
        private const int IMAGE_NAME_CHARS = 1024;

        // ---- FILES（读写剪贴板文件列表）----
        private const uint CF_HDROP = 15;
        private const int CLIPBOARD_OPEN_TRIES = 6;   // 剪贴板是独占资源，被占用时重试
        private const int CLIPBOARD_OPEN_RETRY_MS = 15;
        private const uint MAX_DROP_FILES = 500;      // 与 TS 侧 MAX_FILES 对齐
        private const uint MAX_PATH_CHARS = 4096;     // 单条路径上限，超长的跳过不影响同批
        private const uint GMEM_MOVEABLE = 0x0002;    // SetClipboardData 只接受可移动内存
        private const uint GMEM_ZEROINIT = 0x0040;
        private const int DROPFILES_HEADER_BYTES = 20; // pFiles(4)+pt.x(4)+pt.y(4)+fNC(4)+fWide(4)

        private const int RESTORE_TRIES = 4;      // 软失效宽限重试次数
        private const int GRACE_MS = 80;          // 每次重试间隔（4×80ms ≈ 320ms）
        private const uint DEFAULT_MEDIUM_RID = 0x2000;

        // 落点黑名单：桌面壳窗口，看起来可见但没有可接收粘贴的输入焦点。
        private static readonly string[] FocusSinkBlacklist =
        {
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
        };

        /// <summary>INPUT 的字节尺寸，只算一次并复用。</summary>
        private static readonly int InputSize = Marshal.SizeOf(typeof(NativeMethods.INPUT));

        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--layout")
            {
                return PrintLayout();
            }
            if (args.Length > 0 && args[0] == "--serve")
            {
                return Serve();
            }
            Console.Error.WriteLine("用法: clipchan-helper.exe --layout | --serve");
            return 0;
        }

        /// <summary>--layout：打印五个关键结构体尺寸，供构建脚本自检。</summary>
        private static int PrintLayout()
        {
            Console.WriteLine("SIZE_KEYBDINPUT=" + Marshal.SizeOf(typeof(NativeMethods.KEYBDINPUT)));
            Console.WriteLine("SIZE_MOUSEINPUT=" + Marshal.SizeOf(typeof(NativeMethods.MOUSEINPUT)));
            Console.WriteLine("SIZE_HARDWAREINPUT=" + Marshal.SizeOf(typeof(NativeMethods.HARDWAREINPUT)));
            Console.WriteLine("SIZE_INPUT=" + InputSize);
            Console.WriteLine("SIZE_GUITHREADINFO=" + Marshal.SizeOf(typeof(NativeMethods.GUITHREADINFO)));
            return 0;
        }

        /// <summary>--serve：常驻行协议服务。</summary>
        private static int Serve()
        {
            // UTF-8 无 BOM：中文说明要能原样过管道。
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = true;
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

            stdout.WriteLine("READY pid=" + Process.GetCurrentProcess().Id);

            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                string trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }

                string[] parts = trimmed.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0)
                {
                    continue;
                }

                switch (parts[0].ToUpperInvariant())
                {
                    case "PASTE":
                        HandlePaste(stdout, parts);
                        break;
                    case "BLUR":
                        HandleBlur(stdout, parts);
                        break;
                    case "FG":
                        stdout.WriteLine("FG " + ToDecimal(NativeMethods.GetForegroundWindow()));
                        break;
                    case "FGEXE":
                        HandleForegroundExe(stdout);
                        break;
                    case "FILES":
                        HandleFiles(stdout);
                        break;
                    case "FILESET":
                        // 入参是单行 JSON 数组，路径里有空格，不能按空白切分，所以取整段。
                        HandleFileSet(stdout, trimmed.Substring(parts[0].Length).Trim());
                        break;
                    case "PING":
                        stdout.WriteLine("PONG " + (parts.Length > 1 ? parts[1] : string.Empty));
                        break;
                    case "QUIT":
                        return 0;
                    default:
                        // 未定义命令：协议里没有对应回包，静默忽略。
                        Trace("unknown command: " + parts[0]);
                        break;
                }
            }
            return 0;
        }

        // ---- FILES ----

        /// <summary>
        /// FILES —— 读剪贴板上的文件列表（CF_HDROP），输出 `FILES &lt;json数组&gt;`。
        ///
        /// ★ 只有这里能可靠地读 CF_HDROP：Electron 的 clipboard 对同一份数据会返回空
        ///   （详见 NativeMethods 里剪贴板那段的说明）。所以"有哪些文件"必须问助手。
        /// ★ 绝不抛异常、绝不阻塞 Serve 循环：剪贴板被别的进程占用（OpenClipboard 失败）
        ///   时重试几次仍失败就回空数组，让调用方按"解不出路径"处理。
        /// ★ 输出是单行 JSON，路径里的反斜杠 / 引号 / 控制字符都已转义，绝不会把一行撑成两行。
        /// </summary>
        private static void HandleFiles(StreamWriter stdout)
        {
            string json = "[]";
            try
            {
                List<string> paths = ReadDropFiles();
                json = ToJsonArray(paths);
            }
            catch (Exception e)
            {
                Trace("files failed: " + e.Message);
            }
            try
            {
                stdout.WriteLine("FILES " + json);
            }
            catch
            {
                // stdout 坏了：这一条只能放弃，但不能让异常冒到 Serve 循环。
            }
        }

        /// <summary>读 CF_HDROP 里的全部路径；没有 / 打不开剪贴板时返回空列表。</summary>
        private static List<string> ReadDropFiles()
        {
            var result = new List<string>();
            // 剪贴板是独占资源：别的进程正在写时 OpenClipboard 会失败，等几毫秒再试。
            bool opened = false;
            for (int i = 0; i < CLIPBOARD_OPEN_TRIES && !opened; i++)
            {
                if (i > 0)
                {
                    Thread.Sleep(CLIPBOARD_OPEN_RETRY_MS);
                }
                opened = NativeMethods.OpenClipboard(IntPtr.Zero);
            }
            if (!opened)
            {
                Trace("files open-clipboard failed");
                return result;
            }
            try
            {
                IntPtr drop = NativeMethods.GetClipboardData(CF_HDROP);
                if (drop == IntPtr.Zero)
                {
                    return result;
                }
                uint count = NativeMethods.DragQueryFileW(drop, 0xFFFFFFFF, null, 0);
                if (count == 0)
                {
                    return result;
                }
                if (count > MAX_DROP_FILES)
                {
                    count = MAX_DROP_FILES;
                }
                for (uint i = 0; i < count; i++)
                {
                    uint need = NativeMethods.DragQueryFileW(drop, i, null, 0);
                    if (need == 0 || need > MAX_PATH_CHARS)
                    {
                        // 超长路径（\? 形式可以到 32k）只跳过它，不影响同批其它文件。
                        continue;
                    }
                    var buffer = new StringBuilder((int)need + 1);
                    uint got = NativeMethods.DragQueryFileW(drop, i, buffer, (uint)buffer.Capacity);
                    if (got == 0)
                    {
                        continue;
                    }
                    string p = buffer.ToString();
                    if (p.Length > 0)
                    {
                        result.Add(p);
                    }
                }
            }
            finally
            {
                NativeMethods.CloseClipboard();
            }
            return result;
        }

        /// <summary>把路径列表编成一行 JSON 数组（自己转义，不引入额外程序集）。</summary>
        private static string ToJsonArray(List<string> items)
        {
            var sb = new StringBuilder();
            sb.Append('[');
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }
                sb.Append('"');
                string s = items[i];
                for (int c = 0; c < s.Length; c++)
                {
                    char ch = s[c];
                    if (ch == '"' || ch == '\\')
                    {
                        sb.Append('\\').Append(ch);
                    }
                    else if (ch < ' ')
                    {
                        sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(ch);
                    }
                }
                sb.Append('"');
            }
            sb.Append(']');
            return sb.ToString();
        }

        // ---- FILESET ----

        /// <summary>
        /// FILESET —— 把一批路径写成**标准 CF_HDROP** 放进剪贴板，输出 `FILESET &lt;返回码&gt;`。
        ///
        /// ★ 为什么写也必须走原生：Electron 的 clipboard.writeBuffer('FileNameW', buf) 注册出来的
        ///   是**自定义格式**（EnumClipboardFormats 实测 id=49159、名字 FileNameW），根本不是
        ///   标准 CF_HDROP(15)。资源管理器、WinForms 的 GetFileDropList() 一律读不到，表现就是
        ///   "复制了文件记录但粘贴不出文件"。只有 OpenClipboard + EmptyClipboard +
        ///   SetClipboardData(15, hGlobal) 这一条路是真的。
        ///
        /// 返回码：0 成功 / 1 入参解析失败 / 2 没有可写的路径 / 3 剪贴板打不开或清空失败 /
        ///         4 内存分配失败 / 5 SetClipboardData 失败。绝不抛异常、绝不阻塞 Serve 循环。
        /// </summary>
        private static void HandleFileSet(StreamWriter stdout, string payload)
        {
            int code = 1;
            try
            {
                List<string> paths = ParseJsonArray(payload);
                code = paths.Count == 0 ? 2 : WriteDropFiles(paths);
            }
            catch (Exception e)
            {
                Trace("fileset failed: " + e.Message);
                code = 1;
            }
            try
            {
                stdout.WriteLine("FILESET " + code.ToString());
            }
            catch
            {
                // stdout 坏了：这一条只能放弃，但不能让异常冒到 Serve 循环。
            }
        }

        /// <summary>
        /// 把路径列表写成 DROPFILES 块并交给系统剪贴板。
        ///
        /// ★ SetClipboardData 成功后内存所有权归系统，**绝不能**再 GlobalFree —— 会二次释放。
        ///   只有 SetClipboardData 失败时才由这里释放。
        /// </summary>
        private static int WriteDropFiles(List<string> paths)
        {
            byte[] block = BuildDropFilesBlock(paths);

            bool opened = false;
            for (int i = 0; i < CLIPBOARD_OPEN_TRIES && !opened; i++)
            {
                if (i > 0)
                {
                    Thread.Sleep(CLIPBOARD_OPEN_RETRY_MS);
                }
                opened = NativeMethods.OpenClipboard(IntPtr.Zero);
            }
            if (!opened)
            {
                Trace("fileset open-clipboard failed");
                return 3;
            }

            try
            {
                if (!NativeMethods.EmptyClipboard())
                {
                    Trace("fileset empty-clipboard failed");
                    return 3;
                }

                IntPtr hMem = NativeMethods.GlobalAlloc(
                    GMEM_MOVEABLE | GMEM_ZEROINIT, new UIntPtr((uint)block.Length));
                if (hMem == IntPtr.Zero)
                {
                    Trace("fileset global-alloc failed");
                    return 4;
                }

                IntPtr locked = NativeMethods.GlobalLock(hMem);
                if (locked == IntPtr.Zero)
                {
                    NativeMethods.GlobalFree(hMem);
                    Trace("fileset global-lock failed");
                    return 4;
                }
                try
                {
                    Marshal.Copy(block, 0, locked, block.Length);
                }
                finally
                {
                    NativeMethods.GlobalUnlock(hMem);
                }

                if (NativeMethods.SetClipboardData(CF_HDROP, hMem) == IntPtr.Zero)
                {
                    NativeMethods.GlobalFree(hMem);
                    Trace("fileset set-clipboard-data failed");
                    return 5;
                }
                return 0;
            }
            finally
            {
                NativeMethods.CloseClipboard();
            }
        }

        /// <summary>
        /// 打 DROPFILES 字节块。布局与 packages/desktop/electron/dropfiles.ts 的 buildDropFiles 一致：
        ///   +0  pFiles  = 20（文件列表相对结构体开头的偏移）
        ///   +4  pt.x    = 0
        ///   +8  pt.y    = 0
        ///   +12 fNC     = 0（不是"拖到资源管理器"）
        ///   +16 fWide   = 1（宽字符）★ 实测 WinForms 写 0xFFFFFFFF 也认，1 同样正确
        ///   之后每条路径 UTF-16LE + 一个宽字符 NUL，整块末尾再补一个宽字符 NUL。
        /// </summary>
        private static byte[] BuildDropFilesBlock(List<string> paths)
        {
            var body = new MemoryStream();
            for (int i = 0; i < paths.Count; i++)
            {
                byte[] chars = Encoding.Unicode.GetBytes(paths[i]);
                body.Write(chars, 0, chars.Length);
                body.WriteByte(0);
                body.WriteByte(0);
            }
            body.WriteByte(0);
            body.WriteByte(0);

            byte[] tail = body.ToArray();
            byte[] block = new byte[DROPFILES_HEADER_BYTES + tail.Length];
            WriteUInt32(block, 0, DROPFILES_HEADER_BYTES);
            WriteUInt32(block, 4, 0);
            WriteUInt32(block, 8, 0);
            WriteUInt32(block, 12, 0);
            WriteUInt32(block, 16, 1);
            Buffer.BlockCopy(tail, 0, block, DROPFILES_HEADER_BYTES, tail.Length);
            return block;
        }

        private static void WriteUInt32(byte[] buf, int offset, uint value)
        {
            buf[offset] = (byte)(value & 0xFF);
            buf[offset + 1] = (byte)((value >> 8) & 0xFF);
            buf[offset + 2] = (byte)((value >> 16) & 0xFF);
            buf[offset + 3] = (byte)((value >> 24) & 0xFF);
        }

        /// <summary>
        /// 解析单行 JSON 字符串数组（只认 `["a","b"]` 这一种形态）。
        ///
        /// ★ 自写而不引序列化器：本机只有 .NET Framework 4.x 的 csc，没有 System.Text.Json，
        ///   为一次解析去引 System.Web.Extensions 不值得。遇到不认识的字符就抛，由调用方
        ///   转成非 0 返回码 —— 不猜、不吞。
        /// </summary>
        private static List<string> ParseJsonArray(string text)
        {
            var result = new List<string>();
            if (text == null)
            {
                throw new FormatException("empty payload");
            }
            int i = 0;
            SkipJsonSpace(text, ref i);
            ExpectChar(text, ref i, '[');
            SkipJsonSpace(text, ref i);
            if (i < text.Length && text[i] == ']')
            {
                return result;
            }
            while (true)
            {
                SkipJsonSpace(text, ref i);
                result.Add(ReadJsonString(text, ref i));
                SkipJsonSpace(text, ref i);
                if (i >= text.Length)
                {
                    throw new FormatException("unterminated array");
                }
                char c = text[i];
                i++;
                if (c == ']')
                {
                    return result;
                }
                if (c != ',')
                {
                    throw new FormatException("unexpected char: " + c);
                }
            }
        }

        private static string ReadJsonString(string text, ref int i)
        {
            ExpectChar(text, ref i, '"');
            var sb = new StringBuilder();
            while (i < text.Length)
            {
                char c = text[i];
                i++;
                if (c == '"')
                {
                    return sb.ToString();
                }
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (i >= text.Length)
                {
                    break;
                }
                char esc = text[i];
                i++;
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > text.Length)
                        {
                            throw new FormatException("bad unicode escape");
                        }
                        sb.Append((char)Convert.ToInt32(text.Substring(i, 4), 16));
                        i += 4;
                        break;
                    default:
                        throw new FormatException("bad escape: " + esc);
                }
            }
            throw new FormatException("unterminated string");
        }

        private static void SkipJsonSpace(string text, ref int i)
        {
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' || text[i] == '\n'))
            {
                i++;
            }
        }

        private static void ExpectChar(string text, ref int i, char want)
        {
            if (i >= text.Length || text[i] != want)
            {
                throw new FormatException("expected '" + want + "'");
            }
            i++;
        }

        // ---- FGEXE ----

        /// <summary>
        /// FGEXE —— 前台窗口所属进程的 exe 文件名（只留文件名，不含路径）。
        ///
        /// 输出 `FGEXE &lt;十进制句柄&gt; &lt;exe名&gt;`；任何一步取不到（没有前台窗口 /
        /// 窗口已失效 / 目标进程已退 / 权限不足）一律输出 `FGEXE 0 -`。
        /// ★ 绝不抛异常、绝不阻塞 Serve 循环：来源只是附加信息，剪贴板记录本身
        ///   不能被来源追踪拖死，所以失败必须是一条正常回包而不是异常。
        /// </summary>
        private static void HandleForegroundExe(StreamWriter stdout)
        {
            try
            {
                IntPtr hwnd = NativeMethods.GetForegroundWindow();
                if (hwnd == IntPtr.Zero)
                {
                    stdout.WriteLine("FGEXE 0 -");
                    return;
                }
                long handle = hwnd.ToInt64();
                uint pid;
                NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
                string exe = pid == 0 ? null : TryGetProcessImageName(pid);
                if (string.IsNullOrEmpty(exe))
                {
                    Trace("fgexe unknown hwnd=" + handle + " pid=" + pid);
                    stdout.WriteLine("FGEXE 0 -");
                    return;
                }
                stdout.WriteLine("FGEXE " + handle + " " + exe);
            }
            catch (Exception e)
            {
                Trace("fgexe failed: " + e.Message);
                try
                {
                    stdout.WriteLine("FGEXE 0 -");
                }
                catch
                {
                    // stdout 也坏了：这一条只能放弃，但仍然不能让异常冒到 Serve 循环。
                }
            }
        }

        /// <summary>
        /// 取进程映像的完整路径后只留文件名。OpenProcess 失败（提权进程）按"未知"处理
        /// ——宁可没有来源，也不要猜一个。
        /// </summary>
        private static string TryGetProcessImageName(uint pid)
        {
            IntPtr proc = NativeMethods.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero)
            {
                return null;
            }
            try
            {
                var buffer = new StringBuilder(IMAGE_NAME_CHARS);
                uint size = (uint)buffer.Capacity;
                if (!NativeMethods.QueryFullProcessImageNameW(proc, 0, buffer, ref size) || size == 0)
                {
                    return null;
                }
                return Path.GetFileName(buffer.ToString(0, (int)size));
            }
            finally
            {
                NativeMethods.CloseHandle(proc);
            }
        }

        // ---- PASTE ----

        /// <summary>
        /// PASTE &lt;十进制句柄&gt; —— 三层验证全部通过才发 Ctrl+V。
        /// 码表：0 成功 / 1 窗口失效 / 2 归位失败 / 3 无输入落点 /
        ///       4 SendInput 部分投递 / 5 参数错误 / 6 目标提权 / 7 归位后仍无输入落点。
        /// </summary>
        private static void HandlePaste(StreamWriter stdout, string[] parts)
        {
            long handle;
            if (parts.Length < 2 || !TryParseHandle(parts[1], out handle))
            {
                stdout.WriteLine("RESULT 0 5 参数错误");
                return;
            }
            IntPtr target = new IntPtr(handle);

            // ① 硬失效：窗口没了 / 不可见 / 最小化。不还原用户的窗口，直接放弃。
            if (!NativeMethods.IsWindow(target) || !NativeMethods.IsWindowVisible(target) || NativeMethods.IsIconic(target))
            {
                Trace("paste hard-dead hwnd=" + handle);
                stdout.WriteLine("RESULT " + handle + " 1 窗口失效");
                return;
            }

            // ⑥ 提权检测必须在归位尝试之前：一旦把提权窗口拉到前台再失败，用户焦点白丢。
            if (IsTargetElevated(target))
            {
                Trace("paste elevated hwnd=" + handle);
                stdout.WriteLine("RESULT " + handle + " 6 目标提权");
                return;
            }

            bool wasForeground = NativeMethods.GetForegroundWindow() == target;

            // ② 归位尝试：失败不判死，软失效宽限重试。
            if (!wasForeground && !TryRestore(target))
            {
                Trace("paste restore-failed hwnd=" + handle);
                stdout.WriteLine("RESULT " + handle + " 2 归位失败");
                return;
            }

            // ③ 输入落点。
            if (!TryFocusSink(target))
            {
                // 已经在前台却没有落点 = 3；归位之后仍然没有落点 = 7。
                int code = wasForeground ? 3 : 7;
                Trace("paste no-focus-sink hwnd=" + handle + " code=" + code);
                stdout.WriteLine("RESULT " + handle + " " + code + " " + (wasForeground ? "无输入落点" : "归位后仍无输入落点"));
                return;
            }

            // 三层都过，才真的投递按键。
            if (SendCtrlV())
            {
                stdout.WriteLine("RESULT " + handle + " 0 成功");
            }
            else
            {
                Trace("paste send-partial hwnd=" + handle);
                stdout.WriteLine("RESULT " + handle + " 4 SendInput 部分投递");
            }
        }

        /// <summary>归位到目标窗口，宽限重试 4 次 × 80ms。</summary>
        private static bool TryRestore(IntPtr target)
        {
            for (int i = 0; i < RESTORE_TRIES; i++)
            {
                NativeMethods.SetForegroundWindow(target);
                if (NativeMethods.GetForegroundWindow() == target)
                {
                    return true;
                }
                if (i < RESTORE_TRIES - 1)
                {
                    Thread.Sleep(GRACE_MS);
                }
            }
            return false;
        }

        /// <summary>检查输入落点，拿不到就宽限重试（重新归位 + 复查）。</summary>
        private static bool TryFocusSink(IntPtr target)
        {
            if (HasFocusSink(target))
            {
                return true;
            }
            for (int i = 0; i < RESTORE_TRIES; i++)
            {
                Thread.Sleep(GRACE_MS);
                NativeMethods.SetForegroundWindow(target);
                if (HasFocusSink(target))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 黑名单式落点判定：先 GetGUIThreadInfo，hwndFocus != 0 直接放行；
        /// 拿不到落点时才按窗口类黑名单排除桌面壳窗口，其余看可见性。
        ///
        /// ★ 绝不可把 hwndFocus != 0 当必要条件——Modern Notepad / UWP / WinUI
        ///   常返回 0，当必要条件会让自动粘贴整体失效。
        /// </summary>
        private static bool HasFocusSink(IntPtr hwnd)
        {
            uint pid;
            uint tid = NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            if (tid != 0)
            {
                var gti = new NativeMethods.GUITHREADINFO();
                gti.cbSize = (uint)Marshal.SizeOf(typeof(NativeMethods.GUITHREADINFO));
                if (NativeMethods.GetGUIThreadInfo(tid, ref gti) && gti.hwndFocus != IntPtr.Zero)
                {
                    return true;
                }
            }

            // 拿不到落点：只排除明确没有粘贴落点的窗口类。
            string cls = ClassNameOf(hwnd);
            for (int i = 0; i < FocusSinkBlacklist.Length; i++)
            {
                if (string.Equals(cls, FocusSinkBlacklist[i], StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            if (cls.StartsWith("Windows.UI.Core", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            return NativeMethods.IsWindowVisible(hwnd);
        }

        private static string ClassNameOf(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            int len = NativeMethods.GetClassName(hwnd, sb, sb.Capacity);
            return len > 0 ? sb.ToString() : string.Empty;
        }

        /// <summary>
        /// 目标进程完整性级别高于自身即视为提权（码 6）。
        /// OpenProcess 失败也算提权（宁可放弃，不要往高权限窗口里盲发按键）。
        /// </summary>
        private static bool IsTargetElevated(IntPtr hwnd)
        {
            uint pid;
            NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0)
            {
                return true;
            }

            IntPtr proc = NativeMethods.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero)
            {
                return true;
            }
            try
            {
                int targetRid;
                if (!TryGetProcessIntegrityRid(proc, out targetRid))
                {
                    return true;
                }
                int selfRid = CurrentIntegrityRid();
                return targetRid > selfRid;
            }
            finally
            {
                NativeMethods.CloseHandle(proc);
            }
        }

        private static int CurrentIntegrityRid()
        {
            uint selfPid = (uint)Process.GetCurrentProcess().Id;
            IntPtr proc = NativeMethods.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, selfPid);
            if (proc == IntPtr.Zero)
            {
                return (int)DEFAULT_MEDIUM_RID;
            }
            try
            {
                int rid;
                return TryGetProcessIntegrityRid(proc, out rid) ? rid : (int)DEFAULT_MEDIUM_RID;
            }
            finally
            {
                NativeMethods.CloseHandle(proc);
            }
        }

        /// <summary>
        /// 从「进程句柄」取完整性级别 RID。
        /// ★ 必须先用 OpenProcessToken 换成「令牌句柄」——GetTokenInformation 只认令牌句柄，
        /// 传进程句柄会稳定拿到 ERROR_INVALID_HANDLE(6) 且 ReturnLength=0，
        /// 从而把所有目标都误判成提权（实测踩过这个坑）。
        /// </summary>
        private static bool TryGetProcessIntegrityRid(IntPtr process, out int rid)
        {
            rid = 0;
            IntPtr token;
            if (!NativeMethods.OpenProcessToken(process, TOKEN_QUERY, out token))
            {
                return false;
            }
            try
            {
                return TryGetIntegrityRid(token, out rid);
            }
            finally
            {
                NativeMethods.CloseHandle(token);
            }
        }

        /// <summary>
        /// 取 TokenIntegrityLevel 的最后一个子权威（RID）。参数必须是令牌句柄。
        /// SID 布局：Revision(1) SubAuthorityCount(1) IdentifierAuthority(6) SubAuthority[]，
        /// 故子权威数组从偏移 8 开始。
        /// 注意：首次 size 探测返回 false 且 LastError=122(ERROR_INSUFFICIENT_BUFFER) 是预期行为，
        /// 只要 needed &gt; 0 就继续，不要据此判失败。
        /// </summary>
        private static bool TryGetIntegrityRid(IntPtr token, out int rid)
        {
            rid = 0;
            int needed;
            NativeMethods.GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out needed);
            if (needed <= 0)
            {
                return false;
            }

            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                int written;
                if (!NativeMethods.GetTokenInformation(token, TokenIntegrityLevel, buffer, needed, out written))
                {
                    return false;
                }
                // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } }
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                if (sid == IntPtr.Zero)
                {
                    return false;
                }
                byte subAuthorityCount = Marshal.ReadByte(sid, 1);
                if (subAuthorityCount == 0)
                {
                    return false;
                }
                int lastOffset = 8 + ((subAuthorityCount - 1) * 4);
                rid = Marshal.ReadInt32(sid, lastOffset);
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>
        /// 投递 Ctrl↓ V↓ V↑ Ctrl↑。要求 4 个事件全部被接收；
        /// 部分投递时单独补发两个 key-up（避免 Ctrl 卡在按下状态），返回 false。
        /// </summary>
        private static bool SendCtrlV()
        {
            var inputs = new NativeMethods.INPUT[4];
            inputs[0] = MakeKey(VK_CONTROL, 0);
            inputs[1] = MakeKey(VK_V, 0);
            inputs[2] = MakeKey(VK_V, KEYEVENTF_KEYUP);
            inputs[3] = MakeKey(VK_CONTROL, KEYEVENTF_KEYUP);

            uint sent = NativeMethods.SendInput((uint)inputs.Length, inputs, InputSize);
            if (sent == (uint)inputs.Length)
            {
                return true;
            }

            // 只补两个 key-up：把可能卡住的 V 与 Ctrl 抬起来。
            var lift = new NativeMethods.INPUT[2];
            lift[0] = MakeKey(VK_V, KEYEVENTF_KEYUP);
            lift[1] = MakeKey(VK_CONTROL, KEYEVENTF_KEYUP);
            NativeMethods.SendInput((uint)lift.Length, lift, InputSize);
            return false;
        }

        private static NativeMethods.INPUT MakeKey(uint vk, uint flags)
        {
            var input = new NativeMethods.INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = (ushort)vk;
            input.u.ki.wScan = 0;
            input.u.ki.dwFlags = flags;
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = IntPtr.Zero;
            return input;
        }

        // ---- BLUR ----

        /// <summary>
        /// BLUR &lt;句柄&gt; &lt;0|1&gt; &lt;ABGR&gt; —— 真毛玻璃。
        /// 开：优先 ACCENT_ENABLE_ACRYLICBLURBEHIND，回落 ACCENT_ENABLE_BLURBEHIND，
        ///     两者都失败返回码 2（系统拒绝）。
        /// 关：ACCENT_DISABLED。
        /// </summary>
        private static void HandleBlur(StreamWriter stdout, string[] parts)
        {
            long handle;
            if (parts.Length < 3 || !TryParseHandle(parts[1], out handle))
            {
                stdout.WriteLine("BLUR 0 5");
                return;
            }
            bool on;
            if (parts[2] == "1")
            {
                on = true;
            }
            else if (parts[2] == "0")
            {
                on = false;
            }
            else
            {
                stdout.WriteLine("BLUR " + handle + " 5");
                return;
            }

            uint abgr = 0;
            if (parts.Length >= 4 && !string.IsNullOrEmpty(parts[3]))
            {
                uint parsed;
                if (!uint.TryParse(parts[3], out parsed))
                {
                    stdout.WriteLine("BLUR " + handle + " 5");
                    return;
                }
                abgr = parsed;
            }

            IntPtr target = new IntPtr(handle);
            int code = ApplyBlur(target, on, abgr);
            stdout.WriteLine("BLUR " + handle + " " + code);
        }

        private static int ApplyBlur(IntPtr hwnd, bool on, uint abgr)
        {
            if (!NativeMethods.IsWindow(hwnd))
            {
                return 2;
            }
            if (!on)
            {
                return SetAccent(hwnd, ACCENT_DISABLED, 0) ? 0 : 2;
            }
            // Win10 上 acrylic 是"真毛玻璃"；不支持就回落普通 blurbehind。
            if (SetAccent(hwnd, ACCENT_ENABLE_ACRYLICBLURBEHIND, abgr))
            {
                return 0;
            }
            if (SetAccent(hwnd, ACCENT_ENABLE_BLURBEHIND, abgr))
            {
                return 0;
            }
            return 2;
        }

        private static bool SetAccent(IntPtr hwnd, int state, uint gradient)
        {
            var policy = new NativeMethods.AccentPolicy();
            policy.AccentState = state;
            policy.AccentFlags = 2;
            policy.GradientColor = unchecked((int)gradient);
            policy.AnimationId = 0;

            int size = Marshal.SizeOf(typeof(NativeMethods.AccentPolicy));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(policy, ptr, false);
                var data = new NativeMethods.WindowCompositionAttributeData();
                data.Attribute = WCA_ACCENT_POLICY;
                data.Data = ptr;
                data.SizeOfData = size;
                return NativeMethods.SetWindowCompositionAttribute(hwnd, ref data) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        // ---- 小工具 ----

        private static bool TryParseHandle(string text, out long handle)
        {
            handle = 0;
            long value;
            if (!long.TryParse(text, out value))
            {
                return false;
            }
            if (value < 0)
            {
                return false;
            }
            handle = value;
            return true;
        }

        private static string ToDecimal(IntPtr value)
        {
            return value.ToInt64().ToString();
        }

        /// <summary>排障埋点：设 CLIPCHAN_TRACE 时把判定写进 %TEMP%\clipchan-helper-trace.log。</summary>
        private static void Trace(string message)
        {
            if (Environment.GetEnvironmentVariable("CLIPCHAN_TRACE") == null)
            {
                return;
            }
            try
            {
                string path = Path.Combine(Path.GetTempPath(), "clipchan-helper-trace.log");
                File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch
            {
                // 排障埋点绝不影响主流程。
            }
        }
    }
}
