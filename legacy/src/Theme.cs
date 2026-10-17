using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using Microsoft.Win32;

namespace Clipchan
{
    /// <summary>
    /// 全局设计令牌（Design Tokens）：配色 / 字体 / 圆角 / 间距 / 阴影的单一来源。
    /// 配色支持亮 / 暗双调色板，可跟随系统自动切换（Theme.Changed 通知所有界面重绘）。
    /// 任何视觉统一性调整只改这里，保证主面板、词云、对话框、菜单、托盘完整同步。
    /// </summary>
    internal static class Theme
    {
        // ==================== 一、调色板定义 ====================
        // 命名规则：[语义][色阶]，业务代码不允许出现具体色值。

        private struct Palette
        {
            public Color Accent, AccentSoft, AccentDark, Violet;
            public Color Canvas, Card, Field, Line, LineStrong;
            public Color Ink, InkSoft, InkFaint, InkInvert;
            public Color Gold, Success, Danger;
            public Color SelectFill, HoverFill;
            public Color ButtonPrimary;
            public Color Shadow1, Shadow2, Shadow3;
        }

        private static readonly Palette Light = NewLight();
        private static readonly Palette Dark = NewDark();

        private static Palette NewLight()
        {
            Palette p = new Palette();
            p.Accent      = Color.FromArgb(255, 244, 114, 182);  // 赛博樱花粉
            p.AccentSoft  = Color.FromArgb(255, 251, 225, 236);
            p.AccentDark  = Color.FromArgb(255, 219,  64, 132);
            p.Violet      = Color.FromArgb(255, 167, 139, 250);  // 星紫
            p.Canvas      = Color.FromArgb(255, 253, 248, 250);  // 暖奶油白
            p.Card        = Color.FromArgb(255, 255, 255, 255);
            p.Field       = Color.FromArgb(255, 255, 255, 255);  // 输入框底
            p.Line        = Color.FromArgb(255, 238, 228, 235);
            p.LineStrong  = Color.FromArgb(255, 226, 210, 220);
            p.Ink         = Color.FromArgb(255,  67,  45,  64);  // 深莓墨水
            p.InkSoft     = Color.FromArgb(255, 143, 118, 138);
            p.InkFaint    = Color.FromArgb(255, 184, 162, 176);
            p.InkInvert   = Color.FromArgb(255, 255, 255, 255);
            p.Gold        = Color.FromArgb(255, 217, 160,  40);
            p.Success     = Color.FromArgb(255,  61, 156, 114);
            p.Danger      = Color.FromArgb(255, 214,  91,  87);
            p.SelectFill  = Color.FromArgb(255, 252, 232, 240);
            p.HoverFill   = Color.FromArgb(255, 254, 250, 252);
            p.ButtonPrimary = Color.FromArgb(255, 255, 214, 232);   // 主按钮淡粉底
            p.Shadow1     = Color.FromArgb(14, 220,  90, 150);   // 淡玫瑰三层投影
            p.Shadow2     = Color.FromArgb(10, 220, 110, 165);
            p.Shadow3     = Color.FromArgb( 5, 190,  90, 130);
            return p;
        }

        private static Palette NewDark()
        {
            Palette p = new Palette();
            // 暗色下主色提亮，保证在深底上的强调力；AccentDark 反而更亮（用于描边/文字）
            p.Accent      = Color.FromArgb(255, 240, 110, 180);
            p.AccentSoft  = Color.FromArgb(255,  74,  46,  68);  // 深粉底（徽标底/悬停）
            p.AccentDark  = Color.FromArgb(255, 255, 138, 198);
            p.Violet      = Color.FromArgb(255, 183, 156, 247);
            p.Canvas      = Color.FromArgb(255,  30,  26,  34);  // 深梅黑
            p.Card        = Color.FromArgb(255,  42,  36,  48);
            p.Field       = Color.FromArgb(255,  51,  44,  59);
            p.Line        = Color.FromArgb(255,  58,  51,  66);
            p.LineStrong  = Color.FromArgb(255,  74,  66,  84);
            p.Ink         = Color.FromArgb(255, 239, 231, 240);
            p.InkSoft     = Color.FromArgb(255, 185, 169, 182);
            p.InkFaint    = Color.FromArgb(255, 133, 120, 131);
            // InkInvert 专用于"画在粉/紫渐变标题栏上的文字"，两种主题下标题栏都是彩色，故恒为白
            p.InkInvert   = Color.FromArgb(255, 255, 255, 255);
            p.Gold        = Color.FromArgb(255, 240, 190,  74);
            p.Success     = Color.FromArgb(255,  79, 203, 148);
            p.Danger      = Color.FromArgb(255, 240, 112, 108);
            p.SelectFill  = Color.FromArgb(255,  58,  42,  58);
            p.HoverFill   = Color.FromArgb(255,  46,  40,  52);
            p.ButtonPrimary = Color.FromArgb(255, 96, 58, 78);      // 主按钮深粉底
            p.Shadow1     = Color.FromArgb(40, 0, 0, 0);         // 暗色下投影转黑
            p.Shadow2     = Color.FromArgb(26, 0, 0, 0);
            p.Shadow3     = Color.FromArgb(14, 0, 0, 0);
            return p;
        }

        private static Palette _p = Light;

        /// <summary>当前是否为暗色调色板。</summary>
        public static bool IsDark { get; private set; }

        /// <summary>调色板切换通知（各窗体订阅后重涂控件底色并整体重绘）。</summary>
        public static event Action Changed;

        // ---- 令牌访问器（名称与旧版完全一致，业务代码零改动） ----

        public static Color Accent      { get { return _p.Accent; } }
        public static Color AccentSoft  { get { return _p.AccentSoft; } }
        public static Color AccentDark  { get { return _p.AccentDark; } }
        public static Color Violet      { get { return _p.Violet; } }
        public static Color Canvas      { get { return _p.Canvas; } }
        public static Color Card        { get { return _p.Card; } }
        /// <summary>输入框/弹层表面色。</summary>
        public static Color Field       { get { return _p.Field; } }
        public static Color Line        { get { return _p.Line; } }
        public static Color LineStrong  { get { return _p.LineStrong; } }
        public static Color Ink         { get { return _p.Ink; } }
        public static Color InkSoft     { get { return _p.InkSoft; } }
        public static Color InkFaint    { get { return _p.InkFaint; } }
        public static Color InkInvert   { get { return _p.InkInvert; } }
        public static Color Gold        { get { return _p.Gold; } }
        public static Color Success     { get { return _p.Success; } }
        public static Color Danger      { get { return _p.Danger; } }
        public static Color SelectFill  { get { return _p.SelectFill; } }
        public static Color HoverFill   { get { return _p.HoverFill; } }
        /// <summary>主按钮（保存/确认）底色。</summary>
        public static Color ButtonPrimary { get { return _p.ButtonPrimary; } }

        /// <summary>标题栏渐变在幽灵模式下的两个暗色端点。</summary>
        public static Color GhostHeadA { get { return IsDark ? Color.FromArgb(255, 44, 42, 50) : Color.FromArgb(255, 92, 96, 110); } }
        public static Color GhostHeadB { get { return IsDark ? Color.FromArgb(255, 30, 28, 36) : Color.FromArgb(255, 62, 66, 80); } }
        /// <summary>幽灵徽章底色。</summary>
        public static Color GhostPill  { get { return IsDark ? Color.FromArgb(255, 88, 84, 96) : Color.FromArgb(255, 56, 60, 72); } }
        /// <summary>窗口外框描边（亮色=半透明白高光，暗色=半透明主色微光）。</summary>
        public static Color WindowBorder { get { return IsDark ? Color.FromArgb(120, 90, 78, 96) : Color.FromArgb(200, 255, 255, 255); } }
        /// <summary>类型徽标淡底的不透明度：暗色卡片上需要更高才看得出（亮 14 / 暗 46）。</summary>
        public static int BadgeTintAlpha { get { return IsDark ? 46 : 14; } }

        // ==================== 二、主题模式（auto/light/dark） ====================

        private static string _mode = "auto";

        /// <summary>当前主题模式："auto" 跟随系统 / "light" / "dark"。</summary>
        public static string Mode { get { return _mode; } }

        /// <summary>设置模式并立即应用；返回是否发生了实际切换。</summary>
        public static bool SetMode(string mode)
        {
            if (string.IsNullOrEmpty(mode)) mode = "auto";
            _mode = mode;
            return ApplyFromSystem();
        }

        /// <summary>按当前模式解析并应用调色板。返回是否发生了变化。</summary>
        public static bool ApplyFromSystem()
        {
            bool dark;
            if (_mode == "light") dark = false;
            else if (_mode == "dark") dark = true;
            else dark = SystemPrefersDark();

            return Apply(dark);
        }

        /// <summary>切换到指定调色板；仅在真正变化时触发 Changed 事件。</summary>
        public static bool Apply(bool dark)
        {
            if (dark == IsDark && _pInitialized) return false;
            _pInitialized = true;
            IsDark = dark;
            _p = dark ? Dark : Light;
            InvalidateBrushCache();
            Action h = Changed;
            if (h != null) h();
            return true;
        }
        private static bool _pInitialized;

        /// <summary>
        /// 读取 Windows 系统深色偏好（HKCU\...\Themes\Personalize\AppsUseLightTheme）。
        /// 读不到（旧系统/权限异常）一律回落到浅色，保证行为可预期。
        /// </summary>
        public static bool SystemPrefersDark()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    if (k == null) return false;
                    object v = k.GetValue("AppsUseLightTheme");
                    if (v is int) return (int)v == 0;
                }
            }
            catch (Exception) { }
            return false;
        }

        // ==================== 三、几何令牌 ====================

        public const int Radius      = 18;    // 窗口与最大圆角
        public const int RadiusCard  = 13;    // 卡片圆角
        public const int RadiusField = 10;    // 输入框圆角
        public const int RadiusBadge = 8;     // 小徽标圆角

        public const int PadBase  = 16;       // 页面边距（4px 节奏栅格）
        public const int PadTight = 10;       // 边距 - 紧凑
        public const int GapCard  = 8;        // 卡片间距
        public const int GapElem  = 12;       // 元素间距

        /// <summary>列表行高。</summary>
        public const int ItemHeight = 52;

        // ==================== 四、字体令牌 ====================

        public const float FontTitle   = 12f;    // 标题栏
        public const float FontItem    = 10.5f;  // 列表正文
        public const float FontMeta    = 8.5f;   // 列表次要信息
        public const float FontHint    = 8.5f;   // 底部提示
        public const float FontBadge   = 8.5f;   // 条数徽章
        public const float FontSearch  = 10.5f;  // 搜索框
        public const float FontButton  = 9.5f;   // 按钮

        private static string _family;

        /// <summary>优先使用中文字体，缺失则回退。</summary>
        public static string Family
        {
            get
            {
                if (_family != null) return _family;
                foreach (string name in new[] { "Microsoft YaHei UI", "Source Han Sans SC", "PingFang SC", "Segoe UI" })
                {
                    try
                    {
                        using (var f = new FontFamily(name)) { _family = name; return _family; }
                    }
                    catch { }
                }
                _family = FontFamily.GenericSansSerif.Name;
                return _family;
            }
        }

        public static Font Font(float size, FontStyle style)
        {
            try { return new Font(Family, size, style); }
            catch { return new Font(FontFamily.GenericSansSerif, size, style); }
        }

        // ==================== 五、GDI 性能优化 ====================
        // 常用画刷/画笔全局缓存；主题切换时 InvalidateBrushCache 重建。

        private static SolidBrush _cacheInk, _cacheInkSoft, _cacheInkFaint, _cacheCanvas, _cacheCard, _cacheField;
        private static Pen _penLine, _penLineStrong, _penAccent, _penAccentDark;

        private static void InvalidateBrushCache()
        {
            DisposeAndNull(ref _cacheInk); DisposeAndNull(ref _cacheInkSoft); DisposeAndNull(ref _cacheInkFaint);
            DisposeAndNull(ref _cacheCanvas); DisposeAndNull(ref _cacheCard); DisposeAndNull(ref _cacheField);
            DisposeAndNull(ref _penLine); DisposeAndNull(ref _penLineStrong);
            DisposeAndNull(ref _penAccent); DisposeAndNull(ref _penAccentDark);
        }

        private static void DisposeAndNull<T>(ref T obj) where T : class, IDisposable
        {
            if (obj != null) { obj.Dispose(); obj = null; }
        }

        public static SolidBrush BrushInk       { get { return _cacheInk      ?? (_cacheInk = new SolidBrush(Ink)); } }
        public static SolidBrush BrushInkSoft   { get { return _cacheInkSoft  ?? (_cacheInkSoft = new SolidBrush(InkSoft)); } }
        public static SolidBrush BrushInkFaint  { get { return _cacheInkFaint ?? (_cacheInkFaint = new SolidBrush(InkFaint)); } }
        public static SolidBrush BrushCanvas    { get { return _cacheCanvas   ?? (_cacheCanvas = new SolidBrush(Canvas)); } }
        public static SolidBrush BrushCard      { get { return _cacheCard     ?? (_cacheCard = new SolidBrush(Card)); } }
        public static SolidBrush BrushField     { get { return _cacheField    ?? (_cacheField = new SolidBrush(Field)); } }

        public static Pen PenLine       { get { return _penLine ?? (_penLine = new Pen(Line, 1f)); } }
        public static Pen PenLineStrong { get { return _penLineStrong ?? (_penLineStrong = new Pen(LineStrong, 1f)); } }
        public static Pen PenAccent     { get { return _penAccent ?? (_penAccent = new Pen(Accent, 1f)); } }
        public static Pen PenAccentDark { get { return _penAccentDark ?? (_penAccentDark = new Pen(AccentDark, 1.6f)); } }

        public static void EnableSmoothing(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        }

        // ==================== 六、共享绘制基元 ====================

        /// <summary>构造圆角矩形路径。</summary>
        public static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = Math.Max(1, radius * 2);
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;

            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>统一卡片绘制：多层柔和投影 → 底色 → 薄描边。</summary>
        public static void DrawCard(Graphics g, Rectangle r, Color fill, Color border, int radius)
        {
            EnableSmoothing(g);
            DrawCardShadow(g, r, radius);

            using (var path = RoundRect(r, radius))
            {
                using (var b = new SolidBrush(fill)) g.FillPath(b, path);
                using (var pen = new Pen(border, 1f)) g.DrawPath(pen, path);
            }
        }

        /// <summary>多层柔和投影（亮色淡玫瑰 / 暗色黑雾，由调色板提供）。</summary>
        public static void DrawCardShadow(Graphics g, Rectangle r, int radius)
        {
            DrawShadowLayer(g, r, _p.Shadow1, 1, radius);
            DrawShadowLayer(g, r, _p.Shadow2, 3, radius + 2);
            DrawShadowLayer(g, r, _p.Shadow3, 5, radius + 4);
        }

        private static void DrawShadowLayer(Graphics g, Rectangle r, Color c, int offset, int radius)
        {
            var sh = new Rectangle(r.X, r.Y + offset, r.Width, r.Height);
            using (var path = RoundRect(sh, radius))
            using (var b = new SolidBrush(c))
                g.FillPath(b, path);
        }

        /// <summary>绘制五角星（收藏标记）。</summary>
        public static void DrawStar(Graphics g, int cx, int cy, float r, Color color)
        {
            var pts = new PointF[10];
            for (int i = 0; i < 10; i++)
            {
                double ang = -Math.PI / 2 + i * Math.PI / 5;
                float rr = (i % 2 == 0) ? r : r * 0.45f;
                pts[i] = new PointF(cx + (float)(Math.Cos(ang) * rr),
                                    cy + (float)(Math.Sin(ang) * rr));
            }
            using (var b = new SolidBrush(color)) g.FillPolygon(b, pts);
        }

        /// <summary>通用色彩混合（0..1），替代手工调色。</summary>
        public static Color Blend(Color a, Color b, float ratio)
        {
            ratio = Math.Max(0f, Math.Min(1f, ratio));
            return Color.FromArgb(255,
                (int)(a.R + (b.R - a.R) * ratio),
                (int)(a.G + (b.G - a.G) * ratio),
                (int)(a.B + (b.B - a.B) * ratio));
        }

        /// <summary>带 alpha 的派生色（业务代码里大量 "Accent 加透明度" 的写法归口到这里）。</summary>
        public static Color Alpha(Color c, int a)
        {
            return Color.FromArgb(a, c.R, c.G, c.B);
        }

        /// <summary>把矩形夹紧到工作区内，避免面板出屏。</summary>
        public static Point ClampToScreen(Point p, Size size, Rectangle work)
        {
            int x = Math.Max(work.Left, Math.Min(p.X, work.Right - size.Width));
            int y = Math.Max(work.Top, Math.Min(p.Y, work.Bottom - size.Height));
            return new Point(x, y);
        }

        /// <summary>相对时间显示，例如"刚刚"、"3 分钟前"、"昨天"。</summary>
        public static string RelativeTime(DateTime utc)
        {
            TimeSpan d = DateTime.UtcNow - utc;
            if (d.TotalSeconds < 45) return "刚刚";
            if (d.TotalMinutes < 60) return ((int)Math.Round(d.TotalMinutes)) + " 分钟前";
            if (d.TotalHours < 24) return ((int)d.TotalHours) + " 小时前";
            if (d.TotalDays < 2) return "昨天";
            if (d.TotalDays < 30) return ((int)d.TotalDays) + " 天前";
            return utc.ToLocalTime().ToString("yyyy-MM-dd");
        }
    }
}
