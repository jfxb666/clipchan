using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>无边框、圆角、二次元风格的主面板。</summary>
    internal sealed class MainForm : Form
    {
        private readonly Store _store;
        private readonly Settings _settings;
        private readonly HotkeyWindow _msg;
        private readonly NotifyIcon _tray;

        private readonly TextBox _search;
        private readonly Label _emptyState;
        private readonly ListBox _list;
        private readonly Timer _fade;
        private readonly Label _hint;
        private readonly SlimScrollBar _scroll;
        private readonly Panel _listHost;
        private int _hoverIndex = -1;
        private int _lastSelectedIdx = -1;
        /// <summary>用户上次调整过的面板尺寸（Size.Empty 表示尚未调整过）。</summary>
        private Size _userSize = Size.Empty;
        /// <summary>控件是否已全部创建完毕；未就绪时布局方法直接返回。</summary>
        private bool _layoutReady;


        private List<ClipItem> _view = new List<ClipItem>();
        private bool _closingForReal;
        private DateTime _shownUtc;   // 面板最近一次被唤出的时刻
        private IntPtr _preWindow;    // 唤出面板前用户所在窗口，Enter 自动粘贴的回填目标
        private Timer _pasteTimer;    // 隐藏面板后归位+发键的一次性定时器
        private bool _paused;
        private Timer _ghostTimer;   // 幽灵模式到期检查
        private bool _autoStart;

        // ---- 连续复制（burst）检测：短时间内多次复制 → 提示可一键拼接 ----
        private const int BurstWindowMs = 2000;   // 两次复制间隔 ≤2s 算同一串
        private const int BurstHintAt = 3;        // 攒到 3 条才提示，避免打扰
        private readonly List<string> _burstIds = new List<string>();
        private DateTime _lastCopyUtc = DateTime.MinValue;
        private bool _burstHinted;

        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppName = "Clipchan";
        private const int WM_SETTINGCHANGE = 0x1A;

        public MainForm(Store store)
        {
            _store = store;
            _settings = Settings.Load();

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(430, 560);
            BackColor = Theme.Canvas;
            DoubleBuffered = true;
            KeyPreview = true;
            Text = "Clipchan";

            // 允许鼠标在客户区边缘拖拽缩放
            SetStyle(ControlStyles.ResizeRedraw, true);

            // 记住用户调整后的尺寸
            MinimumSize = new Size(320, 300);
            MaximumSize = new Size(900, 1200);

            var title = new Label();
            title.Text = "  ✿ 剪贴板酱";
            title.Font = Theme.Font(Theme.FontTitle, FontStyle.Bold);
            title.ForeColor = Theme.InkInvert;
            title.BackColor = Color.Transparent;
            title.AutoSize = false;
            title.Height = 36;
            title.Dock = DockStyle.Top;
            title.MouseDown += DragMove;

            _search = new TextBox();
            _search.BorderStyle = BorderStyle.None;
            _search.Font = Theme.Font(9.5f, FontStyle.Regular);
            _search.ForeColor = Theme.Ink;
            _search.BackColor = Theme.Field;
            _search.SetBounds(18, 46, 384, 22);
            _search.TextChanged += delegate
            {
                RefreshView();
            };
            _search.KeyDown += SearchKeyDown;

            _list = new ListBox();
            _list.BorderStyle = BorderStyle.None;
            _list.DrawMode = DrawMode.OwnerDrawFixed;
            _list.ItemHeight = Theme.ItemHeight;
            _list.IntegralHeight = false;
            _list.BackColor = Theme.Canvas;
            // 多选：Ctrl/Shift 可选中多条，配合 Ctrl+M 拼接成一条
            _list.SelectionMode = SelectionMode.MultiExtended;
            // 去掉 ListBox 自带的系统滚动条：它会常驻占掉约 17px 客户区，
            // 且 ScrollAlwaysVisible=false 无法移除。改用 Win32 样式位处理。
            _list.HorizontalScrollbar = false;
            _list.ScrollAlwaysVisible = false;
            // 说明：ListBox 会依据内容自行维护 WS_VSCROLL 样式，用 SetWindowLong
            // 移除后会被它重新加回，且系统滚动条常驻占用约 17px 客户区。
            // 因此这里不再尝试移除，而是把列表宽度外扩 17px，
            // 让系统滚动条落在窗体可视区之外，再由 SlimScrollBar 接管视觉指示。
            // 隐藏 ListBox 自带的系统滚动条（由自定义 SlimScrollBar 负责视觉指示）
            _list.HorizontalScrollbar = false;
            _list.ScrollAlwaysVisible = false;
            _list.Font = Theme.Font(9.5f, FontStyle.Regular);
            // 列表右边界外扩 17px，把 ListBox 自带的系统滚动条推出可视区
            // 列表放在容器里：容器宽 392 负责裁剪，列表再宽 17px，
            // 让 ListBox 自带的系统滚动条被容器裁掉，只留客户区可见。
            _listHost = new Panel();
            _listHost.BackColor = Theme.Canvas;
            _listHost.Controls.Add(_list);
            _list.DrawItem += DrawItem_;
            _list.MouseMove += ListMouseMove;
            _list.MouseWheel += delegate
            {
                if (_scroll != null && _scroll.Visible)
                    _scroll.Value = _list.TopIndex;
            };
            _list.KeyUp += delegate
            {
                if (_scroll != null && _scroll.Visible)
                    _scroll.Value = _list.TopIndex;
            };
            _list.MouseLeave += delegate
            {
                if (_hoverIndex >= 0) _list.Invalidate(_list.GetItemRectangle(_hoverIndex));
                _hoverIndex = -1;
            };
            _list.DoubleClick += delegate { Commit(); };
            _list.KeyDown += ListKeyDown;
            _list.SelectedIndexChanged += delegate
            {
                // 只重绘新旧两行，避免全表 Invalid 造成的闪烁
                int prevIdx = _lastSelectedIdx;
                int curIdx = _list.SelectedIndex;
                _lastSelectedIdx = curIdx;
                if (prevIdx >= 0 && prevIdx < _list.Items.Count) _list.Invalidate(_list.GetItemRectangle(prevIdx));
                if (curIdx >= 0 && curIdx < _list.Items.Count) _list.Invalidate(_list.GetItemRectangle(curIdx));
                if (_scroll != null && _scroll.Visible)
                    _scroll.Value = _list.TopIndex;
                // 多选状态下更新底部提示（"已选 N 条 / Ctrl+M 拼接"）
                UpdateHint();
            };

            _hint = new Label();
            _hint.Font = Theme.Font(8f, FontStyle.Regular);
            _hint.ForeColor = Theme.InkSoft;
            _hint.BackColor = Color.Transparent;
            _hint.AutoSize = false;

            _scroll = new SlimScrollBar();
            _scroll.Visible = false;

            _emptyState = new Label();
            _emptyState.Text = "还没有记录，复制点什么吧～";
            _emptyState.Font = Theme.Font(9.5f, FontStyle.Regular);
            _emptyState.ForeColor = Theme.InkSoft;
            // 不能用 Transparent：标签叠加在列表容器之上时不会正确合成，
            // 直接用与窗体一致的底色（视觉上等价，且必定可见）
            _emptyState.BackColor = Theme.Canvas;
            _emptyState.AutoSize = false;
            _emptyState.TextAlign = ContentAlignment.MiddleCenter;
            _emptyState.Visible = false;

            // z-order 说明：后 Add 的控件位于更底层，
            // 因此把需要浮在列表之上的控件放到最后添加。
            Controls.Add(_hint);
            Controls.Add(title);
            Controls.Add(_search);
            Controls.Add(_listHost);
            Controls.Add(_scroll);
            Controls.Add(_emptyState);

            _msg = new HotkeyWindow(this);
            _msg.ClipboardChanged += OnClipboardChanged;
            _msg.HotkeyPressed += delegate { Toggle(); };

            _tray = new NotifyIcon();
            _tray.Icon = Assets.TrayIcon();
            _tray.Text = "\u526A\u8D34\u677F\u9171 - \u526A\u8D34\u677F\u5386\u53F2";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { Toggle(); };
            _tray.ContextMenuStrip = BuildMenu();

            _fade = new Timer();
            _fade.Interval = 15;
            _fade.Tick += FadeTick;

            // 幽灵模式到期检查：每 15 秒对一次表，到点自动恢复常态
            _ghostTimer = new Timer();
            _ghostTimer.Interval = 15000;
            _ghostTimer.Tick += delegate { UpdateGhostUi(); };
            _ghostTimer.Start();

            ApplyRoundRegion();

            // 触发句柄创建后再布局，确保尺寸计算基于真实客户区
            IntPtr force = _list.Handle;
            GC.KeepAlive(force);

            // 占位符改用系统原生 cue banner（由编辑控件自绘，暗色下无叠层接缝）
            NativeMethods.SetCueBanner(_search.Handle, "搜索历史…");

            _layoutReady = true;   // 控件齐备，允许布局
            LayoutControls();
            RefreshView();

            // 先订阅主题切换，再应用已保存的模式——否则构造期这次切换没人响应，
            // 搜索框等原生控件底色会停留在默认亮色（暗色主题下露白底）。
            Theme.Changed += OnThemeChanged;
            Theme.SetMode(_settings.ThemeMode);
        }

        /// <summary>
        /// 主题切换：把依赖调色板的控件底色重新赋值并整体重绘。
        /// 自绘区域（标题栏/卡片/搜索框）由 OnPaint 读实时令牌自动跟随，
        /// 这里只需处理非自绘控件（TextBox 等不会重绘自己背景的）。
        /// </summary>
        private void OnThemeChanged()
        {
            if (IsDisposed) return;
            try
            {
                _search.BackColor = Theme.Field;
                _search.ForeColor = Theme.Ink;
                _list.BackColor = Theme.Canvas;
                _listHost.BackColor = Theme.Canvas;
                _emptyState.BackColor = Theme.Canvas;
                _hint.ForeColor = Theme.InkSoft;
                Assets.Invalidate();
                if (IsHandleCreated) BeginInvoke(new Action(delegate { Invalidate(true); }));
                else Invalidate(true);
            }
            catch (Exception) { }
        }

        public void StartUp()
        {
            _msg.StartListening();

            if (!_msg.ApplyHotkey(_settings))
            {
                _tray.BalloonTipTitle = "\u70ED\u952E\u6CE8\u518C\u5931\u8D25";
                _tray.BalloonTipText = _settings.Label +
                    " \u5DF2\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF0C\u8BF7\u5728\u6258\u76D8\u83DC\u5355\u91CC\u91CD\u65B0\u8BBE\u7F6E\u3002";
                _tray.ShowBalloonTip(5000);
            }

            SyncAutoStartState();
        }

        private void ApplyRoundRegion()
        {
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width, Height), Theme.Radius))
                Region = new Region(p);
        }

        private void DragMove(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                NativeMethods.ReleaseCapture();
                NativeMethods.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.EnableSmoothing(g);
            g.FillRectangle(Theme.BrushCanvas, ClientRectangle);

            // 标题栏：渐变 + 卡片圆角裁切；幽灵模式下切换为暗色系，提示用户"已屏蔽"
            bool ghost = _settings.IsGhostMode;
            var head = new Rectangle(0, 0, Width, 36);
            using (var b = new LinearGradientBrush(head,
                ghost ? Theme.GhostHeadA : Theme.Accent,
                ghost ? Theme.GhostHeadB : Theme.Violet, 0f))
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width, 64), Theme.Radius))
            {
                Region old = g.Clip;
                g.SetClip(p);
                g.FillRectangle(b, head);
                g.Clip = old;
            }

            // 搜索框：比卡片还淡的玫瑰色底 + 聚焦时主色双描边
            var searchBox = new Rectangle(Theme.PadBase - 2, 44,
                Math.Max(60, ClientSize.Width - (Theme.PadBase - 2) * 2), 30);
            bool searching = _search.Focused || !string.IsNullOrEmpty(_search.Text);
            using (var b = new SolidBrush(Theme.Field))
            using (var p = Theme.RoundRect(searchBox, Theme.RadiusField))
            {
                g.FillPath(b, p);
                using (var pen = new Pen(searching ? Theme.Accent : Theme.Line, searching ? 1.6f : 1f))
                    g.DrawPath(pen, p);
            }

            // 标题栏右侧：条数徽章（胶囊形）
            string badgeText = _view.Count.ToString();
            int bw;
            using (var f = Theme.Font(Theme.FontBadge, FontStyle.Bold))
            {
                SizeF sz = g.MeasureString(badgeText, f);
                bw = (int)sz.Width + 14;
                var badge = new Rectangle(Width - bw - 14, 9, bw, 17);
                using (var p = Theme.RoundRect(badge, 8))
                using (var b = new SolidBrush(Color.FromArgb(56, 255, 255, 255)))
                    g.FillPath(b, p);
                using (var b = new SolidBrush(Theme.InkInvert))
                    g.DrawString(badgeText, f, b,
                        badge.X + (bw - sz.Width) / 2f, badge.Y + (17 - sz.Height) / 2f - 0.5f);
            }

            // 幽灵状态胶囊：置于条数徽章左侧，明确告知"当前复制不会被记录"
            if (ghost)
            {
                using (var f = Theme.Font(Theme.FontMeta, FontStyle.Bold))
                {
                    string ghostText = "幽灵模式";
                    SizeF sz = g.MeasureString(ghostText, f);
                    int gw = (int)sz.Width + 16;
                    var gpill = new Rectangle(Width - gw - 14 - bw - 8, 9, gw, 17);
                    using (var p = Theme.RoundRect(gpill, 8))
                    using (var b = new SolidBrush(Theme.GhostPill))
                        g.FillPath(b, p);
                    using (var b = new SolidBrush(Theme.InkInvert))
                        g.DrawString(ghostText, f, b,
                            gpill.X + (gw - sz.Width) / 2f, gpill.Y + (17 - sz.Height) / 2f - 0.5f);
                }
            }

            // 右下角缩放抓手：轻若无物的斜线提示
            using (var pen = new Pen(Color.FromArgb(120, Theme.AccentDark.R, Theme.AccentDark.G, Theme.AccentDark.B), 1.3f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                for (int i = 0; i < 3; i++)
                {
                    int off = 3 + i * 5;
                    g.DrawLine(pen, Width - off - 11, Height - 7, Width - 7, Height - off - 11);
                }
            }

            // 左下角 Q 版头像，与底部提示文字对齐
            using (Image chan = Assets.Chan(36))
                if (chan != null) g.DrawImage(chan, 16, Height - 50, 36, 36);

            // 窗口整体外框：半透明白 + 底层微描边，强化无边框窗口的边界感
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width - 1, Height - 1), Theme.Radius))
            {
                using (var pen = new Pen(Theme.WindowBorder, 1.2f))
                    g.DrawPath(pen, p);
            }

            base.OnPaint(e);
        }

        /// <summary>列表为空时的引导文案。必须画在列表自身，否则会被列表控件覆盖。</summary>
        private void DrawItem_(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= _view.Count) return;
            ClipItem it = _view[e.Index];
            Graphics g = e.Graphics;
            Theme.EnableSmoothing(g);

            bool sel = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
            bool hover = (e.Index == _hoverIndex) && !sel;

            // 卡片：左右各 6px 内缩，上下各间距 4px，保证疏朗节奏
            var card = new Rectangle(e.Bounds.X + 6, e.Bounds.Y + 4,
                                     e.Bounds.Width - 12, e.Bounds.Height - 8);

            // ---------- 卡片底色与描边：三态分明 ----------
            Color fill, border;
            if (sel)
            {
                fill = Theme.SelectFill;         // 淡粉填充，不破坏可读性
                border = Theme.Accent;           // 1.5px 主色描边 = 选中
            }
            else if (it.Pinned)
            {
                fill = Theme.Blend(Theme.Card, Theme.AccentSoft, 0.5f);
                border = Color.FromArgb(80, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B);
            }
            else
            {
                fill = hover ? Theme.HoverFill : Theme.Card;
                border = hover ? Color.FromArgb(100, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B) : Theme.Line;
            }
            Theme.DrawCard(g, card, fill, border, sel ? Theme.RadiusCard : Theme.RadiusCard);

            // 选中态左侧语义指示条：类似任务管理器/IDE 左侧的蓝条，但改成粉
            if (sel || hover)
            {
                var indicator = new Rectangle(card.X + 3, card.Y + 10, 3, card.Height - 20);
                using (var path = Theme.RoundRect(indicator, 2))
                using (var b = new SolidBrush(sel ? Theme.Accent : Color.FromArgb(160, Theme.Accent.R, Theme.Accent.G, Theme.Accent.B)))
                    g.FillPath(b, path);
            }

            // ---------- 文字层级 ----------
            Color fg = sel ? Theme.Blend(Theme.AccentDark, Color.Black, 0.15f) : Theme.Ink;
            Color fgSoft = sel ? Color.FromArgb(200, Theme.Blend(Theme.AccentDark, Theme.InkSoft, 0.5f)) : Theme.InkSoft;

            // 左侧类型徽标
            ClipKind kind = ClipClassifier.Classify(it.Text);
            var badge = new Rectangle(card.X + 12, card.Y + (card.Height - 30) / 2, 30, 30);
            KindIcon.Draw(g, kind, badge, sel);

            int textLeft = badge.Right + 12;
            int rightPad = it.Pinned ? 24 : 10;
            int avail = card.Right - rightPad - textLeft;

            // 正文：加粗一档 + 加大字号，避免旧版与元信息一样重
            int previewLen = Math.Max(10, avail / 10);
            using (var f = Theme.Font(Theme.FontItem, FontStyle.Bold))
            using (var b = new SolidBrush(fg))
                g.DrawString(it.Preview(previewLen), f, b, textLeft, card.Y + 5);

            // 次要信息：相对时间 + 字符数 + 截断标记
            string meta = it.TimeText;
            int charCount = it.Text == null ? 0 : it.Text.Length;
            if (charCount > 0) meta += "  ·  " + charCount + " 字符";
            if (it.Truncated) meta += "  ·  已截断";
            using (var f = Theme.Font(Theme.FontMeta, FontStyle.Regular))
            using (var b = new SolidBrush(fgSoft))
                g.DrawString(meta, f, b, textLeft, card.Y + 24);

            // 收藏星标：金色，置顶闪一点
            if (it.Pinned)
                Theme.DrawStar(g, card.Right - 17, card.Y + 13, 6.5f,
                    sel ? Theme.Blend(Theme.Gold, Color.White, 0.5f) : Theme.Gold);
        }

        /// <summary>跟踪鼠标悬停的列表项，用于高亮反馈。</summary>
        private void ListMouseMove(object sender, MouseEventArgs e)
        {
            int idx = _list.IndexFromPoint(e.Location);
            if (idx == _hoverIndex) return;
            InvalidateItem(e, _hoverIndex);   // 只重绘离开的那一行
            InvalidateItem(e, idx);           // 只重绘进入的那一行
            _hoverIndex = idx;
        }

        /// <summary>悬停/选择变化只重绘局部区域。</summary>
        private void InvalidateItem(MouseEventArgs e, int index)
        {
            if (index < 0 || index >= _list.Items.Count) return;
            _list.Invalidate(_list.GetItemRectangle(index));
        }

        private void RefreshView()
        {
            string q = _search.Text.Trim();
            List<ClipItem> all = _store.Ordered();
            var filtered = new List<ClipItem>();

            foreach (ClipItem it in all)
            {
                if (q.Length == 0 ||
                    (it.Text != null && it.Text.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0))
                    filtered.Add(it);
            }

            _view = filtered;
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (ClipItem it in _view) _list.Items.Add(it);
            _list.EndUpdate();
            _list.Invalidate();   // 强制重绘，否则空状态引导文案不会出现

            // 滚动条：条目超出可见范围才显示
            if (_scroll != null)
            {
                int visible = Math.Max(1, _list.ClientSize.Height / Math.Max(1, _list.ItemHeight));
                int total = _view.Count;
                bool need = total > visible;
                _scroll.Visible = need;
                if (need)
                {
                    _scroll.LargeChange = visible;
                    _scroll.Maximum = Math.Max(1, total - visible);
                    _scroll.Value = Math.Min(_list.TopIndex, _scroll.Maximum);
                    _scroll.BringToFront();
                }
            }

            if (_list.Items.Count > 0) _list.SelectedIndex = 0;

            // 空状态引导：ListBox 在无 item 时不发 WM_PAINT，所以用独立 Label 叠加显示
            if (_emptyState != null)
            {
                _emptyState.Visible = _view.Count == 0;
                _emptyState.Text = _search.TextLength > 0
                    ? "\u6CA1\u6709\u5339\u914D\u7684\u8BB0\u5F55"
                    : "\u8FD8\u6CA1\u6709\u8BB0\u5F55\uFF0C\u590D\u5236\u70B9\u4EC0\u4E48\u5427\uFF5E";
                _emptyState.BringToFront();
            }

            UpdateHint();
        }

        /// <summary>
        /// 底部状态栏文案。三种状态按优先级：
        /// 幽灵模式 > 多选提示 > 常规操作提示。
        /// </summary>
        private void UpdateHint()
        {
            if (_hint == null || !_layoutReady) return;

            // 1) 幽灵模式：最高优先级，明确告知"现在复制不会被记录"
            if (_settings.IsGhostMode)
            {
                int left = (int)Math.Ceiling((_settings.GhostUntilUtc - DateTime.UtcNow).TotalMinutes);
                if (left < 1) left = 1;
                _hint.Text = "\u5E7D\u7075\u6A21\u5F0F\u4E2D \u00B7 \u590D\u5236\u4E0D\u4F1A\u88AB\u8BB0\u5F55 \u00B7 \u5269\u4F59 " + left + " \u5206\u949F";
                _hint.ForeColor = Theme.InkSoft;
                return;
            }

            // 2) 多选：把"能拼接"这个隐藏能力显式暴露出来
            int selCount = _list == null ? 0 : _list.SelectedIndices.Count;
            if (selCount > 1)
            {
                _hint.Text = "\u5DF2\u9009 " + selCount + " \u6761  |  Ctrl+M \u62FC\u63A5\u6210\u4E00\u6761   Del \u6279\u91CF\u5220\u9664   Esc \u53D6\u6D88";
                _hint.ForeColor = Theme.AccentDark;
                return;
            }

            // 3) 常规
            _hint.Text = string.Format("{0} \u6761  |  {1}  |  Enter \u590D\u5236   Ctrl+D \u6536\u85CF   Ctrl+M \u62FC\u63A5   Del \u5220\u9664",
                _view.Count, _msg.HotkeyLabel);
            _hint.ForeColor = Theme.InkSoft;
        }

        private ClipItem Selected()
        {
            int i = _list.SelectedIndex;
            if (i < 0 || i >= _view.Count) return null;
            return _view[i];
        }

        private void OnClipboardChanged(object sender, EventArgs e)
        {
            if (_paused) return;
            if (_settings.IsGhostMode) { UpdateGhostUi(); return; }   // 幽灵模式：只拦截，不打扰
            string text = ClipboardReader.TryGetText();
            if (text == null) return;
            string affectedId;
            if (_store.Add(text, out affectedId))
            {
                TrackBurst(affectedId);
                RefreshView();
            }
        }

        /// <summary>
        /// 连续复制检测：两次复制间隔 ≤2s 视为"同一串"。攒满 3 条时——
        /// 面板开着就直接帮你选好（底部提示变 Ctrl+M 拼接）；
        /// 面板没开则弹一次气球告知"唤出后已选好"。每串只提示一次，不打扰。
        /// </summary>
        private void TrackBurst(string id)
        {
            if (string.IsNullOrEmpty(id)) return;

            DateTime now = DateTime.UtcNow;
            if ((now - _lastCopyUtc).TotalMilliseconds > BurstWindowMs)
            {
                _burstIds.Clear();
                _burstHinted = false;
            }
            _lastCopyUtc = now;

            if (!_burstIds.Contains(id)) _burstIds.Add(id);
            if (_burstIds.Count < BurstHintAt) return;

            if (Visible)
            {
                ApplyBurstSelection();
                _burstHinted = true;
            }
            else if (!_burstHinted)
            {
                _burstHinted = true;
                _tray.BalloonTipTitle = "已连续复制 " + _burstIds.Count + " 条";
                _tray.BalloonTipText = "唤出面板后已自动选好，按 Ctrl+M 可拼接成一条。";
                _tray.ShowBalloonTip(3000);
            }
        }

        /// <summary>把 burst 串里的条目在列表中预选中（收藏项与已消失的条目自动跳过）。</summary>
        private void ApplyBurstSelection()
        {
            if (_burstIds.Count < 2 || !_layoutReady) return;

            _list.BeginUpdate();
            try
            {
                _list.SelectedIndices.Clear();
                foreach (string id in _burstIds)
                {
                    for (int i = 0; i < _view.Count; i++)
                    {
                        if (_view[i].Id != id || _view[i].Pinned) continue;
                        if (!_list.SelectedIndices.Contains(i)) _list.SelectedIndices.Add(i);
                        break;
                    }
                }
            }
            finally { _list.EndUpdate(); }

            _lastSelectedIdx = _list.SelectedIndex;
            UpdateHint();
        }

        /// <summary>
        /// 进入幽灵模式：接下来 N 分钟内复制的内容不写入历史。
        /// 托盘菜单与 --ghost 启动参数共用这一条路径，保证行为一致。
        /// </summary>
        public void EnterGhostMode(int minutes)
        {
            if (minutes <= 0) minutes = 10;
            _settings.GhostUntilUtc = DateTime.UtcNow.AddMinutes(minutes);
            UpdateGhostUi();
            RefreshView();

            _tray.BalloonTipTitle = "\u5DF2\u8FDB\u5165\u5E7D\u7075\u6A21\u5F0F";
            _tray.BalloonTipText = "\u63A5\u4E0B\u6765 " + minutes + " \u5206\u949F\u7684\u590D\u5236\u5185\u5BB9\u4E0D\u4F1A\u88AB\u8BB0\u5F55";
            _tray.ShowBalloonTip(3000);
        }

        /// <summary>退出幽灵模式，恢复记录。</summary>
        public void ExitGhostMode()
        {
            _settings.GhostUntilUtc = DateTime.MinValue;
            UpdateGhostUi();
            RefreshView();
        }

        /// <summary>同步幽灵模式的托盘/面板视觉状态；模式自然到期后恢复常态。</summary>
        private void UpdateGhostUi()
        {
            bool ghost = _settings.IsGhostMode;
            _tray.Text = ghost ? "\u526A\u8D34\u677F\u9171 - \u5E7D\u7075\u6A21\u5F0F" : "\u526A\u8D34\u677F\u9171 - \u526A\u8D34\u677F\u5386\u53F2";
            if (!ghost && _ghostTimer != null) { _ghostTimer.Stop(); }
            Invalidate();   // 标题栏需要重绘（幽灵态画暗色主题）
        }

        /// <summary>
        /// 窗体级快捷键：在控件收到按键前先拦截，保证焦点在搜索框时
        /// Ctrl+M（拼接）/ Ctrl+D（收藏）同样生效——burst 预选后焦点仍在搜索框，
        /// 若只挂在列表上，用户会看到"已选好"却按了没反应。
        /// Ctrl+Delete 不在此处理：搜索框里它是"删到词尾"的文本编辑操作。
        /// </summary>
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == (Keys.Control | Keys.M))
            {
                MergeSelected();
                return true;
            }
            if (keyData == (Keys.Control | Keys.D))
            {
                ClipItem it = Selected();
                if (it != null) { _store.TogglePin(it.Id); RefreshView(); }
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        private void SearchKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Down || e.KeyCode == Keys.Up)
            {
                _list.Focus();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Enter)
            {
                Commit();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Escape)
            {
                Hide();
                e.Handled = true;
            }
        }

        private void ListKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { Commit(); e.Handled = true; }
            else if (e.KeyCode == Keys.Escape) { Hide(); e.Handled = true; }
            else if (e.KeyCode == Keys.M && e.Control)
            {
                MergeSelected();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Delete)
            {
                if (e.Control)
                {
                    ClearAll();
                }
                else
                {
                    // 支持多选批量删除
                    List<ClipItem> sel = SelectedItems();
                    if (sel.Count > 1)
                    {
                        var ids = new List<string>();
                        foreach (ClipItem s in sel) ids.Add(s.Id);
                        _store.RemoveMany(ids);
                        RefreshView();
                    }
                    else
                    {
                        ClipItem it = Selected();
                        if (it != null) { _store.Remove(it.Id); RefreshView(); }
                    }
                }
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.D && e.Control)
            {
                ClipItem it = Selected();
                if (it != null) { _store.TogglePin(it.Id); RefreshView(); }
                e.Handled = true;
            }
        }

        /// <summary>当前选中的条目，按列表显示顺序返回（多选时用于拼接）。</summary>
        private List<ClipItem> SelectedItems()
        {
            var result = new List<ClipItem>();
            foreach (int i in _list.SelectedIndices)
                if (i >= 0 && i < _view.Count) result.Add(_view[i]);
            return result;
        }

        /// <summary>
        /// 「拼接」：把选中的多条记录按列表顺序合并成一条新记录，
        /// 并把当前面板焦点落到合并结果上，方便直接 Enter 复制。
        /// </summary>
        private void MergeSelected()
        {
            List<ClipItem> sel = SelectedItems();
            if (sel.Count < 2)
            {
                _tray.BalloonTipTitle = "拼接需要至少 2 条";
                _tray.BalloonTipText = "按住 Ctrl 或 Shift 在列表里多选几条，再按 Ctrl+M。";
                _tray.ShowBalloonTip(2500);
                return;
            }

            // 收藏项不参与拼接（避免把置顶内容意外合并掉）
            var texts = new List<string>();
            var ids = new List<string>();
            foreach (ClipItem it in sel)
            {
                if (it.Pinned) continue;
                texts.Add(it.Text ?? string.Empty);
                ids.Add(it.Id);
            }

            if (texts.Count < 2)
            {
                _tray.BalloonTipTitle = "拼接需要至少 2 条未收藏记录";
                _tray.BalloonTipText = "收藏项不会被合并，请换几条试试。";
                _tray.ShowBalloonTip(2500);
                return;
            }

            ClipItem merged = _store.MergeTexts(texts, "\r\n");
            if (merged == null) return;
            _store.RemoveMany(ids);
            _burstIds.Clear();          // 源条目已合并，burst 状态作废
            _burstHinted = false;
            RefreshView();

            // 选中合并结果
            for (int i = 0; i < _view.Count; i++)
            {
                if (_view[i].Id == merged.Id) { _list.SelectedIndex = i; break; }
            }
            _list.Focus();

            _tray.BalloonTipTitle = "已拼接 " + texts.Count + " 条";
            _tray.BalloonTipText = "按 Enter 把拼接结果放入剪贴板。";
            _tray.ShowBalloonTip(2500);
        }

        private void Commit()
        {
            ClipItem it = Selected();
            if (it == null) { Hide(); return; }

            try
            {
                _msg.SuppressNext();
                Clipboard.SetText(it.Text);
                // 走 Store 的 Touch：同时刷新时间与序号，保证"刚复制过的"稳定排在第一
                _store.Touch(it.Id);
            }
            catch (Exception) { Hide(); return; }

            bool attempt = PastePolicy.ShouldAttemptAutoPaste(_settings.AutoPaste, _preWindow, Handle);
            if (attempt)
            {
                // 自动粘贴是一次性动作：本次唤出的目标用完即弃，
                // 防止陈旧句柄（HWND 会被系统回收复用）在下次 Enter 时粘进陌生窗口
                IntPtr back = _preWindow;
                _preWindow = IntPtr.Zero;
                Hide();
                StartPasteReturn(back);   // 归位 + 验证 + 发键；失败回退提示
                return;
            }

            ShowCopiedHint();
            Hide();
        }

        /// <summary>回退提示：内容在剪贴板，请手动粘贴。Commit 与粘贴管线共用一份文案。</summary>
        private void ShowCopiedHint()
        {
            _tray.BalloonTipTitle = "\u5DF2\u590D\u5236";
            _tray.BalloonTipText = "\u5185\u5BB9\u5DF2\u653E\u5165\u526A\u8D34\u677F\uFF0C\u6309 Ctrl+V \u7C98\u8D34\u3002";
            _tray.ShowBalloonTip(1200);
        }

        /// <summary>
        /// 隐藏面板后把焦点归还原窗口，逐项验证通过才发送 Ctrl+V；
        /// 任何一步不满足（窗口关了/最小化/无输入落点/归位失败/前台又被抢）
        /// 都回退为"已复制请粘贴"——验证不通过一律回退，不盲发按键。
        /// </summary>
        private void StartPasteReturn(IntPtr back)
        {
            if (_pasteTimer == null)
            {
                _pasteTimer = new Timer();
                _pasteTimer.Tick += PasteReturnTick;
            }
            _pasteBack = back;
            _pasteRetries = 0;
            _pasteTimer.Interval = 80;
            _pasteTimer.Stop();
            _pasteTimer.Start();
        }

        private IntPtr _pasteBack;   // 本次自动粘贴的归位目标（与 _preWindow 分离：前者用完即清，后者记录唤出前的窗口）
        private int _pasteRetries;   // 焦点交接的宽限重试计数（80ms 一档，最多 4 档）

        private void PasteReturnTick(object sender, EventArgs e)
        {
            IntPtr target = _pasteBack;

            // 诊断埋点：设 CLIPCHAN_TRACE 时把每一层判定打到临时文件
            if (Environment.GetEnvironmentVariable("CLIPCHAN_TRACE") != null)
            {
                try
                {
                    System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "clipchan-paste-trace.log"),
                        DateTime.Now.ToString("HH:mm:ss.fff") +
                        " target=" + target +
                        " self=" + Handle +
                        " alive=" + NativeMethods.IsWindow(target) +
                        " vis=" + NativeMethods.IsWindowVisible(target) +
                        " iconic=" + NativeMethods.IsIconic(target) +
                        " fg=" + NativeMethods.GetForegroundWindow() +
                        " focusSink=" + NativeMethods.HasFocusSink(target) +
                        " retry=" + _pasteRetries + "\r\n");
                }
                catch (Exception) { }
            }

            // 第一层：硬失效判定 —— 句柄没了/隐藏/最小化，直接放弃（不还原用户的窗口）
            bool dead = !NativeMethods.IsWindow(target)
                     || !NativeMethods.IsWindowVisible(target)
                     || NativeMethods.IsIconic(target);

            // 第二层：归位尝试 —— 只做"取前台"和"读回确认"，不在这里判死，
            // 因为后台窗口刚置前时焦点落点常常还是空的（这一层判死会把正常粘贴全误杀）
            bool restored = !dead
                         && NativeMethods.SetForegroundWindow(target)
                         && NativeMethods.GetForegroundWindow() == target;

            // 第三层：落点兜底 —— 归位后依然没有任何焦点落点，说明是桌面/shell 空壳面，
            // 发键只会"报告成功却什么都没粘"，诚实回退
            bool hasTarget = restored && NativeMethods.HasFocusSink(target);

            if (PastePolicy.TargetIsPasteReady(!dead, true, NativeMethods.IsIconic(target), restored)
                && PastePolicy.HasPasteTarget(hasTarget))
            {
                _pasteTimer.Stop();
                if (!NativeMethods.SendCtrlV()) ShowCopiedHint();   // 部分投递也算失败，诚实告知
                return;
            }

            // 软失效（前台还没交接完/落点还没建立）：宽限到 ~320ms 再判死
            if (!dead && _pasteRetries < 4)
            {
                _pasteRetries++;
                _pasteTimer.Interval = 80;
                _pasteTimer.Start();
                return;
            }

            _pasteTimer.Stop();
            ShowCopiedHint();
        }


        private void ClearAll()
        {
            if (MessageBox.Show("\u6E05\u7A7A\u6240\u6709\u975E\u6536\u85CF\u8BB0\u5F55\uFF1F", "\u526A\u8D34\u677F\u9171",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
            {
                _store.ClearUnpinned();
                RefreshView();
            }
        }

        public void Toggle()
        {
            if (Visible) Hide();
            else ShowPanel();
        }

        public void ShowPanel()
        {
            _search.Clear();
            RefreshView();
            _search.Focus();

            // 恢复用户上次调整过的尺寸
            if (_userSize != Size.Empty && Size != _userSize)
            {
                Size = _userSize;
                LayoutControls();
            }

            // 刚连续复制过（窗口未过期）→ 唤出即帮你选好，省掉手动多选
            if ((DateTime.UtcNow - _lastCopyUtc).TotalMilliseconds <= BurstWindowMs)
                ApplyBurstSelection();

            Point cursor = Cursor.Position;
            Screen scr = Screen.FromPoint(cursor);
            Location = Theme.ClampToScreen(cursor, Size, scr.WorkingArea);

            // 记录"用户原来在哪个窗口"。面板已在前台时不覆盖（避免托盘二次唤出把 _preWindow 弄丢）。
            IntPtr fg = NativeMethods.GetForegroundWindow();
            if (fg != IntPtr.Zero && fg != Handle) _preWindow = fg;

            _shownUtc = DateTime.UtcNow;   // 记录唤出时刻，用于失焦宽限判断
            Opacity = 0;
            Show();
            Activate();
            BringToFront();
            _fade.Start();
        }

        /// <summary>面板淡入：6 帧内快速显现，比旧版 0.08/帧更利落。</summary>
        private void FadeTick(object sender, EventArgs e)
        {
            if (Opacity >= 1.0) { Opacity = 1.0; _fade.Stop(); return; }
            Opacity = Math.Min(1.0, Opacity + 0.18);
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            if (Visible && !_closingForReal)
            {
                // 测试钩子：设了 CLIPCHAN_KEEP_OPEN 就不随失焦收起，
                // 方便自动化截图验收（正常用户环境不会有这个变量）。
                if (Environment.GetEnvironmentVariable("CLIPCHAN_KEEP_OPEN") != null) return;

                // 失焦宽限：后台唤出时 Win32 前台锁会让 Activate() 失败、
                // 窗口"从未真正激活"随即失焦。给 400ms 宽限，
                // 刚唤出（哪怕没抢到前台）也不立刻收起，
                // 等它淡入完成、被用户看见。
                bool justShown = (DateTime.UtcNow - _shownUtc) < TimeSpan.FromMilliseconds(400);
                if (!justShown)
                {
                    RememberSize();
                    Hide();
                }
            }
        }

        /// <summary>记住当前尺寸（仅在用户确实调整过时）。</summary>
        private void RememberSize()
        {
            if (WindowState == FormWindowState.Normal && Size.Width >= MinimumSize.Width)
                _userSize = Size;
        }

        /// <summary>
        /// 统一布局。所有控件位置都由设计令牌驱动，改 Theme.PadBase/GapElem 等
        /// 常量即可整体调整节奏，无需动业务代码；窗口拖拽缩放后重跑一次即可正确重排。
        /// </summary>
        private void LayoutControls()
        {
            if (!_layoutReady) return;

            int w = ClientSize.Width;
            int h = ClientSize.Height;
            int pad = Theme.PadBase;       // 16px，内容左右留白

            // 搜索框容器（外框由 OnPaint 绘制，这里定位内部输入区）
            int searchContainerTop = 44;   // 与 OnPaint 中的 searchBox.Y 保持一致
            _search.SetBounds(pad + 8, searchContainerTop + 3, w - pad * 2 - 16, 26);

            // 列表区域：起点 = 搜索框底 + 间距；底部为提示栏预留
            int listTop = searchContainerTop + 30 + Theme.GapCard;    // 44+30+8 = 82
            const int listBottomPad = 54;
            int avail = h - listTop - listBottomPad;
            int itemH = Math.Max(1, _list.ItemHeight);
            int listH = Math.Max(itemH, (avail / itemH) * itemH);   // 取整为行高倍数

            int listW = w - pad * 2;
            _listHost.SetBounds(pad, listTop, listW, listH);

            // 让 ListBox 比容器宽 17px：系统滚动条被裁掉，SlimScrollBar 接管视觉指示
            _list.SetBounds(0, 0, listW + 17, listH);

            // 滚动条贴在列表右侧
            _scroll.SetBounds(w - pad - 4, listTop + 2, 5, listH - 4);

            // 空状态覆盖列表区域
            _emptyState.SetBounds(pad, listTop, listW, listH);

            // 底部：头像 + 提示文字（底部居右排列）
            _hint.SetBounds(60, h - 46, Math.Max(60, w - 60 - pad), 28);

            ApplyRoundRegion();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            LayoutControls();
        }

        // ---- 缩放边（对应 Win32 HTXXX 值）----
        private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
                          HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16,
                          HTBOTTOMRIGHT = 17;
        private const int WM_NCHITTEST = 0x0084;
        private const int ResizeGrip = 6;   // 边缘拖拽感应宽度

        /// <summary>第二个实例启动时广播消息，这里响应并弹出面板。</summary>
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == NativeMethods.WM_CLIPCHAN_SHOW)
            {
                ShowPanel();
                return;
            }

            // 系统设置变更：用户在「设置 → 个性化 → 颜色」里切换明暗时，
            // 系统会广播 WM_SETTINGCHANGE(ImmersiveColorSet)。auto 模式下即时跟随。
            if (m.Msg == WM_SETTINGCHANGE)
            {
                string area = Marshal.PtrToStringAuto(m.LParam);
                if (string.IsNullOrEmpty(area) ||
                    area.IndexOf("ImmersiveColorSet", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    area.IndexOf("theme", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    if (Theme.Mode == "auto") Theme.ApplyFromSystem();
                }
                base.WndProc(ref m);
                return;
            }

            // 无边框窗口需要自己实现边缘缩放
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result == 1)   // HTCLIENT
                {
                    int hit = HitTestEdge();
                    if (hit != 0) m.Result = (IntPtr)hit;
                }
                return;
            }

            base.WndProc(ref m);
        }

        /// <summary>判断鼠标是否位于窗口边缘，返回对应的 HTXXX；不在边缘返回 0。</summary>
        private int HitTestEdge()
        {
            Point p = PointToClient(Cursor.Position);
            int w = ClientSize.Width, h = ClientSize.Height;

            bool left = p.X <= ResizeGrip;
            bool right = p.X >= w - ResizeGrip;
            bool top = p.Y <= ResizeGrip;
            bool bottom = p.Y >= h - ResizeGrip;

            // 标题栏区域不参与缩放，否则会和拖动窗口冲突
            if (top && p.Y <= 34) top = false;

            if (top && left) return HTTOPLEFT;
            if (top && right) return HTTOPRIGHT;
            if (bottom && left) return HTBOTTOMLEFT;
            if (bottom && right) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (top) return HTTOP;
            if (bottom) return HTBOTTOM;
            return 0;
        }

        private ContextMenuStrip BuildMenu()
        {
            var m = new ContextMenuStrip();
            m.Font = Theme.Font(9f, FontStyle.Regular);
            m.Renderer = new ThemeMenuRenderer();   // 菜单跟随明暗主题

            var open = new ToolStripMenuItem("\u663E\u793A\u9762\u677F");
            open.Click += delegate { ShowPanel(); };

            var pause = new ToolStripMenuItem("\u6682\u505C\u76D1\u542C");
            pause.CheckOnClick = true;
            pause.Click += delegate(object s, EventArgs e)
            {
                _paused = ((ToolStripMenuItem)s).Checked;
                if (_paused) _msg.StopListening();
                else _msg.StartListening();
                _tray.Text = _paused ? "\u526A\u8D34\u677F\u9171 - \u5DF2\u6682\u505C" : "\u526A\u8D34\u677F\u9171 - \u526A\u8D34\u677F\u5386\u53F2";
            };

            // Enter 自动粘贴开关：关掉后行为回到"只复制+提示"
            var paste = new ToolStripMenuItem("Enter \u81EA\u52A8\u7C98\u8D34");
            paste.CheckOnClick = true;
            paste.Click += delegate(object s, EventArgs e)
            {
                _settings.AutoPaste = ((ToolStripMenuItem)s).Checked;
                _settings.Save();
            };

            var hotkey = new ToolStripMenuItem("\u8BBE\u7F6E\u70ED\u952E\u2026");
            hotkey.Click += delegate { OpenHotkeyDialog(); };

            var cloud = new ToolStripMenuItem("\u2728 \u4ECA\u65E5\u8BCD\u4E91\u2026");
            cloud.Click += delegate
            {
                using (var form = new WordCloudForm(_store))
                    form.ShowDialog();
            };

            var ghost = new ToolStripMenuItem("\uD83D\uDD75 \u5E7D\u7075\u6A21\u5F0F 10 \u5206\u949F");
            ghost.Click += delegate
            {
                if (_settings.IsGhostMode) ExitGhostMode();
                else EnterGhostMode(10);
            };

            var clear = new ToolStripMenuItem("\u6E05\u7A7A\u672A\u6536\u85CF");
            clear.Click += delegate { ClearAll(); };

            // 外观：跟随系统 / 浅色 / 深色（单选，选中项打勾）
            var appearance = new ToolStripMenuItem("\u5916\u89C2");
            var tAuto = new ToolStripMenuItem("\u8DDF\u968F\u7CFB\u7EDF");
            var tLight = new ToolStripMenuItem("\u6D45\u8272");
            var tDark = new ToolStripMenuItem("\u6DF1\u8272");
            tAuto.Click += delegate { SetThemeMode("auto"); };
            tLight.Click += delegate { SetThemeMode("light"); };
            tDark.Click += delegate { SetThemeMode("dark"); };
            appearance.DropDownItems.Add(tAuto);
            appearance.DropDownItems.Add(tLight);
            appearance.DropDownItems.Add(tDark);

            var auto = new ToolStripMenuItem("\u5F00\u673A\u81EA\u52A8\u542F\u52A8");
            auto.Click += delegate
            {
                SetAutoStart(!_autoStart);
                auto.Checked = _autoStart;
            };

            var exit = new ToolStripMenuItem("\u9000\u51FA");
            exit.Click += delegate { ExitApp(); };

            m.Items.Add(open);
            m.Items.Add(pause);
            m.Items.Add(paste);
            m.Items.Add(cloud);
            m.Items.Add(ghost);
            m.Items.Add(new ToolStripSeparator());
            m.Items.Add(hotkey);
            m.Items.Add(appearance);
            m.Items.Add(clear);
            m.Items.Add(new ToolStripSeparator());
            m.Items.Add(auto);
            m.Items.Add(new ToolStripSeparator());
            m.Items.Add(exit);

            m.Opening += delegate
            {
                pause.Checked = _paused;
                paste.Checked = _settings.AutoPaste;
                auto.Checked = _autoStart;
                tAuto.Checked = Theme.Mode == "auto";
                tLight.Checked = Theme.Mode == "light";
                tDark.Checked = Theme.Mode == "dark";
                ghost.Enabled = !_settings.IsGhostMode;
                ghost.Text = _settings.IsGhostMode
                    ? "🕵 幽灵模式中… " + (int)Math.Ceiling((_settings.GhostUntilUtc - DateTime.UtcNow).TotalMinutes) + " 分钟"
                    : "🕵 幽灵模式 10 分钟";
            };
            return m;
        }

        /// <summary>切换主题模式并持久化；Theme 内部只在真正变化时触发重绘。</summary>
        private void SetThemeMode(string mode)
        {
            Theme.SetMode(mode);
            _settings.ThemeMode = Settings.NormalizeThemeMode(mode);
            _settings.Save();
        }

        /// <summary>打开热键设置对话框；保存后立即重新注册热键。</summary>
        private void OpenHotkeyDialog()
        {
            string before = _settings.Label;

            using (var dlg = new HotkeyDialog(_settings, _msg))
            {
                Hide();          // 避免主面板失焦逻辑干扰对话框
                dlg.ShowDialog();
            }

            if (_settings.Label == before) return;

            if (_msg.ApplyHotkey(_settings))
            {
                _tray.BalloonTipTitle = "\u70ED\u952E\u5DF2\u66F4\u65B0";
                _tray.BalloonTipText = "\u65B0\u7684\u547C\u51FA\u70ED\u952E\uFF1A" + _settings.Label;
                _tray.ShowBalloonTip(2500);
            }
            else
            {
                _tray.BalloonTipTitle = "\u70ED\u952E\u6CE8\u518C\u5931\u8D25";
                _tray.BalloonTipText = _settings.Label + " \u5DF2\u88AB\u5360\u7528\uFF0C\u8BF7\u91CD\u65B0\u8BBE\u7F6E\u3002";
                _tray.ShowBalloonTip(4000);
            }

            RefreshView();   // 刷新底部提示里的热键名
        }

        private void SyncAutoStartState()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    object v = k == null ? null : k.GetValue(AppName);
                    _autoStart = v != null;
                }
            }
            catch (Exception) { _autoStart = false; }
        }

        private void SetAutoStart(bool on)
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (k == null) return;
                    if (on) k.SetValue(AppName, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(AppName, false);
                    _autoStart = on;
                }
            }
            catch (Exception) { }
        }

        public void ExitApp()
        {
            _closingForReal = true;
            _fade.Stop();
            if (_pasteTimer != null) { _pasteTimer.Stop(); _pasteTimer.Dispose(); }
            try { _store.Save(); } catch (Exception) { }
            try { _msg.Dispose(); } catch (Exception) { }
            try { _tray.Visible = false; _tray.Dispose(); } catch (Exception) { }
            Application.Exit();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_closingForReal && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
