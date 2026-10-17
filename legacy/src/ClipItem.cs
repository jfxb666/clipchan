using System;

namespace Clipchan
{
    /// <summary>一条剪贴板历史。</summary>
    internal sealed class ClipItem
    {
        /// <summary>
        /// 进程内单调递增序号。Windows 的 DateTime.UtcNow 精度约 15ms，
        /// 连续快速复制会产生相同时间戳；仅按时间排序结果不稳定
        /// （List.Sort 是快排，非稳定排序），会导致"最新一条"随机漂移。
        /// 因此用秒表级序号作为时间戳相同时的确定性次级排序键。
        /// </summary>
        private static long _seqSeed;

        public string Id { get; set; }
        public string Text { get; set; }
        public DateTime CreatedUtc { get; set; }
        /// <summary>创建顺序（同时间戳时用于稳定排序）</summary>
        public long Seq { get; set; }
        public bool Pinned { get; set; }
        /// <summary>原文超长被截断时为 true，仅用于界面提示。</summary>
        public bool Truncated { get; set; }

        public ClipItem()
        {
            Id = Guid.NewGuid().ToString("N");
            CreatedUtc = DateTime.UtcNow;
            Seq = NextSeq();
        }

        public ClipItem(string text, int maxBytes)
        {
            Id = Guid.NewGuid().ToString("N");
            CreatedUtc = DateTime.UtcNow;
            Seq = NextSeq();
            SetText(text, maxBytes);
        }

        /// <summary>取下一个单调序号（线程安全，溢出后回绕到一个较大基数）。</summary>
        public static long NextSeq()
        {
            long v = System.Threading.Interlocked.Increment(ref _seqSeed);
            if (v <= 0) { System.Threading.Interlocked.Exchange(ref _seqSeed, 1); v = 1; }
            return v;
        }

        public void SetText(string text, int maxBytes)
        {
            if (text == null) text = string.Empty;
            if (maxBytes > 0 && text.Length > maxBytes)
            {
                Text = text.Substring(0, maxBytes);
                Truncated = true;
            }
            else
            {
                Text = text;
                Truncated = false;
            }
        }

        /// <summary>列表中显示的一行预览：压平换行与多余空白。</summary>
        public string Preview(int maxLen)
        {
            string s = (Text ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
            while (s.Contains("  ")) s = s.Replace("  ", " ");
            s = s.Trim();
            if (s.Length == 0) s = "(空白文本)";
            if (maxLen > 0 && s.Length > maxLen) s = s.Substring(0, maxLen) + "…";
            return s;
        }

        public string TimeText { get { return Theme.RelativeTime(CreatedUtc); } }
    }
}
