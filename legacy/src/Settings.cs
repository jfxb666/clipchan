using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>用户可配置项，存 %APPDATA%\Clipchan\settings.json。</summary>
    internal sealed class Settings
    {
        public bool Ctrl;
        public bool Alt;
        public bool Shift;
        public bool Win;
        /// <summary>WinForms Keys 值（不含修饰键）。</summary>
        public int Key;
        /// <summary>幽灵模式截止时间（UTC），早于当前时间表示已过期。不写入文件。</summary>
        public DateTime GhostUntilUtc;
        /// <summary>是否处于幽灵模式（暂停记录）。</summary>
        public bool IsGhostMode
        {
            get { return GhostUntilUtc > DateTime.UtcNow; }
        }
        /// <summary>主题模式："auto" 跟随系统 / "light" / "dark"。</summary>
        public string ThemeMode = "auto";
        /// <summary>Enter 复制后是否自动粘贴回原窗口（默认开）。</summary>
        public bool AutoPaste = true;

        public Settings()
        {
            // 默认 Ctrl + `
            Ctrl = true;
            Key = (int)Keys.Oemtilde;
        }

        private static string Dir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Clipchan"); }
        }

        public static string FilePath { get { return Path.Combine(Dir, "settings.json"); } }

        /// <summary>至少需要一个修饰键，且必须有一个主键，才算合法。</summary>
        public bool IsValid
        {
            get
            {
                if (Key == 0) return false;
                if (!Ctrl && !Alt && !Shift && !Win) return false;
                Keys k = (Keys)Key;
                if (k == Keys.ControlKey || k == Keys.Menu || k == Keys.ShiftKey ||
                    k == Keys.LWin || k == Keys.RWin || k == Keys.None) return false;
                return true;
            }
        }

        /// <summary>显示用文本，如 "Ctrl+`"。</summary>
        public string Label
        {
            get
            {
                if (Key == 0) return "(未设置)";
                var parts = new List<string>();
                if (Ctrl) parts.Add("Ctrl");
                if (Alt) parts.Add("Alt");
                if (Shift) parts.Add("Shift");
                if (Win) parts.Add("Win");
                parts.Add(KeyName((Keys)Key));
                return string.Join("+", parts.ToArray());
            }
        }

        /// <summary>把 Keys 值转成好看的键名。</summary>
        public static string KeyName(Keys k)
        {
            switch (k)
            {
                case Keys.Oemtilde: return "`";
                case Keys.OemMinus: return "-";
                case Keys.Oemplus: return "=";
                case Keys.OemOpenBrackets: return "[";
                case Keys.OemCloseBrackets: return "]";
                case Keys.OemPipe: return "\\";
                case Keys.OemSemicolon: return ";";
                case Keys.OemQuotes: return "'";
                case Keys.Oemcomma: return ",";
                case Keys.OemPeriod: return ".";
                case Keys.OemQuestion: return "/";
                case Keys.Space: return "Space";
                case Keys.Return: return "Enter";
                case Keys.Escape: return "Esc";
                case Keys.Back: return "Backspace";
                case Keys.Delete: return "Delete";
                case Keys.Insert: return "Insert";
                case Keys.Home: return "Home";
                case Keys.End: return "End";
                case Keys.PageUp: return "PageUp";
                case Keys.PageDown: return "PageDown";
                case Keys.Up: return "Up";
                case Keys.Down: return "Down";
                case Keys.Left: return "Left";
                case Keys.Right: return "Right";
                case Keys.Tab: return "Tab";
                case Keys.D0: return "0";
                case Keys.D1: return "1";
                case Keys.D2: return "2";
                case Keys.D3: return "3";
                case Keys.D4: return "4";
                case Keys.D5: return "5";
                case Keys.D6: return "6";
                case Keys.D7: return "7";
                case Keys.D8: return "8";
                case Keys.D9: return "9";
                default: return k.ToString();
            }
        }

        // ---------------- 持久化 ----------------

        public static Settings Load()
        {
            try
            {
                if (!File.Exists(FilePath)) return new Settings();
                string raw = File.ReadAllText(FilePath, Encoding.UTF8);

                var s = new Settings();
                s.Ctrl = ReadBool(raw, "ctrl", s.Ctrl);
                s.Alt = ReadBool(raw, "alt", s.Alt);
                s.Shift = ReadBool(raw, "shift", s.Shift);
                s.Win = ReadBool(raw, "win", s.Win);
                s.Key = ReadInt(raw, "key", s.Key);
                s.ThemeMode = NormalizeThemeMode(ReadString(raw, "theme"));
                s.AutoPaste = ReadBool(raw, "autopaste", s.AutoPaste);

                return s.IsValid ? s : new Settings();
            }
            catch (Exception)
            {
                // 配置损坏：回落到默认值，绝不影响启动
                return new Settings();
            }
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Dir);
                var sb = new StringBuilder();
                sb.Append("{\n");
                sb.Append("  \"ctrl\": ").Append(Ctrl ? "true" : "false").Append(",\n");
                sb.Append("  \"alt\": ").Append(Alt ? "true" : "false").Append(",\n");
                sb.Append("  \"shift\": ").Append(Shift ? "true" : "false").Append(",\n");
                sb.Append("  \"win\": ").Append(Win ? "true" : "false").Append(",\n");
                sb.Append("  \"key\": ").Append(Key).Append(",\n");
                sb.Append("  \"theme\": \"").Append(NormalizeThemeMode(ThemeMode)).Append("\",\n");
                sb.Append("  \"autopaste\": ").Append(AutoPaste ? "true" : "false").Append(",\n");
                sb.Append("  \"label\": \"").Append(Label).Append("\"\n");
                sb.Append("}\n");
                File.WriteAllText(FilePath, sb.ToString(), new UTF8Encoding(false));
            }
            catch (Exception) { }
        }

        /// <summary>把任意输入归一化为 auto/light/dark，非法值回落 auto。</summary>
        public static string NormalizeThemeMode(string v)
        {
            if (string.IsNullOrEmpty(v)) return "auto";
            switch (v.Trim().ToLowerInvariant())
            {
                case "light": return "light";
                case "dark": return "dark";
                default: return "auto";
            }
        }

        private static string ReadString(string raw, string key)
        {
            int k = raw.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return null;
            int c = raw.IndexOf(':', k);
            if (c < 0) return null;
            int q = raw.IndexOf('"', c + 1);
            if (q < 0) return null;
            int q2 = raw.IndexOf('"', q + 1);
            if (q2 < 0) return null;
            return raw.Substring(q + 1, q2 - q - 1);
        }

        private static bool ReadBool(string raw, string key, bool dflt)
        {
            int k = raw.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return dflt;
            int c = raw.IndexOf(':', k);
            if (c < 0) return dflt;
            int p = c + 1;
            while (p < raw.Length && char.IsWhiteSpace(raw[p])) p++;
            return string.CompareOrdinal(raw, p, "true", 0, 4) == 0;
        }

        private static int ReadInt(string raw, string key, int dflt)
        {
            int k = raw.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return dflt;
            int c = raw.IndexOf(':', k);
            if (c < 0) return dflt;
            int p = c + 1;
            while (p < raw.Length && char.IsWhiteSpace(raw[p])) p++;
            int end = p;
            while (end < raw.Length && (char.IsDigit(raw[end]) || raw[end] == '-')) end++;
            int v;
            return int.TryParse(raw.Substring(p, end - p), out v) ? v : dflt;
        }
    }
}
