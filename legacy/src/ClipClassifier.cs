using System;

namespace Clipchan
{
    /// <summary>剪贴板内容的粗略类型，用于列表左侧图标。</summary>
    internal enum ClipKind { Text, Link, Code, Path, Number }

    internal static class ClipClassifier
    {
        public static ClipKind Classify(string s)
        {
            if (string.IsNullOrEmpty(s)) return ClipKind.Text;
            string t = s.Trim();

            // 单行才可能是链接/路径，多行优先判代码
            bool singleLine = t.IndexOf('\n') < 0 && t.IndexOf('\r') < 0;

            if (singleLine)
            {
                if (t.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                    t.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                    t.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ||
                    t.StartsWith("ftp://", StringComparison.OrdinalIgnoreCase))
                    return ClipKind.Link;

                if (t.Length >= 3 &&
                    (t.StartsWith("\\\\") ||
                     (t.Length > 2 && char.IsLetter(t[0]) && t[1] == ':' &&
                      (t[2] == '\\' || t[2] == '/'))))
                    return ClipKind.Path;

                // 纯数字（含小数、千分位、正负号）
                bool numeric = t.Length > 0;
                int digits = 0;
                foreach (char c in t)
                {
                    if (char.IsDigit(c)) { digits++; continue; }
                    if (c == '.' || c == ',' || c == '-' || c == '+' || c == '%' || c == ' ') continue;
                    numeric = false; break;
                }
                if (numeric && digits > 0 && t.Length <= 24) return ClipKind.Number;
            }

            // 代码特征：常见关键字 / 符号密度
            if (LooksLikeCode(t)) return ClipKind.Code;
            return ClipKind.Text;
        }

        private static bool LooksLikeCode(string t)
        {
            string[] hints = new[]
            {
                "function ", "def ", "class ", "import ", "public ", "private ",
                "void ", "const ", "let ", "var ", "return ", "SELECT ", "select ",
                "using ", "namespace ", "console.log", "println", "#!/", "<?xml",
                "<html", "{\n", "};", "=>", "()", ");"
            };
            foreach (string h in hints)
                if (t.IndexOf(h, StringComparison.Ordinal) >= 0) return true;

            // 符号占比高也算代码
            int sym = 0;
            foreach (char c in t)
                if (c == '{' || c == '}' || c == ';' || c == '(' || c == ')' || c == '=' || c == '<' || c == '>') sym++;
            return t.Length >= 12 && sym * 100 / t.Length >= 12;
        }
    }
}
