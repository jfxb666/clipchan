using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Clipchan
{
    /// <summary>
    /// 剪贴板历史存储。手写 JSON 以避免额外程序集依赖，
    /// 写入走临时文件 + File.Replace，保证崩溃时不留半截文件。
    /// </summary>
    internal sealed class Store
    {
        public const int MaxItems = 200;      // 非收藏条目上限
        public const int MaxChars = 100000;   // 单条字符上限

        private readonly string _dir;
        private readonly string _file;
        private readonly List<ClipItem> _items = new List<ClipItem>();

        public Store(string dir)
        {
            _dir = dir;
            _file = Path.Combine(dir, "history.json");
            Load();
        }

        public static string DefaultDir
        {
            get
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                return Path.Combine(appData, "Clipchan");
            }
        }

        public string FilePath { get { return _file; } }

        /// <summary>收藏在前，其余按时间倒序（时间相同用 Seq 保证确定性）。</summary>
        public List<ClipItem> Ordered()
        {
            var list = new List<ClipItem>(_items);
            list.Sort(CompareForDisplay);
            return list;
        }

        /// <summary>统一的展示排序：收藏优先 → 时间倒序 → 序号倒序（消除时间戳并列的不确定性）。</summary>
        internal static int CompareForDisplay(ClipItem a, ClipItem b)
        {
            if (a.Pinned != b.Pinned) return a.Pinned ? -1 : 1;
            int c = b.CreatedUtc.CompareTo(a.CreatedUtc);
            if (c != 0) return c;
            return b.Seq.CompareTo(a.Seq);
        }

        public int Count { get { return _items.Count; } }

        /// <summary>返回今天（本地时间）的所有条目，用于每日词云。</summary>
        public List<ClipItem> GetToday()
        {
            var today = DateTime.Now.Date;
            var result = new List<ClipItem>();
            foreach (ClipItem it in _items)
                if (it.CreatedUtc.ToLocalTime().Date == today)
                    result.Add(it);
            return result;
        }

        public ClipItem Find(string id)
        {
            for (int i = 0; i < _items.Count; i++)
                if (_items[i].Id == id) return _items[i];
            return null;
        }

        /// <summary>
        /// 加入一条文本。返回 true 表示历史发生变化。
        /// 已存在完全相同的内容时不产生重复项，而是把它提到最前。
        /// </summary>
        public bool Add(string text)
        {
            string ignored;
            return Add(text, out ignored);
        }

        /// <summary>
        /// 加入一条文本，并通过 affectedId 返回受影响条目的 Id
        /// （新建的条目或被提到最前的既有条目）。供界面自动预选用。
        /// </summary>
        public bool Add(string text, out string affectedId)
        {
            affectedId = null;
            if (text == null) return false;
            text = text.Trim('\0');
            if (text.Length == 0) return false;

            // 去重 + 提到最前。注意必须"同时"刷新 CreatedUtc 和 Seq：
            //  - 只刷时间戳：同一次系统时钟 tick 内（Windows 约 15ms）会并列，
            //    排序退化到 Seq 比较，旧序号会把条目压回后面；
            //  - 只刷 Seq：相对时间的显示会失真。
            // 两者一起刷新才能保证"刚复制的永远在第一条"这一确定性结果。
            for (int i = 0; i < _items.Count; i++)
            {
                if (_items[i].Text != text) continue;
                TouchExisting(_items[i]);
                affectedId = _items[i].Id;
                Save();
                return true;
            }

            ClipItem created = new ClipItem(text, MaxChars);
            _items.Add(created);
            affectedId = created.Id;
            Trim();
            Save();
            return true;
        }

        /// <summary>把已存在的条目刷新为"刚刚复制"（时间 + 序号同步推进）。</summary>
        private static void TouchExisting(ClipItem it)
        {
            it.CreatedUtc = DateTime.UtcNow;
            it.Seq = ClipItem.NextSeq();
            it.Truncated = false;
        }

        /// <summary>复制到剪贴板后把条目提到最前（刷新时间与序号，保证排序确定）。</summary>
        public void Touch(string id)
        {
            ClipItem it = Find(id);
            if (it == null) return;
            it.CreatedUtc = DateTime.UtcNow;
            it.Seq = ClipItem.NextSeq();
            Save();
        }

        /// <summary>
        /// 把多条记录按给定顺序合并成一条新记录（「拼接」功能）。
        /// 源条目被移除，新条目文本为各段用分隔符连接的结果。返回新条目。
        /// </summary>
        public ClipItem MergeTexts(List<string> texts, string separator)
        {
            if (texts == null || texts.Count == 0) return null;

            var sb = new StringBuilder();
            for (int i = 0; i < texts.Count; i++)
            {
                if (i > 0) sb.Append(separator);
                sb.Append(texts[i]);
            }

            var merged = new ClipItem(sb.ToString(), MaxChars);
            _items.Add(merged);
            Trim();
            Save();
            return merged;
        }

        /// <summary>删除一批条目，返回实际删除数量。</summary>
        public int RemoveMany(List<string> ids)
        {
            if (ids == null || ids.Count == 0) return 0;
            var set = new HashSet<string>(ids);
            int removed = 0;
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                if (set.Contains(_items[i].Id)) { _items.RemoveAt(i); removed++; }
            }
            if (removed > 0) Save();
            return removed;
        }

        public bool Remove(string id)
        {
            for (int i = 0; i < _items.Count; i++)
            {
                if (_items[i].Id == id)
                {
                    _items.RemoveAt(i);
                    Save();
                    return true;
                }
            }
            return false;
        }

        public bool TogglePin(string id)
        {
            ClipItem it = Find(id);
            if (it == null) return false;
            it.Pinned = !it.Pinned;
            Save();
            return true;
        }

        /// <summary>清空非收藏条目；返回删除数量。</summary>
        public int ClearUnpinned()
        {
            int removed = 0;
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                if (!_items[i].Pinned) { _items.RemoveAt(i); removed++; }
            }
            if (removed > 0) Save();
            return removed;
        }

        private void Trim()
        {
            var unpinned = new List<ClipItem>();
            foreach (ClipItem it in _items) if (!it.Pinned) unpinned.Add(it);

            if (unpinned.Count <= MaxItems) return;
            // 与展示排序同一套规则，保证"保留最新的 200 条"与用户所见一致
            unpinned.Sort(CompareForDisplay);

            var keep = new HashSet<string>();
            for (int i = 0; i < MaxItems && i < unpinned.Count; i++) keep.Add(unpinned[i].Id);

            for (int i = _items.Count - 1; i >= 0; i--)
            {
                ClipItem it = _items[i];
                if (!it.Pinned && !keep.Contains(it.Id)) _items.RemoveAt(i);
            }
        }

        // ---------------- 持久化 ----------------

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(_dir);
                string tmp = _file + ".tmp";

                var sb = new StringBuilder();
                sb.Append("{\"version\":1,\"items\":[");
                List<ClipItem> ordered = Ordered();
                for (int i = 0; i < ordered.Count; i++)
                {
                    ClipItem it = ordered[i];
                    if (i > 0) sb.Append(',');
                    sb.Append("{\"id\":").Append(Js(it.Id));
                    sb.Append(",\"text\":").Append(Js(it.Text));
                    sb.Append(",\"at\":\"").Append(it.CreatedUtc.ToString("o")).Append('"');
                    sb.Append(",\"seq\":").Append(it.Seq);
                    sb.Append(",\"pin\":").Append(it.Pinned ? "true" : "false");
                    sb.Append(",\"trunc\":").Append(it.Truncated ? "true" : "false");
                    sb.Append('}');
                }
                sb.Append("]}");

                File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));

                if (File.Exists(_file))
                {
                    try { File.Replace(tmp, _file, null); }
                    catch (Exception) { File.Copy(tmp, _file, true); File.Delete(tmp); }
                }
                else
                {
                    File.Move(tmp, _file);
                }
            }
            catch (Exception)
            {
                // 磁盘满 / 被占用：本次保存失败不影响程序运行
            }
        }

        public void Load()
        {
            _items.Clear();
            try
            {
                if (!File.Exists(_file)) return;
                string raw = File.ReadAllText(_file, Encoding.UTF8);
                if (raw.Trim().Length == 0) return;

                // 内容非空却不是本程序的 JSON 结构 → 视为损坏。
                // Parse 对垃圾输入会安静地返回空列表，所以这里必须显式校验结构，
                // 否则下面的 catch 永远不触发，.bad 备份也就永远不会发生。
                if (!LooksLikeOurFormat(raw))
                    throw new InvalidDataException("history.json 不是有效的 Clipchan 数据结构");

                List<ClipItem> parsed = Parse(raw);
                _items.AddRange(parsed);
            }
            catch (Exception)
            {
                // 文件损坏：备份后以空历史启动，绝不因此崩溃
                try
                {
                    if (File.Exists(_file))
                    {
                        string bad = _file + ".bad";
                        if (File.Exists(bad)) File.Delete(bad);
                        File.Move(_file, bad);
                    }
                }
                catch (Exception) { }
                _items.Clear();
            }
        }

        /// <summary>粗判文件是否为本程序写出的结构（含 version 与 items 数组）。</summary>
        private static bool LooksLikeOurFormat(string raw)
        {
            return raw.IndexOf("\"items\"", StringComparison.Ordinal) >= 0 &&
                   raw.IndexOf('[', raw.IndexOf("\"items\"", StringComparison.Ordinal)) >= 0;
        }

        // ---------------- 手写 JSON ----------------

        private static string Js(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    case '\b': sb.Append("\\b");  break;
                    case '\f': sb.Append("\\f");  break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>简易 JSON 解析：只识别本程序自己写出的结构。</summary>
        internal static List<ClipItem> Parse(string raw)
        {
            var result = new List<ClipItem>();
            if (raw == null) return result;

            int itemsIdx = raw.IndexOf("\"items\"", StringComparison.Ordinal);
            if (itemsIdx < 0) return result;
            int arrStart = raw.IndexOf('[', itemsIdx);
            if (arrStart < 0) return result;

            int i = arrStart + 1;
            while (i < raw.Length)
            {
                while (i < raw.Length && (char.IsWhiteSpace(raw[i]) || raw[i] == ',')) i++;
                if (i >= raw.Length || raw[i] == ']') break;
                if (raw[i] != '{') break;

                int objEnd = FindObjectEnd(raw, i);
                if (objEnd < 0) break;

                ClipItem it = ParseObject(raw.Substring(i, objEnd - i + 1));
                if (it != null && !string.IsNullOrEmpty(it.Text)) result.Add(it);

                i = objEnd + 1;
            }
            return result;
        }

        private static int FindObjectEnd(string s, int start)
        {
            int depth = 0;
            bool inStr = false;
            for (int i = start; i < s.Length; i++)
            {
                char c = s[i];
                if (inStr)
                {
                    if (c == '\\') { i++; continue; }
                    if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') { inStr = true; continue; }
                if (c == '{') depth++;
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0) return i;
                }
            }
            return -1;
        }

        private static ClipItem ParseObject(string obj)
        {
            var it = new ClipItem();
            string id = Str(obj, "id");
            if (id != null) it.Id = id;
            it.Text = Str(obj, "text");
            if (it.Text == null) return null;

            string at = Str(obj, "at");
            DateTime dt;
            if (at != null && DateTime.TryParse(at, null,
                    System.Globalization.DateTimeStyles.RoundtripKind, out dt))
                it.CreatedUtc = dt.ToUniversalTime();

            it.Pinned = Bool(obj, "pin");
            it.Truncated = Bool(obj, "trunc");

            // seq 是后加的字段：旧文件没有它，回落到 0（按时间戳排序仍然正确），
            // 但要把进程序号推高，避免新条目比旧条目的序号还小。
            long seq = Long(obj, "seq");
            if (seq > 0) it.Seq = seq;
            else it.Seq = ClipItem.NextSeq();
            return it;
        }

        private static bool Bool(string obj, string key)
        {
            int k = obj.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return false;
            int c = obj.IndexOf(':', k);
            if (c < 0) return false;

            // 只取冒号后的第一个字面量，跳过空白，严格比较 "true"/"false"。
            // 不能用 IndexOf("true") 模糊匹配，否则 "trunc":true 会串到相邻键。
            int p = c + 1;
            while (p < obj.Length && char.IsWhiteSpace(obj[p])) p++;
            return string.CompareOrdinal(obj, p, "true", 0, 4) == 0;
        }

        /// <summary>读取整数字面量（用于向后兼容地解析后加字段，如 seq）。</summary>
        private static long Long(string obj, string key)
        {
            int k = obj.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return 0;
            int c = obj.IndexOf(':', k);
            if (c < 0) return 0;
            int p = c + 1;
            while (p < obj.Length && char.IsWhiteSpace(obj[p])) p++;
            int end = p;
            while (end < obj.Length && (char.IsDigit(obj[end]) || obj[end] == '-')) end++;
            long v;
            if (end > p && long.TryParse(obj.Substring(p, end - p),
                    System.Globalization.NumberStyles.Integer,
                    System.Globalization.CultureInfo.InvariantCulture, out v))
                return v;
            return 0;
        }

        private static string Str(string obj, string key)
        {
            int k = obj.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return null;
            int c = obj.IndexOf(':', k);
            if (c < 0) return null;
            int q = obj.IndexOf('"', c + 1);
            if (q < 0) return null;

            var sb = new StringBuilder();
            for (int i = q + 1; i < obj.Length; i++)
            {
                char ch = obj[i];
                if (ch == '"') return sb.ToString();
                if (ch == '\\' && i + 1 < obj.Length)
                {
                    i++;
                    char e = obj[i];
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            if (i + 4 < obj.Length)
                            {
                                int code;
                                if (int.TryParse(obj.Substring(i + 1, 4),
                                        System.Globalization.NumberStyles.HexNumber,
                                        System.Globalization.CultureInfo.InvariantCulture, out code))
                                {
                                    sb.Append((char)code);
                                    i += 4;
                                }
                            }
                            break;
                        default: sb.Append(e); break;
                    }
                }
                else sb.Append(ch);
            }
            return sb.ToString();
        }
    }
}
