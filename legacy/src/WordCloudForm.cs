using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>
    /// 「今日词云」悬浮窗：把当天所有复制内容提取高频词，
    /// 以漂浮气泡形式绘制，让用户一眼回顾一天做了什么。
    /// 这是本软件区别于传统剪贴板工具的核心差异化功能之一。
    /// </summary>
    internal sealed class WordCloudForm : Form
    {
        private readonly Store _store;
        private readonly List<WordSpot> _spots = new List<WordSpot>();
        private readonly Timer _floatTimer;
        private readonly int _todayCount;
        private int[] _fontSizes = new int[0];
        private bool _layoutDone;
        private float _phase;
        /// <summary>失去焦点即关闭（托盘唤起时符合直觉）；独立启动时应设为 false。</summary>
        public bool CloseOnDeactivate { get; set; }
        private bool _everActivated;

        // ---- 导出 PNG ----
        private Rectangle _exportPill;      // 右下角"导出 PNG"按钮命中区（OnPaint 计算）
        private bool _hoverExport;
        private bool _exporting;            // 保存对话框打开中：抑制失焦关闭
        private string _exportMsg;          // 保存成功后的短暂提示
        private DateTime _exportMsgUntil;

        private struct WordSpot
        {
            public string Text;
            public int Weight;
            public float X, Y;      // 归一化坐标 0..1
        }

        public WordCloudForm(Store store)
        {
            _store = store;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(420, 540);
            BackColor = Theme.Canvas;
            DoubleBuffered = true;
            ShowInTaskbar = false;
            TopMost = true;
            KeyPreview = true;
            CloseOnDeactivate = true;
            // 窗口标题：任务切换器 / 无障碍工具（屏幕阅读器）都依赖它，不能留空
            Text = "今日词云 - Clipchan";

            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width, Height), Theme.Radius))
                Region = new Region(p);

            _todayCount = _store.GetToday().Count;
            BuildCloud();

            // 轻微漂浮动效：25FPS，正弦摆动，永不越界
            _floatTimer = new Timer();
            _floatTimer.Interval = 40;
            _floatTimer.Tick += delegate
            {
                _phase += 0.04f;
                Invalidate();
            };
            _floatTimer.Start();

            KeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) Close();
            };
            Deactivate += delegate
            {
                // 保存对话框弹出时窗口必然失焦，此时绝不能把词云一起关掉
                if (CloseOnDeactivate && _everActivated && !_exporting) Close();
            };
        }

        /// <summary>从今日条目提取高频词并按权重摆位（含防重叠布局）。</summary>
        private void BuildCloud()
        {
            var list = _store.GetToday();
            var freq = new Dictionary<string, int>(StringComparer.Ordinal);
            var cjkRuns = new List<string>();

            foreach (ClipItem it in list)
            {
                if (string.IsNullOrEmpty(it.Text)) continue;

                foreach (string run in CjkRuns(it.Text))
                    if (run.Length >= 2) cjkRuns.Add(run);

                foreach (string w in LatinWords(it.Text))
                    freq[w] = freq.ContainsKey(w) ? freq[w] + 1 : 1;
            }

            // 中文无空格，这里用"高频 n-gram 发现"来切词：
            // 统计 2~4 字的候选片段，按 长度²×出现次数 打分，贪心挑走不重叠的高分片段。
            // 这样"剪贴板"会作为整体胜出，而不是留下"剪贴/贴板/板的"一串碎片。
            // 注意必须带上真实的出现次数作为权重，否则高频中文词会和只出现一次的
            // 英文长单词并列，被长度排序挤出前 18 名。
            foreach (var kv in ExtractCjkWords(cjkRuns))
                freq[kv.Key] = freq.ContainsKey(kv.Key) ? freq[kv.Key] + kv.Value : kv.Value;

            var top = new List<KeyValuePair<string, int>>(freq);
            top.Sort(delegate(KeyValuePair<string, int> a, KeyValuePair<string, int> b)
            {
                int c = b.Value.CompareTo(a.Value);
                if (c != 0) return c;
                c = b.Key.Length.CompareTo(a.Key.Length);
                return c != 0 ? c : string.CompareOrdinal(a.Key, b.Key);
            });

            int count = Math.Min(top.Count, 18);
            for (int i = 0; i < count; i++)
                _spots.Add(new WordSpot { Text = top[i].Key, Weight = top[i].Value });
        }

        /// <summary>
        /// 中文分词（无词典）：从所有 CJK 片段里发现重复出现的词。
        /// 步骤：统计 2~4 字 n-gram 的出现次数 → 按"长度² × 频次"降序 →
        /// 贪心地把高分片段从语料中"抠掉"，避免子串碎片重复入选。
        /// 返回 词 → 真实出现次数。
        /// </summary>
        internal static Dictionary<string, int> ExtractCjkWords(List<string> runs)
        {
            var grams = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (string run in runs)
            {
                int maxLen = Math.Min(4, run.Length);
                for (int len = 2; len <= maxLen; len++)
                {
                    for (int i = 0; i + len <= run.Length; i++)
                    {
                        string g = run.Substring(i, len);
                        grams[g] = grams.ContainsKey(g) ? grams[g] + 1 : 1;
                    }
                }
            }

            // 只保留重复出现的候选（出现 1 次的片段只是噪声），并排除停用词
            var candidates = new List<string>();
            foreach (var kv in grams)
            {
                if (kv.Value < 2) continue;
                if (StopWords.Contains(kv.Key)) continue;
                candidates.Add(kv.Key);
            }

            // 得分：长度越长、出现越多，越像一个真正的词
            candidates.Sort(delegate(string a, string b)
            {
                int sa = a.Length * a.Length * grams[a];
                int sb = b.Length * b.Length * grams[b];
                int c = sb.CompareTo(sa);
                if (c != 0) return c;
                c = b.Length.CompareTo(a.Length);
                return c != 0 ? c : string.CompareOrdinal(a, b);
            });

            // 贪心：选中一个词后，把它在语料中的所有出现位置标记为已占用
            var result = new Dictionary<string, int>(StringComparer.Ordinal);
            var taken = new List<bool[]>();
            foreach (string run in runs) taken.Add(new bool[run.Length]);

            foreach (string cand in candidates)
            {
                var hits = new List<int[]>();
                for (int r = 0; r < runs.Count; r++)
                {
                    string run = runs[r];
                    for (int i = 0; i + cand.Length <= run.Length; i++)
                    {
                        if (string.CompareOrdinal(run, i, cand, 0, cand.Length) != 0) continue;
                        bool free = true;
                        for (int k = 0; k < cand.Length; k++) if (taken[r][i + k]) { free = false; break; }
                        if (free) hits.Add(new int[] { r, i });
                    }
                }

                // 至少要有 2 次可用出现，才值得作为一个词收录
                if (hits.Count < 2) continue;

                // 剪掉首尾虚词后再收录："剪贴板的" → "剪贴板"，与真正的"剪贴板"合并计数
                string word = TrimParticles(cand);
                if (word.Length < 2) continue;

                result[word] = result.ContainsKey(word) ? result[word] + hits.Count : hits.Count;
                foreach (int[] h in hits)
                    for (int k = 0; k < cand.Length; k++) taken[h[0]][h[1] + k] = true;

                if (result.Count >= 30) break;
            }

            return result;
        }

        /// <summary>
        /// 去掉中文词首尾的虚词（"的""了""是"等）。
        /// n-gram 切出来的常见形态是"剪贴板的"，读起来像半个词，
        /// 剪掉尾缀既更像一个词，也能与真正的"剪贴板"合并计数。
        /// </summary>
        internal static string TrimParticles(string w)
        {
            int start = 0, end = w.Length;
            while (start < end && Particles.IndexOf(w[start]) >= 0) start++;
            while (end > start && Particles.IndexOf(w[end - 1]) >= 0) end--;
            return w.Substring(start, end - start);
        }

        /// <summary>常被误当词首尾的虚词/单字。</summary>
        private const string Particles = "的了是这那我们你们他们和与或及而在就都也很把被给对为个之其";

        /// <summary>英文/数字词：按非字母数字切分并小写化。</summary>
        internal static IEnumerable<string> LatinWords(string text)
        {
            var buf = new System.Text.StringBuilder();
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsLetterOrDigit(c) && !IsCjk(c))
                {
                    buf.Append(char.ToLowerInvariant(c));
                }
                else if (buf.Length > 0)
                {
                    string w = buf.ToString();
                    buf.Length = 0;
                    if (w.Length >= 2 && !StopWords.Contains(w)) yield return w;
                }
            }
            if (buf.Length >= 2)
            {
                string w = buf.ToString();
                if (!StopWords.Contains(w)) yield return w;
            }
        }

        /// <summary>切出文本中的连续 CJK 片段（用于统计整段短语频率）。</summary>
        internal static IEnumerable<string> CjkRuns(string text)
        {
            int start = -1;
            for (int i = 0; i <= text.Length; i++)
            {
                bool cjk = i < text.Length && IsCjk(text[i]);
                if (cjk)
                {
                    if (start < 0) start = i;
                }
                else if (start >= 0)
                {
                    yield return text.Substring(start, i - start);
                    start = -1;
                }
            }
        }

        private static bool IsCjk(char c)
        {
            return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7AF);
        }


        /// <summary>常见停用词：中英文混排。</summary>
        private static readonly HashSet<string> StopWords = new HashSet<string>(StringComparer.Ordinal)
        {
            "的","了","是","我","你","他","她","它","这","那","有","在","和","就","都","而","及","与","或","一个","我们","你们","他们",
            "the","a","an","is","are","was","were","be","been","to","of","and","in","on","at","for","with",
            "it","this","that","i","you","he","she","we","they","not","but","have","has","do","does"
        };

        protected override void OnPaint(PaintEventArgs e)
        {
            EnsureLayout();
            RenderContent(e.Graphics, Width, Height);

            // ---- 以下仅屏幕可见，不参与导出 ----
            Graphics g = e.Graphics;

            // 右下角"导出 PNG"胶囊按钮
            string label = "⬇ 导出 PNG";
            using (var f = Theme.Font(Theme.FontMeta, FontStyle.Bold))
            {
                SizeF sz = g.MeasureString(label, f);
                int pw = (int)sz.Width + 22;
                int ph = 24;
                _exportPill = new Rectangle(Width - pw - 16, Height - ph - 14, pw, ph);
                using (var p = Theme.RoundRect(_exportPill, ph / 2))
                {
                    Color fill = _hoverExport ? Theme.AccentDark : Theme.Accent;
                    using (var b = new SolidBrush(fill)) g.FillPath(b, p);
                    using (var b = new SolidBrush(Theme.InkInvert))
                        g.DrawString(label, f, b,
                            _exportPill.X + (pw - sz.Width) / 2f,
                            _exportPill.Y + (ph - sz.Height) / 2f - 0.5f);
                }
            }

            // 保存成功后的短暂提示（画在按钮左侧）
            if (_exportMsg != null && DateTime.UtcNow < _exportMsgUntil)
            {
                using (var f = Theme.Font(Theme.FontMeta, FontStyle.Regular))
                using (var b = new SolidBrush(Theme.Success))
                {
                    SizeF msz = g.MeasureString(_exportMsg, f);
                    g.DrawString(_exportMsg, f, b, _exportPill.X - msz.Width - 8,
                        _exportPill.Y + (24 - msz.Height) / 2f);
                }
            }
            else if (_exportMsg != null)
            {
                _exportMsg = null;
            }

            // 窗口外框
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width - 1, Height - 1), Theme.Radius))
            using (var pen = new Pen(Theme.WindowBorder, 1.2f))
                g.DrawPath(pen, p);

            base.OnPaint(e);
        }

        /// <summary>
        /// 词云主体绘制（标题条 + 统计副标题 + 词云 + 空态引导）。
        /// 窗口显示与导出 PNG 共用这一份代码，保证"所见即所得"。
        /// </summary>
        private void RenderContent(Graphics g, int w, int h)
        {
            Theme.EnableSmoothing(g);
            g.FillRectangle(Theme.BrushCanvas, new Rectangle(0, 0, w, h));

            // 顶部渐变标题条
            var head = new Rectangle(0, 0, w, 44);
            using (var b = new LinearGradientBrush(head, Theme.Accent, Theme.Violet, 0f))
            using (var p = Theme.RoundRect(new Rectangle(0, 0, w, 70), Theme.Radius))
            {
                Region old = g.Clip;
                g.SetClip(p);
                g.FillRectangle(b, head);
                g.Clip = old;
            }

            using (var f = Theme.Font(Theme.FontTitle, FontStyle.Bold))
            using (var b = new SolidBrush(Theme.InkInvert))
                g.DrawString("✿ 今日词云", f, b, 16, 11);

            string sub = "今天复制了 " + _todayCount + " 条 · " + _spots.Count + " 个高频词";
            using (var f = Theme.Font(Theme.FontMeta, FontStyle.Regular))
            using (var b = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
                g.DrawString(sub, f, b, w - 30 - g.MeasureString(sub, f).Width, 15);

            // 今日无记录时给引导文案
            if (_spots.Count == 0)
            {
                using (var f = Theme.Font(Theme.FontItem, FontStyle.Regular))
                using (var b = new SolidBrush(Theme.InkFaint))
                {
                    string tip = _todayCount == 0
                        ? "今天还没有复制过内容\n\n去复制点什么，明天的词云会更精彩～"
                        : "内容太少，还形不成词云";
                    g.DrawString(tip, f, b, new RectangleF(0, h / 2f - 40, w, 80),
                        new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center });
                }
                return;
            }

            // 画词云：位置由防重叠布局预先算好，绘制时只叠加轻微正弦漂浮
            int maxWeight = 1;
            foreach (var s in _spots) if (s.Weight > maxWeight) maxWeight = s.Weight;

            for (int i = 0; i < _spots.Count; i++)
            {
                WordSpot s = _spots[i];
                float w01 = (float)s.Weight / maxWeight;
                int fontSize = _fontSizes[i];

                // 正弦漂浮：每词相位不同，慢速摆动 ±3px（幅度小于布局留白，不会撞在一起）
                float ox = (float)Math.Sin(_phase * 0.9f + i * 1.7f) * 3f;
                float oy = (float)Math.Cos(_phase * 0.7f + i * 2.3f) * 3f;
                float x = s.X + ox;
                float y = s.Y + oy;

                Color baseColor = w01 > 0.7f ? Theme.AccentDark : (w01 > 0.4f ? Theme.Accent : Theme.InkSoft);
                Color c = Theme.Blend(baseColor, Theme.Violet, 0.3f * (1f - w01));

                using (var f = Theme.Font(fontSize, w01 > 0.5f ? FontStyle.Bold : FontStyle.Regular))
                {
                    SizeF sz = g.MeasureString(s.Text, f);

                    using (var b = new SolidBrush(Color.FromArgb(205, c.R, c.G, c.B)))
                        g.DrawString(s.Text, f, b, x, y);

                    // 高频词底部画一根淡色小横线，像标签下划线
                    if (w01 > 0.6f)
                    {
                        using (var pen = new Pen(Color.FromArgb(90, c.R, c.G, c.B), 1.6f))
                        {
                            pen.StartCap = LineCap.Round;
                            pen.EndCap = LineCap.Round;
                            g.DrawLine(pen, x + 1, y + sz.Height - 1, x + sz.Width - 1, y + sz.Height - 1);
                        }
                    }
                }
            }
        }

        // ---- 导出 PNG：2x 高清渲染到圆角透明位图，弹保存对话框 ----

        private void ExportPng()
        {
            EnsureLayout();

            const int scale = 2;   // 朋友圈/周报常用高清倍率
            int w = Width, h = Height;

            var bmp = new Bitmap(w * scale, h * scale, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.ScaleTransform(scale, scale);

                // 圆角裁切：导出的 PNG 四角透明，贴到任何背景都自然
                using (var clip = Theme.RoundRect(new Rectangle(0, 0, w, h), Theme.Radius))
                {
                    var old = g.Clip;
                    g.SetClip(clip);
                    RenderContent(g, w, h);
                    g.Clip = old;
                }
            }

            _exporting = true;   // 对话框期间不要被失焦关闭逻辑干掉
            try
            {
                using (var dlg = new SaveFileDialog())
                {
                    dlg.Title = "导出词云图片";
                    dlg.Filter = "PNG 图片|*.png";
                    dlg.FileName = "clipchan-wordcloud-" + DateTime.Now.ToString("yyyy-MM-dd") + ".png";
                    dlg.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);

                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        bmp.Save(dlg.FileName, System.Drawing.Imaging.ImageFormat.Png);
                        _exportMsg = "已保存 ✓";
                        _exportMsgUntil = DateTime.UtcNow.AddSeconds(3);
                    }
                }
            }
            catch (Exception)
            {
                _exportMsg = "保存失败";
                _exportMsgUntil = DateTime.UtcNow.AddSeconds(3);
            }
            finally
            {
                _exporting = false;
                bmp.Dispose();
                Invalidate();
            }
        }

        /// <summary>
        /// 整窗可拖动，但"导出 PNG"按钮区域例外——那里要接收真实点击，
        /// 所以保持 HTCLIENT，其余客户区才转成 HTCAPTION。
        /// </summary>
        protected override void WndProc(ref Message m)
        {
            const int WM_NCHITTEST = 0x84;
            const int HTCAPTION = 2;
            const int HTCLIENT = 1;
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result == HTCLIENT)
                {
                    int lp = m.LParam.ToInt32();
                    Point screen = new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF));
                    Point client = PointToClient(screen);
                    // 按钮命中区不转成标题栏，交给鼠标事件处理点击
                    if (!_exportPill.IsEmpty && _exportPill.Contains(client))
                        return;   // 维持 HTCLIENT
                    m.Result = (IntPtr)HTCAPTION;
                }
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool over = !_exportPill.IsEmpty && _exportPill.Contains(e.Location);
            if (over != _hoverExport)
            {
                _hoverExport = over;
                Cursor = over ? Cursors.Hand : Cursors.Default;
                Invalidate(_exportPill);
            }
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Left && !_exportPill.IsEmpty && _exportPill.Contains(e.Location))
                ExportPng();
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            _everActivated = true;
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            _layoutDone = false;   // 尺寸变化后重新排版
            Invalidate();
        }

        /// <summary>
        /// 防重叠布局：按权重从大到小依次放置，每个词尝试若干候选位置，
        /// 选第一个不与已放置词相交的位置。这样词云是"排出来的"，不是随机撒的。
        /// </summary>
        private void EnsureLayout()
        {
            if (_layoutDone || _spots.Count == 0) return;
            _layoutDone = true;

            int maxWeight = 1;
            foreach (var s in _spots) if (s.Weight > maxWeight) maxWeight = s.Weight;

            _fontSizes = new int[_spots.Count];
            var placed = new List<RectangleF>();
            int left = 18, right = Width - 18, top = 56, bottom = Height - 34;
            if (right <= left || bottom <= top) return;

            // 轻微正扰动，避免每次重排看起来都一模一样，但保持确定性
            var rnd = new Random(1337);

            for (int i = 0; i < _spots.Count; i++)
            {
                WordSpot s = _spots[i];
                float w01 = (float)s.Weight / maxWeight;
                int fontSize = 11 + (int)(w01 * 14);
                if (fontSize > 24) fontSize = 24;
                _fontSizes[i] = fontSize;

                // 用与绘制一致的字体测量，保证布局尺寸 == 实际绘制尺寸
                SizeF sz;
                using (var f = Theme.Font(fontSize, w01 > 0.5f ? FontStyle.Bold : FontStyle.Regular))
                using (var bmp = new Bitmap(1, 1))
                using (var mg = Graphics.FromImage(bmp))
                {
                    mg.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                    sz = mg.MeasureString(s.Text, f);
                }

                float bw = sz.Width + 10;   // 留白，漂浮摆动不会撞车
                float bh = sz.Height + 6;

                // 保证单词本身放得进画布，否则会被裁剪
                if (bw > right - left) bw = right - left;
                if (bh > bottom - top) bh = bottom - top;

                // 权重越高越靠中心：从中心螺旋向外找空位
                float cx = (left + right) / 2f;
                float cy = (top + bottom) / 2f;
                float bestX = -1, bestY = -1;

                for (int attempt = 0; attempt < 1200; attempt++)
                {
                    // 阿基米德螺旋：半径线性增长、角度连续推进，
                    // 比纯随机撒点更快填满画布，也不会在中心堆成一团。
                    double angle = attempt * 0.55;
                    double radius = (1.0 - w01) * 14 + attempt * 1.6;
                    float px = cx + (float)(Math.Cos(angle) * radius * 1.35) - bw / 2f;
                    float py = cy + (float)(Math.Sin(angle) * radius * 0.85) - bh / 2f;

                    if (px < left || py < top || px + bw > right || py + bh > bottom) continue;

                    var rect = new RectangleF(px, py, bw, bh);
                    bool hit = false;
                    foreach (RectangleF r in placed)
                    {
                        if (r.IntersectsWith(rect)) { hit = true; break; }
                    }
                    if (!hit) { bestX = px; bestY = py; break; }
                }

                // 极端拥挤时退化为按面积比例找最空的格子，至少保证画出内容
                if (bestX < 0)
                {
                    float bestGap = -1;
                    for (int gx = 0; gx < 12; gx++)
                    {
                        for (int gy = 0; gy < 14; gy++)
                        {
                            float px = left + (right - left - bw) * gx / 11f;
                            float py = top + (bottom - top - bh) * gy / 13f;
                            var rect = new RectangleF(px, py, bw, bh);
                            float gap = float.MaxValue;
                            foreach (RectangleF r in placed)
                            {
                                float dx = Math.Max(0, Math.Max(r.Left - rect.Right, rect.Left - r.Right));
                                float dy = Math.Max(0, Math.Max(r.Top - rect.Bottom, rect.Top - r.Bottom));
                                float d = dx * dx + dy * dy;
                                if (d < gap) gap = d;
                            }
                            if (placed.Count == 0) gap = 1;
                            // 越靠中心越优先（加权），避免角落被先占满
                            float centerBias = 1f - 0.35f * Math.Min(1f,
                                (float)Math.Sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) / Math.Max(1, right - left));
                            gap *= centerBias;
                            if (gap > bestGap) { bestGap = gap; bestX = px; bestY = py; }
                        }
                    }
                    bestX = Math.Max(left, Math.Min(bestX, right - bw));
                    bestY = Math.Max(top, Math.Min(bestY, bottom - bh));
                }

                placed.Add(new RectangleF(bestX, bestY, bw, bh));
                _spots[i] = new WordSpot { Text = s.Text, Weight = s.Weight, X = bestX, Y = bestY };
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            if (_floatTimer != null) { _floatTimer.Stop(); _floatTimer.Dispose(); }
        }
    }
}
